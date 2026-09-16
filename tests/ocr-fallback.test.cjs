const { test } = require('node:test');
const assert = require('node:assert/strict');
const api = require('../juya-demo.js');
const recorded = require('./extension-regression-result.json');

function sample(titles = ['Intro', 'OpenAl', 'StepAudio', 'Claude', '尾声'], confidences = [90, 91, 92, 87, 0]) {
  const segments = titles.map((title, index) => ({ index, start: index * 20, end: (index + 1) * 20 }));
  return { visual: { reliable: true, segments },
    rows: titles.map((title, index) => ({ index, title, confidence: confidences[index] })) };
}

test('OCR variants of selected words are kept, including one-edit and split-token recognition', () => {
  assert.deepEqual(api.matchOcrKeywords('OpenAl', ['OpenAI']).map(match => match.mode), ['fuzzy']);
  assert.deepEqual(api.matchOcrKeywords('Open AI', ['OpenAI']).map(match => match.mode), ['exact']);
  assert.deepEqual(api.matchOcrKeywords('C0dex', ['Codex']).map(match => match.mode), ['fuzzy']);
  assert.deepEqual(api.matchOcrKeywords('Deep Seek', ['DeepSeek']).map(match => match.mode), ['exact']);
  assert.deepEqual(api.matchOcrKeywords('GP1', ['GPT']), []);
});

test('fallback skips only clear unmatched titles and preserves uncertain OCR blocks', () => {
  const result = sample();
  const segments = api.ocrFallbackSegments(result, 100, ['OpenAI', 'Claude']);
  assert.deepEqual(segments.map(segment => segment.keep), [false, true, false, true, true]);
  assert.equal(segments[1].matches[0].mode, 'fuzzy');
  assert.equal(segments[4].reason, 'uncertain-ocr');
  assert.equal(api.skipTarget(segments, 5).target, 20);
  assert.equal(api.skipTarget(segments, 45).target, 60);
  assert.equal(api.skipTarget(segments, 85), null);
});

test('unrecognized or unreliable geometry does not enable automatic skipping', () => {
  assert.throws(() => api.ocrFallbackSegments(sample(['Intro', 'Other'], [90, 90]), 40, ['OpenAI']), /没有识别出任何关注关键词/);
  const result = sample();
  result.visual.reliable = false;
  assert.throws(() => api.ocrFallbackSegments(result, 100, ['OpenAI']), /几何或识别结果不完整/);
  result.visual.reliable = true;
  result.visual.segments[2].start = 41;
  assert.throws(() => api.ocrFallbackSegments(result, 100, ['OpenAI']), /边界不连续/);
});

test('independent visual samples must agree on all chapter boundaries', () => {
  const base = { reliable: true, width: 640, height: 16,
    boundariesPx: [0, 30, 83, 147, 199, 240, 283, 640] };
  assert.equal(api.sameVisualBoundaries(base, { ...base, boundariesPx: [0, 31, 83, 147, 199, 240, 283, 640] }), true);
  assert.equal(api.sameVisualBoundaries(base, { ...base, boundariesPx: [0, 30, 83, 147, 199, 283, 640] }), false);
  assert.equal(api.sameVisualBoundaries(base, { ...base, reliable: false }), false);
});

test('recorded Edge OCR output keeps low-confidence titles and skips only clear nonmatches', () => {
  const rows = recorded.activeOcr.logs.filter(log => log.level === 'table' && log.text.includes('confidence'))
    .map(log => JSON.parse(log.text)).slice(-15);
  const result = { visual: { reliable: true,
    segments: rows.map(row => ({ start: Number(row.start), end: Number(row.end) })) },
  rows: rows.map(row => ({ index: row.block, title: row.title, confidence: Number(row.confidence) })) };
  const segments = api.ocrFallbackSegments(result, 195, api.KEYWORDS);
  assert.equal(segments.filter(segment => !segment.keep).length, 3);
  assert.equal(segments.filter(segment => segment.reason === 'uncertain-ocr').length, 9);
  assert.equal(segments.find(segment => segment.title === 'TypeSafe Codex').keep, true);
});
