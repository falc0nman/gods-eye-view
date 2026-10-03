import test from 'node:test';
import assert from 'node:assert/strict';
import {
  altitudeFade,
  altitudeScale,
  clearWorldOverlayTextMeasureCache,
  combinedOverlayAlpha,
  distanceFade,
  distanceScale,
  destroyWorldOverlayDraw,
  getWorldOverlayTextMeasureCacheSize,
  installWorldOverlayFontInvalidation,
  measureOverlayEntry,
  measureWorldOverlayText,
  paintCard,
  paintLabel,
  paintSelected,
  paintTacticalCard,
  paintThumbnail,
  paintTrack,
  paintTracked,
  leaderRevealProgress,
  tacticalCardRevealAlpha,
  placementVariants,
  roundedRectPath,
} from './worldOverlayDraw.js';
import { createCctvThumbnailOverlayEntry, createFrameSlot } from '../data/cctvCards.js';
import { WORLD_OVERLAY_STYLE } from './worldOverlayTokens.js';

function mockContext() {
  const calls = [];
  let strokeStyle = '';
  let lineWidth = 1;
  return {
    calls,
    font: '',
    globalAlpha: 1,
    get strokeStyle() { return strokeStyle; },
    set strokeStyle(value) { strokeStyle = value; calls.push(['strokeStyle', value]); },
    get lineWidth() { return lineWidth; },
    set lineWidth(value) { lineWidth = value; calls.push(['lineWidth', value]); },
    measureCount: 0,
    measureText(text) {
      this.measureCount++;
      return { width: String(text).length * 6 };
    },
    save() { calls.push(['save']); },
    restore() { calls.push(['restore']); },
    beginPath() { calls.push(['beginPath']); },
    roundRect(...args) { calls.push(['roundRect', ...args]); },
    moveTo(...args) { calls.push(['moveTo', ...args]); },
    lineTo(...args) { calls.push(['lineTo', ...args]); },
    arcTo(...args) { calls.push(['arcTo', ...args]); },
    closePath() { calls.push(['closePath']); },
    fill() { calls.push(['fill']); },
    stroke() { calls.push(['stroke']); },
    fillRect(...args) { calls.push(['fillRect', ...args]); },
    fillText(...args) { calls.push(['fillText', ...args]); },
    drawImage(...args) { calls.push(['drawImage', ...args]); },
  };
}

test('distance and altitude fades preserve exact boundary/ramp math', () => {
  assert.equal(distanceFade(0, { maxDistance: 1000 }), 1);
  assert.equal(distanceFade(700, { maxDistance: 1000 }), 1);
  assert.equal(distanceFade(850, { maxDistance: 1000 }), 0.5);
  assert.equal(distanceFade(1000, { maxDistance: 1000 }), 0);
  assert.equal(distanceFade(50, { minDistance: 100, maxDistance: 1000 }), 0);
  assert.equal(altitudeFade(6000, { fadeStart: 7500, fadeEnd: 9500 }), 1);
  assert.equal(altitudeFade(8500, { fadeStart: 7500, fadeEnd: 9500 }), 0.5);
  assert.equal(altitudeFade(9500, { fadeStart: 7500, fadeEnd: 9500 }), 0);
});

test('distance scale matches the legacy infrastructure NearFarScalar curve', () => {
  const curve = { near: 250_000, nearValue: 1, far: 9_000_000, farValue: 0.62 };
  assert.equal(distanceScale(0, curve), 1);
  assert.equal(distanceScale(250_000, curve), 1);
  assert.equal(distanceScale(9_000_000, curve), 0.62);
  assert.equal(distanceScale(12_000_000, curve), 0.62);
  assert.ok(Math.abs(distanceScale(4_625_000, curve) - 0.81) < 1e-12);
  assert.equal(distanceScale(1_000_000, null), 1);
});

