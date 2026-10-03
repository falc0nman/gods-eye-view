import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ContextControls } from './contextControls.js';

function fixture(t) {
  const calls = [];
  const controls = new ContextControls({
    actions: {
      showToast: (message) => calls.push(`notice:${message}`),
      setClearBusy: (busy) => calls.push(`busy:${busy}`),
    },
  });
  t.after(() => {
    controls.stop();
    controls.disconnect();
  });
  return { controls, calls };
}

test('Clear All reports the cleared count and releases its busy state', async (t) => {
  const { controls, calls } = fixture(t);
  const requests = [];
  controls.connect({
    clearSelectedLayers: async (options) => {
      requests.push(options);
      return {
        targetIds: ['flights', 'traffic'],
        items: [],
        clearedIds: ['flights', 'traffic'],
        notClearedIds: [],
      };
    },
  });
  const first = controls.clearSelectedLayers();
  assert.equal(
    controls.clearSelectedLayers(),
    first,
    'a second click joins the first',
  );
  assert.equal(controls._preservePanelStateDuringLayerClear, true);
  const result = await first;
  assert.deepEqual(result.clearedIds, ['flights', 'traffic']);
  assert.equal(requests.length, 1);
  assert.equal(requests[0].origin, 'user');
  assert.equal(typeof requests[0].notificationToken, 'symbol');
  assert.deepEqual(calls, [
    'busy:true',
    'notice:Cleared 2 data layers',
    'busy:false',
  ]);
  assert.equal(controls._preservePanelStateDuringLayerClear, false);
});

test('Clear All says when nothing was selected or a layer would not clear', async (t) => {
  const { controls, calls } = fixture(t);
  let next = { targetIds: [], items: [], clearedIds: [], notClearedIds: [] };
  controls.connect({ clearSelectedLayers: async () => next });
  await controls.clearSelectedLayers();
  next = {
    targetIds: ['cctv'],
    items: [],
    clearedIds: [],
    notClearedIds: ['cctv'],
  };
  await controls.clearSelectedLayers();
  assert.deepEqual(
    calls.filter((call) => call.startsWith('notice:')),
    [
      'notice:No selected data layers',
      'notice:1 data layer could not be cleared',
    ],
  );
});

test('a failed Clear All toasts once and resolves with the error', async (t) => {
  const { controls, calls } = fixture(t);
  t.mock.method(console, 'warn', () => {});
  const failure = new Error('boom');
  controls.connect({
    clearSelectedLayers: async () => {
      throw failure;
    },
  });
  const result = await controls.clearSelectedLayers();
  assert.equal(result.error, failure);
  assert.deepEqual(result.clearedIds, []);
  assert.deepEqual(calls, [
    'busy:true',
    'notice:Selected data layers could not be cleared',
    'busy:false',
  ]);
});

test('Clear All without a manager, or after stop, does nothing', async (t) => {
  const { controls, calls } = fixture(t);
  assert.deepEqual((await controls.clearSelectedLayers()).targetIds, []);
  controls.connect({
    clearSelectedLayers: async () => {
      throw new Error('must not run');
    },
  });
  controls.stop();
  assert.equal((await controls.clearSelectedLayers()).cancelled, true);
  assert.deepEqual(calls, []);
});

test('user-facing actions convert rejection and semantic false into one toast', async (t) => {
  const { controls, calls } = fixture(t);
  t.mock.method(console, 'warn', () => {});
  assert.equal(
    await controls._runUserFacingContextAction(async () => true, 'nope'),
    true,
  );
  assert.equal(
    await controls._runUserFacingContextAction(
      async () => false,
      'false fails',
    ),
    false,
  );
  assert.equal(
    await controls._runUserFacingContextAction(async () => false, 'kept', {
      falseIsFailure: false,
    }),
    false,
  );
  assert.equal(
    await controls._runUserFacingContextAction(async () => {
      throw new Error('x');
    }, 'threw'),
    false,
  );
  assert.deepEqual(calls, ['notice:false fails', 'notice:threw']);
  controls.stop();
  assert.equal(
    await controls._runUserFacingContextAction(async () => true),
    false,
  );
});

test('a broken toast surface cannot turn a failed action into a rejection', async (t) => {
  t.mock.method(console, 'warn', () => {});
  const controls = new ContextControls({
    actions: {
      showToast: () => {
        throw new Error('toast broke');
      },
      setClearBusy: () => {},
    },
  });
  assert.equal(
    await controls._runUserFacingContextAction(async () => false),
    false,
  );
  controls.stop();
});
