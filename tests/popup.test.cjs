const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const config = require('../keyword-config.js');
const popup = fs.readFileSync(path.join(__dirname, '../popup.js'), 'utf8');
const html = fs.readFileSync(path.join(__dirname, '../popup.html'), 'utf8');
const tick = async () => { for (let i = 0; i < 5; i++) await new Promise(resolve => setImmediate(resolve)); };

function open(storage, bridge) {
  let currentBridge = bridge;
  let injections = 0;
  const elements = new Map();
  const listeners = [];
  const intervals = [];
  const tab = { id: 42, url: 'https://www.bilibili.com/video/BV1kAYS6FEeF/', title: 'Juya sample' };
  function element(id = '') {
    return {
      id, value: '', textContent: '', disabled: false, hidden: false, checked: false,
      scrollTop: 0, scrollHeight: 0, clientHeight: 100, children: [], listeners: {},
      addEventListener(name, listener) { this.listeners[name] = listener; },
      replaceChildren(...children) { this.children = children; },
      append(...children) { this.children.push(...children); },
      fire(name) { assert.ok(this.listeners[name], `${id}: ${name}`); this.listeners[name](); }
    };
  }
  const document = {
    getElementById(id) {
      if (!elements.has(id)) elements.set(id, element(id));
      return elements.get(id);
    },
    createElement: () => element(), createTextNode: text => ({ textContent: text }),
    createDocumentFragment: () => element()
  };
  const calls = [];
  const chrome = {
    storage: { onChanged: { addListener(listener) { listeners.push(listener); } }, local: {
      async get(keys) { return Object.fromEntries((Array.isArray(keys) ? keys : [keys]).map(key => [key, storage[key]])); },
      async set(value) {
        const changes = Object.fromEntries(Object.entries(value).map(([key, next]) =>
          [key, { oldValue: storage[key], newValue: next }]));
        Object.assign(storage, structuredClone(value));
        for (const listener of listeners) listener(changes, 'local');
      }
    } },
    tabs: { async query() { return [tab]; } },
    runtime: { async sendMessage(message) {
      if (message.type !== 'setEnabled') throw new Error('Unexpected message');
      await chrome.storage.local.set({ juyaGlobalEnabled: message.enabled });
      return { ok: true, enabled: message.enabled };
    } },
    scripting: { async executeScript(request) {
      if (request.files) { injections++; currentBridge = currentBridge || makeBridge(); return [{ result: null }]; }
      if (!request.args) return [{ result: { known: true, supported: true } }];
      const [method, args] = request.args;
      calls.push([method, ...args]);
      return [{ result: currentBridge?.[method](...args) ?? null }];
    } }
  };
  const context = vm.createContext({ document, chrome, crypto: { randomUUID: () => `group-${++open.counter}` },
    JuyaKeywordConfig: config, window: { confirm: () => true }, setInterval(fn) { intervals.push(fn); } });
  vm.runInContext(popup, context);
  return { elements, calls, tab, intervals, get injections() { return injections; }, el: document.getElementById };
}
open.counter = 0;
function makeBridge() {
  let words = [...config.DEFAULT_KEYWORDS];
  const calls = [];
  return {
    calls, get words() { return words; },
    finishInstall() { return this.snapshot(); },
    snapshot() { return { ready: true, version: '0.3.1', supported: true, title: 'Juya sample', active: true,
      total: 25, keep: words.includes('Tibo') ? 2 : 14, jumps: 0,
      ocrAllowed: false, ocrRunning: false, logs: [], source: '置顶正文 + 作者回复' }; },
    command(action, value) {
      calls.push([action, value]);
      if (action === 'keywords') {
        if (value.includes('NoSuchStory')) throw new Error('当前视频没有匹配新集合的资讯');
        words = [...value];
      }
      return this.snapshot();
    }
  };
}
const bridge = makeBridge;