test('altitude scale preserves CCTV\'s exact smoothstep and linear waypoints', () => {
  const curve = {
    fullEnd: 1800,
    midEnd: 6000,
    end: 9500,
    midValue: 0.45,
    endValue: 0.35,
    smoothToMid: true,
  };
  assert.equal(altitudeScale(0, curve), 1);
  assert.equal(altitudeScale(1800, curve), 1);
  assert.ok(Math.abs(altitudeScale(6000, curve) - 0.45) < 1e-12);
  assert.equal(altitudeScale(9500, curve), 0.35);
  assert.ok(Math.abs(altitudeScale(3900, curve) - 0.725) < 1e-12);
  assert.ok(Math.abs(altitudeScale(7750, curve) - 0.4) < 1e-12);
});

test('the five-channel alpha chain is multiplicative and clamps inputs', () => {
  assert.equal(combinedOverlayAlpha({
    sourceAlpha: 0.5,
    temporalFade: 0.8,
    distanceFade: 0.5,
    altitudeFade: 0.5,
    keyholeEdgeFade: 0.25,
  }), 0.025);
  assert.equal(combinedOverlayAlpha({ sourceAlpha: 2, temporalFade: -1 }), 0);
});

test('placement variants flip below near the top and stay viewport-clamped', () => {
  const nearTop = placementVariants({
    anchorX: 10,
    anchorY: 5,
    width: 80,
    height: 30,
    viewportWidth: 200,
    viewportHeight: 100,
    gap: 10,
  });
  assert.deepEqual(nearTop.map((item) => item.corner), ['below', 'above', 'right', 'left']);
  for (const placement of nearTop) {
    assert.ok(placement.rect.x >= 4);
    assert.ok(placement.rect.y >= 4);
    assert.ok(placement.rect.x + placement.rect.w <= 196);
    assert.ok(placement.rect.y + placement.rect.h <= 96);
  }
  const reused = nearTop.slice();
  assert.equal(placementVariants({
    anchorX: 100,
    anchorY: 80,
    width: 40,
    height: 20,
    viewportWidth: 200,
    viewportHeight: 100,
  }, reused), reused);
  assert.equal(reused[0].corner, 'above');
});

test('tactical cards retain vertical-only placement and sprite-edge leaders', () => {
  const placements = placementVariants({
    anchorX: 100,
    anchorY: 80,
    width: 80,
    height: 30,
    viewportWidth: 200,
    viewportHeight: 120,
    gap: 20,
    leaderOffset: 14,
    verticalOnly: true,
  });
  assert.deepEqual(placements.map(({ corner }) => corner), ['above', 'below']);
  assert.equal(placements[0].leadFromY, 80);
  assert.equal(placements[0].leaderOffset, -14);
  assert.equal(placements[0].leadToY, placements[0].rect.y + placements[0].rect.h);
});

test('edge-clamped CCTV placements keep leaders vertical unless the anchor is outside the card', () => {
  const edgeClamped = placementVariants({
    anchorX: 20,
    anchorY: 160,
    width: 104,
    height: 77,
    viewportWidth: 240,
    viewportHeight: 240,
    gap: 22,
    leaderOffset: 16,
    verticalOnly: true,
  })[0];
  assert.equal(edgeClamped.rect.x, 4, 'card is horizontally clamped at the viewport edge');
  assert.equal(edgeClamped.leadFromX, 20);
  assert.equal(edgeClamped.leadToX, 20, 'leader stays strictly vertical at sx');

  const offRectAnchor = placementVariants({
    anchorX: 2,
    anchorY: 160,
    width: 104,
    height: 77,
    viewportWidth: 240,
    viewportHeight: 240,
    gap: 22,
    leaderOffset: 16,
    verticalOnly: true,
  })[0];
  // RE-SCOPED 2026-08-03. The old contract was `leadToX === 4` here: an anchor
  // outside the (edge-clamped) card rect pulled the leader endpoint to the card,
  // making the stub diagonal. That is branch-new — the shipped leader ran from
  // the anchor's sx to the card edge at the SAME sx, unconditionally — and a
  // slanted stub is exactly what reads as "this card is not attached to that
  // camera". Vertical always, even when the card has been clamped sideways off
  // its anchor.
  assert.equal(offRectAnchor.leadFromX, 2);
  assert.equal(offRectAnchor.leadToX, 2,
    'an off-rect anchor keeps the leader vertical rather than slanting it to the card');
});

