import { readShellSource } from '../testSupport/readShellSource.mjs';
import { expandApplicationHtml } from '../../build/application-html.js';
import { readLayerSource } from '../testSupport/readLayerSource.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';

import { DataLayerManager } from './manager.js';
import {
  LEGACY_LAYER_STATE_TOKENS,
  LAYER_STATE_REGISTRY,
  LAYER_STATE_STORAGE_KEY,
  LAYER_STATE_TOKEN_ALPHABET,
  LAYER_STATE_TOKEN_RESERVATIONS,
  LayerStateCoordinator,
  REGISTERED_LAYER_IDS,
  SHARE_TRACKING_RESTORE_POLICIES,
  createDefaultLayerState,
  decodeLayerStateParams,
  encodeLayerStateParams,
  nextLayerStateToken,
  normalizeLayerState,
  parseStoredLayerState,
  serializeStoredLayerState,
  validateLayerStateAllocations,
  validateLayerStateRegistry,
} from './layerState.js';
import radioLayer from './radio.js';
import { stampInitialShareGesture } from '../navigationPolicy.js';

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function paramsForLayer(id) {
  if (id === 'cctv') {
    return {
      coverageMode: 'on',
      showProjection: true,
      autoHop: false,
      autoHopSec: 22,
      selectedCameraId: 'secret-camera',
      calibrationMode: true,
      calibration: { cameraId: 'secret-camera', values: { heading: 12 } },
    };
  }
  if (id === 'radio') {
    return {
      filter: 'all',
      volume: 0.8,
      selectedStationId: 'private-station',
      audioState: 'playing',
      voiceDucked: true,
    };
  }
  return null;
}

function fakeLayer(id, hooks = {}) {
  let params = paramsForLayer(id);
  return {
    id,
    name: id,
    icon: '',
    source: 'test',
    async init() {
      return hooks.init ? hooks.init() : true;
    },
    async enable() {
      return hooks.enable ? hooks.enable() : true;
    },
    async update() {
      return hooks.update ? hooks.update() : true;
    },
    async disable() {
      return hooks.disable ? hooks.disable() : true;
    },
    ...(hooks.resolveTrackingRestoreTarget
      ? {
          async resolveTrackingRestoreTarget(targetId, options) {
            return hooks.resolveTrackingRestoreTarget(targetId, options);
          },
        }
      : {}),
    ...(params
      ? {
          setParams(next = {}, options = {}) {
            if (hooks.setParams) {
              const result = hooks.setParams(next, options);
              if (result === false) return false;
              // 'defer' models the production tracking latch: the layer ACCEPTS the
              // request and holds it pending, but getParams() keeps reporting the
              // previous (still-untracked) value until the subject really arrives.
              if (result === 'defer') return true;
            }
            params = { ...params, ...next };
            return true;
          },
          /** Test seam: a deferred subject finally arrives on a later poll. */
          _arrive(next) {
            params = { ...params, ...next };
          },
          getParams() {
            return { ...params };
          },
          ...(hooks.cancelPendingTrackingRestore
            ? {
                cancelPendingTrackingRestore(options) {
                  hooks.cancelPendingTrackingRestore(options);
                },
              }
            : {}),
        }
      : {}),
  };
}

function productionManager(hooksById = {}) {
  const manager = new DataLayerManager({});
  for (const id of REGISTERED_LAYER_IDS)
    manager.register(fakeLayer(id, hooksById[id] || {}));
  manager.finalizeRegistrations(LAYER_STATE_REGISTRY);
  return manager;
}

/**
 * Deterministic clock + timer queue for the pending-tracking window, so the
 * 90 s / 45 s / 300 s expiries are provable without sleeping.
 */
function manualTimers(startMs = 0) {
  let nowMs = startMs;
  let queued = null;
  return {
    now: () => nowMs,
    setTimer: (fn, ms) => {
      queued = { fn, ms };
      return queued;
    },
    clearTimer: (handle) => {
      if (queued === handle) queued = null;
    },
    /** Fire queued polls, advancing the clock, until nothing re-arms. */
    runUntilIdle(maxTicks = 2_000) {
      for (let tick = 0; tick < maxTicks; tick += 1) {
        const pending = queued;
        if (!pending) return;
        queued = null;
        nowMs += pending.ms;
        pending.fn();
      }
      throw new Error('pending-tracking watch never settled');
    },
  };
}

function memoryStorage(initial = null) {
  const values = new Map();
  if (initial !== null) values.set(LAYER_STATE_STORAGE_KEY, initial);
  return {
    writes: [],
    getItem(key) {
      return values.has(key) ? values.get(key) : null;
    },
    setItem(key, value) {
      values.set(key, value);
      this.writes.push([key, value]);
    },
  };
}

function shareSink() {
  return {
    provider: null,
    updates: 0,
    setLayerStateProvider(provider) {
      this.provider = provider;
    },
    onLayerStateChange() {
      this.updates += 1;
    },
  };
}

function encode(state) {
  const params = new URLSearchParams([['v', '2']]);
  encodeLayerStateParams(params, state);
  return params.toString();
}

