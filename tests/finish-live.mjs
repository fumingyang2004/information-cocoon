import { connect } from './cdp.mjs';
import { writeFile, readFile } from 'node:fs/promises';
import assert from 'node:assert/strict';
const browser = await connect();
const page = await connect('bilibili.com/video');
let popup = await connect('popup.html');
const pause = ms => new Promise(r => setTimeout(r, ms));
try {
  const { targetInfos } = await browser.call('Target.getTargets', { filter: [{}] });
  const target = targetInfos.find(t => t.type === 'page' && t.url.includes('bilibili.com/video'));
  const { windowId } = await browser.call('Browser.getWindowForTarget', { targetId: target.targetId });
  await browser.call('Browser.setWindowBounds', { windowId, bounds: { width: 1280, height: 1000 } });
  await page.evaluate(`document.querySelector('bili-comments, #commentapp, #comment')?.scrollIntoView()`);
  await pause(3000);
  await popup.call('Page.reload');
  await pause(1500);
  await popup.evaluate(`document.getElementById('start').click()`);
  for (let i = 0; i < 80; i++) {
    if (await page.evaluate('JuyaPanel.snapshot().active')) break;
    await pause(500);
  }
  const state = await page.evaluate('JuyaPanel.snapshot()');
  assert.ok(state.active, state.lastError);
  assert.equal(state.source, '置顶下的作者回复');
  await page.evaluate('JuyaDemo.testSkip()');
  let seek;
  for (let i = 0; i < 80; i++) {
    seek = await page.evaluate(`JuyaDemo.report().events.find(e=>e.type==='SEEK_CONFIRMED')`);
    if (seek) break;
    await pause(300);
  }
  assert.equal(seek.target, 109);
  await page.evaluate(`document.querySelector('video').pause()`);
  await pause(1200);
  const screenshot = await popup.call('Page.captureScreenshot', { format: 'png' });
  await writeFile(new URL('./popup-live.png', import.meta.url), Buffer.from(screenshot.data, 'base64'));
  const path = new URL('./extension-regression-result.json', import.meta.url);
  const result = JSON.parse(await readFile(path, 'utf8'));
  result.initialReplyAttempt = result.error;
  delete result.error;
  result.reply = state; result.replySeek = seek;
  result.note = 'Reply video required scrolling to the comments after initial lazy-loading timeout, then retrying Start. Core reader unchanged.';
  await writeFile(path, JSON.stringify(result, null, 2));
  console.log({ source: state.source, total: state.total, seek });
} finally { popup.close(); page.close(); browser.close(); }
