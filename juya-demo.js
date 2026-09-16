/* Paste this entire file into the Edge console on a Bilibili video page. */
(function (root) {
  'use strict';
  // The popup supplies a scoped logger; ordinary console injection still works.
  const console = root.__JUYA_DEMO_LOGGER__ || root.console;
  const KEYWORDS = ['OpenAI', 'GPT', 'Codex', 'Claude', 'Anthropic', 'DeepSeek'];
  let activeKeywords = [...KEYWORDS];
  const TAG = '[JuyaDemo]';
  const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
  const clock = () => root.performance?.now?.() ?? Date.now();
  function withTimeout(promise, timeoutMs, label, onLateResolve) {
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) return Promise.resolve(promise);
    let timer;
    let timedOut = false;
    const source = Promise.resolve(promise).then(value => {
      if (timedOut && onLateResolve) Promise.resolve(onLateResolve(value)).catch(() => {});
      return value;
    });
    const deadline = new Promise((resolve, reject) => {
      timer = setTimeout(() => {
        timedOut = true;
        reject(new Error(`${label}超时（${Math.round(timeoutMs / 1000)} 秒）`));
      }, timeoutMs);
    });
    return Promise.race([source, deadline]).finally(() => clearTimeout(timer));
  }
  // Measured on Juya's 16:9 AI-news layout. Values are normalized so the same
  // crop works for the 1280x720 stream used in the experiment and a 4K stream.
  const VISUAL_NAV = Object.freeze({
    roi: Object.freeze({ x: 0, y: 688 / 720, width: 1, height: 32 / 720 }),
    // The first rows contain the separators but not the title glyphs.
    sampleTop: 0,
    sampleBottom: 6 / 32,
    minEdgeScore: 12,
    coverageEdgeScore: 6,
    minVerticalCoverage: 0.7,
    mergeGapPx: 3,
    playheadTolerancePx: 4,
    // Juya's final "再见" block is intentionally only about 2-3 seconds.
    minBlockDuration: 1
  });
  const OCR_EXPERIMENT = Object.freeze({
    // Pin the experiment so a future CDN release cannot silently change behavior.
    scriptUrl: 'https://cdn.jsdelivr.net/npm/tesseract.js@7.0.0/dist/tesseract.min.js',
    language: 'eng',
    targetTextHeightPx: 260,
    paddingXPx: 30,
    paddingYPx: 40,
    // Measured against the 32px-high 720p navigation strip.
    trimX: 2 / 32,
    trimTop: 1 / 32,
    trimBottom: 5 / 32,
    fuzzyMinKeywordLength: 5,
    fuzzyMaxDistance: 1
  });
  const STARTUP_TIMING = Object.freeze({
    commentWaitMs: 15000,
    commentRecheckMs: 5000,
    commentRecheckSettleMs: root.__JUYA_COMMENT_RECHECK_SETTLE_MS__ ?? 1000,
    commentPollMs: 250,
    replyAttempts: 24,
    replyRecheckAttempts: 10,
    replyPollMs: 500,
    workerInitTimeoutMs: 45000,
    workerJobTimeoutMs: 15000,
    workerTerminateTimeoutMs: 5000,
    ocrTotalTimeoutMs: 90000
  });

  function parseTimeline(text, duration, { minRows = 2 } = {}) {
    if (!Number.isFinite(duration) || duration <= 0) throw new Error('视频总时长尚未就绪');
    const rows = [];
    // Only line-leading timestamps: link URLs and times inside titles are not chapters.
    for (const line of text.normalize('NFKC').split(/\r?\n/)) {
      const match = line.match(/^\s*(?:[-•●▪⬛]\s*)?[\[【(]?((?:\d{1,3}:)?\d{1,3}:\d{2})[\]】)]?\s*(?:[-—|:：]\s*)?(.+?)\s*$/u);
      if (!match) continue;
      const parts = match[1].split(':').map(Number);
      if (parts.at(-1) >= 60 || (parts.length === 3 && parts[1] >= 60)) {
        throw new Error(`非法时间戳: ${match[1]}`);
      }
      const start = parts.reduce((n, p) => n * 60 + p, 0);
      if (start >= duration) throw new Error(`时间戳超出视频总时长: ${match[1]}`);
      if (rows.length && start <= rows.at(-1).start) throw new Error('时间轴存在重复或倒序时间戳，停止自动跳段');
      const title = match[2].trim();
      const keywords = activeKeywords.filter(word => title.toLowerCase().includes(word.toLowerCase()));
      rows.push({ start, title, keep: keywords.length > 0, keywords });
    }
    if (rows.length < minRows) throw new Error(`评论中未找到至少 ${minRows} 个行首时间戳`);
    return rows.map((row, i) => ({ ...row, end: rows[i + 1]?.start ?? duration }));
  }

  function skipTarget(segments, time) {
    const i = segments.findIndex(s => time >= s.start && time < s.end);
    if (i < 0 || segments[i].keep) return null;
    const next = segments.slice(i + 1).find(s => s.keep);
    return { segment: segments[i], target: next?.start ?? segments.at(-1).end, terminal: !next };
  }

  // Traverse open Shadow DOM; normal querySelector does not cross these boundaries.
  function deepAll(scope, selector) {
    const found = [...scope.querySelectorAll(selector)];
    if (scope.shadowRoot) found.push(...deepAll(scope.shadowRoot, selector));
    for (const element of scope.querySelectorAll('*')) {
      if (element.shadowRoot) found.push(...deepAll(element.shadowRoot, selector));
    }
    return [...new Set(found)];
  }

  function domText(node) {
    if (node.nodeType === 3) return node.textContent;
    if (node.nodeType === 1 && /^(STYLE|SCRIPT)$/.test(node.tagName)) return '';
    if (node.nodeType === 1 && node.tagName === 'BR') return '\n';
    const source = node.shadowRoot || node;
    const text = [...source.childNodes].map(domText).join('');
    return node.nodeType === 1 && /^(P|DIV|LI)$/.test(node.tagName) ? `${text}\n` : text;
  }

  function pinnedCandidates(doc) {
    const modern = deepAll(doc, 'bili-comment-renderer');
    const legacy = [...doc.querySelectorAll('.reply-item, .list-item.reply-wrap')];
    return [...modern, ...legacy].filter(el => {
      const data = el.__data;
      const control = data?.reply_control;
      if (control?.is_up_top === true || control?.is_up_top === 1 || data?.is_top === 1) return true;
      // A badge must be outside the comment body; quoting “置顶” is not a pin.
      return deepAll(el, '#top, #top-tag, .top-icon, .reply-top, .stick, [class*="top-tag"]').some(badge => {
        return /^(置顶|UP主置顶)$/.test(badge.textContent.trim());
      });
    });
  }

  function pinnedReadiness(el) {
    const dataText = typeof el.__data?.content?.message === 'string'
      ? el.__data.content.message.trim() : '';
    // Modern renderers expose the complete text in __data; avoid traversing a shell
    // until that data is absent (also keeps legacy/test objects safe).
    const body = !dataText && typeof el.querySelectorAll === 'function'
      ? deepAll(el, 'bili-rich-text, .reply-content, .text').find(Boolean) : null;
    const bodyText = body ? domText(body).trim() : '';
    return { ready: !!(dataText || bodyText), dataLength: dataText.length,
      bodyLength: bodyText.length, hasData: !!el.__data, hasBody: !!body };
  }

  async function readPinned(doc, options = {}) {
    const timeoutMs = options.timeoutMs ?? STARTUP_TIMING.commentWaitMs;
    const minimumWaitMs = Math.min(timeoutMs, options.minimumWaitMs ?? 0);
    const pollMs = options.pollMs ?? STARTUP_TIMING.commentPollMs;
    const valid = options.valid ?? (() => true);
    const reason = options.reason ?? 'initial';
    const startedAt = Date.now();
    const area = doc.querySelector('bili-comments, #commentapp, #comment');
    const view = doc.defaultView;
    const position = view && { left: view.scrollX, top: view.scrollY, url: view.location.href };
    let userInteracted = false;
    const onInput = () => { userInteracted = true; };
    const inputs = ['wheel', 'touchmove', 'pointerdown', 'keydown'];
    let candidates = pinnedCandidates(doc);
    let states = candidates.map(pinnedReadiness);
    let lastSignature = '';
    console.log(TAG, '评论读取开始', { reason, timeoutMs, minimumWaitMs, commentHost: !!area,
      readyState: doc.readyState, url: view?.location?.href ?? '' });
    try {
      for (const name of inputs) view?.addEventListener(name, onInput, { passive: true });
      // Trigger lazy rendering only while actual comment text is unavailable.
      if (!states.some(state => state.ready)) {
        area?.scrollIntoView({ block: 'center', behavior: 'instant' });
      }
      while (valid()) {
        candidates = pinnedCandidates(doc);
        states = candidates.map(pinnedReadiness);
        const signature = JSON.stringify({ candidates: candidates.length,
          ready: states.filter(state => state.ready).length,
          data: states.filter(state => state.hasData).length,
          bodies: states.filter(state => state.hasBody).length });
        if (signature !== lastSignature) {
          lastSignature = signature;
          console.log(TAG, '评论加载状态', { reason, elapsedMs: Date.now() - startedAt,
            ...JSON.parse(signature) });
        }
        // A renderer shell or pin badge is not enough: wait for actual data/text hydration.
        if (states.some(state => state.ready) && Date.now() - startedAt >= minimumWaitMs) break;
        if (Date.now() - startedAt >= timeoutMs) break;
        await sleep(Math.min(pollMs, Math.max(1, timeoutMs - (Date.now() - startedAt))));
      }
    } finally {
      for (const name of inputs) view?.removeEventListener(name, onInput);
      // Do not pull the user back if they interacted or navigated while loading.
      if (area && position && !userInteracted && view.location.href === position.url) {
        view.scrollTo({ left: position.left, top: position.top, behavior: 'instant' });
      }
    }
    if (!valid()) {
      console.warn(TAG, '评论读取已取消', { reason, elapsedMs: Date.now() - startedAt });
      return [];
    }
    if (!candidates.length || !states.some(state => state.ready)) {
      console.warn(TAG, '评论读取超时', { reason, elapsedMs: Date.now() - startedAt,
        candidates: candidates.length, states });
      throw new Error('未识别到置顶评论正文。评论节点可能尚未完成加载；请稍后重试');
    }
    const results = [];
    for (const el of candidates) {
      const data = el.__data;
      if (typeof data?.content?.message === 'string' && data.content.message.trim()) {
        results.push({ text: data.content.message, source: 'pinned renderer.__data.content.message',
          rpid: String(data.rpid_str ?? data.rpid ?? ''), author: data.member?.uname ?? '',
          authorMid: String(data.member?.mid ?? ''),
          completeness: '页面评论数据原文，不受折叠显示影响' });
        continue;
      }
      const body = deepAll(el, 'bili-rich-text, .reply-content, .text').find(Boolean);
      if (!body) continue;
      const expanded = new Set();
      for (let attempt = 0; attempt < 5; attempt++) {
        const button = deepAll(el, 'button, bili-text-button, #view-more, #expand, .view-more, .btn-more')
          .find(b => /^(展开|展开全文|展开更多|查看更多)$/.test(domText(b).trim()) && !expanded.has(b));
        if (!button) break;
        expanded.add(button);
        button.click();
        await sleep(350);
      }
      const stillCollapsed = deepAll(el, 'button, bili-text-button, #view-more, #expand, .view-more, .btn-more')
        .some(b => /^(展开|展开全文|展开更多|查看更多)$/.test(domText(b).trim()) && b.getClientRects().length);
      if (stillCollapsed) throw new Error('置顶评论仍有展开按钮，无法确认全文；请手动展开后重试');
      results.push({ text: domText(body).trim(), source: 'pinned expanded DOM',
        rpid: el.getAttribute('data-id') || '', author: '', completeness: 'DOM 提取，请核对控制台全文与最后一条资讯' });
    }
    if (!results.length) throw new Error('未识别到置顶评论正文。置顶节点存在，但数据尚未完成加载');
    console.log(TAG, '评论读取完成', { reason, elapsedMs: Date.now() - startedAt,
      candidates: candidates.length, results: results.length,
      sources: results.map(result => result.source), textLengths: results.map(result => result.text.length) });
    return results;
  }

  function juyaOwner(state) {
    const owner = state?.videoData?.owner;
    if (owner?.name !== '橘鸦Juya' || String(owner.mid) !== '285286947') {
      throw new Error('当前视频 UP 主不是橘鸦Juya，停止');
    }
    return owner;
  }

  function replyTimelines(entries, owner, pinnedRpid, duration, options = {}) {
    const found = new Map();
    for (const { data, source } of entries) {
      const rpid = String(data?.rpid_str ?? data?.rpid ?? '');
      const rootRpid = String(data?.root_str ?? data?.root ?? '');
      if (!rpid || rootRpid !== pinnedRpid || data?.member?.uname !== '橘鸦Juya'
        || String(data.member.mid) !== String(owner.mid)
        || String(data.mid_str ?? data.mid) !== String(owner.mid)
        || typeof data.content?.message !== 'string') continue;
      try {
        const segments = parseTimeline(data.content.message, duration, options);
        if (!found.has(rpid)) found.set(rpid, {
          comment: { text: data.content.message, source, rpid, rootRpid,
            parentRpid: String(data.parent_str ?? data.parent ?? ''),
            author: data.member.uname, authorMid: String(owner.mid),
            completeness: '置顶评论下 UP 主回复的数据原文，不受折叠显示影响' },
          segments
        });
      } catch { /* A non-timeline reply is not a source. */ }
    }
    return [...found.values()];
  }

  // Keep every row's original classification, but rebuild ends across comment boundaries.
  function mergePinnedTimeline(base, replies, duration, owner) {
    if (base.comment.author !== owner.name || base.comment.authorMid !== String(owner.mid)) return base;
    const rows = new Map(base.segments.map(segment => [segment.start, segment]));
    const parts = [base.comment];
    const ids = new Set();
    const normalizedTitle = title => title.normalize('NFKC').replace(/\s+/g, ' ').trim().toLowerCase();
    for (const reply of replies) {
      const comment = reply.comment;
      if (comment.rootRpid !== base.comment.rpid || comment.author !== owner.name
        || comment.authorMid !== String(owner.mid) || ids.has(comment.rpid)) continue;
      ids.add(comment.rpid);
      let added = false;
      for (const segment of reply.segments) {
        const previous = rows.get(segment.start);
        if (previous && normalizedTitle(previous.title) !== normalizedTitle(segment.title)) {
          throw new Error(`时间轴冲突：${segment.start} 秒在置顶/作者回复中有不同标题，停止自动跳段`);
        }
        if (!previous) { rows.set(segment.start, segment); added = true; }
      }
      if (added) parts.push(comment);
    }
    if (parts.length === 1) return base;
    const ordered = [...rows.values()].sort((a, b) => a.start - b.start);
    return {
      comment: { ...base.comment, source: 'pinned + author replies', sourceKind: 'pinned-with-replies',
        text: parts.map(part => part.text).join('\n'), parts,
        completeness: '置顶正文及同一线程作者回复的原文，按时间戳去重合并' },
      segments: ordered.map((segment, i) => ({ ...segment, end: ordered[i + 1]?.start ?? duration }))
    };
  }

  async function readPinnedReplies(doc, pinned, duration, owner, valid = () => true, options = {}) {
    const supplement = options.supplement ?? false;
    const maxAttempts = options.maxAttempts ?? STARTUP_TIMING.replyAttempts;
    const pollMs = options.pollMs ?? STARTUP_TIMING.replyPollMs;
    const reason = options.reason ?? (supplement ? 'supplement' : 'fallback');
    const startedAt = Date.now();
    const clicked = new WeakSet();
    let lastSignature = '';
    console.log(TAG, '作者回复读取开始', { reason, supplement, maxAttempts,
      pinnedRpids: pinned.map(comment => comment.rpid).filter(Boolean) });
    for (let attempt = 0; attempt < maxAttempts && valid(); attempt++) {
      const found = [];
      const expanders = [];
      let possibleReplies = false;
      let knownEmpty = true;
      let matchedThreads = 0;
      for (const renderer of pinnedCandidates(doc)) {
        const data = renderer.__data;
        const rpid = String(data?.rpid_str ?? data?.rpid ?? '');
        if (!rpid || !pinned.some(comment => comment.rpid === rpid)) continue;
        matchedThreads++;
        const thread = renderer.getRootNode().host;
        const replies = thread?.tagName === 'BILI-COMMENT-THREAD-RENDERER'
          ? thread.shadowRoot.querySelector('bili-comment-replies-renderer') : null;
        const entries = (data.replies || []).map(reply => ({ data: reply, source: 'pinned.__data.replies[].content.message' }));
        if (replies) {
          entries.push(...deepAll(replies, 'bili-comment-reply-renderer').map(reply => ({
            data: reply.__data, source: 'pinned reply renderer.__data.content.message'
          })));
          const button = replies.shadowRoot?.querySelector('#view-more bili-text-button');
          if (button && !clicked.has(replies)
            && (!supplement || data.reply_control?.up_reply !== false)) expanders.push({ replies, button });
        }
        // A continuation may contain just one item; the original reply-only fallback still needs two.
        found.push(...replyTimelines(entries, owner, rpid, duration, { minRows: supplement ? 1 : 2 }));
        const count = Number(data.rcount ?? data.count);
        if (count !== 0 || entries.length) knownEmpty = false;
        const loaded = new Set(entries.map(entry => String(entry.data?.rpid_str ?? entry.data?.rpid ?? ''))).size;
        if (data.reply_control?.up_reply !== false && (!Number.isFinite(count) || loaded < count)) {
          possibleReplies = true;
        }
      }
      const signature = JSON.stringify({ attempt: attempt + 1, matchedThreads,
        found: found.length, expanders: expanders.length, possibleReplies, knownEmpty });
      if (signature !== lastSignature) {
        lastSignature = signature;
        console.log(TAG, '作者回复加载状态', { reason, elapsedMs: Date.now() - startedAt,
          ...JSON.parse(signature) });
      }
      if (found.length) {
        console.log(TAG, '作者回复时间轴读取完成', { reason, elapsedMs: Date.now() - startedAt,
          timelines: found.length, rpids: found.map(item => item.comment.rpid) });
        return found;
      }
      if (matchedThreads && knownEmpty && !expanders.length) {
        console.log(TAG, '置顶线程明确没有回复', { reason, elapsedMs: Date.now() - startedAt });
        return [];
      }
      // Do not add a 12-second delay when the complete cached thread has no author timeline.
      if (supplement && !possibleReplies) {
        console.log(TAG, '置顶线程没有待加载的作者补充', { reason, elapsedMs: Date.now() - startedAt });
        return [];
      }
      // Expand only the pinned thread's reply list; full text comes from reply data.
      for (const { replies, button } of expanders) {
        if (!valid()) return [];
        clicked.add(replies);
        console.log(TAG, '展开置顶评论回复列表', { reason, attempt: attempt + 1 });
        button.click();
      }
      await sleep(pollMs);
    }
    console.warn(TAG, valid() ? '作者回复读取达到等待上限' : '作者回复读取已取消', {
      reason, elapsedMs: Date.now() - startedAt, maxAttempts });
    return [];
  }

  async function resolvePinnedTimeline(doc, pinned, duration, owner, valid = () => true, options = {}) {
    const reason = options.reason ?? 'initial';
    const onStage = options.onStage ?? (() => {});
    console.log(TAG, '解析置顶评论时间轴', { reason, comments: pinned.length,
      rpids: pinned.map(comment => comment.rpid).filter(Boolean) });
    let parsed = pinned.map(comment => {
      try {
        const segments = parseTimeline(comment.text, duration);
        console.log(TAG, '置顶正文时间轴解析成功', { reason, rpid: comment.rpid,
          segments: segments.length, textLength: comment.text.length });
        return { comment, segments };
      } catch (error) {
        console.warn(TAG, '置顶正文不是有效时间轴', { reason, rpid: comment.rpid,
          message: error.message, textLength: comment.text.length });
        return null;
      }
    }).filter(Boolean);
    if (!parsed.length && pinned.length) {
      onStage('reading-replies', { reason, pinned: pinned.length });
      console.log(TAG, '置顶正文没有有效时间轴，检查该置顶评论下橘鸦Juya本人的回复', { reason });
      parsed = await readPinnedReplies(doc, pinned, duration, owner, valid, {
        reason: `${reason}-fallback`, maxAttempts: options.replyAttempts
      });
    } else if (parsed.length === 1 && parsed[0].comment.author === owner.name
      && parsed[0].comment.authorMid === String(owner.mid)) {
      onStage('reading-replies', { reason, supplement: true, pinned: 1 });
      console.log(TAG, '置顶正文已有时间轴，检查同一置顶下作者是否补充后续条目', { reason });
      const replies = await readPinnedReplies(doc, [parsed[0].comment], duration, owner, valid, {
        supplement: true, reason: `${reason}-supplement`, maxAttempts: options.replyAttempts
      });
      if (!valid()) return [];
      const originalCount = parsed[0].segments.length;
      parsed[0] = mergePinnedTimeline(parsed[0], replies, duration, owner);
      if (parsed[0].segments.length > originalCount) {
        console.log(TAG, '已合并置顶正文与作者回复', {
          reason, original: originalCount, added: parsed[0].segments.length - originalCount,
          total: parsed[0].segments.length, rpids: parsed[0].comment.parts.map(part => part.rpid)
        });
      }
    }
    console.log(TAG, '评论时间轴解析阶段结束', { reason, sources: parsed.length,
      segments: parsed.map(item => item.segments.length) });
    return parsed;
  }

  function findVideo(doc) {
    const container = doc.querySelector('#bilibili-player, #bilibiliPlayer, .bpx-player-container');
    const videos = deepAll(container || doc, 'video');
    const visible = videos.filter(v => v.getClientRects().length && Number.isFinite(v.duration) && v.duration > 0);
    if (visible.length === 1) return visible[0];
    if (!visible.length && videos.length === 1 && Number.isFinite(videos[0].duration) && videos[0].duration > 0) return videos[0];
    throw new Error(`无法唯一识别已加载的 video (共 ${videos.length}，可见且有时长 ${visible.length})。请先播放视频后重试`);
  }

  function captureNavigationStrip(video, roi = VISUAL_NAV.roi, doc = document) {
    if (!Number.isFinite(video.videoWidth) || !video.videoWidth
      || !Number.isFinite(video.videoHeight) || !video.videoHeight
      || video.readyState < 2) throw new Error('视频帧尚未就绪，至少播放或暂停到一帧后重试');
    const source = {
      x: Math.round(video.videoWidth * roi.x),
      y: Math.round(video.videoHeight * roi.y),
      width: Math.round(video.videoWidth * roi.width),
      height: Math.round(video.videoHeight * roi.height)
    };
    if (source.width < 2 || source.height < 2 || source.x < 0 || source.y < 0
      || source.x + source.width > video.videoWidth || source.y + source.height > video.videoHeight) {
      throw new Error(`章节条 ROI 超出视频帧: ${JSON.stringify(source)}`);
    }
    const canvas = doc.createElement('canvas');
    canvas.width = source.width;
    canvas.height = source.height;
    const context = canvas.getContext('2d', { willReadFrequently: true });
    if (!context) throw new Error('无法创建 Canvas 2D context');
    try {
      context.drawImage(video, source.x, source.y, source.width, source.height,
        0, 0, source.width, source.height);
      return { canvas, imageData: context.getImageData(0, 0, source.width, source.height), source };
    } catch (error) {
      if (error?.name === 'SecurityError') {
        throw new Error('Canvas 像素读取被跨域策略阻止；当前播放器视频源不可用于视觉 fallback');
      }
      throw error;
    }
  }

  function median(values) {
    values.sort((a, b) => a - b);
    const middle = Math.floor(values.length / 2);
    return values.length % 2 ? values[middle] : (values[middle - 1] + values[middle]) / 2;
  }

  // Detect full-height separators only in the quiet band above the titles.
  // This intentionally targets Juya's current fixed UI instead of attempting
  // general-purpose rectangle detection.
  function detectVisualBoundaries(imageData, duration, currentTime, options = {}) {
    if (!Number.isFinite(duration) || duration <= 0) throw new Error('视频总时长尚未就绪');
    const { data, width, height } = imageData;
    if (!data || data.length !== width * height * 4 || width < 2 || height < 2) {
      throw new Error('无效的章节条 ImageData');
    }
    const sampleTop = Math.max(0, Math.min(height - 1,
      Math.round(height * (options.sampleTop ?? VISUAL_NAV.sampleTop))));
    const sampleBottom = Math.max(sampleTop + 1, Math.min(height,
      Math.round(height * (options.sampleBottom ?? VISUAL_NAV.sampleBottom))));
    const minEdgeScore = options.minEdgeScore ?? VISUAL_NAV.minEdgeScore;
    const coverageEdgeScore = options.coverageEdgeScore ?? VISUAL_NAV.coverageEdgeScore;
    const minVerticalCoverage = options.minVerticalCoverage ?? VISUAL_NAV.minVerticalCoverage;
    const mergeGapPx = options.mergeGapPx ?? VISUAL_NAV.mergeGapPx;
    const playheadTolerancePx = options.playheadTolerancePx ?? VISUAL_NAV.playheadTolerancePx;
    const minBlockDuration = options.minBlockDuration ?? VISUAL_NAV.minBlockDuration;
    const minBlockWidthPx = options.minBlockWidthPx ?? Math.max(2, minBlockDuration / duration * width);
    const scores = new Array(width - 1).fill(0);
    const verticalCoverage = new Array(width - 1).fill(0);
    for (let x = 1; x < width; x++) {
      const rowScores = [];
      let coveredRows = 0;
      for (let y = sampleTop; y < sampleBottom; y++) {
        const right = (y * width + x) * 4;
        const left = right - 4;
        rowScores.push((Math.abs(data[right] - data[left])
          + Math.abs(data[right + 1] - data[left + 1])
          + Math.abs(data[right + 2] - data[left + 2])) / 3);
      }
      for (let y = 0; y < height; y++) {
        const right = (y * width + x) * 4;
        const left = right - 4;
        const edge = (Math.abs(data[right] - data[left])
          + Math.abs(data[right + 1] - data[left + 1])
          + Math.abs(data[right + 2] - data[left + 2])) / 3;
        if (edge >= coverageEdgeScore) coveredRows++;
      }
      scores[x - 1] = median(rowScores);
      verticalCoverage[x - 1] = coveredRows / height;
    }

    const runs = [];
    for (let i = 0; i < scores.length;) {
      if (scores[i] < minEdgeScore || verticalCoverage[i] < minVerticalCoverage) { i++; continue; }
      let end = i + 1;
      while (end < scores.length && scores[end] >= minEdgeScore
        && verticalCoverage[end] >= minVerticalCoverage) end++;
      let best = i;
      for (let p = i + 1; p < end; p++) if (scores[p] > scores[best]) best = p;
      runs.push({ x: best + 1, score: scores[best], coverage: verticalCoverage[best] });
      i = end;
    }
    const groups = [];
    for (const peak of runs) {
      const group = groups.at(-1);
      if (group && peak.x - group.at(-1).x <= mergeGapPx) group.push(peak);
      else groups.push([peak]);
    }
    const peaks = groups.map(group => group.reduce((best, peak) => peak.score > best.score ? peak : best));
    const expectedPlayheadX = Number.isFinite(currentTime) ? currentTime / duration * width : null;
    let playhead = null;
    if (expectedPlayheadX !== null && expectedPlayheadX > playheadTolerancePx
      && expectedPlayheadX < width - playheadTolerancePx) {
      const nearby = peaks.filter(peak => Math.abs(peak.x - expectedPlayheadX) <= playheadTolerancePx)
        .sort((a, b) => Math.abs(a.x - expectedPlayheadX) - Math.abs(b.x - expectedPlayheadX));
      playhead = nearby[0] ?? null;
    }
    const internal = peaks.filter(peak => peak !== playhead && peak.x > 0 && peak.x < width)
      .map(peak => peak.x);
    const boundariesPx = [0, ...internal, width];
    const narrowBlocks = boundariesPx.slice(0, -1).map((x, i) => ({
      index: i, width: boundariesPx[i + 1] - x
    })).filter(block => block.width < minBlockWidthPx);
    const warnings = [];
    if ((options.warnMissingPlayhead ?? true) && expectedPlayheadX !== null && expectedPlayheadX > playheadTolerancePx
      && expectedPlayheadX < width - playheadTolerancePx && !playhead) {
      warnings.push('未在预测位置找到播放进度竖线；请核对 ROI 或换一帧重试');
    }
    if (narrowBlocks.length) warnings.push(`检测到 ${narrowBlocks.length} 个异常窄块，结果不应接入自动跳段`);
    if (boundariesPx.length < 3) warnings.push('检测到的章节块少于 2 个，结果不可靠');
    const segments = boundariesPx.slice(0, -1).map((x, index) => ({
      index,
      start: x / width * duration,
      end: boundariesPx[index + 1] / width * duration,
      title: null,
      terminal: index === boundariesPx.length - 2,
      startPx: x,
      endPx: boundariesPx[index + 1]
    }));
    return {
      width, height, sampleRows: [sampleTop, sampleBottom], minEdgeScore,
      coverageEdgeScore, minVerticalCoverage,
      boundariesPx, segments, warnings, reliable: warnings.length === 0,
      playhead: expectedPlayheadX === null ? null : {
        expectedX: expectedPlayheadX,
        detectedX: playhead?.x ?? null,
        errorPx: playhead ? playhead.x - expectedPlayheadX : null,
        score: playhead?.score ?? null
      }
    };
  }

  function mergeVisualGeometries(frames, duration, options = {}) {
    if (frames.length < 2) throw new Error('稳定视觉实验至少需要两帧');
    const width = frames[0].geometry.width;
    const height = frames[0].geometry.height;
    if (frames.some(frame => frame.geometry.width !== width || frame.geometry.height !== height)) {
      throw new Error('两帧章节条尺寸不一致，播放器可能已切换');
    }
    const mergeGapPx = options.mergeGapPx ?? VISUAL_NAV.mergeGapPx;
    const playheadTolerancePx = options.playheadTolerancePx ?? VISUAL_NAV.playheadTolerancePx;
    const observations = [];
    frames.forEach((frame, frameIndex) => {
      frame.geometry.boundariesPx.slice(1, -1).forEach(x => observations.push({ x, frameIndex }));
    });
    observations.sort((a, b) => a.x - b.x);
    const groups = [];
    for (const observation of observations) {
      const group = groups.at(-1);
      if (group && observation.x - group.at(-1).x <= mergeGapPx) group.push(observation);
      else groups.push([observation]);
    }
    const evidence = groups.map(group => {
      const xs = group.map(item => item.x).sort((a, b) => a - b);
      const x = Math.round(median(xs));
      const observedFrames = [...new Set(group.map(item => item.frameIndex))];
      const occludedFrames = frames.map((frame, frameIndex) => ({ frame, frameIndex }))
        .filter(({ frame, frameIndex }) => !observedFrames.includes(frameIndex)
          && Math.abs(frame.geometry.playhead?.expectedX - x) <= playheadTolerancePx)
        .map(({ frameIndex }) => frameIndex);
      return { x, observedFrames, occludedFrames };
    }).filter(item => item.observedFrames.length >= 2 || item.occludedFrames.length > 0);
    const boundariesPx = [0, ...evidence.map(item => item.x), width];
    const minBlockDuration = options.minBlockDuration ?? VISUAL_NAV.minBlockDuration;
    const minBlockWidthPx = options.minBlockWidthPx ?? Math.max(2, minBlockDuration / duration * width);
    const narrowBlocks = boundariesPx.slice(0, -1).map((x, index) => ({
      index, width: boundariesPx[index + 1] - x,
      duration: (boundariesPx[index + 1] - x) / width * duration
    })).filter(block => block.width < minBlockWidthPx);
    const warnings = [];
    if (narrowBlocks.length) warnings.push(`检测到 ${narrowBlocks.length} 个短于 ${minBlockDuration}s 的异常块`);
    if (boundariesPx.length < 3) warnings.push('稳定检测到的章节块少于 2 个');
    const segments = boundariesPx.slice(0, -1).map((x, index) => ({
      index,
      start: x / width * duration,
      end: boundariesPx[index + 1] / width * duration,
      title: null,
      terminal: index === boundariesPx.length - 2,
      startPx: x,
      endPx: boundariesPx[index + 1]
    }));
    return { width, height, boundariesPx, segments, evidence, warnings, reliable: warnings.length === 0 };
  }

  function seekVideoFrame(video, time, timeoutMs = 8000) {
    return new Promise((resolve, reject) => {
      let timeout;
      const cleanup = () => {
        clearTimeout(timeout);
        video.removeEventListener('seeked', onSeeked);
        video.removeEventListener('error', onError);
      };
      const finish = () => {
        cleanup();
        // The media element fires seeked only after the target frame is ready.
        resolve();
      };
      const onSeeked = () => finish();
      const onError = () => { cleanup(); reject(video.error || new Error('视频 seek 失败')); };
      timeout = setTimeout(() => { cleanup(); reject(new Error('视频 seek 等待超时')); }, timeoutMs);
      video.addEventListener('seeked', onSeeked, { once: true });
      video.addEventListener('error', onError, { once: true });
      try {
        if (Math.abs(video.currentTime - time) < 0.01 && !video.seeking) finish();
        else video.currentTime = time;
      } catch (error) { cleanup(); reject(error); }
    });
  }

  function cropNavigationBlocks(stripCanvas, boundariesPx, doc = document) {
    return boundariesPx.slice(0, -1).map((x, index) => {
      const width = boundariesPx[index + 1] - x;
      const canvas = doc.createElement('canvas');
      canvas.width = width;
      canvas.height = stripCanvas.height;
      const context = canvas.getContext('2d');
      if (!context) throw new Error('无法创建章节块 Canvas 2D context');
      context.drawImage(stripCanvas, x, 0, width, stripCanvas.height,
        0, 0, width, stripCanvas.height);
      return canvas;
    });
  }

  function repairPlayheadInStrip(frames, options = {}, doc = document) {
    const base = frames[0];
    if (!base?.canvas) throw new Error('Missing base navigation-strip canvas');
    const canvas = doc.createElement('canvas');
    canvas.width = base.canvas.width;
    canvas.height = base.canvas.height;
    const context = canvas.getContext('2d');
    if (!context) throw new Error('Cannot create repaired navigation-strip Canvas context');
    context.drawImage(base.canvas, 0, 0);
    const expectedX = base.geometry?.playhead?.expectedX;
    const donors = frames.slice(1).filter(frame => frame.canvas
      && frame.canvas.width === canvas.width && frame.canvas.height === canvas.height
      && Number.isFinite(frame.geometry?.playhead?.expectedX));
    if (!Number.isFinite(expectedX) || !donors.length) {
      return { canvas, repaired: false, expectedX: expectedX ?? null, donorFrame: null };
    }
    donors.sort((a, b) => Math.abs(b.geometry.playhead.expectedX - expectedX)
      - Math.abs(a.geometry.playhead.expectedX - expectedX));
    const donor = donors[0];
    const radius = options.playheadRepairRadiusPx
      ?? (options.playheadTolerancePx ?? VISUAL_NAV.playheadTolerancePx);
    if (Math.abs(donor.geometry.playhead.expectedX - expectedX) <= radius * 2) {
      return { canvas, repaired: false, expectedX, donorFrame: null };
    }
    const left = Math.max(0, Math.floor(expectedX - radius));
    const right = Math.min(canvas.width, Math.ceil(expectedX + radius + 1));
    context.drawImage(donor.canvas, left, 0, right - left, canvas.height,
      left, 0, right - left, canvas.height);
    return { canvas, repaired: true, expectedX, donorFrame: frames.indexOf(donor),
      range: [left, right] };
  }

  function prepareOcrBlock(blockCanvas, options = {}, doc = blockCanvas.ownerDocument || document) {
    const trimX = Math.max(0, Math.round(blockCanvas.height
      * (options.ocrTrimX ?? OCR_EXPERIMENT.trimX)));
    const trimTop = Math.max(0, Math.round(blockCanvas.height
      * (options.ocrTrimTop ?? OCR_EXPERIMENT.trimTop)));
    const trimBottom = Math.max(0, Math.round(blockCanvas.height
      * (options.ocrTrimBottom ?? OCR_EXPERIMENT.trimBottom)));
    const sourceWidth = blockCanvas.width - trimX * 2;
    const sourceHeight = blockCanvas.height - trimTop - trimBottom;
    if (sourceWidth < 1 || sourceHeight < 1) {
      throw new Error(`OCR crop is empty: ${blockCanvas.width}x${blockCanvas.height}`);
    }
    const targetHeight = options.ocrTextHeightPx ?? OCR_EXPERIMENT.targetTextHeightPx;
    const paddingX = options.ocrPaddingXPx ?? OCR_EXPERIMENT.paddingXPx;
    const paddingY = options.ocrPaddingYPx ?? OCR_EXPERIMENT.paddingYPx;
    const targetWidth = Math.max(1, Math.round(sourceWidth / sourceHeight * targetHeight));
    const canvas = doc.createElement('canvas');
    canvas.width = targetWidth + paddingX * 2;
    canvas.height = targetHeight + paddingY * 2;
    const context = canvas.getContext('2d');
    if (!context) throw new Error('Cannot create OCR Canvas 2D context');
    context.fillStyle = '#fff';
    context.fillRect(0, 0, canvas.width, canvas.height);
    context.imageSmoothingEnabled = true;
    context.imageSmoothingQuality = 'high';
    context.drawImage(blockCanvas, trimX, trimTop, sourceWidth, sourceHeight,
      paddingX, paddingY, targetWidth, targetHeight);
    return canvas;
  }

  function normalizeOcrText(text) {
    return String(text ?? '').normalize('NFKC').replace(/\s+/g, ' ').trim();
  }

  function editDistance(left, right) {
    const a = String(left);
    const b = String(right);
    let previous = Array.from({ length: b.length + 1 }, (_, index) => index);
    for (let i = 1; i <= a.length; i++) {
      const current = [i];
      for (let j = 1; j <= b.length; j++) {
        current[j] = Math.min(
          current[j - 1] + 1,
          previous[j] + 1,
          previous[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1)
        );
      }
      previous = current;
    }
    return previous[b.length];
  }

  function matchOcrKeywords(text, keywords = activeKeywords, options = {}) {
    const normalized = normalizeOcrText(text).toLowerCase();
    const tokens = normalized.match(/[a-z0-9]+/g) || [];
    const candidates = [...tokens, ...tokens.slice(0, -1).map((token, index) => token + tokens[index + 1])];
    const fuzzyMinLength = options.fuzzyMinKeywordLength ?? OCR_EXPERIMENT.fuzzyMinKeywordLength;
    const fuzzyMaxDistance = options.fuzzyMaxDistance ?? OCR_EXPERIMENT.fuzzyMaxDistance;
    const matches = [];
    for (const keyword of keywords) {
      const needle = keyword.toLowerCase();
      if (normalized.includes(needle) || candidates.includes(needle)) {
        matches.push({ keyword, mode: 'exact', token: keyword, distance: 0 });
        continue;
      }
      if (needle.length < fuzzyMinLength) continue;
      const close = candidates.filter(token => Math.abs(token.length - needle.length) <= fuzzyMaxDistance)
        .map(token => ({ token, distance: editDistance(token, needle) }))
        .filter(candidate => candidate.distance <= fuzzyMaxDistance)
        .sort((a, b) => a.distance - b.distance);
      if (close.length) matches.push({ keyword, mode: 'fuzzy', ...close[0] });
    }
    return matches;
  }

  function classifyOcrSegment(segment, keywords = activeKeywords, options = {}) {
    const title = normalizeOcrText(segment.ocrText ?? segment.title);
    const matches = matchOcrKeywords(title, keywords, options);
    const confidence = Number.isFinite(segment.confidence) ? segment.confidence : null;
    const reason = matches.length ? 'keyword' : 'unmatched';
    return { title: title || '[未识别]', ocrText: title, confidence,
      keep: matches.length > 0, keywords: matches.map(match => match.keyword), matches,
      reviewRequired: matches.some(match => match.mode === 'fuzzy'),
      reason };
  }

  function ocrFallbackSegments(result, duration, keywords = activeKeywords, options = {}) {
    const visual = result?.visual;
    const rows = result?.rows;
    if (!visual?.reliable || !Array.isArray(rows) || rows.length !== visual.segments?.length
      || rows.length < 2 || !Number.isFinite(duration) || duration <= 0) {
      throw new Error('OCR 章节几何或识别结果不完整，停止自动跳段');
    }
    const segments = visual.segments.map((segment, index) => {
      const row = rows[index];
      if (row.index !== index || !Number.isFinite(segment.start) || !Number.isFinite(segment.end)
        || segment.start < 0 || segment.end <= segment.start
        || (index && Math.abs(segment.start - visual.segments[index - 1].end) > 0.05)) {
        throw new Error('OCR 章节边界不连续，停止自动跳段');
      }
      return { ...segment, ...classifyOcrSegment(row, keywords, options) };
    });
    if (Math.abs(segments[0].start) > 0.05 || Math.abs(segments.at(-1).end - duration) > 1) {
      throw new Error('OCR 章节未覆盖整条视频，停止自动跳段');
    }
    if (!segments.some(segment => segment.keywords.length)) {
      throw new Error('OCR 没有识别出任何关注关键词，停止自动跳段');
    }
    return segments;
  }

  function sameVisualBoundaries(left, right, tolerancePx = VISUAL_NAV.mergeGapPx) {
    return !!left?.reliable && !!right?.reliable
      && Number.isInteger(left.width) && left.width > 0
      && Number.isInteger(left.height) && left.height > 0
      && left.width === right.width
      && left.height === right.height && left.boundariesPx?.length === right.boundariesPx?.length
      && left.boundariesPx?.length >= 3
      && left.boundariesPx.every((x, index) => Math.abs(x - right.boundariesPx[index]) <= tolerancePx);
  }

  let tesseractLoadPromise;
  function loadTesseract(scope, doc, scriptUrl = OCR_EXPERIMENT.scriptUrl, timeoutMs = 45000) {
    if (scope.Tesseract?.createWorker) return Promise.resolve(scope.Tesseract);
    if (tesseractLoadPromise) return tesseractLoadPromise;
    tesseractLoadPromise = new Promise((resolve, reject) => {
      const existing = doc.querySelector('script[data-juya-tesseract]');
      const script = existing || doc.createElement('script');
      let timeout;
      const cleanup = () => {
        clearTimeout(timeout);
        script.removeEventListener('load', onLoad);
        script.removeEventListener('error', onError);
      };
      const onLoad = () => {
        cleanup();
        if (scope.Tesseract?.createWorker) resolve(scope.Tesseract);
        else {
          script.remove();
          reject(new Error('Tesseract.js loaded, but the global API is missing'));
        }
      };
      const onError = () => {
        cleanup();
        script.remove();
        reject(new Error(`Cannot load Tesseract.js; the page CSP or network may have blocked ${scriptUrl}`));
      };
      script.addEventListener('load', onLoad, { once: true });
      script.addEventListener('error', onError, { once: true });
      timeout = setTimeout(() => {
        cleanup();
        script.remove();
        reject(new Error('Timed out while loading Tesseract.js'));
      }, timeoutMs);
      if (!existing) {
        script.src = scriptUrl;
        script.crossOrigin = 'anonymous';
        script.dataset.juyaTesseract = 'loading';
        (doc.head || doc.documentElement).appendChild(script);
      }
    }).catch(error => {
      tesseractLoadPromise = null;
      throw error;
    });
    return tesseractLoadPromise;
  }

  function compareTimelines(visualSegments, referenceSegments) {
    const visualStarts = visualSegments.map((segment, index) => ({ value: segment.start, index }));
    const referenceStarts = referenceSegments.map((segment, index) => ({ value: segment.start, index }));
    const visualEnd = visualSegments.at(-1)?.end;
    const referenceEnd = referenceSegments.at(-1)?.end;
    if (visualStarts.some(row => !Number.isFinite(row.value))
      || referenceStarts.some(row => !Number.isFinite(row.value))
      || !Number.isFinite(visualEnd) || !Number.isFinite(referenceEnd)) {
      throw new Error('时间轴包含无效边界');
    }
    const alignedVisual = [...visualStarts];
    const ignoredVisualBoundaries = [];
    // Some comments start at the first news item and omit the burned-in intro.
    if (alignedVisual.length > referenceStarts.length && alignedVisual[0]?.value < 1
      && referenceStarts[0]?.value >= 1) {
      ignoredVisualBoundaries.push({ ...alignedVisual.shift(), reason: '人工时间轴省略片头' });
    }
    // Juya's fixed 2-3 second "再见" block is visually real but commonly absent
    // from the manual timeline. Keep it in geometry; ignore it only for comparison.
    if (alignedVisual.length > referenceStarts.length && visualSegments.at(-1)?.terminal) {
      const terminalIndex = alignedVisual.findIndex(row => row.index === visualSegments.length - 1);
      if (terminalIndex >= 0) {
        ignoredVisualBoundaries.push({ ...alignedVisual.splice(terminalIndex, 1)[0],
          reason: '人工时间轴省略“再见”尾块' });
      }
    }
    if (alignedVisual.length !== referenceStarts.length) return {
      comparable: false,
      visualBoundaries: visualStarts.length + 1,
      referenceBoundaries: referenceStarts.length + 1,
      alignedVisualBoundaries: alignedVisual.length + 1,
      ignoredVisualBoundaries,
      reason: '去除可选片头/尾块后，视觉块数与人工时间轴仍不同'
    };
    const boundaries = alignedVisual.map((visual, position) => {
      const reference = referenceStarts[position];
      return {
        index: position,
        visualIndex: visual.index,
        referenceIndex: reference.index,
        visual: visual.value,
        reference: reference.value,
        error: visual.value - reference.value,
        absoluteError: Math.abs(visual.value - reference.value)
      };
    });
    boundaries.push({
      index: boundaries.length,
      visualIndex: visualSegments.length,
      referenceIndex: referenceSegments.length,
      visual: visualEnd,
      reference: referenceEnd,
      error: visualEnd - referenceEnd,
      absoluteError: Math.abs(visualEnd - referenceEnd),
      terminalEnd: true
    });
    const measured = boundaries.filter(row => !row.terminalEnd
      && !(row.visual < 1 && row.reference < 1));
    return {
      comparable: true,
      boundaries,
      ignoredVisualBoundaries,
      meanAbsoluteError: measured.reduce((sum, row) => sum + row.absoluteError, 0) / measured.length,
      maxAbsoluteError: Math.max(...measured.map(row => row.absoluteError))
    };
  }

  function attach(video, segments, { log = (...args) => console.log(TAG, ...args), valid = () => true } = {}) {
    let active = true;
    let pending = null;
    let timeout;
    const events = [];
    function record(type, details) {
      const event = { type, at: new Date().toISOString(), ...details };
      events.push(event);
      log(type, details);
    }
    function stop() {
      if (!active) return;
      active = false;
      clearTimeout(timeout);
      for (const name of ['timeupdate', 'playing', 'seeked']) video.removeEventListener(name, tick);
      video.removeEventListener('emptied', changed);
      video.removeEventListener('durationchange', checkDuration);
      record('STOP', { currentTime: video.currentTime });
    }
    function changed() { record('PLAYER_CHANGED', {}); stop(); }
    function checkDuration() {
      if (Math.abs(video.duration - segments.at(-1).end) > 1) changed();
    }
    function tick(event) {
      if (!active) return;
      if (!valid()) return changed();
      if (pending) {
        if (event?.type !== 'seeked') return;
        const actual = video.currentTime;
        const success = Math.abs(actual - pending.target) < 1;
        record(success ? 'SEEK_CONFIRMED' : 'SEEK_FAILED', { ...pending, actual });
        pending = null;
        clearTimeout(timeout);
        if (!success) stop();
        return;
      }
      if (video.paused || video.seeking || video.ended) return;
      const decision = skipTarget(segments, video.currentTime);
      if (!decision) return;
      pending = { from: video.currentTime, target: decision.target, title: decision.segment.title,
        terminal: decision.terminal };
      record('SEEK_REQUEST', { ...pending });
      timeout = setTimeout(() => { record('SEEK_TIMEOUT', { ...pending }); stop(); }, 8000);
      try {
        // Pause before seeking to duration to avoid continuing into the next video.
        if (decision.terminal) video.pause();
        video.currentTime = decision.target;
      } catch (error) {
        record('SEEK_ERROR', { message: error.message });
        stop();
      }
    }
    for (const name of ['timeupdate', 'playing', 'seeked']) video.addEventListener(name, tick);
    video.addEventListener('emptied', changed);
    video.addEventListener('durationchange', checkDuration);
    record('START', { duration: video.duration, segments: segments.length });
    tick();
    return { stop, events, get active() { return active; } };
  }

  const api = { KEYWORDS, VISUAL_NAV, OCR_EXPERIMENT, STARTUP_TIMING, withTimeout,
    parseTimeline, skipTarget, deepAll, domText, pinnedCandidates, pinnedReadiness, readPinned, findVideo,
    captureNavigationStrip, detectVisualBoundaries, mergeVisualGeometries, cropNavigationBlocks, repairPlayheadInStrip, prepareOcrBlock,
    normalizeOcrText, editDistance, matchOcrKeywords, classifyOcrSegment, ocrFallbackSegments, sameVisualBoundaries,
    loadTesseract, compareTimelines,
    seekVideoFrame, attach,
    juyaOwner, replyTimelines, readPinnedReplies, resolvePinnedTimeline, mergePinnedTimeline };
  if (typeof module !== 'undefined' && module.exports) { module.exports = api; return; }
  root.JuyaDemo?.stop?.();
  let controller;
  let report;
  let video;
  let generation = 0;
  function identity() { return `${location.pathname}${location.search}|${root.__INITIAL_STATE__?.cid ?? ''}`; }
  root.JuyaDemo = {
    getKeywords() { return [...activeKeywords]; },
    setKeywords(words) {
      if (!Array.isArray(words) || !words.length || words.length > 30
        || words.some(word => typeof word !== 'string' || !word.trim() || word.trim().length > 80)) {
        throw new Error('需要 1–30 个有效关键词');
      }
      const seen = new Set();
      const next = words.map(word => word.trim()).filter(word => {
        const key = word.toLowerCase();
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      });
      const changes = report?.segments.map(segment => {
        if (report.comment.sourceKind === 'ocr-visual') return classifyOcrSegment(segment, next);
        const keywords = next.filter(word => segment.title.toLowerCase().includes(word.toLowerCase()));
        return { keywords, keep: keywords.length > 0 };
      });
      if (controller?.active && changes && !changes.some(change => change.keywords.length)) {
        throw new Error('当前视频没有匹配新集合的资讯；请停止跳段后再切换，或添加匹配词');
      }
      if (JSON.stringify(activeKeywords) === JSON.stringify(next)) return [...activeKeywords];
      activeKeywords = next;
      if (changes) {
        changes.forEach((change, index) => Object.assign(report.segments[index], change));
        report.keywords = [...next];
      }
      console.log(TAG, '关键词已更新', { keywords: next, keep: changes?.filter(change => change.keep).length ?? null });
      return [...activeKeywords];
    },
    stop() { generation++; controller?.stop(); },
    // The extension checks readiness in the page world before starting.
    findVideo(doc = document) { return findVideo(doc); },
    inspect() {
      const renderers = deepAll(document, 'bili-comment-renderer');
      const snapshot = {
        url: location.href,
        commentHosts: deepAll(document, 'bili-comments').length,
        renderers: renderers.length,
        candidates: pinnedCandidates(document).length,
        firstComments: renderers.slice(0, 3).map(el => ({
          tag: el.tagName, dataKeys: Object.keys(el.__data || {}),
          control: el.__data?.reply_control,
          // Structure only; no unrelated comment text or account data.
          elements: deepAll(el, '[id], [class]').slice(0, 35).map(n => ({ tag: n.tagName, id: n.id, class: n.className }))
        })),
        videos: deepAll(document, 'video').map(v => ({ duration: v.duration, currentTime: v.currentTime, paused: v.paused }))
      };
      console.log(TAG, snapshot);
      return snapshot;
    },
    visualExperiment(options = {}) {
      juyaOwner(root.__INITIAL_STATE__);
      const experimentVideo = findVideo(document);
      const capture = captureNavigationStrip(experimentVideo, options.roi ?? VISUAL_NAV.roi);
      const geometry = detectVisualBoundaries(capture.imageData, experimentVideo.duration,
        experimentVideo.currentTime, options);
      const blockCanvases = cropNavigationBlocks(capture.canvas, geometry.boundariesPx);
      const referenceSegments = options.referenceSegments ?? report?.segments;
      const comparison = referenceSegments ? compareTimelines(geometry.segments, referenceSegments) : null;
      console.log(TAG, '视觉实验 ROI', { video: [experimentVideo.videoWidth, experimentVideo.videoHeight],
        roi: capture.source, canvas: capture.canvas, currentTime: experimentVideo.currentTime });
      console.table(geometry.segments.map(segment => ({ block: segment.index,
        start: segment.start.toFixed(3), end: segment.end.toFixed(3),
        startPx: segment.startPx, endPx: segment.endPx })));
      if (geometry.warnings.length) console.warn(TAG, geometry.warnings.join('；'));
      if (comparison?.comparable) {
        if (comparison.ignoredVisualBoundaries.length) {
          console.log(TAG, '人工时间轴未列出的视觉端块（仅比较时忽略，几何结果仍保留）',
            comparison.ignoredVisualBoundaries);
        }
        console.table(comparison.boundaries.map(row => ({ boundary: row.index,
          visual: row.visual.toFixed(3), reference: row.reference.toFixed(3),
          error: row.error.toFixed(3), absoluteError: row.absoluteError.toFixed(3) })));
        console.log(TAG, '视觉/人工时间轴误差', {
          meanAbsoluteError: comparison.meanAbsoluteError,
          maxAbsoluteError: comparison.maxAbsoluteError
        });
      } else if (comparison) console.warn(TAG, comparison.reason, comparison);
      return { ...geometry, roi: capture.source, canvas: capture.canvas, blockCanvases, comparison };
    },
    async visualExperimentStable(options = {}) {
      juyaOwner(root.__INITIAL_STATE__);
      if (controller?.active) throw new Error('稳定视觉实验会临时移动播放位置，请先运行 JuyaDemo.stop()');
      const experimentVideo = findVideo(document);
      const originalTime = experimentVideo.currentTime;
      const wasPaused = experimentVideo.paused;
      const sourceUrl = experimentVideo.currentSrc;
      const page = identity();
      const shiftSeconds = options.shiftSeconds
        ?? Math.max(1.5, 10 * experimentVideo.duration / experimentVideo.videoWidth);
      const margin = Math.min(0.25, experimentVideo.duration / 10);
      const secondTime = originalTime + shiftSeconds <= experimentVideo.duration - margin
        ? originalTime + shiftSeconds : Math.max(margin, originalTime - shiftSeconds);
      if (Math.abs(secondTime - originalTime) < 0.5) throw new Error('视频太短，无法取得两帧稳定样本');
      let restoreWarning = null;
      let result;
      experimentVideo.pause();
      try {
        const firstCapture = captureNavigationStrip(experimentVideo, options.roi ?? VISUAL_NAV.roi);
        const firstGeometry = detectVisualBoundaries(firstCapture.imageData, experimentVideo.duration,
          experimentVideo.currentTime, { ...options, warnMissingPlayhead: false });
        const frames = [{ time: experimentVideo.currentTime, geometry: firstGeometry,
          canvas: firstCapture.canvas }];
        await seekVideoFrame(experimentVideo, secondTime, options.seekTimeoutMs);
        if (!experimentVideo.isConnected || experimentVideo.currentSrc !== sourceUrl || identity() !== page) {
          throw new Error('取第二帧期间播放器或页面已切换');
        }
        const secondCapture = captureNavigationStrip(experimentVideo, options.roi ?? VISUAL_NAV.roi);
        const secondGeometry = detectVisualBoundaries(secondCapture.imageData, experimentVideo.duration,
          experimentVideo.currentTime, { ...options, warnMissingPlayhead: false });
        frames.push({ time: experimentVideo.currentTime, geometry: secondGeometry,
          canvas: secondCapture.canvas });
        const stable = mergeVisualGeometries(frames, experimentVideo.duration, options);
        const blockCanvases = cropNavigationBlocks(firstCapture.canvas, stable.boundariesPx);
        const referenceSegments = options.referenceSegments ?? report?.segments;
        const comparison = referenceSegments ? compareTimelines(stable.segments, referenceSegments) : null;
        result = { ...stable, roi: firstCapture.source, canvas: firstCapture.canvas,
          blockCanvases, frames, comparison, originalTime, secondTime };
      } finally {
        try {
          if (experimentVideo.isConnected && experimentVideo.currentSrc === sourceUrl && identity() === page) {
            await seekVideoFrame(experimentVideo, originalTime, options.seekTimeoutMs);
            if (!wasPaused) await experimentVideo.play();
          }
        } catch (error) {
          restoreWarning = `实验完成，但恢复原播放位置失败: ${error.message}`;
        }
      }
      if (restoreWarning) {
        result.warnings.push(restoreWarning);
        result.reliable = false;
      }
      console.log(TAG, '双帧稳定视觉实验', {
        video: [experimentVideo.videoWidth, experimentVideo.videoHeight], roi: result.roi,
        frameTimes: result.frames.map(frame => frame.time), restoredTime: experimentVideo.currentTime,
        canvas: result.canvas
      });
      console.table(result.segments.map(segment => ({ block: segment.index,
        start: segment.start.toFixed(3), end: segment.end.toFixed(3), terminal: segment.terminal,
        startPx: segment.startPx, endPx: segment.endPx })));
      if (result.warnings.length) console.warn(TAG, result.warnings.join('；'));
      if (result.comparison?.comparable) {
        if (result.comparison.ignoredVisualBoundaries.length) {
          console.log(TAG, '人工时间轴未列出的视觉端块（仅比较时忽略，几何结果仍保留）',
            result.comparison.ignoredVisualBoundaries);
        }
        console.table(result.comparison.boundaries.map(row => ({ boundary: row.index,
          visual: row.visual.toFixed(3), reference: row.reference.toFixed(3),
          error: row.error.toFixed(3), absoluteError: row.absoluteError.toFixed(3) })));
        console.log(TAG, '稳定视觉/人工时间轴误差', {
          meanAbsoluteError: result.comparison.meanAbsoluteError,
          maxAbsoluteError: result.comparison.maxAbsoluteError
        });
      } else if (result.comparison) console.warn(TAG, result.comparison.reason, result.comparison);
      return result;
    },
    async ocrExperiment(options = {}) {
      juyaOwner(root.__INITIAL_STATE__);
      const startedAt = clock();
      const totalTimeoutMs = options.ocrTotalTimeoutMs ?? STARTUP_TIMING.ocrTotalTimeoutMs;
      const deadline = startedAt + totalTimeoutMs;
      const remaining = (limit, label) => {
        const left = deadline - clock();
        if (left <= 0) throw new Error(`OCR 总时限已耗尽（阶段：${label}）`);
        return Math.max(1, Math.min(limit, left));
      };
      options.onStage?.('ocr-preparing', { totalTimeoutMs });
      console.log(TAG, 'OCR 识别准备', { totalTimeoutMs, suppliedVisual: !!options.visualResult,
        suppliedWorker: !!options.worker });
      const visual = options.visualResult
        ?? await this.visualExperimentStable(options.visualOptions ?? options);
      if (!visual?.blockCanvases?.length || visual.blockCanvases.length !== visual.segments.length) {
        throw new Error('Visual geometry did not produce a complete set of block canvases');
      }
      if (!visual.reliable && !options.allowUnreliableGeometry) {
        throw new Error('Visual geometry has warnings; OCR experiment stopped. Inspect the geometry first');
      }

      const repairedStrip = visual.frames?.some(frame => frame.canvas)
        ? repairPlayheadInStrip(visual.frames, options)
        : { canvas: visual.canvas, repaired: false, expectedX: null, donorFrame: null };
      const ocrBlockCanvases = cropNavigationBlocks(repairedStrip.canvas, visual.boundariesPx);
      const processedCanvases = ocrBlockCanvases.map(canvas => prepareOcrBlock(canvas, options));
      options.onStage?.('ocr-loading', { blocks: processedCanvases.length });
      console.log(TAG, 'OCR 引擎加载开始', { blocks: processedCanvases.length,
        repairedPlayhead: repairedStrip.repaired, elapsedMs: Math.round(clock() - startedAt) });
      const tesseract = options.tesseract
        ?? await loadTesseract(root, document, options.tesseractUrl,
          remaining(options.loadTimeoutMs ?? 45000, '加载 Tesseract.js'));
      let worker = options.worker;
      let ownsWorker = false;
      const progressSeen = new Set();
      if (!worker) {
        const workerOptions = { ...(options.workerOptions || {}) };
        if (!workerOptions.logger && options.logProgress !== false) {
          workerOptions.logger = message => {
            const quarter = Math.floor((message.progress ?? 0) * 4);
            const key = `${message.status}|${quarter}`;
            if (progressSeen.has(key)) return;
            progressSeen.add(key);
            console.log(TAG, 'OCR load', {
              status: message.status,
              progress: Number.isFinite(message.progress) ? `${Math.round(message.progress * 100)}%` : null
            });
          };
        }
        const workerPromise = tesseract.createWorker(options.language ?? OCR_EXPERIMENT.language,
          options.oem, workerOptions);
        worker = await withTimeout(workerPromise,
          remaining(options.workerInitTimeoutMs ?? STARTUP_TIMING.workerInitTimeoutMs, '初始化 OCR Worker'),
          'OCR Worker 初始化', lateWorker => lateWorker?.terminate?.());
        ownsWorker = true;
      }

      const rows = [];
      try {
        await withTimeout(worker.setParameters({
          tessedit_pageseg_mode: options.psm ?? tesseract.PSM?.SINGLE_BLOCK ?? '6',
          preserve_interword_spaces: '1',
          user_defined_dpi: '300',
          ...(options.parameters || {})
        }), remaining(options.workerJobTimeoutMs ?? STARTUP_TIMING.workerJobTimeoutMs, '配置 OCR Worker'),
        'OCR Worker 参数配置');
        options.onStage?.('ocr-recognizing', { blocks: processedCanvases.length });
        for (let index = 0; index < processedCanvases.length; index++) {
          const blockStartedAt = clock();
          console.log(TAG, 'OCR 分块开始', { block: index, position: `${index + 1}/${processedCanvases.length}`,
            size: [processedCanvases[index].width, processedCanvases[index].height] });
          const recognition = await withTimeout(worker.recognize(processedCanvases[index]),
            remaining(options.workerJobTimeoutMs ?? STARTUP_TIMING.workerJobTimeoutMs, `识别分块 ${index}`),
            `OCR 分块 ${index} 识别`);
          const title = normalizeOcrText(recognition.data?.text);
          const matches = matchOcrKeywords(title, options.keywords ?? activeKeywords, options);
          const row = {
            index,
            start: visual.segments[index].start,
            end: visual.segments[index].end,
            terminal: visual.segments[index].terminal,
            title,
            confidence: Number.isFinite(recognition.data?.confidence)
              ? recognition.data.confidence : null,
            keepCandidate: matches.length > 0,
            keywords: matches.map(match => match.keyword),
            matches,
            reviewRequired: matches.some(match => match.mode === 'fuzzy')
          };
          rows.push(row);
          console.log(TAG, 'OCR 分块完成', { block: index,
            elapsedMs: Math.round(clock() - blockStartedAt), confidence: row.confidence,
            title: row.title, keywords: row.keywords, reviewRequired: row.reviewRequired });
        }
      } finally {
        if (ownsWorker && worker) {
          try {
            await withTimeout(worker.terminate(),
              options.workerTerminateTimeoutMs ?? STARTUP_TIMING.workerTerminateTimeoutMs,
              'OCR Worker 关闭');
          } catch (error) { console.warn(TAG, 'OCR Worker 清理未完成', { message: error.message }); }
        }
      }

      const elapsedMs = clock() - startedAt;
      const fuzzyRows = rows.filter(row => row.matches.some(match => match.mode === 'fuzzy'));
      const warnings = [...visual.warnings];
      if (!rows.some(row => row.keepCandidate)) {
        warnings.push('OCR did not find any keyword; do not enable automatic skipping');
      }
      if (fuzzyRows.length) {
        warnings.push(`${fuzzyRows.length} block(s) use one-edit fuzzy keyword matches; automatic fallback keeps them`);
      }
      const experimentalSegments = visual.segments.map((segment, index) => ({
        ...segment,
        title: rows[index].title,
        confidence: rows[index].confidence,
        keepCandidate: rows[index].keepCandidate,
        keywords: rows[index].keywords,
        reviewRequired: rows[index].reviewRequired
      }));
      const result = {
        attachSafe: false,
        visual,
        rows,
        experimentalSegments,
        repairedStrip,
        ocrBlockCanvases,
        processedCanvases,
        elapsedMs,
        warnings
      };
      console.table(rows.map(row => ({
        block: row.index,
        start: row.start.toFixed(3),
        end: row.end.toFixed(3),
        confidence: row.confidence === null ? '' : row.confidence.toFixed(1),
        keepCandidate: row.keepCandidate,
        match: row.matches.map(item => `${item.keyword}:${item.mode}`).join(', '),
        title: row.title
      })));
      console.log(TAG, 'OCR experiment complete', {
        elapsedMs: Math.round(elapsedMs),
        keepCandidates: rows.filter(row => row.keepCandidate).length,
        fuzzyCandidates: fuzzyRows.length,
        attachSafe: false
      });
      if (warnings.length) console.warn(TAG, warnings.join('; '));
      options.onStage?.('ocr-complete', { elapsedMs: Math.round(elapsedMs), blocks: rows.length,
        keepCandidates: rows.filter(row => row.keepCandidate).length, warnings: warnings.length });
      return result;
    },
    async start(options = {}) {
      this.stop();
      const run = generation;
      const page = identity();
      const startedAt = clock();
      const stage = (name, details = {}) => {
        const payload = { stage: name, run, elapsedMs: Math.round(clock() - startedAt), ...details };
        console.log(TAG, '启动阶段', payload);
        try { options.onStage?.(name, payload); } catch (error) {
          console.warn(TAG, '阶段回调失败', { stage: name, message: error.message });
        }
      };
      report = null;
      try {
        stage('initializing', { url: location.href, identity: page, keywords: [...activeKeywords] });
        const owner = juyaOwner(root.__INITIAL_STATE__);
        video = findVideo(document);
        const source = video.currentSrc;
        const valid = () => run === generation && page === identity()
          && video.isConnected && video.currentSrc === source;
        stage('waiting-comments', { duration: video.duration,
          videoSize: [video.videoWidth, video.videoHeight], readyState: video.readyState });
        let pinned = [];
        try {
          pinned = await readPinned(document, { valid, reason: 'initial',
            timeoutMs: options.commentWaitMs ?? STARTUP_TIMING.commentWaitMs });
        }
        catch (error) {
          if (!error.message.includes('未识别到置顶评论')) throw error;
          console.warn(TAG, '首次评论读取没有得到可用置顶正文', { message: error.message });
        }
        if (!valid()) { stage('cancelled', { reason: 'page-or-player-changed-after-comments' }); return; }
        let parsed = await resolvePinnedTimeline(document, pinned, video.duration, owner, valid, {
          reason: 'initial', onStage: stage,
          replyAttempts: options.replyAttempts ?? STARTUP_TIMING.replyAttempts
        });
        if (!valid()) { stage('cancelled', { reason: 'page-or-player-changed-after-replies' }); return; }

        // Comments often hydrate immediately after the first deadline. Recheck before committing
        // to the much heavier visual/OCR fallback, and re-run the author-reply path as well.
        if (!parsed.length) {
          stage('rechecking-comments', { timeoutMs: options.commentRecheckMs ?? STARTUP_TIMING.commentRecheckMs });
          let rechecked = [];
          try {
            rechecked = await readPinned(document, { valid, reason: 'pre-ocr-recheck',
              timeoutMs: options.commentRecheckMs ?? STARTUP_TIMING.commentRecheckMs,
              minimumWaitMs: options.commentRecheckSettleMs ?? STARTUP_TIMING.commentRecheckSettleMs });
          } catch (error) {
            if (!error.message.includes('未识别到置顶评论')) throw error;
            console.warn(TAG, 'OCR 前评论复查仍未取得置顶正文', { message: error.message });
          }
          if (!valid()) { stage('cancelled', { reason: 'page-or-player-changed-during-recheck' }); return; }
          if (rechecked.length) pinned = rechecked;
          parsed = await resolvePinnedTimeline(document, pinned, video.duration, owner, valid, {
            reason: 'pre-ocr-recheck', onStage: stage,
            replyAttempts: options.replyRecheckAttempts ?? STARTUP_TIMING.replyRecheckAttempts
          });
          if (!valid()) { stage('cancelled', { reason: 'page-or-player-changed-after-recheck' }); return; }
        }
        if (!parsed.length) {
          stage('ocr-sampling', { reason: 'comment-timeline-unavailable', maxSamples: 3 });
          console.warn(TAG, '两轮评论读取均无有效时间轴，开始视频章节条 OCR 降级');
          const samples = [];
          let visual;
          for (let attempt = 0; attempt < 3 && !visual; attempt++) {
            console.log(TAG, 'OCR 几何取样开始', { attempt: attempt + 1, previousSamples: samples.length });
            const sample = await this.visualExperimentStable();
            if (!valid()) { stage('cancelled', { reason: 'page-or-player-changed-during-ocr-sampling' }); return; }
            if (!sample.reliable) throw new Error(`OCR 章节取样不可靠：${sample.warnings.join('；')}`);
            visual = samples.find(previous => sameVisualBoundaries(previous, sample));
            samples.push(sample);
            console.log(TAG, 'OCR 几何取样完成', { attempt: attempt + 1,
              boundaries: sample.boundariesPx,
              blocks: sample.segments?.length ?? Math.max(0, (sample.boundariesPx?.length ?? 1) - 1),
              matchedPrevious: !!visual, warnings: sample.warnings });
          }
          if (!visual) throw new Error('OCR 章节边界在三次取样中不一致，停止自动跳段');
          const ocr = await this.ocrExperiment({ visualResult: visual,
            onStage: (name, details) => stage(name, details) });
          if (!valid()) { stage('cancelled', { reason: 'page-or-player-changed-after-ocr' }); return; }
          const segments = ocrFallbackSegments(ocr, video.duration, activeKeywords);
          const text = segments.map(segment => `${Math.floor(segment.start / 60).toString().padStart(2, '0')}:${Math.floor(segment.start % 60).toString().padStart(2, '0')} ${segment.title}`).join('\n');
          parsed = [{ comment: { text, source: 'video navigation strip / Tesseract OCR',
            sourceKind: 'ocr-visual', author: owner.name, authorMid: String(owner.mid),
            completeness: '视频章节条多次取样；未命中关注关键词的区间自动跳过' }, segments }];
          console.log(TAG, 'OCR 降级完成', { blocks: segments.length,
            matched: segments.filter(segment => segment.keywords.length).length,
            skipped: segments.filter(segment => !segment.keep).length });
        }
        if (parsed.length !== 1) throw new Error(`可解析的时间轴来源数量为 ${parsed.length}，需要唯一时间轴`);
        const { comment, segments } = parsed[0];
        if (!segments.some(s => s.keep)) throw new Error('没有任何关键词命中，停止，避免整条视频被跳过');
        stage('attaching', { source: comment.sourceKind ?? comment.source,
          segments: segments.length, keep: segments.filter(segment => segment.keep).length });
        report = { url: location.href, title: document.title, capturedAt: new Date().toISOString(),
          duration: video.duration, keywords: [...activeKeywords], comment, segments };
        console.log(TAG, '时间轴来源与全文', comment);
        console.table(segments.map(s => ({ start: s.start, end: s.end, keep: s.keep,
          title: s.title, keywords: s.keywords.join(', '),
          confidence: s.confidence ?? '', reason: s.reason ?? '' })));
        console.log(TAG, '实际播放器', video);
        controller = attach(video, segments, { valid: () => video.isConnected && identity() === page && video.currentSrc === source });
        stage('active', { source: comment.sourceKind ?? comment.source,
          segments: segments.length, keep: segments.filter(segment => segment.keep).length });
        console.log(TAG, '已启用。播放时进入未命中区间将自动跳转。JuyaDemo.stop() 停止；JuyaDemo.testSkip() 做一次真实边界实验。');
        return this.report();
      } catch (error) {
        stage('failed', { name: error.name, message: error.message,
          stack: typeof error.stack === 'string' ? error.stack.split('\n').slice(0, 4).join(' | ') : '' });
        console.error(TAG, '启动失败', { message: error.message, name: error.name });
        throw error;
      }
    },
    async testSkip() {
      if (!controller?.active) throw new Error('请先成功运行 JuyaDemo.start()');
      const segment = report.segments.find(s => !s.keep && report.segments.some(next => next.keep && next.start > s.start));
      if (!segment) throw new Error('没有可跳往后续保留片段的非关注区间');
      video.pause();
      // Enter the unwanted interval through actual playback, not a manually fired event.
      video.currentTime = Math.max(0, segment.start - 0.7);
      for (let i = 0; video.seeking && i < 100; i++) await sleep(50);
      if (video.seeking) throw new Error('实验定位超时');
      console.log(TAG, '边界实验开始', { from: video.currentTime, unwanted: segment });
      await video.play();
    },
    report() { return report ? { ...report, events: controller?.events ?? [], active: controller?.active ?? false } : null; }
  };
  if (!root.__JUYA_DEMO_MANUAL_START__) root.JuyaDemo.start().catch(() => {});
})(globalThis);
