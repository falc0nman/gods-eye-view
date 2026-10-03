import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { isCalibratedAllocationRuntime } from '../../scripts/run-unit-tests.mjs';

/** The prebuilt-option focus path stays within 16 B/call. */
test('converged focus treatment stays within the GC-bracketed allocation budget', (t) => {
  if (!isCalibratedAllocationRuntime()) {
    return t.skip(`allocation budgets are calibrated for Node 24; running ${process.versions.node}`);
  }
  const result = spawnSync(
    process.execPath,
    ['--expose-gc', 'scripts/focus-allocation-check.mjs'],
    { cwd: process.cwd(), encoding: 'utf8' },
  );
  assert.equal(result.status, 0, result.stderr || result.stdout);
  const report = JSON.parse(result.stdout.trim());
  assert.ok(report.advanceSpriteFocus.roundedMedian <= 16, result.stdout);
});
