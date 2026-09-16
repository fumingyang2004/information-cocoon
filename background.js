/* The persisted master switch owns automatic startup across tabs and reloads. */
importScripts('keyword-config.js');
const SWITCH_KEY = 'juyaGlobalEnabled';
const VERSION = '0.4.0';
const VIDEO_URL = /^https:\/\/www\.bilibili\.com\/video\/BV[\w]+/i;
const inFlight = new Map();

async function pageCall(tabId, method, ...args) {
  const result = await chrome.scripting.executeScript({ target: { tabId }, world: 'MAIN',
    func: (name, params) => window.JuyaPanel?.[name]?.(...params) ?? null,
    args: [method, args] });
  return result[0]?.result ?? null;
}
async function pageProbe(tabId) {
  const result = await chrome.scripting.executeScript({ target: { tabId }, world: 'MAIN', func: () => {
    const owner = window.__INITIAL_STATE__?.videoData?.owner;
    return { ownerKnown: !!owner, supported: owner?.name === '橘鸦Juya' && String(owner.mid) === '285286947',
      url: location.href };
  } });
  return result[0]?.result;
}
async function videoReady(tabId) {
  const result = await chrome.scripting.executeScript({ target: { tabId }, world: 'MAIN', func: () => {
    try { return !!window.JuyaDemo?.findVideo(document); } catch { return false; }
  } });
  return !!result[0]?.result;
}
async function stopTab(tabId) {
  try { await pageCall(tabId, 'command', 'stop'); } catch { /* The page may be navigating. */ }
}
async function ensureTab(tabId, retry = false) {
  if (inFlight.has(tabId)) return inFlight.get(tabId);
  const job = (async () => {
    try {
      const stored = await chrome.storage.local.get([SWITCH_KEY, JuyaKeywordConfig.STORAGE_KEY]);
      if (!stored[SWITCH_KEY]) return { status: 'off' };
      const tab = await chrome.tabs.get(tabId);
      if (!VIDEO_URL.test(tab.url || '')) return { status: 'unsupported' };
      // snapshot() clears the previous controller when Bilibili changes videos in-place.
      let state = await pageCall(tabId, 'snapshot');
      const probe = await pageProbe(tabId);
      if (!probe?.ownerKnown) return { status: 'waiting' };
      if (!probe.supported) return { status: 'unsupported' };
      if (state?.version !== VERSION || !state.ready) {
        await chrome.scripting.executeScript({ target: { tabId }, world: 'MAIN',
          files: ['page-bridge.js', 'juya-demo.js'] });
        state = await pageCall(tabId, 'finishInstall');
      }
      if (!state || state.url !== probe.url) return { status: 'waiting' };
      if (state.starting || state.sampling || state.ocrRunning) return { status: 'starting' };
      const settings = JuyaKeywordConfig.restore(stored[JuyaKeywordConfig.STORAGE_KEY]);
      const words = JuyaKeywordConfig.selected(settings).keywords;
      if (JSON.stringify(state.keywords) !== JSON.stringify(words)) {
        try { state = await pageCall(tabId, 'command', 'keywords', words); }
        catch {
          // Never keep a different keyword set running in another open tab.
          await stopTab(tabId);
          state = await pageCall(tabId, 'command', 'keywords', words);
        }
      }
      if (state.active) return { status: 'active' };
      if (state.lastError && !retry) {
        const transient = /未识别到置顶评论|视频总时长尚未就绪|已加载的 video|播放器/.test(state.lastError);
        return { status: transient ? 'failed' : 'blocked', error: state.lastError };
      }
      if (!await videoReady(tabId)) return { status: 'waiting' };
      if (!(await chrome.storage.local.get(SWITCH_KEY))[SWITCH_KEY]) return { status: 'off' };
      state = await pageCall(tabId, 'command', 'start');
      return { status: state?.active ? 'active' : 'starting' };
    } catch (error) { return { status: 'waiting', error: error.message }; }
  })();
  inFlight.set(tabId, job);
  try { return await job; } finally { inFlight.delete(tabId); }
}
async function syncTabs(enabled) {
  const tabs = await chrome.tabs.query({ url: 'https://www.bilibili.com/*' });
  await Promise.all(tabs.map(tab => enabled ? ensureTab(tab.id) : stopTab(tab.id)));
}
async function handle(message, sender) {
  if (message?.type === 'setEnabled') {
    const enabled = message.enabled === true;
    await chrome.storage.local.set({ [SWITCH_KEY]: enabled });
    await syncTabs(enabled);
    return { ok: true, enabled };
  }
  if (message?.type === 'ensure' && sender.tab?.id !== undefined) {
    return { ok: true, ...(await ensureTab(sender.tab.id, message.retry === true)) };
  }
  if (message?.type === 'stopTab' && sender.tab?.id !== undefined) {
    await stopTab(sender.tab.id);
    return { ok: true };
  }
  return { ok: false, error: '未知操作' };
}
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  handle(message, sender).then(sendResponse, error => sendResponse({ ok: false, error: error.message }));
  return true;
});
chrome.runtime.onInstalled.addListener(() => {
  chrome.storage.local.get(SWITCH_KEY).then(value => { if (value[SWITCH_KEY]) return syncTabs(true); });
});
chrome.runtime.onStartup.addListener(() => {
  chrome.storage.local.get(SWITCH_KEY).then(value => { if (value[SWITCH_KEY]) return syncTabs(true); });
});
chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if ((changeInfo.status === 'complete' || changeInfo.url) && VIDEO_URL.test(tab.url || '')) {
    void ensureTab(tabId);
  }
});
chrome.webNavigation.onHistoryStateUpdated.addListener(details => {
  if (details.frameId === 0 && VIDEO_URL.test(details.url)) void ensureTab(details.tabId);
}, { url: [{ hostEquals: 'www.bilibili.com' }] });
