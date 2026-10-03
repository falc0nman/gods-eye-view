import test from 'node:test';
import assert from 'node:assert/strict';
import {
  registerSpriteCollection,
  restoreSpriteOrder,
  restoreSpriteOrderOnEnable,
  unregisterSpriteCollection,
} from './spriteOrder.js';

const ORDER = ['cctv', 'directions'];

function makePrimitives(initial = []) {
  return {
    items: [...initial],
    calls: [],
    contains(collection) { return this.items.includes(collection); },
    raiseToTop(collection) {
      this.calls.push(collection.id);
      const index = this.items.indexOf(collection);
      if (index >= 0) this.items.splice(index, 1);
      this.items.push(collection);
    },
  };
}

function makeCollection(id, destroyed = false) {
  return { id, isDestroyed: () => destroyed };
}

test('restoreSpriteOrder raises live collections bottom-to-top and skips destroyed entries', () => {
  const collections = Object.fromEntries(ORDER.map((id) => [id, makeCollection(id)]));
  const destroyedCctv = makeCollection('cctv', true);
  registerSpriteCollection('cctv', destroyedCctv);
  registerSpriteCollection('directions', collections.directions);
  const primitives = makePrimitives([collections.directions, destroyedCctv]);

  restoreSpriteOrder({ scene: { primitives } });

  assert.deepEqual(primitives.calls, ['directions']);
  assert.deepEqual(primitives.items.map((item) => item.id), ['cctv', 'directions']);

  for (const id of ORDER) unregisterSpriteCollection(id);
});

test('late CCTV registration still restores directions above the ambient collection', () => {
  const directions = makeCollection('directions');
  const cctv = makeCollection('cctv');
  const primitives = makePrimitives([directions]);
  const viewer = { scene: { primitives } };

  registerSpriteCollection('directions', directions);
  restoreSpriteOrder(viewer);
  primitives.items.push(cctv); // CCTV enabled after directions: it starts on top.
  registerSpriteCollection('cctv', cctv);
  primitives.calls.length = 0;

  restoreSpriteOrder(viewer);

  assert.deepEqual(primitives.calls, ['cctv', 'directions']);
  assert.deepEqual(primitives.items.map((item) => item.id), ['cctv', 'directions']);

  unregisterSpriteCollection('cctv', cctv);
  unregisterSpriteCollection('directions', directions);
});

test('restoreSpriteOrder is inert for destroyed viewers and primitive collections', () => {
  const directions = makeCollection('directions');
  const primitives = makePrimitives([directions]);
  registerSpriteCollection('directions', directions);

  restoreSpriteOrder({ isDestroyed: () => true, scene: { primitives } });
  restoreSpriteOrder({ scene: { primitives: { ...primitives, isDestroyed: () => true } } });

  assert.deepEqual(primitives.calls, []);
  unregisterSpriteCollection('directions', directions);
});

test('restoreSpriteOrder never raises a registered collection absent from scene primitives', () => {
  const directions = makeCollection('directions');
  const primitives = makePrimitives([]);
  registerSpriteCollection('directions', directions);

  restoreSpriteOrder({ scene: { primitives } });

  assert.deepEqual(primitives.calls, []);
  assert.deepEqual(primitives.items, []);
  unregisterSpriteCollection('directions', directions);
});

test('a sprite layer enable path is wired through the shared sprite restorer', () => {
  const viewer = { id: 'viewer' };
  const calls = [];
  const restoreSpy = (value) => calls.push(value);
  restoreSpriteOrderOnEnable('directions', viewer, restoreSpy);
  restoreSpriteOrderOnEnable('flights', viewer, restoreSpy);
  assert.deepEqual(calls, [viewer]);
});
