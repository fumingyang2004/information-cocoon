const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const api = require('../juya-demo.js');
const fixture = require('./split-timeline-source.json');
const owner = fixture.owner;
const pin = fixture.pinned;
const base = { comment: { text: pin.content.message, rpid: pin.rpid_str, author: owner.name,
  authorMid: String(owner.mid) }, segments: api.parseTimeline(pin.content.message, fixture.duration) };
function parsedReplies(data = pin.replies) {
  return api.replyTimelines(data.map(data => ({ data, source: 'API fixture / same renderer data shape' })),
    owner, pin.rpid_str, fixture.duration, { minRows: 1 });
}
test('real API sample: 18 + 7 = 25; boundary becomes 220–235; final 314–329', () => {
  const replies = parsedReplies();
  const result = api.mergePinnedTimeline(base, replies, fixture.duration, owner);
  assert.equal(base.segments.length, 18);
  assert.equal(replies[0].segments.length, 7);
  assert.equal(result.segments.length, 25);
  assert.equal(result.segments.find(s => s.start === 220).end, 235);
  assert.equal(result.segments.at(-1).start, 314);
  assert.equal(result.segments.at(-1).end, 329);
  assert.equal(result.segments.filter(s => s.keep).length, 14);
  assert.equal(api.skipTarget(result.segments, 235), null);
  assert.equal(api.skipTarget(result.segments, 263).target, 290);
  assert.equal(api.skipTarget(result.segments, 272).target, 290);
  assert.deepEqual(result.comment.parts.map(p => p.rpid), ['317163680496', '317163549488']);
  assert.equal(base.segments.at(-1).end, 329, 'input must not be mutated');
});
test('duplicate representations and identical overlapping timestamps do not duplicate rows', () => {
  const replies = parsedReplies();
  const overlap = { ...replies[0], comment: { ...replies[0].comment, rpid: 'overlap' },
    segments: [base.segments.at(-1), ...replies[0].segments] };
  const result = api.mergePinnedTimeline(base, [overlap, ...replies, ...replies], fixture.duration, owner);
  assert.equal(result.segments.length, 25);
  assert.equal(result.comment.parts.length, 2);
});
test('conflicting titles at the same timestamp stop merging', () => {
  const reply = parsedReplies()[0];
  const bad = { ...reply, segments: [{ ...reply.segments[0], start: 220 }] };
  assert.throws(() => api.mergePinnedTimeline(base, [bad], 329, owner), /时间轴冲突/);
});
test('strict author and parent checks exclude other threads, names, and UIDs', () => {
  const original = pin.replies[0];
  const wrong = [
    { ...original, root_str: 'another-pin' },
    { ...original, mid_str: '999' },
    { ...original, member: { uname: owner.name, mid: '999' } },
    { ...original, member: { uname: '其他人', mid: String(owner.mid) } }
  ];
  assert.equal(parsedReplies(wrong).length, 0);
  assert.equal(api.mergePinnedTimeline(base, [], 329, owner), base);
  const notAuthorPin = { ...base, comment: { ...base.comment, authorMid: '999' } };
  assert.equal(api.mergePinnedTimeline(notAuthorPin, parsedReplies(), 329, owner), notAuthorPin);
});
test('one-row continuation is allowed only in supplement mode; default parser unchanged', () => {
  const data = { ...pin.replies[0], content: { message: '05:14 Anthropic' } };
  assert.throws(() => api.parseTimeline(data.content.message, 329));
  assert.equal(api.replyTimelines([{ data }], owner, pin.rpid_str, 329).length, 0);
  const result = api.mergePinnedTimeline(base, parsedReplies([data]), 329, owner);
  assert.equal(result.segments.length, 19);
  assert.equal(result.segments.at(-2).end, 314);
});

// Use actual core + popup bridge with a simulated DOM/video. This is not a live player test.
function runtime(data, duration, url = 'https://www.bilibili.com/video/BV1kAYS6FEeF/') {
  class Video extends EventTarget {
    currentTime = 0; paused = true; seeking = false; ended = false; isConnected = true;
    currentSrc = 'fixture-video'; duration = duration;
    getClientRects() { return [1]; }
    pause() { this.paused = true; }
    emit(event) { this.dispatchEvent(new Event(event)); }
  }
  const video = new Video();
  const renderer = { __data: data, getRootNode: () => ({}) };
  const document = { title: 'fixture', querySelector: () => null,
    querySelectorAll: selector => selector === 'bili-comment-renderer' ? [renderer]
      : selector === 'video' ? [video] : [] };
  const location = { href: url, pathname: new URL(url).pathname, search: '' };
  const context = vm.createContext({ document, location, Element: class {},
    console: { log() {}, warn() {}, error() {}, table() {} }, setTimeout, clearTimeout,
    __INITIAL_STATE__: { cid: 1, videoData: { owner } } });
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../page-bridge.js'), 'utf8'), context);
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../juya-demo.js'), 'utf8'), context);
  context.JuyaPanel.finishInstall();
  return { context, video };
}