test('rounded rectangles use native support and retain a fallback path', () => {
  const native = mockContext();
  roundedRectPath(native, 1, 2, 30, 20, 4);
  assert.deepEqual(native.calls[0], ['roundRect', 1, 2, 30, 20, 4]);

  const fallback = mockContext();
  delete fallback.roundRect;
  roundedRectPath(fallback, 1, 2, 30, 20, 4);
  assert.equal(fallback.calls.filter(([name]) => name === 'arcTo').length, 4);
  assert.equal(fallback.calls.at(-1)[0], 'closePath');
});

test('text measurement cache is font-aware and font hooks follow host lifetime', () => {
  destroyWorldOverlayDraw();
  const ctx = mockContext();
  let loadingDone = null;
  let addCount = 0;
  let removeCount = 0;
  globalThis.document = {
    fonts: {
      ready: new Promise(() => {}),
      addEventListener(name, listener) {
        if (name === 'loadingdone') {
          loadingDone = listener;
          addCount++;
        }
      },
      removeEventListener(name, listener) {
        if (name === 'loadingdone' && listener === loadingDone) removeCount++;
      },
    },
  };

  assert.equal(measureWorldOverlayText(ctx, 'A12', '10px mono'), 18);
  assert.equal(measureWorldOverlayText(ctx, 'A12', '10px mono'), 18);
  assert.equal(ctx.measureCount, 1);
  measureWorldOverlayText(ctx, 'A12', '12px mono');
  assert.equal(ctx.measureCount, 2);
  assert.equal(addCount, 1);
  assert.equal(getWorldOverlayTextMeasureCacheSize(), 2);
  loadingDone();
  assert.equal(getWorldOverlayTextMeasureCacheSize(), 0);
  destroyWorldOverlayDraw();
  assert.equal(removeCount, 1);
  installWorldOverlayFontInvalidation();
  assert.equal(addCount, 2);
  destroyWorldOverlayDraw();
  delete globalThis.document;
});

test('text measurement cache caps LRU retention at 1024 entries', () => {
  clearWorldOverlayTextMeasureCache();
  const ctx = mockContext();
  for (let i = 0; i < 1100; i++) measureWorldOverlayText(ctx, `label-${i}`, '10px mono');
  assert.equal(getWorldOverlayTextMeasureCacheSize(), 1024);
  const measured = ctx.measureCount;
  measureWorldOverlayText(ctx, 'label-0', '10px mono');
  assert.equal(ctx.measureCount, measured + 1);
  measureWorldOverlayText(ctx, 'label-1099', '10px mono');
  assert.equal(ctx.measureCount, measured + 1);
  assert.equal(getWorldOverlayTextMeasureCacheSize(), 1024);
  clearWorldOverlayTextMeasureCache();
});

test('variant measurement and all six painters remain renderer-local', () => {
  const ctx = mockContext();
  const entry = {
    title: 'CAMERA 12',
    details: ['LIVE', '1.2 KM'],
    accent: '#6be8ff',
    image: { width: 192, height: 108 },
    thumbnailWidth: 96,
    thumbnailHeight: 54,
  };
  const variants = ['label', 'track', 'card', 'thumbnail', 'selected', 'tracked'];
  const painters = [paintLabel, paintTrack, paintCard, paintThumbnail, paintSelected, paintTracked];
  for (let i = 0; i < variants.length; i++) {
    const variantEntry = { ...entry, variant: variants[i], selected: variants[i] === 'selected' };
    const layout = measureOverlayEntry(ctx, variantEntry, {});
    variantEntry._overlayLayout = layout;
    const placement = placementVariants({
      anchorX: 100,
      anchorY: 100,
      width: layout.w,
      height: layout.h,
      viewportWidth: 400,
      viewportHeight: 300,
    })[0];
    assert.equal(painters[i](ctx, variantEntry, placement, 0.5), placement.rect);
  }
  assert.ok(ctx.calls.some(([name]) => name === 'drawImage'));
  assert.ok(ctx.calls.filter(([name]) => name === 'fillText').length >= variants.length);
  const trackLayout = measureOverlayEntry(ctx, { ...entry, variant: 'track' }, {});
  assert.ok(trackLayout.w >= 'CAMERA 12 · LIVE'.length * 6);
});

