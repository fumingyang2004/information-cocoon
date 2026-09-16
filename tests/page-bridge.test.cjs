const { test } = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const source = fs.readFileSync(require('node:path').join(__dirname, '../page-bridge.js'), 'utf8');
const flush = () => new Promise(resolve => setImmediate(resolve));
function fixture(active = false) {
  let release;
  let starts = 0;
  const sample = new Promise(resolve => { release = resolve; });
  const report = { url: 'https://www.bilibili.com/video/BVtest/', active,
    comment: {}, segments: [{ start: 0, end: 40, keep: true, title: 'OpenAI' }], events: [] };
  const demo = {
    report: () => report,
    stop() { report.active = false; },
    async start() { starts++; report.active = true; },
    visualExperimentStable: () => sample,
    async ocrExperiment() {
      return { rows: [{ keepCandidate: true }], elapsedMs: 123, experimentalSegments: [{ title: 'DO NOT APPLY', keep: true }] };
    }
  };
  const context = vm.createContext({ console: { log() {}, warn() {}, error() {}, table() {} },
    location: { href: report.url, pathname: '/video/BVtest/', search: '' }, document: { title: 'test' },
    __INITIAL_STATE__: { videoData: { owner: { name: '橘鸦Juya', mid: 285286947 }, cid: 1 } },
    JuyaDemo: demo, Element: class {}, Error });
  vm.runInContext(source, context);
  context.JuyaPanel.finishInstall();
  return { panel: context.JuyaPanel, report, release, starts: () => starts, context };
}
test('opening is inert; disabled OCR cannot run', () => {
  const f = fixture();
  f.panel.command('ocr');
  assert.equal(f.starts(), 0);
  assert.equal(f.panel.snapshot().ocrRunning, false);
  assert.equal(f.report.active, false);
});
test('OCR alone restores inactive mode and never installs candidates', async () => {
  const f = fixture();
  f.panel.command('allowOcr', true);
  f.panel.command('ocr');
  f.release({}); await flush();
  assert.equal(f.starts(), 0);
  assert.equal(f.report.active, false);
  assert.equal(f.report.segments[0].title, 'OpenAI');
  assert.equal(f.panel.snapshot().ocrSummary.attachSafe, false);
});
test('OCR sampling restores previously active production automation', async () => {
  const f = fixture(true);
  f.panel.command('allowOcr', true);
  f.panel.command('ocr');
  assert.equal(f.report.active, false);
  f.release({}); await flush();
  assert.equal(f.starts(), 1);
  assert.equal(f.report.active, true);
  assert.equal(f.report.segments[0].title, 'OpenAI');
});
test('Stop during frame sampling prevents automatic restart', async () => {
  const f = fixture(true);
  f.panel.command('allowOcr', true);
  f.panel.command('ocr');
  f.panel.command('stop');
  f.release({}); await flush();
  assert.equal(f.starts(), 0);
  assert.equal(f.report.active, false);
});
test('video change discards OCR result and does not restart old automation', async () => {
  const f = fixture(true);
  f.panel.command('allowOcr', true);
  f.panel.command('ocr');
  f.context.location.pathname = '/video/BVother/';
  f.panel.snapshot();
  f.release({}); await flush();
  assert.equal(f.starts(), 0);
  assert.equal(f.panel.snapshot().ocrSummary, null);
});
