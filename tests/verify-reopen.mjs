import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { connect } from './cdp.mjs';
const browser = await connect();
const page = await connect('bilibili.com/video');
let popup;
const pause = ms => new Promise(r => setTimeout(r, ms));
const evidence = { at: new Date().toISOString() };
async function reopen() {
  const { targetInfos } = await browser.call('Target.getTargets', { filter: [{}] });
  const old = targetInfos.find(t => t.url.endsWith('/popup.html'));
  if (old) await browser.call('Target.closeTarget', { targetId: old.targetId });
  const tab = targetInfos.find(t => t.type === 'tab' && t.url.includes('bilibili.com/video'));
  await browser.call('Extensions.triggerAction', { id: 'jaggklanaokdohcjmcjcklfkkiodphkk', targetId: tab.targetId });
  await pause(1200);
  return connect('popup.html');
}
async function until(expression) {
  for (let i = 0; i < 100; i++) {
    const value = await page.evaluate(expression);
    if (value) return value;
    await pause(300);
  }
  throw new Error(`Timeout: ${expression}`);
}
try {
  const before = await page.evaluate('JuyaPanel.snapshot()');
  popup = await reopen();
  const after = await page.evaluate('JuyaPanel.snapshot()');
  assert.equal(after.logs.length, before.logs.length);
  assert.deepEqual(after.ocrSummary, before.ocrSummary);
  evidence.reopenPreservesLogsAndOcr = true;
  await popup.evaluate(`document.getElementById('start').click()`);
  await until('JuyaPanel.snapshot().active');
  await pause(1000); // Let the popup render the completed start before clicking.
  await popup.evaluate(`document.getElementById('ocr-run').click()`);
  await until('JuyaPanel.snapshot().ocrRunning');
  evidence.activeOcr = await until('!JuyaPanel.snapshot().ocrRunning && JuyaPanel.snapshot()');
  assert.ok(evidence.activeOcr.active);
  assert.ok(evidence.activeOcr.ocrSummary);
  assert.equal(evidence.activeOcr.total, 14);
  await pause(1000);
  const shot = await popup.call('Page.captureScreenshot', { format: 'png' });
  await writeFile(new URL('./popup-live.png', import.meta.url), Buffer.from(shot.data, 'base64'));
  console.log('Active OCR and reopen passed');
  popup.close();
  await page.call('Page.navigate', { url: 'https://www.bilibili.com/video/BV1eh3k6GERM/' });
  await until(`window.__INITIAL_STATE__?.bvid === 'BV1eh3k6GERM' && document.querySelector('video')?.readyState >= 2`);
  await page.evaluate(`document.querySelector('video').pause()`);
  popup = await reopen();
  await popup.evaluate(`document.getElementById('start').click()`);
  evidence.reply = await until('window.JuyaPanel?.snapshot().active && JuyaPanel.snapshot()');
  assert.equal(evidence.reply.source, '置顶下的作者回复');
  await page.evaluate('JuyaDemo.testSkip()');
  evidence.replySeek = await until(`JuyaDemo.report().events.find(e => e.type === 'SEEK_CONFIRMED')`);
  assert.equal(evidence.replySeek.target, 109);
  await popup.evaluate(`document.getElementById('stop').click()`);
  await page.evaluate(`document.querySelector('video').pause()`);
  console.log('Reply sample passed', evidence.replySeek);
} catch (error) { evidence.error = error.message; console.error(error); process.exitCode = 1; }
finally {
  await writeFile(new URL('./extension-regression-result.json', import.meta.url), JSON.stringify(evidence, null, 2));
  popup?.close(); page.close(); browser.close();
}