test('production registry is exact, canonical, and rejects incomplete contracts', async () => {
  assert.equal(validateLayerStateRegistry(), true);
  assert.equal(REGISTERED_LAYER_IDS.length, 13);
  assert.equal(new Set(REGISTERED_LAYER_IDS).size, 13);
  assert.equal(REGISTERED_LAYER_IDS.includes('transit'), false);
  assert.deepEqual(REGISTERED_LAYER_IDS, [...REGISTERED_LAYER_IDS].sort());
  assert.deepEqual(LEGACY_LAYER_STATE_TOKENS, {
    'ais-live-vessels': 'a',
    'alpr-cameras': 'p',
    'bhote-koshi-2026': 'h',
    'bhote-koshi-locator': 'z',
    bikeshare: 'b',
    cctv: 'c',
    directions: 'n',
    earthquakes: 'e',
    'fire-perimeters': '2',
    flights: 'f',
    'local-dams': 'q',
    'local-datacenters': 'd',
    'local-firms': 'w',
    military: 'm',
    'military-awareness': 'g',
    'military-installations': 'i',
    radio: 'r',
    'recent-imagery': '1',
    'rocket-launches': 'x',
    satellites: 's',
    'telegeography-submarine-cables': 'u',
    traffic: 't',
    transit: 'j',
    'weather-cyclones': 'y',
    'weather-lightning': 'l',
    'weather-radar': 'v',
    'weather-satellite': 'o',
    wind: 'k',
  });
  for (const { id, token } of LAYER_STATE_REGISTRY) {
    assert.equal(LAYER_STATE_TOKEN_RESERVATIONS[id], token);
  }
  for (const [id, token] of Object.entries(LEGACY_LAYER_STATE_TOKENS)) {
    assert.equal(LAYER_STATE_TOKEN_RESERVATIONS[id], token);
  }
  // Free digits are derived from the live ledger: every layer added since the
  // ledger was introduced publishes one (storm chase took 0, 3 and 4).
  const FREE = [...'0123456789'].filter(
    (digit) => !Object.values(LAYER_STATE_TOKEN_RESERVATIONS).includes(digit),
  );
  assert.equal(nextLayerStateToken(), FREE[0]);
  assert.equal(
    nextLayerStateToken({
      ...LAYER_STATE_TOKEN_RESERVATIONS,
      alpha: FREE[0],
      bravo: FREE[1],
    }),
    FREE[2],
  );
  const digitsExhausted = {
    ...LAYER_STATE_TOKEN_RESERVATIONS,
    ...Object.fromEntries(FREE.map((digit) => [`prior-${digit}`, digit])),
  };
  assert.equal(nextLayerStateToken(digitsExhausted), '00');
  assert.equal(
    nextLayerStateToken({ ...digitsExhausted, retired: '00', used: '01' }),
    '02',
  );
  assert.equal(
    nextLayerStateToken({
      ...digitsExhausted,
      ...Object.fromEntries(
        [...LAYER_STATE_TOKEN_ALPHABET].map((second) => [
          `pair-0${second}`,
          `0${second}`,
        ]),
      ),
    }),
    '10',
  );
  assert.throws(
    () =>
      nextLayerStateToken(
        Object.fromEntries(
          [
            ...'0123456789',
            ...[...LAYER_STATE_TOKEN_ALPHABET].flatMap((first) =>
              [...LAYER_STATE_TOKEN_ALPHABET].map(
                (second) => `${first}${second}`,
              ),
            ),
          ].map((token, index) => [`occupied-${index}`, token]),
        ),
      ),
    /namespace exhausted/,
  );
  assert.equal(
    validateLayerStateRegistry(
      [{ id: 'future-layer', token: '0', disposition: 'enabled-only' }],
      { 'future-layer': '0' },
    ),
    true,
  );
  assert.equal(
    validateLayerStateRegistry(
      [{ id: 'future-layer', token: '01', disposition: 'enabled-only' }],
      { retired: '00', 'future-layer': '01' },
    ),
    true,
  );
  assert.equal(
    validateLayerStateAllocations(LAYER_STATE_TOKEN_RESERVATIONS, {
      ...LAYER_STATE_TOKEN_RESERVATIONS,
      future: FREE[0],
      next: FREE[1],
    }),
    true,
  );
  assert.throws(
    () =>
      validateLayerStateAllocations(LAYER_STATE_TOKEN_RESERVATIONS, {
        ...LAYER_STATE_TOKEN_RESERVATIONS,
        future: '00',
      }),
    new RegExp(`next free token ${FREE[0]}`),
  );
  const beforeLastDigit = { ...digitsExhausted };
  delete beforeLastDigit[`prior-${FREE.at(-1)}`];
  assert.equal(
    validateLayerStateAllocations(beforeLastDigit, {
      ...beforeLastDigit,
      futurePair: '00',
      futureDigit: FREE.at(-1),
    }),
    true,
  );
  assert.equal(
    validateLayerStateAllocations(digitsExhausted, {
      ...digitsExhausted,
      pairB: '01',
      pairA: '00',
    }),
    true,
  );
  assert.throws(
    () =>
      validateLayerStateAllocations(
        { ...LAYER_STATE_TOKEN_RESERVATIONS, merged: FREE[0] },
        {
          ...LAYER_STATE_TOKEN_RESERVATIONS,
          merged: FREE[0],
          competing: FREE[0],
        },
      ),
    new RegExp('next free token ' + FREE[1]),
  );
  assert.throws(
    () => validateLayerStateAllocations({ future: '00' }, { future: '01' }),
    /changed or removed/,
  );
  assert.throws(
    () => validateLayerStateAllocations({ retired: '00' }, { newcomer: '00' }),
    /changed or removed/,
  );
  assert.throws(
    () =>
      validateLayerStateRegistry([
        ...LAYER_STATE_REGISTRY,
        LAYER_STATE_REGISTRY[0],
      ]),
    /Duplicate layer-state id/,
  );
  assert.throws(
    () =>
      validateLayerStateRegistry(
        [{ id: 'future-layer', token: '000', disposition: 'enabled-only' }],
        { 'future-layer': '000' },
      ),
    /Invalid layer-state token reservation/,
  );
  assert.throws(
    () =>
      validateLayerStateRegistry(
        [{ id: 'future-layer', token: 'a', disposition: 'enabled-only' }],
        { 'future-layer': 'a' },
      ),
    /Legacy layer-state token is immutable/,
  );
  assert.throws(
    () =>
      validateLayerStateRegistry(
        [{ id: 'flights', token: '0', disposition: 'enabled-only' }],
        { flights: '0' },
      ),
    /Legacy layer-state token is immutable/,
  );

  const manager = new DataLayerManager({});
  manager.register(fakeLayer('weather-cyclones'));
  assert.throws(
    () => manager.register(fakeLayer('weather-cyclones')),
    /Duplicate data-layer id/,
  );
  await assert.rejects(
    manager.restoreLayerState('weather-cyclones', { enabled: true }),
    /finalized/,
  );
  assert.throws(() => manager.finalizeRegistrations([]), /registry mismatch/);
  assert.throws(
    () =>
      manager.finalizeRegistrations([
        { id: 'weather-cyclones', disposition: 'default' },
      ]),
    /Invalid layer serialization disposition/,
  );
  assert.equal(
    manager.finalizeRegistrations([
      { id: 'weather-cyclones', disposition: 'enabled-only' },
    ]),
    true,
  );
  assert.throws(() => manager.register(fakeLayer('radio')), /finalized/);
  assert.throws(
    () => manager.registerForQa(fakeLayer('radio')),
    /not authorized/,
  );
  const qaManager = new DataLayerManager({}, { allowQaRegistration: true });
  qaManager.register(fakeLayer('weather-cyclones'));
  qaManager.finalizeRegistrations([
    { id: 'weather-cyclones', disposition: 'enabled-only' },
  ]);
  qaManager.registerForQa(fakeLayer('radio'));
  assert.equal(qaManager.layers.has('radio'), true);
  assert.equal(await qaManager.unregisterForQa('radio'), true);
  assert.equal(qaManager.layers.has('radio'), false);
});

