import { test } from 'node:test';
import assert from 'node:assert/strict';
import { formatRadarContext, formatRadarValue } from './readout.js';

test("values read in each product's unit; velocity in knots with direction", () => {
  assert.equal(formatRadarValue('ref', 52.5), '52.5 dBZ');
  assert.equal(formatRadarValue('vel', -30), '58 kt toward');
  assert.equal(formatRadarValue('vel', 0.1), '0 kt');
  assert.equal(formatRadarValue('srv', 64), '64 kt away');
  assert.equal(formatRadarValue('cc', 0.9712), '0.97');
  assert.equal(formatRadarValue('kdp', 1.234), '1.23 °/km');
  assert.equal(formatRadarValue('et', 37), '37 kft');
});

test('classes, range folding and no-data read sensibly', () => {
  assert.equal(formatRadarValue('hc', 'LH'), 'Large hail');
  assert.equal(formatRadarValue('vel', 'RF'), 'Range folded');
  assert.equal(formatRadarValue('ref', null), null);
});

test('context line gives range in km and miles and the beam height', () => {
  assert.equal(
    formatRadarContext({ rangeKm: 87.4, beamHeightFt: 6200 }),
    '87 km / 54 mi · beam 6,200 ft',
  );
  assert.equal(
    formatRadarContext({ rangeKm: 10, beamHeightFt: null }),
    '10 km / 6 mi',
  );
});
