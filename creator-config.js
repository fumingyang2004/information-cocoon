(function (root) {
  'use strict';

  const COMMON_VISUAL = Object.freeze({
    roi: Object.freeze({ x: 0, y: 688 / 720, width: 1, height: 32 / 720 }),
    sampleTop: 0,
    sampleBottom: 6 / 32,
    minEdgeScore: 12,
    coverageEdgeScore: 6,
    minVerticalCoverage: 0.7,
    mergeGapPx: 3,
    playheadTolerancePx: 4,
    minBlockDuration: 1,
    ocrFilter: 'none'
  });

  const creators = Object.freeze([
    Object.freeze({
      id: 'juya',
      name: '橘鸦Juya',
      mid: '285286947',
      avatar: 'imgs/Juya.png',
      visual: COMMON_VISUAL
    }),
    Object.freeze({
      id: 'heya',
      name: '黑鸦Heya',
      mid: '3706929260006322',
      avatar: 'imgs/Heya.png',
      visual: Object.freeze({
        ...COMMON_VISUAL,
        // The dark strip has lower separator contrast after video compression.
        // These thresholds recovered the same boundaries across sampled frames
        // without changing Juya's already-validated profile.
        minEdgeScore: 8,
        coverageEdgeScore: 4,
        // Heya uses pale text on a dark navy strip. Normalize it to the
        // dark-on-light polarity expected by the English OCR model.
        ocrFilter: 'grayscale(1) invert(1) contrast(1.4)'
      })
    })
  ]);

  function matchOwner(owner) {
    if (!owner) return null;
    return creators.find(creator => creator.name === owner.name
      && creator.mid === String(owner.mid)) ?? null;
  }

  const api = Object.freeze({
    creators,
    matchOwner,
    isSupported(owner) { return !!matchOwner(owner); },
    publicOwners() { return creators.map(({ id, name, mid }) => ({ id, name, mid })); }
  });

  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.InformationCocoonCreators = api;
})(globalThis);
