/* Isolated content script: watches reloads and Bilibili's in-page navigation. */
(function () {
  'use strict';
  const KEY = 'juyaGlobalEnabled';
  const VIDEO_URL = /^https:\/\/www\.bilibili\.com\/video\/BV[\w]+/i;
  let enabled = false;
  let currentUrl = location.href;
  let status = '';
  let lastCheck = 0;
  let failures = 0;
  let retry = false;
  let busy = false;
  function reset() { status = ''; lastCheck = 0; failures = 0; retry = false; }
  async function check() {
    if (busy || !enabled || !VIDEO_URL.test(location.href)) return;
    if (status === 'unsupported' || status === 'blocked' || (status === 'failed' && failures >= 3)) return;
    if (status === 'active' && Date.now() - lastCheck < 10000) return;
    busy = true;
    try {
      const response = await chrome.runtime.sendMessage({ type: 'ensure', retry });
      if (!response?.ok) return;
      status = response.status;
      lastCheck = Date.now();
      if (status === 'failed') { failures++; retry = true; }
      else retry = false;
      if (status === 'active') failures = 0;
    } catch { /* The extension may be reloading. */ }
    finally { busy = false; }
  }
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local') return;
    if (changes[KEY]) {
      enabled = changes[KEY].newValue === true;
      reset();
      if (!enabled) void chrome.runtime.sendMessage({ type: 'stopTab' }).catch(() => {});
      else void check();
    }
    if (changes.juyaKeywordSettings && enabled) { reset(); void check(); }
  });
  setInterval(() => {
    if (location.href !== currentUrl) {
      currentUrl = location.href;
      reset();
      if (enabled && !VIDEO_URL.test(currentUrl)) {
        void chrome.runtime.sendMessage({ type: 'stopTab' }).catch(() => {});
      }
    }
    void check();
  }, 3000);
  chrome.storage.local.get(KEY).then(value => {
    enabled = value[KEY] === true;
    void check();
  });
})();