test('v2 codec distinguishes absent from empty and keeps canonical deterministic ordering', () => {
  assert.equal(
    decodeLayerStateParams(new URLSearchParams('lat=1&lon=2')),
    null,
  );
  assert.equal(decodeLayerStateParams(new URLSearchParams('v=1&l=e')), null);
  assert.equal(decodeLayerStateParams(new URLSearchParams('v=3&l=e')), null);
  assert.equal(decodeLayerStateParams(new URLSearchParams('v=2')), null);

  const empty = decodeLayerStateParams(new URLSearchParams('v=2&l='));
  assert.deepEqual(empty.enabledLayerIds, []);
  assert.deepEqual(empty.options.cctv, {
    coverageMode: 'on',
    showProjection: true,
    autoHop: false,
  });

  const first = normalizeLayerState({
    enabledLayerIds: ['traffic', 'cctv', 'weather-cyclones', 'cctv'],
    options: {
      radio: { volume: 0.37, filter: 'news' },
      cctv: { autoHop: true, coverageMode: 'viewshed', showProjection: false },
    },
  });
  const second = normalizeLayerState({
    enabledLayerIds: ['weather-cyclones', 'cctv', 'traffic'],
    options: {
      cctv: { showProjection: false, coverageMode: 'viewshed', autoHop: true },
      radio: { filter: 'news', volume: 0.37 },
    },
  });
  assert.equal(encode(first), encode(second));
  assert.deepEqual(
    decodeLayerStateParams(new URLSearchParams(encode(first))),
    first,
  );
});

test('all production layers and options round-trip through a v2 share URL', () => {
  const allEnabled = normalizeLayerState({
    enabledLayerIds: REGISTERED_LAYER_IDS,
    options: {
      cctv: { coverageMode: 'viewshed', showProjection: false, autoHop: true },
      radio: { filter: 'news', volume: 0.37 },
    },
  });
  const shareUrl = new URL('https://example.invalid/');
  shareUrl.hash = encode(allEnabled);
  const params = new URLSearchParams(shareUrl.hash.slice(1));
  const restored = decodeLayerStateParams(params);

  assert.equal(params.get('l')?.split('.').length, REGISTERED_LAYER_IDS.length);
  assert.deepEqual(restored?.enabledLayerIds, REGISTERED_LAYER_IDS);
  assert.deepEqual(restored?.options, allEnabled.options);
});

test('unknown enabled-layer tokens reject the payload instead of becoming an empty set', () => {
  assert.equal(
    decodeLayerStateParams(new URLSearchParams('v=2&l=unknown')),
    null,
  );
  assert.equal(
    decodeLayerStateParams(new URLSearchParams('v=2&l=c.unknown')),
    null,
  );
});

test('malformed enabled-layer lists reject the entire payload', () => {
  for (const value of ['.c', 'c.', 'c..e', 'c.c', '00', 'c.00']) {
    assert.equal(
      decodeLayerStateParams(new URLSearchParams(`v=2&l=${value}`)),
      null,
      `l=${value}`,
    );
  }
  assert.deepEqual(
    decodeLayerStateParams(new URLSearchParams('v=2&l=c.y')).enabledLayerIds,
    ['cctv', 'weather-cyclones'],
  );
  for (const fields of ['l=f&l=f', 'l=f&l=unknown', 'l=&l=f']) {
    assert.equal(
      decodeLayerStateParams(new URLSearchParams(`v=2&${fields}`)),
      null,
      fields,
    );
  }
});