test('the real page script exposes the player readiness check used by the background worker', () => {
  const { context, video } = runtime(pin, 329);
  assert.equal(context.JuyaDemo.findVideo(context.document), video);
  assert.equal(vm.runInContext('!!JuyaDemo?.findVideo(document)', context), true);
});

test('popup start reaches merge branch, displays source, and uses new SKIP interval (simulated video)', async () => {
  const { context, video } = runtime(pin, 329);
  context.JuyaPanel.command('start');
  await new Promise(r => setImmediate(r));
  const state = context.JuyaPanel.snapshot();
  assert.equal(state.active, true, state.lastError);
  assert.equal(state.source, '置顶正文 + 作者回复');
  assert.equal(state.total, 25);
  video.currentTime = 263; video.paused = false; video.emit('timeupdate');
  assert.equal(video.currentTime, 290);
  video.emit('seeked');
  assert.equal(context.JuyaPanel.snapshot().jumps, 1);
  context.JuyaPanel.command('stop');
});
test('switching keywords reclassifies an active timeline without rereading comments or replacing segments', async () => {
  const { context, video } = runtime(pin, 329);
  context.JuyaPanel.command('start');
  await new Promise(r => setImmediate(r));
  const before = context.JuyaDemo.report();
  const segments = before.segments;
  const current = before.segments.find(segment => segment.start === 235);
  assert.equal(current.keep, true);
  context.JuyaPanel.command('keywords', ['Tibo']);
  assert.equal(context.JuyaDemo.report().segments, segments);
  assert.equal(current.keep, false);
  assert.equal(context.JuyaPanel.snapshot().keep, 2);
  video.currentTime = 235; video.paused = false; video.emit('timeupdate');
  assert.equal(video.currentTime, 290);
  video.emit('seeked');
  assert.equal(context.JuyaPanel.snapshot().jumps, 1);
  assert.throws(() => context.JuyaPanel.command('keywords', ['NoSuchStory']), /没有匹配/);
  assert.equal(context.JuyaPanel.snapshot().keep, 2);
  assert.deepEqual(Array.from(context.JuyaDemo.getKeywords()), ['Tibo']);
  context.JuyaPanel.command('stop');
  context.JuyaPanel.command('keywords', ['NoSuchStory']);
  assert.equal(context.JuyaPanel.snapshot().keep, 0);
  await assert.rejects(context.JuyaDemo.start(), /没有任何关键词命中/);
});
test('normal pinned path and ad-pin author-reply fallback retain their prior results', async () => {
  const normal = JSON.parse(fs.readFileSync(path.join(__dirname, '../../regression-live-result.json'), 'utf8'));
  const normalPin = { ...pin, rpid_str: normal.comment.rpid, content: { message: normal.comment.text },
    replies: [], rcount: 0, reply_control: { is_up_top: true, up_reply: false } };
  const first = runtime(normalPin, normal.duration, normal.url);
  await first.context.JuyaDemo.start();
  assert.equal(first.context.JuyaPanel.snapshot().source, '置顶评论');
  assert.deepEqual(JSON.parse(JSON.stringify(first.context.JuyaDemo.report().segments)), normal.segments);
  first.context.JuyaDemo.stop();
  const ad = JSON.parse(fs.readFileSync(path.join(__dirname, '../../fallback-structure.json'), 'utf8'));
  const second = runtime(ad.pinned, ad.duration, ad.url);
  await second.context.JuyaDemo.start();
  assert.equal(second.context.JuyaPanel.snapshot().source, '置顶下的作者回复');
  assert.equal(second.context.JuyaDemo.report().segments.length, 18);
  second.context.JuyaDemo.stop();
});
test('supplement unfolds only the pinned thread and accepts an asynchronously loaded reply', async () => {
  const data = { ...pin, replies: [] };
  let clicks = 0;
  const rendered = [];
  const button = { click() { clicks++; setTimeout(() => rendered.push({ __data: pin.replies[0] }), 10); } };
  const replyHost = { querySelectorAll: s => s === 'bili-comment-reply-renderer' ? rendered : [],
    shadowRoot: { querySelector: () => button, querySelectorAll: () => [] } };
  const renderer = { __data: data, getRootNode: () => ({ host: {
    tagName: 'BILI-COMMENT-THREAD-RENDERER', shadowRoot: { querySelector: () => replyHost }
  } }) };
  const doc = { querySelectorAll: s => s === 'bili-comment-renderer' ? [renderer] : [] };
  const result = await api.readPinnedReplies(doc, [base.comment], 329, owner, () => true, { supplement: true });
  assert.equal(clicks, 1);
  assert.equal(api.mergePinnedTimeline(base, result, 329, owner).segments.length, 25);
  assert.deepEqual(await api.readPinnedReplies(doc, [base.comment], 329, owner, () => false, { supplement: true }), []);
});
