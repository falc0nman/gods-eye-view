// NAMING THE MISSING KEY — a control a provider key holds back must say which
// key, or the operator is left with a dead row and no next step. Two halves
// are pinned here: the manager publishes a layer's declared key on the row,
// and the panel turns the pair into guidance that names the environment
// variable.
//
// Run with: npm test
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { layerKeyRequirementTooltip } from './layerPanel.js';
import { DataLayerManager } from '../data/manager.js';
test('the guidance names the environment variable and where to set it', () => {
  const text = layerKeyRequirementTooltip({
    requiresKeyId: 'tomtom',
    stats: { keyRequired: true },
  });
  assert.match(text, /TOMTOM_API_KEY/);
  assert.match(text, /configure it on the server/);
});

test('guidance appears only for a key that is actually missing and actually named', () => {
  for (const layer of [
    undefined,
    {},
    { requiresKeyId: 'tomtom' },
    { requiresKeyId: 'tomtom', stats: {} },
    { requiresKeyId: 'tomtom', stats: { keyRequired: false } },
    // Truthy but not the boolean the contract asks for: a stray string must
    // not be read as "the key is missing".
    { requiresKeyId: 'tomtom', stats: { keyRequired: 'yes' } },
    // Missing key, but the layer never said which one.
    { stats: { keyRequired: true } },
    { requiresKeyId: '', stats: { keyRequired: true } },
    { requiresKeyId: '   ', stats: { keyRequired: true } },
    // An id the registry does not know must not be guessed at: guidance
    // naming the wrong variable sends the operator to the wrong provider.
    { requiresKeyId: 'not-a-provider', stats: { keyRequired: true } },
  ]) {
    assert.equal(
      layerKeyRequirementTooltip(layer),
      '',
      `${JSON.stringify(layer)} must produce no guidance`,
    );
  }
});

test('the manager publishes the declared key id on the row', async () => {
  const manager = new DataLayerManager();
  const base = {
    name: 'Test layer',
    icon: '•',
    source: 'Test',
    init() {},
    enable() {},
    disable() {},
    update() {},
    destroy() {},
  };
  manager.register({
    ...base,
    id: 'gated',
    requiresKeyId: 'tomtom',
    getStats: () => ({ count: 0, keyRequired: true }),
  });
  manager.register({
    ...base,
    id: 'ungated',
    getStats: () => ({ count: 3, lastUpdate: Date.now() }),
  });

  // The manager consults a layer's getStats() only once it is initialized, so
  // the rows are read the way the panel reads them: after the layers are on.
  await manager.setEnabled('gated', true);
  await manager.setEnabled('ungated', true);

  const rows = manager.getAll();
  const gated = rows.find((row) => row.id === 'gated');
  const ungated = rows.find((row) => row.id === 'ungated');
  assert.equal(gated.requiresKeyId, 'tomtom');
  assert.equal(gated.stats.keyRequired, true);
  assert.match(layerKeyRequirementTooltip(gated), /TOMTOM_API_KEY/);

  assert.equal(
    ungated.requiresKeyId,
    null,
    'a layer that needs no key declares none',
  );
  assert.equal(layerKeyRequirementTooltip(ungated), '');
});