test('removed layers keep their tokens reserved and old links skip them', () => {
  // GW-53 removed the Bhote Koshi event (h) and locator (z). Their tokens
  // stay in the ledger so no new layer can reuse them.
  assert.equal(LAYER_STATE_TOKEN_RESERVATIONS['bhote-koshi-2026'], 'h');
  assert.equal(LAYER_STATE_TOKEN_RESERVATIONS['bhote-koshi-locator'], 'z');
  assert.equal(REGISTERED_LAYER_IDS.includes('bhote-koshi-2026'), false);
  const decoded = decodeLayerStateParams(new URLSearchParams('v=2&l=h.c.z'));
  assert.deepEqual(decoded.enabledLayerIds, ['cctv']);
  assert.deepEqual(decoded.retiredLayerIds, [
    'bhote-koshi-2026',
    'bhote-koshi-locator',
  ]);
  assert.ok(encode(decoded).includes('l=c'));
  // GW-57 removed submarine cables (u) the same way.
  assert.equal(
    LAYER_STATE_TOKEN_RESERVATIONS['telegeography-submarine-cables'],
    'u',
  );
  assert.deepEqual(
    decodeLayerStateParams(new URLSearchParams('v=2&l=c.u')).retiredLayerIds,
    ['telegeography-submarine-cables'],
  );
  // ...and ALPR cameras (p).
  assert.equal(LAYER_STATE_TOKEN_RESERVATIONS['alpr-cameras'], 'p');
  assert.deepEqual(
    decodeLayerStateParams(new URLSearchParams('v=2&l=p.c')).retiredLayerIds,
    ['alpr-cameras'],
  );
  // ...and earthquakes (e).
  assert.equal(LAYER_STATE_TOKEN_RESERVATIONS.earthquakes, 'e');
  assert.deepEqual(
    decodeLayerStateParams(new URLSearchParams('v=2&l=e.c')).retiredLayerIds,
    ['earthquakes'],
  );
  // ...and FIRMS fires (w) and fire perimeters (2).
  assert.equal(LAYER_STATE_TOKEN_RESERVATIONS['local-firms'], 'w');
  assert.equal(LAYER_STATE_TOKEN_RESERVATIONS['fire-perimeters'], '2');
  assert.deepEqual(
    decodeLayerStateParams(new URLSearchParams('v=2&l=2.k.1.w'))
      .retiredLayerIds,
    ['fire-perimeters', 'local-firms'],
  );
  // ...and bikeshare (b).
  assert.equal(LAYER_STATE_TOKEN_RESERVATIONS.bikeshare, 'b');
  assert.deepEqual(
    decodeLayerStateParams(new URLSearchParams('v=2&l=b.c')).retiredLayerIds,
    ['bikeshare'],
  );
  // ...and transit (j).
  assert.equal(LAYER_STATE_TOKEN_RESERVATIONS.transit, 'j');
  assert.deepEqual(
    decodeLayerStateParams(new URLSearchParams('v=2&l=j.c')).retiredLayerIds,
    ['transit'],
  );
  // ...and data centers (d) and dams (q).
  assert.equal(LAYER_STATE_TOKEN_RESERVATIONS['local-datacenters'], 'd');
  assert.equal(LAYER_STATE_TOKEN_RESERVATIONS['local-dams'], 'q');
  assert.deepEqual(
    decodeLayerStateParams(new URLSearchParams('v=2&l=c.d.q')).retiredLayerIds,
    ['local-datacenters', 'local-dams'],
  );
  // ...and rocket launches (x).
  assert.equal(LAYER_STATE_TOKEN_RESERVATIONS['rocket-launches'], 'x');
  assert.deepEqual(
    decodeLayerStateParams(new URLSearchParams('v=2&l=c.x')).retiredLayerIds,
    ['rocket-launches'],
  );
  // ...and satellites (s), the first retired layer that owned options: its
  // option assignments are skipped with it, and the rest of the link restores.
  assert.equal(LAYER_STATE_TOKEN_RESERVATIONS.satellites, 's');
  const retiredWithOptions = decodeLayerStateParams(
    new URLSearchParams('v=2&l=c.s&lo=s.c.d_s.t.25544_c.c.v'),
  );
  assert.deepEqual(retiredWithOptions.enabledLayerIds, ['cctv']);
  assert.deepEqual(retiredWithOptions.retiredLayerIds, ['satellites']);
  assert.equal(Object.hasOwn(retiredWithOptions.options, 'satellites'), false);
  assert.equal(retiredWithOptions.options.cctv.coverageMode, 'viewshed');
  // ...and military awareness (g).
  assert.equal(LAYER_STATE_TOKEN_RESERVATIONS['military-awareness'], 'g');
  assert.deepEqual(
    decodeLayerStateParams(new URLSearchParams('v=2&l=c.g')).retiredLayerIds,
    ['military-awareness'],
  );
  // ...and military installations (i).
  assert.equal(LAYER_STATE_TOKEN_RESERVATIONS['military-installations'], 'i');
  assert.deepEqual(
    decodeLayerStateParams(new URLSearchParams('v=2&l=c.i')).retiredLayerIds,
    ['military-installations'],
  );
  // ...and AIS vessels (a).
  assert.equal(LAYER_STATE_TOKEN_RESERVATIONS['ais-live-vessels'], 'a');
  assert.deepEqual(
    decodeLayerStateParams(new URLSearchParams('v=2&l=c.a')).retiredLayerIds,
    ['ais-live-vessels'],
  );
  // ...and civilian (f) and military (m) flights, with their 3D and tracking
  // options.
  assert.equal(LAYER_STATE_TOKEN_RESERVATIONS.flights, 'f');
  assert.equal(LAYER_STATE_TOKEN_RESERVATIONS.military, 'm');
  const retiredFlights = decodeLayerStateParams(
    new URLSearchParams('v=2&l=c.f.m&lo=f.e.1_f.m.a_f.t.abc123_f.u.xyz'),
  );
  assert.deepEqual(retiredFlights.enabledLayerIds, ['cctv']);
  assert.deepEqual(retiredFlights.retiredLayerIds, ['flights', 'military']);
  assert.equal(Object.hasOwn(retiredFlights.options, 'flights'), false);
  // A token that was never reserved is still malformed.
  assert.equal(decodeLayerStateParams(new URLSearchParams('v=2&l=c.Q')), null);
  assert.equal(decodeLayerStateParams(new URLSearchParams('v=2&l=h.h')), null);
});

test('unknown and forbidden option fields are ignored while missing options use codec defaults', () => {
  const decoded = decodeLayerStateParams(
    new URLSearchParams(
      'v=2&l=c.y&lo=c.c.v_c.z.1_z.c.1_f.e.1_f.m.a_r.f.n_r.v.35',
    ),
  );
  assert.deepEqual(decoded.enabledLayerIds, ['cctv', 'weather-cyclones']);
  assert.deepEqual(decoded.options.cctv, {
    coverageMode: 'viewshed',
    showProjection: true,
    autoHop: false,
  });
  assert.equal(Object.hasOwn(decoded.options, 'flights'), false);
  assert.deepEqual(decoded.options.radio, { filter: 'news', volume: 0.35 });

  const raw = normalizeLayerState({
    enabledLayerIds: ['cctv', 'unknown-layer'],
    options: {
      cctv: {
        coverageMode: 'off',
        selectedCameraId: 'private-camera',
        calibrationMode: true,
        calibration: { secret: 'do-not-share' },
        autoHopSec: 99,
      },
      radio: {
        filter: 'genre:ambient',
        volume: 0.66,
        selectedStationId: 'private-station',
        audioState: 'playing',
        voiceDucked: true,
      },
    },
  });
  const serialized = `${encode(raw)} ${serializeStoredLayerState(raw)}`;
  for (const forbidden of [
    'private-camera',
    'calibration',
    'autoHopSec',
    'irBoost',
    'showPoints',
    'showOrbits',
    'private-station',
    'audioState',
    'voiceDucked',
    'secret',
  ])
    assert.equal(serialized.includes(forbidden), false, forbidden);
});

test('Radio genre ids with spaces and ampersands round-trip through v2', () => {
  for (const filter of ['genre:hip hop', 'genre:r&b']) {
    const state = normalizeLayerState({
      enabledLayerIds: ['radio'],
      options: { radio: { filter, volume: 0.5 } },
    });
    const decoded = decodeLayerStateParams(new URLSearchParams(encode(state)));
    assert.equal(decoded.options.radio.filter, filter);
  }
});

test('compact URL omits absent-meaning option state and still resolves to it', () => {
  const state = createDefaultLayerState();
  state.enabledLayerIds = ['wind'];
  state.options.wind.overlay = 'speed'; // Frozen v2 omitted-token meaning; new boots use trails.
  const params = encodeLayerStateParams(new URLSearchParams('v=2'), state);
  assert.equal(params.has('lo'), false);
  const roundTrip = decodeLayerStateParams(params);
  assert.equal(roundTrip.options.wind.overlay, 'speed');
});

test('stored state is deterministic, rejects other versions, and stays within a tested URL bound', () => {
  const state = createDefaultLayerState();
  state.enabledLayerIds = [...REGISTERED_LAYER_IDS].reverse();
  state.options.cctv = {
    coverageMode: 'viewshed',
    showProjection: false,
    autoHop: true,
  };
  state.options.radio = { filter: 'genre:experimental-ambient', volume: 1 };
  const stored = serializeStoredLayerState(state);
  assert.deepEqual(parseStoredLayerState(stored), normalizeLayerState(state));
  assert.equal(parseStoredLayerState('{"v":1,"l":[]}'), null);
  assert.ok(encode(state).length < 420, encode(state));
});

