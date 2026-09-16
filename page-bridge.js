(function (root) {
  'use strict';
  if (root.JuyaPanel?.version === '0.4.0') return;
  const nativeConsole = root.console;
  const logs = [];
  let sequence = 0;
  let page = identity();
  let desiredActive = false;
  let starting = false;
  let ocrRunning = false;
  let sampling = false;
  let ocrAllowed = false;
  let ocrSummary = null;
  let lastError = '';
  let startRun = 0;
  const demo = () => root.JuyaDemo;
  function identity() {
    return `${location.pathname}${location.search}|${root.__INITIAL_STATE__?.videoData?.cid ?? root.__INITIAL_STATE__?.cid ?? ''}`;
  }
  function serialize(value) {
    if (typeof value === 'string') return value;
    if (value instanceof Error) return value.message;
    const seen = new WeakSet();
    try {
      return JSON.stringify(value, (key, item) => {
        if (item instanceof Element) return `<${item.tagName.toLowerCase()}>`;
        if (item && typeof item === 'object') {
          if (seen.has(item)) return '[重复引用]';
          seen.add(item);
        }
        return item;
      });
    } catch { return String(value); }
  }
  function record(level, ...args) {
    const text = args.filter(a => a !== '[JuyaDemo]').map(serialize).join(' ').slice(0, 5000);
    logs.push({ id: ++sequence, time: new Date().toLocaleTimeString('zh-CN', { hour12: false }), level, text });
    if (logs.length > 300) logs.shift();
  }
  const logger = {};
  for (const level of ['log', 'warn', 'error']) logger[level] = (...args) => {
    nativeConsole[level](...args);
    record(level, ...args);
  };
  logger.table = rows => {
    nativeConsole.table(rows);
    for (const row of Array.isArray(rows) ? rows : [rows]) record('table', row);
  };
  function checkPage() {
    if (identity() !== page) {
      demo()?.stop();
      desiredActive = false;
      starting = false;
      startRun++;
      page = identity();
      ocrSummary = null;
      lastError = '';
      record('warn', '视频已切换；总开关开启时会自动检查新视频。');
    }
  }
  function supported() {
    const owner = root.__INITIAL_STATE__?.videoData?.owner;
    return owner?.name === '橘鸦Juya' && String(owner.mid) === '285286947';
  }
  function snapshot() {
    checkPage();
    const report = demo()?.report();
    const samePage = report?.url === location.href;
    const segments = samePage ? report.segments : [];
    return {
      ready: !!demo(), version: '0.4.0', supported: supported(),
      url: location.href,
      title: root.__INITIAL_STATE__?.videoData?.title || document.title,
      active: samePage && !!report.active, starting, sampling, ocrRunning, ocrAllowed,
      source: samePage ? (report.comment.sourceKind === 'ocr-visual' ? '视频章节条 OCR'
        : report.comment.sourceKind === 'pinned-with-replies' ? '置顶正文 + 作者回复'
        : report.comment.rootRpid ? '置顶下的作者回复' : '置顶评论') : '',
      total: segments.length, keep: segments.filter(s => s.keep).length,
      jumps: samePage ? report.events.filter(e => e.type === 'SEEK_CONFIRMED').length : 0,
      keywords: demo()?.getKeywords?.() ?? [], ocrSummary, lastError, logs
    };
  }
  async function start() {
    if (starting || sampling) return;
    desiredActive = true;
    starting = true;
    lastError = '';
    const currentPage = page;
    const run = ++startRun;
    try {
      await demo().start();
      if (currentPage !== identity() || !desiredActive || run !== startRun) return;
      if (!demo().report()?.active) throw new Error('时间轴尚未启用，请先播放视频再重试');
    } catch (error) {
      if (currentPage === identity() && run === startRun) {
        desiredActive = false;
        lastError = error.message;
        record('error', '开启失败：', error);
      }
    } finally { if (run === startRun) starting = false; }
  }
  async function runOcr() {
    if (!ocrAllowed || ocrRunning || starting) return;
    ocrRunning = true;
    sampling = true;
    ocrSummary = null;
    lastError = '';
    const currentPage = page;
    desiredActive = !!demo().report()?.active;
    demo().stop();
    record('log', 'OCR 实验开始：临时移动播放位置取两帧，随后恢复。识别结果仅供查看。');
    try {
      let visual;
      try {
        visual = await demo().visualExperimentStable();
      } finally {
        sampling = false;
        if (currentPage === identity() && desiredActive) await start();
      }
      if (currentPage !== identity()) throw new Error('视频已切换，本次实验结束');
      const result = await demo().ocrExperiment({ visualResult: visual });
      if (currentPage !== identity()) return;
      // Never pass experimentalSegments or keepCandidate into attach()/start().
      ocrSummary = { blocks: result.rows.length, candidates: result.rows.filter(r => r.keepCandidate).length,
        elapsedMs: Math.round(result.elapsedMs), attachSafe: false };
      record('log', 'OCR 实验完成，仅输出日志，未应用到自动跳段。', ocrSummary);
    } catch (error) {
      if (currentPage === identity()) lastError = `OCR 实验：${error.message}`;
      record('error', 'OCR 实验未完成：', error);
    } finally { ocrRunning = false; sampling = false; }
  }
  root.JuyaPanel = {
    version: '0.4.0', snapshot,
    finishInstall() {
      delete root.__JUYA_DEMO_MANUAL_START__;
      delete root.__JUYA_DEMO_LOGGER__;
      record('log', '页面脚本已就绪；总开关开启时自动读取评论时间轴。');
      return snapshot();
    },
    command(action, value) {
      checkPage();
      if (!demo()) throw new Error('脚本尚未加载，请重新打开弹窗');
      if (action === 'stop') {
        desiredActive = false;
        starting = false;
        startRun++;
        demo().stop();
        lastError = '';
        record('log', '已停止自动跳段。');
      } else if (action === 'clear') { logs.length = 0; }
      else if (action === 'allowOcr') { ocrAllowed = !!value; }
      else if (action === 'keywords') {
        if (starting || sampling) throw new Error('读取时间轴或 OCR 取帧期间不能切换关键词');
        demo().setKeywords(value);
        lastError = '';
      }
      else {
        if (!supported()) throw new Error('请打开橘鸦Juya的视频');
        if (action === 'start') void start();
        else if (action === 'ocr') void runOcr();
        else throw new Error('未知操作');
      }
      return snapshot();
    }
  };
  root.__JUYA_DEMO_MANUAL_START__ = true;
  root.__JUYA_DEMO_LOGGER__ = logger;
})(globalThis);