test('popup loads default, edits words, creates and names groups, persists across reopening', async () => {
  const storage = {};
  const page = bridge();
  const first = open(storage, page);
  await tick();
  assert.equal(first.el('keyword-group').value, 'default');
  assert.equal(first.el('keyword-words').value, config.DEFAULT_KEYWORDS.join('\n'));
  first.el('keyword-add').fire('click');
  await tick();
  assert.equal(storage[config.STORAGE_KEY].groups.length, 2);
  first.el('keyword-name').value = '重点公司';
  first.el('keyword-words').value = 'Tibo\nDeepSeek';
  first.el('keyword-save').fire('click');
  await tick();
  assert.deepEqual(page.words, ['Tibo', 'DeepSeek']);
  assert.equal(storage[config.STORAGE_KEY].groups[1].name, '重点公司');
  assert.equal(first.el('keyword-preview').textContent, 'Tibo · DeepSeek');
  const reopened = open(storage, page);
  await tick();
  assert.equal(reopened.el('keyword-words').value, 'Tibo\nDeepSeek');
  assert.equal(reopened.el('keyword-group').value, storage[config.STORAGE_KEY].selectedId);
  reopened.el('keyword-group').value = 'default';
  reopened.el('keyword-group').fire('change');
  await tick();
  assert.deepEqual(page.words, config.DEFAULT_KEYWORDS);
  assert.equal(storage[config.STORAGE_KEY].selectedId, 'default');
});

test('failed active configuration neither saves nor changes current selection', async () => {
  const storage = {};
  const page = bridge();
  const ui = open(storage, page);
  await tick();
  ui.el('keyword-add').fire('click');
  await tick();
  const id = storage[config.STORAGE_KEY].selectedId;
  ui.el('keyword-words').value = 'NoSuchStory';
  ui.el('keyword-save').fire('click');
  await tick();
  assert.equal(storage[config.STORAGE_KEY].selectedId, id);
  assert.deepEqual(storage[config.STORAGE_KEY].groups[1].keywords, config.DEFAULT_KEYWORDS);
  assert.deepEqual(page.words, config.DEFAULT_KEYWORDS);
  assert.match(ui.el('error').textContent, /没有匹配/);
});

test('popup markup has the editor controls and external scripts in CSP-compatible order', () => {
  for (const id of ['keyword-group', 'keyword-name', 'keyword-words', 'keyword-save', 'keyword-add',
    'keyword-delete', 'keyword-reset', 'keyword-discard']) assert.match(html, new RegExp(`id="${id}"`));
  assert.ok(html.indexOf('src="keyword-config.js"') < html.indexOf('src="popup.js"'));
});

test('master switch persists and remains on after the tab navigates away', async () => {
  const storage = {};
  const ui = open(storage, bridge());
  await tick();
  assert.equal(ui.el('global-switch').checked, false);
  ui.el('global-switch').checked = true;
  ui.el('global-switch').fire('change');
  await tick();
  assert.equal(storage.juyaGlobalEnabled, true);
  assert.equal(ui.el('global-switch').checked, true);
  ui.tab.url = 'https://www.bilibili.com/';
  await ui.intervals[0]();
  await tick();
  assert.equal(ui.el('global-switch').checked, true);
  assert.match(ui.el('source').textContent, /不是 B站视频/);
  ui.el('global-switch').checked = false;
  ui.el('global-switch').fire('change');
  await tick();
  assert.equal(storage.juyaGlobalEnabled, false);
});

test('global off prepares OCR on a valid page without activating the master switch', async () => {
  const ui = open({}, null);
  await tick();
  assert.equal(ui.injections, 1);
  assert.equal(ui.el('global-switch').checked, false);
  assert.equal(ui.el('ocr-enabled').disabled, false);
  assert.equal(ui.el('status').textContent, '已关闭');
  assert.ok(ui.calls.some(([method, action]) => method === 'command' && action === 'keywords'));
});

test('global on lets the background own injection while popup waits', async () => {
  const ui = open({ juyaGlobalEnabled: true }, null);
  await tick();
  assert.equal(ui.injections, 0);
  assert.equal(ui.el('global-switch').checked, true);
  assert.match(ui.el('source').textContent, /自动启用/);
});
