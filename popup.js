'use strict';
const $ = id => document.getElementById(id);
const config = globalThis.JuyaKeywordConfig;
let tabId;
let lastLogKey = '';
let fetching = false;
let lastError = '';
let settings = config.defaults();
let settingsBusy = false;
let connected = false;
let lastState;
let globalEnabled = false;
let switching = false;
function fail(error) {
  lastError = error.message || String(error);
  $('error').textContent = lastError;
  $('error').hidden = false;
}
async function pageCall(method, ...args) {
  if (!tabId) return null;
  const results = await chrome.scripting.executeScript({
    target: { tabId }, world: 'MAIN',
    func: (name, params) => {
      const bridge = window.JuyaPanel;
      if (!bridge) return null;
      return bridge[name](...params);
    }, args: [method, args]
  });
  return results[0]?.result;
}
function renderMaster() {
  $('global-switch').checked = globalEnabled;
  $('global-switch').disabled = switching;
  $('master-label').textContent = globalEnabled ? '总开关已开启' : '总开关已关闭';
}
function renderSettings() {
  const group = config.selected(settings);
  const selector = $('keyword-group');
  selector.replaceChildren(...settings.groups.map(item => {
    const option = document.createElement('option');
    option.value = item.id;
    option.textContent = item.name;
    return option;
  }));
  selector.value = settings.selectedId;
  $('keyword-preview').textContent = group.keywords.join(' · ');
  $('keyword-name').value = group.name;
  $('keyword-words').value = group.keywords.join('\n');
  updateSettingsControls();
}
function updateSettingsControls() {
  const locked = settingsBusy || lastState?.starting || lastState?.sampling;
  $('keyword-group').disabled = !!locked;
  $('keyword-name').disabled = !!locked || settings.selectedId === 'default';
  $('keyword-words').disabled = !!locked;
  for (const id of ['keyword-save', 'keyword-discard', 'keyword-add']) $(id).disabled = !!locked;
  $('keyword-delete').disabled = !!locked || settings.selectedId === 'default';
  $('keyword-reset').disabled = !!locked || settings.selectedId !== 'default';
}
async function commitSettings(next) {
  settingsBusy = true;
  updateSettingsControls();
  const previous = settings;
  try {
    if (connected) await pageCall('command', 'keywords', config.selected(next).keywords);
    await chrome.storage.local.set({ [config.STORAGE_KEY]: next });
    settings = next;
    lastError = '';
    renderSettings();
    if (connected) render(await pageCall('snapshot'));
    else { $('error').hidden = true; }
  } catch (error) {
    if (connected) {
      try { await pageCall('command', 'keywords', config.selected(previous).keywords); } catch { /* Preserve the original error. */ }
    }
    renderSettings();
    fail(error);
  } finally {
    settingsBusy = false;
    updateSettingsControls();
  }
}
function render(state) {
  if (!state) return;
  lastState = state;
  renderMaster();
  $('video-title').textContent = state.title || '未读取到视频';
  $('video-title').title = state.title || '';
  $('status').textContent = !globalEnabled ? '已关闭' : state.sampling ? '实验取帧中'
    : state.starting ? '读取中' : state.active ? '本页已启用'
    : state.lastError ? '本页未启用' : state.supported ? '检查中' : '待命中';
  $('status').className = `badge ${state.sampling || state.starting ? 'busy' : globalEnabled && state.active ? 'active' : ''}`;
  $('source').textContent = state.source ? `时间轴来源：${state.source}` : state.supported
    ? (state.lastError ? '自动处理未完成；请查看下方错误'
      : globalEnabled ? '正在检查评论时间轴' : '打开总开关后自动读取评论时间轴')
    : '当前页面未识别为橘鸦Juya视频；总开关会继续待命';
  $('total').textContent = state.total || '—';
  $('keep').textContent = state.total ? state.keep : '—';
  $('jumps').textContent = state.jumps;
  $('ocr-enabled').disabled = !state.supported || state.ocrRunning;
  $('ocr-enabled').checked = state.ocrAllowed;
  $('ocr-run').disabled = !state.ocrAllowed || state.ocrRunning || state.starting || !state.supported;
  $('ocr-run').textContent = state.ocrRunning ? '实验运行中…' : '运行一次 OCR';
  $('ocr-state').textContent = state.ocrSummary ? `${state.ocrSummary.blocks} 块 · ${state.ocrSummary.candidates} 个关注候选` : '';
  $('clear').disabled = !state.logs.length;
  updateSettingsControls();
  const error = state.lastError || lastError;
  $('error').textContent = error;
  $('error').hidden = !error;
  const key = `${state.logs.length}:${state.logs.at(-1)?.id ?? 0}`;
  if (key !== lastLogKey) {
    const box = $('logs');
    const bottom = box.scrollHeight - box.clientHeight - box.scrollTop < 24;
    const scroll = box.scrollTop;
    const fragment = document.createDocumentFragment();
    for (const log of state.logs) {
      const row = document.createElement('div'); row.className = `entry ${log.level}`;
      const time = document.createElement('span'); time.className = 'time'; time.textContent = log.time;
      row.append(time, document.createTextNode(log.text)); fragment.append(row);
    }
    if (!state.logs.length) {
      const empty = document.createElement('p');empty.className = 'empty';empty.textContent = '暂无日志';fragment.append(empty);
    }
    box.replaceChildren(fragment);
    box.scrollTop = bottom ? box.scrollHeight : scroll;
    lastLogKey = key;
  }
}
function renderUnavailable(title, reason) {
  connected = false;
  render({ title, ready: false, supported: false, active: false, total: 0, keep: 0,
    jumps: 0, ocrAllowed: false, ocrRunning: false, logs: [] });
  $('source').textContent = reason;
}
async function command(action, value) {
  lastError = '';
  try { render(await pageCall('command', action, value)); } catch (error) { fail(error); }
}
async function refresh() {
  if (fetching) return;
  fetching = true;
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    tabId = tab?.id && /^https:\/\/www\.bilibili\.com\/video\/BV[\w]+/i.test(tab.url || '') ? tab.id : null;
    if (!tabId) {
      renderUnavailable(tab?.title || '非 B站视频页', '当前页不是 B站视频；总开关会在目标视频页自动生效');
      return;
    }
    const state = await pageCall('snapshot');
    if (state?.version === '0.3.1' && state.ready) {
      connected = true;
      render(state);
    } else {
      const [probe] = await chrome.scripting.executeScript({ target: { tabId }, world: 'MAIN', func: () => {
        const owner = window.__INITIAL_STATE__?.videoData?.owner;
        return { known: !!owner, supported: owner?.name === '橘鸦Juya' && String(owner.mid) === '285286947' };
      } });
      const owner = probe?.result;
      if (!globalEnabled && owner?.supported) {
        // Prepare the separate OCR experiment without enabling production skipping.
        await chrome.scripting.executeScript({ target: { tabId }, world: 'MAIN',
          files: ['page-bridge.js', 'juya-demo.js'] });
        await pageCall('finishInstall');
        await pageCall('command', 'keywords', config.selected(settings).keywords);
        const prepared = await pageCall('snapshot');
        connected = !!prepared?.ready;
        render(prepared);
      } else renderUnavailable(tab.title || '视频页加载中', owner?.known && !owner.supported
        ? '当前视频 UP 主不是橘鸦Juya；总开关继续待命'
        : '正在检查页面；符合条件时会自动启用');
    }
  } catch { renderUnavailable('页面加载中', '正在等待视频页，符合条件时会自动启用'); }
  finally { fetching = false; }
}
$('global-switch').addEventListener('change', async () => {
  const desired = $('global-switch').checked;
  switching = true;
  renderMaster();
  try {
    const result = await chrome.runtime.sendMessage({ type: 'setEnabled', enabled: desired });
    if (!result?.ok) throw new Error(result?.error || '无法更新总开关');
    globalEnabled = result.enabled;
    lastError = '';
    await refresh();
  } catch (error) { fail(error); }
  finally { switching = false; renderMaster(); }
});
$('ocr-run').addEventListener('click', () => command('ocr'));
$('ocr-enabled').addEventListener('change', () => command('allowOcr', $('ocr-enabled').checked));
$('clear').addEventListener('click', () => command('clear'));
$('keyword-group').addEventListener('change', () => {
  const current = config.selected(settings);
  if (($('keyword-name').value !== current.name || $('keyword-words').value !== current.keywords.join('\n'))
    && !window.confirm('尚未保存的关键词修改会丢失，继续切换？')) {
    $('keyword-group').value = settings.selectedId;
    return;
  }
  void commitSettings(config.select(settings, $('keyword-group').value));
});
$('keyword-save').addEventListener('click', () => {
  try { void commitSettings(config.update(settings, settings.selectedId, $('keyword-name').value, $('keyword-words').value)); }
  catch (error) { fail(error); }
});
$('keyword-discard').addEventListener('click', renderSettings);
$('keyword-add').addEventListener('click', () => {
  void commitSettings(config.add(settings, crypto.randomUUID()));
  $('keyword-editor').open = true;
});
$('keyword-delete').addEventListener('click', () => {
  if (!window.confirm(`删除“${config.selected(settings).name}”关键词集合？`)) return;
  void commitSettings(config.remove(settings, settings.selectedId));
});
$('keyword-reset').addEventListener('click', () => {
  void commitSettings(config.update(settings, 'default', '默认', config.DEFAULT_KEYWORDS.join('\n')));
});
(async () => {
  try {
    const saved = await chrome.storage.local.get([config.STORAGE_KEY, 'juyaGlobalEnabled']);
    settings = config.restore(saved[config.STORAGE_KEY]);
    globalEnabled = saved.juyaGlobalEnabled === true;
    renderSettings();
    renderMaster();
    await refresh();
    setInterval(refresh, 800);
  } catch (error) { $('status').textContent = '未连接'; fail(error); }
})();
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local' || !changes.juyaGlobalEnabled) return;
  globalEnabled = changes.juyaGlobalEnabled.newValue === true;
  renderMaster();
  void refresh();
});