test('thumbnail painter preserves the shipped CCTV 104x77 geometry and drawing coordinates', () => {
  const ctx = mockContext();
  const frameSlot = createFrameSlot();
  frameSlot.frame = { width: 192, height: 108 };
  frameSlot.stamp = 123;
  const entry = createCctvThumbnailOverlayEntry({
    id: 'cam-a',
    position: { x: 1, y: 2, z: 3 },
    title: 'Main & Fifth Avenue',
    frameSlot,
  });
  entry._overlayLayout = measureOverlayEntry(ctx, entry, {});
  assert.deepEqual(
    { w: entry._overlayLayout.w, h: entry._overlayLayout.h },
    { w: 104, h: 77 },
  );
  const placement = placementVariants({
    anchorX: 200,
    anchorY: 200,
    width: 104,
    height: 77,
    viewportWidth: 500,
    viewportHeight: 400,
    gap: entry.gapPx,
    leaderOffset: entry.leaderOffsetPx,
    verticalOnly: true,
  })[0];
  assert.deepEqual(placement.rect, { x: 148, y: 101, w: 104, h: 77 });
  paintThumbnail(ctx, entry, placement, 0.75);
  assert.deepEqual(
    ctx.calls.find(([name]) => name === 'strokeStyle'),
    ['strokeStyle', 'rgba(107, 232, 255, 0.6)'],
    'CCTV leader uses the source cyan token rather than the generic leader fallback',
  );
  assert.deepEqual(ctx.calls.find(([name]) => name === 'moveTo'), ['moveTo', 200, 184]);
  assert.deepEqual(
    ctx.calls.find(([name]) => name === 'drawImage'),
    ['drawImage', frameSlot.frame, 152, 105, 96, 54],
  );
  assert.deepEqual(
    ctx.calls.find(([name]) => name === 'fillText'),
    ['fillText', 'MAIN & FIFTH AV', 152, 169],
  );
});

test('tracked painter preserves centered multi-line readout metrics', () => {
  const ctx = mockContext();
  const entry = {
    variant: 'tracked',
    title: 'UAL123',
    details: ['FL350 · 451 kts', 'SFO → JFK'],
    accent: '#39d0ff',
  };
  entry._overlayLayout = measureOverlayEntry(ctx, entry, {});
  assert.equal(entry._overlayLayout.padX, 13);
  assert.equal(entry._overlayLayout.padY, 9);
  assert.equal(entry._overlayLayout.lineH, 17);
  const placement = placementVariants({
    anchorX: 200,
    anchorY: 180,
    width: entry._overlayLayout.w,
    height: entry._overlayLayout.h,
    viewportWidth: 600,
    viewportHeight: 400,
    verticalOnly: true,
  })[0];
  paintTracked(ctx, entry, placement, 0.8);
  assert.deepEqual(
    ctx.calls.filter(([name]) => name === 'fillText').map(([, text]) => text),
    ['UAL123', 'FL350 · 451 kts', 'SFO → JFK'],
  );
});

test('shared tactical painter preserves FIRMS card metrics and top-rule treatment', () => {
  const ctx = mockContext();
  const entry = {
    variant: 'selected',
    selected: true,
    cardStyle: 'tactical',
    title: 'FIRE · 1520 MW',
    details: ['high conf · 2h ago', '61.9°N 122.9°W'],
    accent: '224, 82, 82',
  };
  entry._overlayLayout = measureOverlayEntry(ctx, entry, {});
  assert.deepEqual(
    {
      padX: entry._overlayLayout.padX,
      padY: entry._overlayLayout.padY,
      titleH: entry._overlayLayout.titleH,
      lineH: entry._overlayLayout.lineH,
    },
    { padX: 12, padY: 8, titleH: 14, lineH: 15 },
  );
  const placement = placementVariants({
    anchorX: 200,
    anchorY: 160,
    width: entry._overlayLayout.w,
    height: entry._overlayLayout.h,
    viewportWidth: 500,
    viewportHeight: 300,
    gap: 20,
    leaderOffset: 14,
    verticalOnly: true,
  })[0];
  assert.equal(paintTacticalCard(ctx, entry, placement, 0.5), placement.rect);
  assert.deepEqual(ctx.calls.find(([name]) => name === 'moveTo'), ['moveTo', 200, 146]);
  assert.equal(ctx.calls.filter(([name]) => name === 'stroke').length, 2, 'leader + selected border');
  assert.equal(ctx.calls.filter(([name]) => name === 'fillText').length, 3);
  assert.equal(ctx.calls.at(-1)[0], 'restore');
});

