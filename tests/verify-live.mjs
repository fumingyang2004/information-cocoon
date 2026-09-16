import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { connect } from './cdp.mjs';
const popup = await connect('popup.html');
const page = await connect('bilibili.com/video');
const evidence = { at: new Date().toISOString(), browser: 'Edge headless, unpacked extension, actual action popup' };
const wait = async (expression, limit = 30000) => {
  const end = Date.now() + limit;
  while (Date.now() < end) {
    const value = await page.evaluate(expression);
    if (value) return value;
    await new Promise(r => setTimeout(r, 300));
  }
  throw new Error(`Timed out: ${expression}`);
};
try {
  evidence.initial = await page.evaluate('JuyaPanel.snapshot()');
  assert.equal(evidence.initial.active, false);
  assert.equal(evidence.initial.ocrAllowed, false);
  await page.evaluate(`document.querySelector('video').pause()`);
  await popup.evaluate(`document.getElementById('start').click()`);
  evidence.started = await wait('JuyaPanel.snapshot().active && JuyaPanel.snapshot()');
  console.log('START', { total: evidence.started.total, keep: evidence.started.keep, source: evidence.started.source });
  assert.equal(evidence.started.total, 14);
  await page.evaluate('JuyaDemo.testSkip()');
  evidence.seek = await wait(`JuyaDemo.report().events.find(e => e.type === 'SEEK_CONFIRMED')`);
  console.log('REAL SEEK', evidence.seek);
  assert.equal(evidence.seek.target, 72);
  await page.evaluate(`document.querySelector('video').pause()`);
  await popup.evaluate(`document.getElementById('stop').click()`);
  await wait('!JuyaPanel.snapshot().active');
  // A readable frame for the user's existing visual/OCR experiment.
  await page.evaluate(`(async()=>{ const v=document.querySelector('video'); v.currentTime=80; await new Promise(r=>v.addEventListener('seeked',r,{once:true})); })()`);
  evidence.beforeOcr = await page.evaluate(`({time:document.querySelector('video').currentTime,segments:JuyaDemo.report().segments})`);
  await popup.evaluate(`document.getElementById('ocr-enabled').click()`);
  await new Promise(r => setTimeout(r, 300));
  await popup.evaluate(`document.getElementById('ocr-run').click()`);
  await wait('JuyaPanel.snapshot().ocrRunning');
  console.log('OCR started');
  evidence.ocr = await wait(`!JuyaPanel.snapshot().ocrRunning && JuyaPanel.snapshot()`, 180000);
  evidence.afterOcr = await page.evaluate(`({time:document.querySelector('video').currentTime,segments:JuyaDemo.report().segments})`);
  assert.equal(evidence.ocr.active, false);
  assert.deepEqual(evidence.afterOcr.segments, evidence.beforeOcr.segments);
  assert.ok(Math.abs(evidence.afterOcr.time - evidence.beforeOcr.time) < 0.1);
  console.log('OCR', { result: evidence.ocr.ocrSummary, error: evidence.ocr.lastError });
  await new Promise(r => setTimeout(r, 1000));
  const shot = await popup.call('Page.captureScreenshot', { format: 'png' });
  await writeFile(new URL('./popup-live.png', import.meta.url), Buffer.from(shot.data, 'base64'));
  assert.ok(evidence.ocr.ocrSummary, evidence.ocr.lastError);
  assert.equal(evidence.ocr.ocrSummary.attachSafe, false);
} catch (error) { evidence.error = error.message; process.exitCode = 1; console.error(error); }
finally {
  await writeFile(new URL('./extension-live-result.json', import.meta.url), JSON.stringify(evidence, null, 2));
  popup.close(); page.close();
}
