const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const source = name => fs.readFileSync(path.join(__dirname, '..', name), 'utf8');
const flush = async () => { for (let i = 0; i < 6; i++) await new Promise(resolve => setImmediate(resolve)); };

test('manifest registers persistent worker and Bilibili content listener', () => {
  const manifest = JSON.parse(source('manifest.json'));
  assert.equal(manifest.background.service_worker, 'background.js');
  assert.deepEqual(manifest.content_scripts[0].js, ['autostart.js']);
  assert.equal(manifest.content_scripts[0].run_at, 'document_idle');
  for (const permission of ['scripting', 'storage', 'tabs', 'webNavigation']) {
    assert.ok(manifest.permissions.includes(permission));
  }
});

function fakePage(url, owner = { name: '橘鸦Juya', mid: 285286947 }) {
  const page = { url, owner, ready: true, panel: null, injectionCount: 0 };
  page.install = () => {
    page.injectionCount++;
    const bridge = { active: false, starting: false, lastError: '', keywords: ['OpenAI'], reads: 0,
      originalUrl: page.url,
      snapshot() {
        if (this.originalUrl !== page.url) { this.active = false; this.lastError = ''; this.originalUrl = page.url; }
        return { ready: true, version: '0.3.1', url: page.url, supported: true,
          active: this.active, starting: this.starting, lastError: this.lastError,
          keywords: this.keywords };
      },
      finishInstall() { return this.snapshot(); },
      command(action, value) {
        this.snapshot();
        if (action === 'keywords') { this.keywords = value; this.lastError = ''; }
        if (action === 'start') {
          this.reads++;
          this.active = !page.failStartMessage;
          this.lastError = page.failStartMessage || '';
        }
        if (action === 'stop') this.active = false;
        return this.snapshot();
      }
    };
    page.panel = bridge;
  };
  return page;
}
function service(storage, tabs) {
  let onMessage;
  let onUpdated;
  let onHistory;
  const chrome = {
    storage: { local: {
      async get(keys) { return Object.fromEntries((Array.isArray(keys) ? keys : [keys]).map(key => [key, storage[key]])); },
      async set(values) { Object.assign(storage, structuredClone(values)); }
    } },
    tabs: { onUpdated: { addListener(listener) { onUpdated = listener; } },
      async get(id) { return tabs.get(id); }, async query() {
      return [...tabs.values()].filter(tab => tab.url.startsWith('https://www.bilibili.com/'));
    } },
    scripting: { async executeScript(request) {
      const tab = tabs.get(request.target.tabId);
      const page = tab.page;
      if (request.files) { page.install(); return [{ result: null }]; }
      const sandbox = { window: { __INITIAL_STATE__: { videoData: { owner: page.owner } },
        get JuyaPanel() { return page.panel; },
        JuyaDemo: { findVideo() { if (!page.ready) throw new Error('not ready'); return {}; } } },
      document: {}, location: { get href() { return page.url; } } };
      const fn = vm.runInNewContext(`(${request.func.toString()})`, sandbox);
      return [{ result: fn(...(request.args || [])) }];
    } },
    webNavigation: { onHistoryStateUpdated: { addListener(listener) { onHistory = listener; } } },
    runtime: { onMessage: { addListener(listener) { onMessage = listener; } },
      onInstalled: { addListener() {} }, onStartup: { addListener() {} } }
  };
  const context = vm.createContext({ chrome, importScripts(name) { vm.runInContext(source(name), context); } });
  vm.runInContext(source('background.js'), context);
  const send = (message, sender = {}) => new Promise(resolve => onMessage(message, sender, resolve));
  return { send, updated: (...args) => onUpdated(...args), history: details => onHistory(details) };
}

test('one switch handles all valid tabs, rejects another owner, and stops all when off', async () => {
  const storage = {};
  const tabs = new Map([
    [1, { id: 1, url: 'https://www.bilibili.com/video/BVone/', page: fakePage('https://www.bilibili.com/video/BVone/') }],
    [2, { id: 2, url: 'https://www.bilibili.com/video/BVother/',
      page: fakePage('https://www.bilibili.com/video/BVother/', { name: '其他 UP', mid: 1 }) }]
  ]);
  const background = service(storage, tabs);
  assert.deepEqual(JSON.parse(JSON.stringify(await background.send({ type: 'setEnabled', enabled: true }))),
    { ok: true, enabled: true });
  assert.equal(storage.juyaGlobalEnabled, true);
  assert.equal(tabs.get(1).page.panel.active, true);
  assert.equal(tabs.get(1).page.panel.reads, 1);
  assert.equal(tabs.get(2).page.panel, null);
  assert.equal((await background.send({ type: 'ensure' }, { tab: tabs.get(2) })).status, 'unsupported');
  assert.deepEqual(JSON.parse(JSON.stringify(await background.send({ type: 'setEnabled', enabled: false }))),
    { ok: true, enabled: false });
  assert.equal(tabs.get(1).page.panel.active, false);
});