test('restore applies sanitized params after init and before enable', async () => {
  const order = [];
  const manager = productionManager({
    cctv: {
      init: () => {
        order.push('init');
        return true;
      },
      setParams: () => {
        order.push('params');
        return true;
      },
      enable: () => {
        order.push('enable');
        return true;
      },
      update: () => {
        order.push('update');
        return true;
      },
    },
  });
  const outcome = await manager.restoreLayerState(
    'cctv',
    {
      enabled: true,
      params: { coverageMode: 'viewshed', autoHop: true },
    },
    { origin: 'share-restore' },
  );
  assert.deepEqual(order, ['init', 'params', 'enable', 'update']);
  assert.equal(outcome.succeeded, true);
  assert.equal(outcome.persistenceWrite, false);
  assert.deepEqual(outcome.appliedOptions, {
    coverageMode: 'viewshed',
    autoHop: true,
  });
});

test('manager forwards passive restore origin into module parameter application', async () => {
  const seen = [];
  const manager = productionManager({
    cctv: {
      setParams: (_params, options) => {
        seen.push(options);
      },
    },
  });
  await manager.restoreLayerState(
    'cctv',
    {
      enabled: false,
      params: { autoHop: true },
    },
    { origin: 'share-restore' },
  );
  assert.deepEqual(seen, [{ origin: 'share-restore', paramsIntentEpoch: 1 }]);
});

test('share payload wins over local, passive restore writes nothing, and explicit success persists', async () => {
  const local = createDefaultLayerState();
  local.enabledLayerIds = ['traffic'];
  const storage = memoryStorage(serializeStoredLayerState(local));
  const manager = productionManager();
  const share = shareSink();
  const coordinator = new LayerStateCoordinator(manager, share, { storage });
  const explicitEmpty = createDefaultLayerState();
  await coordinator.start({ shareLayerState: explicitEmpty });

  assert.equal(coordinator.source, 'share');
  assert.deepEqual(coordinator.getDurableState().enabledLayerIds, []);
  assert.deepEqual(storage.writes, []);
  assert.equal(share.provider().enabledLayerIds.length, 0);

  await manager.setEnabled('weather-cyclones', true, { origin: 'user' });
  assert.deepEqual(coordinator.getDurableState().enabledLayerIds, [
    'weather-cyclones',
  ]);
  assert.equal(storage.writes.length, 1);

  await manager.setEnabled('traffic', true, { origin: 'scene' });
  assert.equal(storage.writes.length, 1);
  assert.deepEqual(coordinator.getDurableState().enabledLayerIds, [
    'weather-cyclones',
  ]);

  await manager.setEnabled('traffic', true, { origin: 'tool' });
  assert.equal(storage.writes.length, 2);
  assert.deepEqual(coordinator.getDurableState().enabledLayerIds, [
    'traffic',
    'weather-cyclones',
  ]);

  manager.setLayerParams(
    'cctv',
    { selectedCameraId: 'private-camera' },
    { origin: 'user' },
  );
  assert.equal(storage.writes.length, 2);
  assert.deepEqual(coordinator.getDurableState().options.cctv, {
    coverageMode: 'on',
    showProjection: true,
    autoHop: false,
  });

  manager.setLayerParams('cctv', { coverageMode: 'off' }, { origin: 'scene' });
  assert.equal(storage.writes.length, 2);
  assert.equal(coordinator.getDurableState().options.cctv.coverageMode, 'on');

  manager.setLayerParams(
    'cctv',
    { coverageMode: 'viewshed' },
    { origin: 'voice' },
  );
  assert.equal(storage.writes.length, 3);
  assert.equal(
    coordinator.getDurableState().options.cctv.coverageMode,
    'viewshed',
  );
  coordinator.destroy();
});

test('absent share payload restores local state without rewriting it', async () => {
  const local = createDefaultLayerState();
  local.enabledLayerIds = ['weather-cyclones', 'radio'];
  local.options.radio = { filter: 'talk', volume: 0.42 };
  const storage = memoryStorage(serializeStoredLayerState(local));
  const manager = productionManager();
  const coordinator = new LayerStateCoordinator(manager, shareSink(), {
    storage,
  });
  const results = await coordinator.start();
  assert.equal(coordinator.source, 'local');
  assert.equal(manager.isEnabled('weather-cyclones'), true);
  assert.equal(manager.isEnabled('radio'), true);
  assert.deepEqual(manager.getLayerParams('radio'), {
    filter: 'talk',
    volume: 0.42,
    selectedStationId: 'private-station',
    audioState: 'playing',
    voiceDucked: true,
  });
  assert.equal(
    results.every((result) => result.persistenceWrite === false),
    true,
  );
  assert.deepEqual(storage.writes, []);
  coordinator.destroy();
});

test('historical share payload suppresses unrelated local layer preferences', async () => {
  const local = createDefaultLayerState();
  local.enabledLayerIds = ['traffic', 'radio'];
  const storage = memoryStorage(serializeStoredLayerState(local));
  const manager = productionManager();
  const coordinator = new LayerStateCoordinator(manager, shareSink(), {
    storage,
  });
  await coordinator.start({ allowLocalState: false });
  assert.equal(coordinator.source, 'legacy-share');
  assert.deepEqual(coordinator.getDurableState().enabledLayerIds, []);
  assert.equal(manager.getEnabledLayerIds().size, 0);
  assert.deepEqual(storage.writes, []);
  coordinator.destroy();
});

test('one layer failure is isolated from sibling restoration', async () => {
  const manager = productionManager({
    cctv: {
      init: () => {
        throw new Error('missing key');
      },
    },
  });
  const state = createDefaultLayerState();
  state.enabledLayerIds = ['cctv', 'weather-cyclones'];
  const coordinator = new LayerStateCoordinator(manager, shareSink(), {
    storage: memoryStorage(),
  });
  const results = await coordinator.start({ shareLayerState: state });
  assert.equal(manager.isEnabled('cctv'), false);
  assert.equal(manager.isEnabled('weather-cyclones'), true);
  const failed = results.find((result) => result.layerId === 'cctv');
  assert.equal(failed.succeeded, false);
  assert.equal(failed.phase, 'init');
  assert.equal(failed.errorClass, 'Error');
  assert.equal(failed.error, 'missing key');
  assert.equal(
    results.find((result) => result.layerId === 'weather-cyclones').succeeded,
    true,
  );
  coordinator.destroy();
});

