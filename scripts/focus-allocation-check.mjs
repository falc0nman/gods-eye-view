#!/usr/bin/env node
import assert from 'node:assert/strict';
import {
  advanceSpriteFocus,
} from '../src/data/focusDeemphasis.js';

if (typeof global.gc !== 'function') {
  throw new Error('focus-allocation-check.mjs requires node --expose-gc');
}

const CALLS = 100_000;
const TRIALS = 9;
const WARMUP_CALLS = 200_000;
const PURE_CALL_BUDGET = 16;

function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
}

function bytesPerCall(fn) {
  for (let index = 0; index < WARMUP_CALLS; index += 1) fn();
  const samples = [];
  for (let trial = 0; trial < TRIALS; trial += 1) {
    global.gc();
    const before = process.memoryUsage().heapUsed;
    let checksum = 0;
    for (let index = 0; index < CALLS; index += 1) checksum += fn();
    const after = process.memoryUsage().heapUsed;
    // Keep the returned scalar observable so V8 cannot delete the calls.
    assert.ok(Number.isFinite(checksum));
    samples.push((after - before) / CALLS);
  }
  const rawMedian = median(samples);
  return { rawMedian, samples };
}

function netOfLoopBaseline(observed, baseline) {
  // V8's callback/checksum loop itself retains roughly one boxed-number word
  // per call until the next collection. Subtract the identically measured
  // no-op loop so this gate reports allocation attributable to the treatment.
  const rawMedian = Math.max(0, observed.rawMedian - baseline.rawMedian);
  return {
    rawMedian,
    roundedMedian: Math.round(rawMedian),
    observedRawMedian: observed.rawMedian,
    baselineRawMedian: baseline.rawMedian,
    samples: observed.samples,
  };
}

const target = {
  screenRect: { left: 0, top: 0, right: 10, bottom: 10 },
  paddingPx: 18,
  cameraDistance: 1000,
};
const sprite = {};
const focusInput = {
  screenPosition: { x: 5, y: 5 },
  cameraDistance: 1200,
  nowMs: 1000,
  target,
};

const baseline = bytesPerCall(() => focusInput.nowMs);
const focus = netOfLoopBaseline(
  bytesPerCall(() => advanceSpriteFocus(sprite, focusInput).factor),
  baseline,
);
assert.ok(
  focus.roundedMedian <= PURE_CALL_BUDGET,
  `advanceSpriteFocus allocated ${focus.rawMedian.toFixed(3)} B/call median`,
);
console.log(JSON.stringify({
  callsPerTrial: CALLS,
  trials: TRIALS,
  budgets: { pureCall: PURE_CALL_BUDGET },
  loopBaseline: baseline,
  advanceSpriteFocus: focus,
}));