test('persisted on state restarts on a refreshed document and on Bilibili SPA navigation', async () => {
  const storage = { juyaGlobalEnabled: true };
  const old = fakePage('https://www.bilibili.com/video/BVone/');
  const tab = { id: 7, url: old.url, page: old };
  const tabs = new Map([[7, tab]]);
  const background = service(storage, tabs);
  assert.equal((await background.send({ type: 'ensure' }, { tab })).status, 'active');
  assert.equal(old.panel.reads, 1);
  tab.page = fakePage(tab.url);
  assert.equal((await background.send({ type: 'ensure' }, { tab })).status, 'active');
  assert.equal(tab.page.panel.reads, 1);
  const reloaded = tab.page;
  tab.url = 'https://www.bilibili.com/video/BVtwo/';
  reloaded.url = tab.url;
  assert.equal((await background.send({ type: 'ensure' }, { tab })).status, 'active');
  assert.equal(reloaded.panel.reads, 2);
  assert.equal(reloaded.injectionCount, 1);
  tab.page = fakePage(tab.url);
  background.updated(tab.id, { status: 'complete' }, tab);
  await flush();
  assert.equal(tab.page.panel.active, true);
  const active = tab.page;
  tab.url = 'https://www.bilibili.com/video/BVthree/';
  active.url = tab.url;
  background.history({ frameId: 0, tabId: tab.id, url: tab.url });
  await flush();
  assert.equal(active.panel.reads, 2);
});

test('waits for owner/video readiness and applies the selected keyword group before start', async () => {
  const settings = { version: 1, selectedId: 'tibo', groups: [
    { id: 'default', name: '默认', keywords: ['OpenAI'] },
    { id: 'tibo', name: '人物', keywords: ['Tibo'] }
  ] };
  const storage = { juyaGlobalEnabled: true, juyaKeywordSettings: settings };
  const page = fakePage('https://www.bilibili.com/video/BVone/', null);
  const tab = { id: 9, url: page.url, page };
  const background = service(storage, new Map([[9, tab]]));
  assert.equal((await background.send({ type: 'ensure' }, { tab })).status, 'waiting');
  assert.equal(page.panel, null);
  page.owner = { name: '橘鸦Juya', mid: 285286947 };
  page.ready = false;
  assert.equal((await background.send({ type: 'ensure' }, { tab })).status, 'waiting');
  assert.equal(page.panel.active, false);
  page.ready = true;
  assert.equal((await background.send({ type: 'ensure' }, { tab })).status, 'active');
  assert.deepEqual(Array.from(page.panel.keywords), ['Tibo']);
});

test('transient comment loading may retry; no matching keywords blocks only this page', async () => {
  const storage = { juyaGlobalEnabled: true };
  const page = fakePage('https://www.bilibili.com/video/BVone/');
  const tab = { id: 11, url: page.url, page };
  const background = service(storage, new Map([[11, tab]]));
  page.failStartMessage = '未识别到置顶评论';
  assert.equal((await background.send({ type: 'ensure' }, { tab })).status, 'starting');
  assert.equal((await background.send({ type: 'ensure' }, { tab })).status, 'failed');
  page.failStartMessage = '';
  assert.equal((await background.send({ type: 'ensure', retry: true }, { tab })).status, 'active');
  page.panel.active = false;
  page.panel.lastError = '没有任何关键词命中';
  assert.equal((await background.send({ type: 'ensure' }, { tab })).status, 'blocked');
  assert.equal(storage.juyaGlobalEnabled, true);
});

function content(storage, url) {
  const location = { href: url };
  const calls = [];
  let interval;
  let onChanged;
  const chrome = { storage: { local: { async get(key) { return { [key]: storage[key] }; } },
    onChanged: { addListener(listener) { onChanged = listener; } } },
  runtime: { async sendMessage(message) {
    calls.push(message);
    return message.type === 'ensure' ? { ok: true, status: 'active' } : { ok: true };
  } } };
  vm.runInNewContext(source('autostart.js'), { chrome, location, setInterval(fn) { interval = fn; }, Date });
  return { location, calls, tick: () => interval(), change(key, value) {
    storage[key] = value;
    onChanged({ [key]: { newValue: value } }, 'local');
  } };
}

test('content script retries after a reload, watches SPA URL changes and respects off', async () => {
  const storage = { juyaGlobalEnabled: true };
  const first = content(storage, 'https://www.bilibili.com/video/BVone/');
  await flush();
  assert.equal(first.calls[0].type, 'ensure');
  const refreshed = content(storage, 'https://www.bilibili.com/video/BVone/');
  await flush();
  assert.equal(refreshed.calls[0].type, 'ensure');
  refreshed.location.href = 'https://www.bilibili.com/video/BVtwo/';
  refreshed.tick(); await flush();
  assert.equal(refreshed.calls.filter(call => call.type === 'ensure').length, 2);
  refreshed.change('juyaGlobalEnabled', false); await flush();
  assert.ok(refreshed.calls.some(call => call.type === 'stopTab'));
  refreshed.location.href = 'https://www.bilibili.com/video/BVthree/';
  refreshed.tick(); await flush();
  assert.equal(refreshed.calls.filter(call => call.type === 'ensure').length, 2);
});