test('later explicit visibility during delayed restore wins for that layer only', async () => {
  const gate = deferred();
  const manager = productionManager();
  const storage = memoryStorage();
  const state = createDefaultLayerState();
  state.enabledLayerIds = ['radio', 'weather-cyclones'];
  const coordinator = new LayerStateCoordinator(manager, shareSink(), {
    storage,
    restoreGate: gate.promise,
  });
  const restore = coordinator.start({ shareLayerState: state });
  await manager.setEnabled('radio', false, { origin: 'user' });
  gate.resolve();
  const results = await restore;
  assert.equal(manager.isEnabled('radio'), false);
  assert.equal(manager.isEnabled('weather-cyclones'), true);
  assert.equal(
    results.find((result) => result.layerId === 'radio').cancellationReason,
    'superseded',
  );
  assert.equal(storage.writes.length, 1);
  coordinator.destroy();
});

test('share restore waits for a superseding same-target visibility successor', async () => {
  const firstUpdateStarted = deferred();
  const releaseFirstUpdate = deferred();
  const secondUpdateStarted = deferred();
  const releaseSecondUpdate = deferred();
  let updateCount = 0;
  const manager = productionManager({
    radio: {
      update: async () => {
        updateCount += 1;
        if (updateCount === 1) {
          firstUpdateStarted.resolve();
          await releaseFirstUpdate.promise;
        } else if (updateCount === 2) {
          secondUpdateStarted.resolve();
          await releaseSecondUpdate.promise;
        }
        return true;
      },
    },
  });
  const state = createDefaultLayerState();
  state.enabledLayerIds = ['radio'];
  const coordinator = new LayerStateCoordinator(manager, shareSink(), {
    storage: memoryStorage(),
  });

  let restoreSettled = false;
  const restore = coordinator
    .start({ shareLayerState: state })
    .then((result) => {
      restoreSettled = true;
      return result;
    });
  await firstUpdateStarted.promise;
  let successorSettled = false;
  const explicitOn = manager
    .setEnabled('radio', true, { origin: 'user' })
    .then((result) => {
      successorSettled = true;
      return result;
    });
  releaseFirstUpdate.resolve();
  await secondUpdateStarted.promise;
  await Promise.resolve();
  assert.equal(
    restoreSettled,
    false,
    'aggregate must wait for the authoritative successor',
  );
  assert.equal(successorSettled, false);

  releaseSecondUpdate.resolve();
  assert.equal(await explicitOn, true);
  const results = await restore;
  const radio = results.find((result) => result.layerId === 'radio');
  assert.equal(radio.cancellationReason, 'superseded');
  assert.equal(radio.successorEnabled, true);
  assert.equal(radio.authoritativeIntentEpoch, radio.successorIntentEpoch);
  assert.equal(radio.authoritativeEnabled, true);
  assert.equal(radio.succeeded, true);
  assert.equal(
    manager.getLayerLifecycleState('radio').lifecycleState,
    'enabled',
  );
  coordinator.destroy();
});

test('share restore waits for a superseding opposite-target visibility successor', async () => {
  const updateStarted = deferred();
  const releaseUpdate = deferred();
  const disableStarted = deferred();
  const releaseDisable = deferred();
  const manager = productionManager({
    radio: {
      update: async () => {
        updateStarted.resolve();
        await releaseUpdate.promise;
        return true;
      },
      disable: async () => {
        disableStarted.resolve();
        await releaseDisable.promise;
        return true;
      },
    },
  });
  const state = createDefaultLayerState();
  state.enabledLayerIds = ['radio'];
  const coordinator = new LayerStateCoordinator(manager, shareSink(), {
    storage: memoryStorage(),
  });

  let restoreSettled = false;
  const restore = coordinator
    .start({ shareLayerState: state })
    .then((result) => {
      restoreSettled = true;
      return result;
    });
  await updateStarted.promise;
  const explicitOff = manager.setEnabled('radio', false, { origin: 'user' });
  releaseUpdate.resolve();
  await disableStarted.promise;
  await Promise.resolve();
  assert.equal(
    restoreSettled,
    false,
    'aggregate must wait for the OFF successor to settle',
  );

  releaseDisable.resolve();
  assert.equal(await explicitOff, true);
  const results = await restore;
  const radio = results.find((result) => result.layerId === 'radio');
  assert.equal(radio.cancellationReason, 'superseded');
  assert.equal(radio.successorEnabled, false);
  assert.equal(radio.authoritativeIntentEpoch, radio.successorIntentEpoch);
  assert.equal(radio.authoritativeEnabled, false);
  assert.equal(
    radio.succeeded,
    false,
    'the newer OFF must not count as successful shared ON',
  );
  assert.equal(
    manager.getLayerLifecycleState('radio').lifecycleState,
    'disabled',
  );
  coordinator.destroy();
});

test('later explicit params during init replace options without cancelling visibility', async () => {
  const initGate = deferred();
  const initStarted = deferred();
  const manager = productionManager({
    cctv: {
      init: async () => {
        initStarted.resolve();
        await initGate.promise;
        return true;
      },
    },
  });
  const storage = memoryStorage();
  const state = createDefaultLayerState();
  state.enabledLayerIds = ['cctv'];
  state.options.cctv = {
    coverageMode: 'viewshed',
    showProjection: false,
    autoHop: true,
  };
  const share = shareSink();
  const coordinator = new LayerStateCoordinator(manager, share, { storage });
  const restore = coordinator.start({ shareLayerState: state });
  await initStarted.promise;
  assert.equal(
    manager.setLayerParams(
      'cctv',
      { coverageMode: 'off', showProjection: true, autoHop: false },
      { origin: 'user' },
    ),
    true,
  );
  initGate.resolve();
  const results = await restore;
  assert.equal(manager.isEnabled('cctv'), true);
  assert.deepEqual(coordinator.getDurableState().options.cctv, {
    coverageMode: 'off',
    showProjection: true,
    autoHop: false,
  });
  assert.equal(
    results.find((result) => result.layerId === 'cctv').succeeded,
    true,
  );
  assert.equal(storage.writes.length, 1);
  coordinator.destroy();
});

