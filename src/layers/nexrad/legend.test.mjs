import { test } from 'node:test';
import assert from 'node:assert/strict';
import { LEVEL3_COLOR_STOPS } from './palette.js';
import { createRadarLegend, radarLegendModel } from './legend.js';

test('the legend is built from the exact colours the server renders with', () => {
  const model = radarLegendModel('cc', { elevationDeg: 0.5 });
  for (const [, color] of LEVEL3_COLOR_STOPS.cc) assert.ok(model.gradient.includes(color));
  assert.deepEqual(model.ticks, ['0.2', '0.45', '0.65', '0.8', '0.9', '0.95', '0.98', '1', '1.05']);
  assert.equal(model.subtitle, '0.5° tilt');
  assert.equal(model.rangeFolded, true);
});

test('velocity is labelled in knots with a toward/away hint', () => {
  const model = radarLegendModel('vel');
  assert.equal(model.unit, 'kt');
  assert.equal(model.ticks[0], '-117', '-60 m/s');
  assert.equal(model.ticks.at(-1), '117');
  assert.equal(model.signHint, true);
  assert.equal(radarLegendModel('srv').ticks.at(-1), '120', 'SRV is already knots');
});

test('hydrometeor class is a key of named classes, not a scale', () => {
  const model = radarLegendModel('hc');
  assert.equal(model.gradient, null);
  assert.ok(model.classes.some((c) => c.label === 'Large hail' && c.color === '#b00030'));
  assert.equal(model.classes.length, 12);
});

test('unknown products (including the retired composite) have no legend', () => {
  assert.equal(radarLegendModel('composite'), null, 'the national mosaic is the Weather Radar layer now');
  assert.equal(radarLegendModel('nope'), null);
});

test('without a document the legend is a harmless no-op', () => {
  const legend = createRadarLegend({ documentRef: undefined });
  legend.show(radarLegendModel('ref'));
  legend.hide();
  legend.destroy();
});