test('selected elbow leader reveals from the glyph before its card fades in', () => {
  const animation = {
    leaderAnimationMs: 1000, leaderAnimationStartedAt: 100, leaderDrawRatio: 0.7,
  };
  assert.equal(leaderRevealProgress(animation, 100), 0);
  assert.ok(leaderRevealProgress(animation, 450) > 0.8);
  assert.equal(leaderRevealProgress(animation, 800), 1);
  assert.equal(tacticalCardRevealAlpha(animation, 799), 0);
  assert.ok(tacticalCardRevealAlpha(animation, 950) > 0.4);
  assert.equal(tacticalCardRevealAlpha(animation, 1100), 1);
  const ctx = mockContext();
  const entry = {
    variant: 'selected', selected: true, cardStyle: 'tactical', title: 'CAM-2516',
    details: ['MAPPED'], accent: '#ff6474', leaderStyle: 'elbow',
    leaderAnimationMs: 1, leaderAnimationStartedAt: 0,
  };
  entry._overlayLayout = measureOverlayEntry(ctx, entry, {});
  const placement = placementVariants({
    anchorX: 240, anchorY: 180, width: entry._overlayLayout.w, height: entry._overlayLayout.h,
    viewportWidth: 500, viewportHeight: 300, gap: 20, leaderOffset: 30, verticalOnly: true,
  })[0];
  paintTacticalCard(ctx, entry, placement, 1);
  assert.deepEqual(ctx.calls.find(([name]) => name === 'moveTo'), ['moveTo', 210, 180]);
  const lines = ctx.calls.filter(([name]) => name === 'lineTo');
  assert.ok(lines.length >= 2, 'leader draws horizontally from the glyph, then vertically to the card');
  assert.ok(ctx.calls.some(([name, value]) => name === 'strokeStyle' && value === 'rgba(255, 100, 116, 0.95)'));
});

test('track display text is cached across measure and paint and invalidates on content change', () => {
  const ctx = mockContext();
  const entry = { variant: 'track', title: 'UAL123', details: ['450 KT'] };
  const originalFilter = Array.prototype.filter;
  let filterCalls = 0;
  Array.prototype.filter = function countTrackDisplayFilters(...args) {
    filterCalls++;
    return originalFilter.apply(this, args);
  };
  try {
    entry._overlayLayout = measureOverlayEntry(ctx, entry, {});
    const placement = placementVariants({
      anchorX: 100,
      anchorY: 100,
      width: entry._overlayLayout.w,
      height: entry._overlayLayout.h,
      viewportWidth: 400,
      viewportHeight: 300,
    })[0];
    paintTrack(ctx, entry, placement);
    measureOverlayEntry(ctx, entry, entry._overlayLayout);
    paintTrack(ctx, entry, placement);
    entry.title = 'UAL124';
    entry.details[0] = '451 KT';
    measureOverlayEntry(ctx, entry, entry._overlayLayout);
    paintTrack(ctx, entry, placement);
  } finally {
    Array.prototype.filter = originalFilter;
  }
  assert.equal(filterCalls, 0);
  assert.equal(entry._overlayTrackDisplayText, 'UAL124 · 451 KT');
  assert.deepEqual(
    ctx.calls.filter(([name]) => name === 'fillText').map(([, text]) => text),
    ['UAL123 · 450 KT', 'UAL123 · 450 KT', 'UAL124 · 451 KT'],
  );
});