test('explicit navigation preserves unrelated visibility and option restoration', async () => {
  const initGate = deferred();
  const initStarted = deferred();
  const paramsCalls = [];
  const manager = productionManager({
    cctv: {
      init: async () => {
        initStarted.resolve();
        await initGate.promise;
        return true;
      },
      setParams: (params) => {
        paramsCalls.push(params);
        return true;
      },
    },
  });
  const state = createDefaultLayerState();
  state.enabledLayerIds = ['cctv'];
  state.options.cctv = {
    coverageMode: 'viewshed',
    showProjection: false,
    autoHop: true,
  };
  const coordinator = new LayerStateCoordinator(manager, shareSink(), {
    storage: memoryStorage(),
  });
  const restore = coordinator.start({ shareLayerState: state });
  await initStarted.promise;
  // Navigation owns only camera and pending entity selection. It must not
  // revoke the layer visibility or unrelated display-option lanes.
  initGate.resolve();
  const results = await restore;
  assert.equal(manager.isEnabled('cctv'), true);
  assert.deepEqual(paramsCalls, [
    { coverageMode: 'viewshed', showProjection: false, autoHop: true },
  ]);
  assert.equal(
    results.find((result) => result.layerId === 'cctv').succeeded,
    true,
  );
  coordinator.destroy();
});

test('startup gesture preserves slow layer and display options', async () => {
  const radioInit = deferred();
  const radioStarted = deferred();
  const manager = productionManager({
    radio: {
      init: async () => {
        radioStarted.resolve();
        await radioInit.promise;
        return true;
      },
    },
  });
  const state = createDefaultLayerState();
  state.enabledLayerIds = ['radio'];
  state.options.radio = { filter: 'genre:r&b', volume: 0.42 };
  const storage = memoryStorage();
  const coordinator = new LayerStateCoordinator(manager, shareSink(), {
    storage,
  });
  const restore = coordinator.start({ shareLayerState: state });
  await radioStarted.promise;

  let cameraGeneration = 0;
  stampInitialShareGesture(({ cancelPendingSelection }) => {
    cameraGeneration += 1;
    if (cancelPendingSelection) {
      coordinator.cancelPendingShareTracking('startup-gesture', {
        clearSelection: true,
      });
    }
  });
  radioInit.resolve();
  const results = await restore;

  assert.equal(cameraGeneration, 1);
  assert.equal(manager.isEnabled('radio'), true);
  assert.deepEqual(manager.getLayerParams('radio'), {
    filter: 'genre:r&b',
    volume: 0.42,
    selectedStationId: 'private-station',
    audioState: 'playing',
    voiceDucked: true,
  });
  assert.equal(
    results.find((result) => result.layerId === 'radio').succeeded,
    true,
  );
  assert.deepEqual(storage.writes, []);
  coordinator.destroy();
});

// ---------------------------------------------------------------------------
// Share restore must be as resilient as reload-from-local.
//
// Reload-from-local arms the layer's own deferred-restore latch, which
// re-attempts on every later poll, so a contact that misses the first refresh
// is still picked up. The shared path used to decide on that single refresh:
// it cleared the subject from durable state AND the URL and posted a failure
// notice seconds into startup, so the SAME link healed on reload but never on
// the share. These pin both directions.
// ---------------------------------------------------------------------------

test('Radio durable params work before enable and never start playback', () => {
  assert.equal(radioLayer.setParams({ filter: 'news', volume: 0.33 }), true);
  assert.deepEqual(radioLayer.getParams(), { filter: 'news', volume: 0.33 });
  assert.equal(radioLayer.getUIState().audioState, 'stopped');
  assert.equal(radioLayer.getUIState().playingStationId, null);
  radioLayer.setParams({ filter: 'all', volume: 0.8 });
});

// ---------------------------------------------------------------------------
// Share IDs and payloads are untrusted input and must be BOUNDED.
//
// A tracking ID is a transponder address, not free text. Identity is never
// truncated to fit: half an address is a different aircraft, not a shorter name
// for the same one, so an out-of-grammar ID is rejected outright and an
// oversized payload fails closed exactly like an unknown layer token.
// ---------------------------------------------------------------------------

test('an oversized enabled-layer field fails closed instead of decoding a prefix', () => {
  assert.equal(
    decodeLayerStateParams(
      new URLSearchParams([
        ['v', '2'],
        ['l', 'f.'.repeat(5_000)],
      ]),
    ),
    null,
  );
});

// ---------------------------------------------------------------------------
// The pending watch and the LAYER's deferred-restore latch are two halves of
// one mechanism and must die together.
//
// Aborting only the restore controller was a no-op by the time the watch
// existed (the controller has already settled), so the orphaned timer went on
// to announce "Shared … unavailable" at its deadline — a verdict about work
// nothing was attempting any more. Both paths below cancel the module latch in
// production: an explicit parameter replacement, and the owner layer going
// away (at any origin, including a programmatic disable).
// ---------------------------------------------------------------------------

test('wind appearance shares round trip while old links retain weather defaults', () => {
  const state = normalizeLayerState({
    enabledLayerIds: ['wind'],
    options: {
      wind: { model: 'ifs', overlay: 'pressure', units: 'mph', paused: true },
    },
  });
  assert.deepEqual(
    decodeLayerStateParams(new URLSearchParams(encode(state))).options.wind,
    { model: 'ifs', overlay: 'pressure', units: 'mph', paused: true },
  );
  const defaults = createDefaultLayerState().options.wind;
  assert.deepEqual(defaults, {
    model: 'gfs',
    overlay: 'none',
    units: 'km/h',
    paused: false,
  });
  const legacy = decodeLayerStateParams(new URLSearchParams('v=2&l=k'));
  assert.equal(
    legacy.options.wind.overlay,
    'speed',
    'old links retain their authored field',
  );
  assert.equal(
    decodeLayerStateParams(
      new URLSearchParams(encode(createDefaultLayerState())),
    ).options.wind.overlay,
    'none',
    'new default is encoded explicitly',
  );
  const old = normalizeLayerState({ options: { wind: { model: 'ifs' } } });
  assert.deepEqual(old.options.wind, { ...defaults, model: 'ifs' });
  const invalid = normalizeLayerState({
    options: {
      wind: {
        model: 'unknown',
        overlay: 'clouds',
        units: '<script>',
        paused: 'yes',
      },
    },
  });
  assert.deepEqual(invalid.options.wind, defaults);
});

test('observed weather round trips product and opacity without persisting historical playback', () => {
  const state = normalizeLayerState({
    enabledLayerIds: ['weather-radar', 'weather-satellite'],
    options: {
      'weather-radar': { opacity: 'light', play: true },
      'weather-satellite': { product: 'clouds', opacity: 'light', step: -1 },
    },
  });
  const params = new URLSearchParams(encode(state));
  const decoded = decodeLayerStateParams(params);
  assert.deepEqual(decoded, state);
  assert.equal(state.options['weather-satellite'].product, 'clouds');
  assert.equal(Object.hasOwn(state.options['weather-radar'], 'play'), false);
});

test('satellite infrared display mode round trips and invalid or absent values use filtered', () => {
  for (const infrared of ['full', 'filtered', undefined, 'invalid']) {
    const state = normalizeLayerState({
      enabledLayerIds: ['weather-satellite'],
      options: {
        'weather-satellite': {
          infrared,
          product: 'clouds',
          step: -1,
          play: true,
        },
      },
    });
    assert.deepEqual(
      decodeLayerStateParams(new URLSearchParams(encode(state))),
      state,
    );
    assert.equal(
      state.options['weather-satellite'].infrared,
      infrared === 'full' ? 'full' : 'filtered',
    );
    assert.equal(
      Object.hasOwn(state.options['weather-satellite'], 'step'),
      false,
    );
    assert.equal(
      Object.hasOwn(state.options['weather-satellite'], 'play'),
      false,
    );
  }
});

// Recent Imagery (`1`): the box travels as four integers at degrees × 100000,
// the two days as product letter + compact date, the split as a percent.
const imageryOptions = (lo) =>
  decodeLayerStateParams(
    new URLSearchParams([
      ['v', '2'],
      ['l', '1'],
      ['lo', lo],
    ]),
  ).options['recent-imagery'];

test('recent-imagery box, days, mode, split and overview toggle round-trip under token 1; defaults stay out of the URL', () => {
  const entry = LAYER_STATE_REGISTRY.find((row) => row.id === 'recent-imagery');
  assert.deepEqual(
    [entry.token, entry.disposition, entry.optionOwner],
    ['1', 'enabled+options', 'recent-imagery'],
  );
  assert.deepEqual(createDefaultLayerState().options['recent-imagery'], {
    west: null,
    south: null,
    east: null,
    north: null,
    a: null,
    b: null,
    mode: 0,
    split: 50,
    viirs: false,
  });
  const state = createDefaultLayerState();
  state.enabledLayerIds = ['recent-imagery'];
  state.options['recent-imagery'] = {
    west: -9781235,
    south: -3020000,
    east: -9770000,
    north: 3040000,
    a: 'S30:2026-09-18',
    b: 'L30:2026-09-10',
    mode: 2,
    split: 37,
    viirs: true,
  };
  const encoded = encode(state);
  assert.ok(
    encoded.includes(
      '1.w.-9781235_1.s.-3020000_1.e.-9770000_1.n.3040000_1.a.S20260918_1.b.L20260910_1.m.2_1.p.37_1.v.1',
    ),
    encoded,
  );
  const decoded = decodeLayerStateParams(new URLSearchParams(encoded));
  assert.deepEqual(
    decoded.options['recent-imagery'],
    state.options['recent-imagery'],
  );
  const bare = createDefaultLayerState();
  bare.enabledLayerIds = ['recent-imagery'];
  assert.doesNotMatch(
    new URLSearchParams(encode(bare)).get('lo') || '',
    /(^|_)1\./,
  );
  // The codec is calendar-only: a link decodes the same whenever it is opened.
  assert.equal(imageryOptions('1.a.L19991231').a, 'L30:1999-12-31');
  assert.equal(imageryOptions('1.b.V20991231').b, 'VIIRS:2099-12-31');
});

test('recent-imagery rejects impossible days and out-of-range edges instead of rolling or clamping them', () => {
  for (const bad of [
    'S20260230',
    'L20261301',
    'S20260900',
    'X20260918',
    's20260918',
    'S2026091',
    'S30:2026-09-18',
  ])
    assert.equal(imageryOptions(`1.a.${bad}`).a, null, bad);
  assert.equal(
    imageryOptions('1.b.S20240229').b,
    'S30:2024-02-29',
    'a real leap day',
  );
  assert.equal(imageryOptions('1.b.S20230229').b, null);
  const mixed = imageryOptions('1.a.S20260230_1.b.V20260921_1.p.80');
  assert.deepEqual(
    [mixed.a, mixed.b, mixed.split],
    [null, 'VIIRS:2026-09-21', 80],
  );
  for (const bad of [
    '1.w.18000001',
    '1.n.8505111',
    '1.s.-8505111',
    '1.w.1.5',
    '1.w.abc',
    '1.w.1234567890',
  ]) {
    const field = { w: 'west', s: 'south', n: 'north' }[bad.split('.')[1]];
    assert.equal(imageryOptions(bad)[field], null, bad);
  }
  assert.equal(imageryOptions('1.w.18000000').west, 18000000);
  assert.equal(imageryOptions('1.p.101').split, 50);
  assert.equal(imageryOptions('1.m.1').mode, 1);
  for (const bad of ['1.m.3', '1.m.-1', '1.m.x'])
    assert.equal(imageryOptions(bad).mode, 0, bad);
  assert.deepEqual(
    normalizeLayerState({
      enabledLayerIds: ['recent-imagery'],
      options: {
        'recent-imagery': {
          a: 'S30:2026-02-30',
          b: ' L30:2026-09-10 ',
          split: 150,
          west: 'abc',
          north: -8505110,
        },
      },
    }).options['recent-imagery'],
    {
      west: null,
      south: null,
      east: null,
      north: -8505110,
      a: null,
      b: 'L30:2026-09-10',
      mode: 0,
      split: 50,
      viirs: false,
    },
  );
  // An oversized payload fails closed at the shared 512-character cap.
  const long = '1.a.S20260918_'.repeat(40);
  assert.ok(imageryOptions(long.slice(0, 512)));
  assert.equal(
    decodeLayerStateParams(
      new URLSearchParams([
        ['v', '2'],
        ['l', '1'],
        ['lo', long.slice(0, 513)],
      ]),
    ),
    null,
  );
});

test('the recent-imagery split is share-link only: never stored locally, and a stored value reads as the default', () => {
  const state = createDefaultLayerState();
  state.enabledLayerIds = ['recent-imagery'];
  state.options['recent-imagery'] = {
    a: 'S30:2026-09-18',
    split: 8,
    viirs: true,
  };
  assert.ok(encode(state).includes('1.p.8'));
  const stored = JSON.parse(serializeStoredLayerState(state)).o[
    'recent-imagery'
  ];
  assert.deepEqual(
    [stored.split, stored.a, stored.viirs],
    [50, 'S30:2026-09-18', true],
  );
  const previous = JSON.stringify({
    v: 2,
    l: ['recent-imagery'],
    o: { 'recent-imagery': { split: 8 } },
  });
  assert.equal(
    parseStoredLayerState(previous).options['recent-imagery'].split,
    50,
  );
});
