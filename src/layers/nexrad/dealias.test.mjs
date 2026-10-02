import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  dealiasSweep,
  parseStormMotion,
  stormRadialComponent,
  stormRelative,
} from '../../../server/providers/nexrad/dealias.js';
import {
  createStormMotionSource,
  NWS_USER_AGENT,
} from '../../../server/providers/nexrad/stormMotion.js';
import { dealiasedSweep } from '../../../server/providers/nexrad/level2Velocity.js';
import { createLevel2Ingest } from '../../../server/providers/nexrad-level2.js';
import { createProviderRegistry } from '../../../server/providers/registry.js';

const VN = 23.84; // KTLX VCP 212 low tilts
const KT = 1.943844;
const fold = (v, vn = VN) => ((((v + vn) % (2 * vn)) + 2 * vn) % (2 * vn)) - vn;

/** Deterministic pseudo-random numbers. */
function rng(seed) {
  let s = seed;
  return () => (s = (s * 1103515245 + 12345) % 2 ** 31) / 2 ** 31;
}

/**
 * A sweep of a known wind field, folded at Vn: a 30–40 m/s westerly with
 * range shear plus a tight rotation couplet, with noise and missing gates.
 */
function syntheticSweep({
  radials = 360,
  gates = 400,
  gateKm = 0.5,
  noise = 2,
  dropout = 0.02,
  gap = true,
  seed = 7,
} = {}) {
  const rnd = rng(seed);
  const truth = new Float32Array(radials * gates);
  const folded = new Float32Array(radials * gates);
  for (let r = 0; r < radials; r += 1) {
    const az = ((r + 0.5) * (360 / radials) * Math.PI) / 180;
    for (let g = 0; g < gates; g += 1) {
      const km = 2 + g * gateKm;
      const x = km * Math.sin(az);
      const y = km * Math.cos(az);
      let u = 30 + 10 * Math.min(1, km / 150);
      let v = 5;
      const dx = x - 60;
      const dy = y - 40;
      const d = Math.hypot(dx, dy);
      const vt = d < 3 ? (45 * d) / 3 : (45 * 3) / d;
      if (d > 0.01) {
        u += (-vt * dy) / d;
        v += (vt * dx) / d;
      }
      const vr = (u * x + v * y) / km;
      const i = r * gates + g;
      const echo =
        rnd() > dropout && !(gap && r > radials * 0.42 && r < radials * 0.46);
      truth[i] = echo ? vr : NaN;
      folded[i] = echo ? fold(vr + (rnd() - 0.5) * noise) : NaN;
    }
  }
  return { radials, gates, truth, folded };
}

/** Share of gates put in the right Nyquist interval, and share that were folded. */
function score({ truth, folded }, out) {
  let n = 0;
  let right = 0;
  let wasFolded = 0;
  for (let i = 0; i < truth.length; i += 1) {
    if (Number.isNaN(truth[i])) {
      assert.ok(Number.isNaN(out[i]), 'no data stays no data');
      continue;
    }
    n += 1;
    if (Math.abs(out[i] - truth[i]) < VN) right += 1;
    if (Math.abs(folded[i] - truth[i]) > VN) wasFolded += 1;
  }
  return { right: right / n, folded: wasFolded / n };
}

test('a folded full sweep is unfolded back to the true wind field', () => {
  const sweep = syntheticSweep();
  const result = dealiasSweep({
    radials: sweep.radials,
    gates: sweep.gates,
    velocity: sweep.folded,
    nyquist: VN,
    wrap: true,
  });
  const { right, folded } = score(sweep, result.velocity);
  assert.ok(folded > 0.4, `the test field is heavily folded (${folded})`);
  assert.equal(right, 1);
  assert.equal(result.regions, 1);
  assert.ok(result.unfolded > 0);
});

test('heavy noise and speckle still unfold almost every gate', () => {
  const sweep = syntheticSweep({ noise: 12, dropout: 0.35, seed: 11 });
  const result = dealiasSweep({
    radials: sweep.radials,
    gates: sweep.gates,
    velocity: sweep.folded,
    nyquist: VN,
    wrap: true,
  });
  assert.ok(score(sweep, result.velocity).right > 0.995);
});

test('a partial sweep looking down a strong wind needs the previous sweep as reference', () => {
  const full = syntheticSweep();
  const radials = 120; // the first third of the sweep: 0°–120°, all downwind
  const part = {
    radials,
    gates: full.gates,
    truth: full.truth.subarray(0, radials * full.gates),
    folded: full.folded.subarray(0, radials * full.gates),
  };
  const sweep = {
    radials,
    gates: part.gates,
    velocity: part.folded,
    nyquist: VN,
    wrap: false,
  };
  // Alone, every gate is consistent with its neighbours but the whole echo
  // sits one interval low: its true mean (+30 m/s) is outside ±Vn.
  const alone = dealiasSweep(sweep);
  assert.equal(score(part, alone.velocity).right, 0);
  assert.equal(alone.referenced, 0);
  // The previous scan of this tilt (here: the truth, a few minutes old)
  // puts it in the right interval.
  const anchored = dealiasSweep({ ...sweep, reference: part.truth });
  assert.equal(score(part, anchored.velocity).right, 1);
  assert.equal(anchored.referenced, 1);
});

test('unfolded data is left alone, and no Nyquist means no change', () => {
  const calm = syntheticSweep();
  // Keep winds well inside the interval.
  const gentle = calm.truth.map((v) => (Number.isNaN(v) ? v : v / 4));
  const result = dealiasSweep({
    radials: calm.radials,
    gates: calm.gates,
    velocity: gentle,
    nyquist: VN,
    wrap: true,
  });
  assert.equal(result.unfolded, 0);
  assert.deepEqual([...result.velocity.slice(0, 50)], [...gentle.slice(0, 50)]);
  const passthrough = dealiasSweep({
    radials: calm.radials,
    gates: calm.gates,
    velocity: calm.folded,
    nyquist: null,
  });
  assert.equal(passthrough.unfolded, 0);
  assert.equal(passthrough.velocity[123], calm.folded[123]);
});

test('an isolated echo is centred on the Nyquist interval (the documented limit)', () => {
  const radials = 10;
  const gates = 10;
  const velocity = new Float32Array(radials * gates).fill(NaN);
  // A small blob truly at +30 m/s reads −17.68: no neighbour says otherwise.
  for (let r = 3; r < 6; r += 1)
    for (let g = 3; g < 6; g += 1) velocity[r * gates + g] = fold(30);
  const result = dealiasSweep({ radials, gates, velocity, nyquist: VN });
  assert.ok(Math.abs(result.velocity[4 * gates + 4] - fold(30)) < 1e-5);
});

test('storm motion parses as FROM degrees / knots', () => {
  assert.deepEqual(parseStormMotion('240/30'), { fromDeg: 240, speedKt: 30 });
  assert.deepEqual(parseStormMotion(' 360 / 0 '), { fromDeg: 0, speedKt: 0 });
  assert.equal(parseStormMotion('240'), null);
  assert.equal(parseStormMotion('400/20'), null);
  assert.equal(parseStormMotion('240/200'), null);
});

test('SRV removes the storm motion along each beam, positive away from the radar', () => {
  // Moving FROM the west (toward the east) at 20 kt.
  const motion = { fromDeg: 270, speedKt: 20 };
  const ms = 20 / KT;
  assert.ok(Math.abs(stormRadialComponent(motion, 90) - ms) < 1e-9); // east: receding
  assert.ok(Math.abs(stormRadialComponent(motion, 270) + ms) < 1e-9); // west: approaching
  assert.ok(Math.abs(stormRadialComponent(motion, 0)) < 1e-9); // across the beam
  // A gate moving with the storm reads zero storm-relative.
  assert.ok(Math.abs(stormRelative(ms, motion, 90)) < 1e-9);
});

/** A Level II sweep object (as the assembler builds) from a velocity grid. */
function sweepObject(values, { radials, gates, from = 0, revision = 1 }) {
  const map = new Map();
  for (let r = from; r < from + radials; r += 1) {
    const data = new Uint8Array(gates);
    for (let g = 0; g < gates; g += 1) {
      const v = values[r * gates + g];
      data[g] = Number.isNaN(v) ? 0 : Math.max(2, Math.round(v * 2 + 129));
    }
    map.set(r + 1, {
      azimuthNumber: r + 1,
      azimuthDeg: (r + 0.5) * (360 / 360),
      azimuthSpacingDeg: 1,
      nyquistMs: VN,
      moments: {
        VEL: {
          gates,
          gateM: 500,
          firstGateM: 2000,
          wordSize: 8,
          scale: 2,
          offset: 129,
          data,
        },
      },
    });
  }
  return { radials: map, revision, elevationNumber: 2, firstRadialMs: 0 };
}

test('sweeps dealias against the same tilt of the previous volume', () => {
  const full = syntheticSweep();
  const opts = { radials: 360, gates: full.gates };
  const previous = sweepObject(full.folded, opts);
  const current = sweepObject(full.folded, { ...opts, radials: 120 });
  const referenceOf = (sweep) => (sweep === current ? previous : null);
  const anchored = dealiasedSweep(current, { referenceOf });
  const alone = dealiasedSweep(current);
  assert.equal(anchored.referenced, 1);
  assert.equal(alone.referenced, 0);
  const right = (result) => {
    let ok = 0;
    let n = 0;
    for (let i = 0; i < result.velocity.length; i += 1) {
      const truth = full.truth[i];
      if (Number.isNaN(truth) || Number.isNaN(result.velocity[i])) continue;
      n += 1;
      if (Math.abs(result.velocity[i] - truth) < VN) ok += 1;
    }
    return ok / n;
  };
  assert.ok(right(anchored) > 0.999);
  assert.ok(right(alone) < 0.01);
  // Cached until the sweep or its reference changes.
  assert.equal(
    dealiasedSweep(current, { referenceOf }),
    dealiasedSweep(current, { referenceOf }),
  );
});

const KTLX = { lat: 35.3334, lon: -97.2778 };

test('server-side NWS requests identify themselves, as api.weather.gov requires', async () => {
  const requests = [];
  const source = createStormMotionSource({
    fetchImpl: async (url, init) => {
      requests.push({ url, init });
      return new Response(
        JSON.stringify({ type: 'FeatureCollection', features: [] }),
      );
    },
  });
  const result = await source.resolve('auto', KTLX);
  assert.match(result.error, /no NWS warning/);
  assert.match(requests[0].url, /^https:\/\/api\.weather\.gov\/alerts\/active/);
  assert.equal(requests[0].init.headers['User-Agent'], NWS_USER_AGENT);
  assert.equal(requests[0].init.headers.Accept, 'application/geo+json');
});

function warningsWith(list) {
  let calls = 0;
  return {
    source: {
      async getSnapshot() {
        calls += 1;
        if (list instanceof Error) throw list;
        return { warnings: list };
      },
    },
    calls: () => calls,
  };
}

test('auto storm motion comes from the nearest NWS warning in range, labelled', async () => {
  const warnings = warningsWith([
    {
      key: 'KOUN.TO.W.0042',
      code: 'TOR',
      event: 'Tornado Warning',
      office: 'NWS Norman OK',
      motion: {
        fromDeg: 235,
        speedKt: 32,
        timeMs: 1,
        points: [{ lat: 35.6, lon: -97.6 }],
      },
    },
    {
      key: 'KOUN.SV.W.0100',
      code: 'SVR',
      event: 'Severe Thunderstorm Warning',
      motion: {
        fromDeg: 260,
        speedKt: 20,
        points: [{ lat: 36.5, lon: -98.5 }],
      },
    },
    {
      key: 'KFWD.SV.W.0007',
      code: 'SVR',
      event: 'Severe Thunderstorm Warning',
      motion: { fromDeg: 180, speedKt: 10, points: [{ lat: 31, lon: -97 }] },
    },
  ]);
  const source = createStormMotionSource({ warnings: warnings.source });
  const { motion } = await source.resolve('auto', KTLX);
  assert.equal(motion.source, 'nws-warning');
  assert.deepEqual([motion.fromDeg, motion.speedKt], [235, 32]);
  assert.equal(motion.label, '235° / 32 kt (TOR KOUN.TO.W.0042)');
  assert.equal(motion.warning.key, 'KOUN.TO.W.0042');
  assert.ok(motion.warning.distanceKm < 50);
  await source.resolve('auto', KTLX);
  assert.equal(warnings.calls(), 1, 'warnings are cached briefly');

  const user = await source.resolve('240/30', KTLX);
  assert.equal(user.motion.label, '240° / 30 kt (user)');
  assert.match((await source.resolve('fast', KTLX)).error, /DDD\/SS/);
  assert.deepEqual(await source.resolve('', KTLX), { motion: null });
});

test('auto storm motion explains why there is none', async () => {
  const far = createStormMotionSource({
    warnings: warningsWith([
      {
        key: 'X',
        code: 'SVR',
        motion: { fromDeg: 1, speedKt: 1, points: [{ lat: 25, lon: -80 }] },
      },
    ]).source,
  });
  assert.match((await far.resolve('auto', KTLX)).error, /within 250 km/);
  const down = createStormMotionSource({
    warnings: warningsWith(new Error('NWS HTTP 503')).source,
  });
  assert.match((await down.resolve('auto', KTLX)).error, /NWS HTTP 503/);
});

// The real chunk from level2Ingest.test.mjs: tilt 6 of KTLX volume 112.
const VOLUME = '20260930-182908';
const I_KEY = `KTLX/112/${VOLUME}-033-I`;
const I_CHUNK = new Uint8Array(
  readFileSync(
    new URL(
      `../../data/fixtures/level2-KTLX-${VOLUME}-033-I.bin`,
      import.meta.url,
    ),
  ),
);

async function mountWithChunk() {
  const now = Date.parse('2026-09-30T18:31:05Z');
  const fetchImpl = async (url) => {
    const u = new URL(url);
    if (u.pathname === '/')
      return new Response('<ListBucketResult></ListBucketResult>');
    if (u.pathname === `/${I_KEY}`) return new Response(I_CHUNK);
    return new Response('missing', { status: 404 });
  };
  const ingest = createLevel2Ingest({
    fetchImpl,
    now: () => now,
    stormMotion: createStormMotionSource({ warnings: warningsWith([]).source }),
  });
  const registry = createProviderRegistry({
    runtimeOptions: { now: () => now },
  });
  const runtime = registry.register(ingest.provider);
  let handler;
  for (const plugin of registry.plugins())
    plugin.configureServer({
      middlewares: {
        use: (path, fn) => path === '/api/radar/l2' && (handler = fn),
      },
    });
  const call = (url) =>
    new Promise((resolve) => {
      const res = {
        headersSent: false,
        writeHead(status, headers) {
          this.status = status;
          this.headers = headers;
        },
        end(body) {
          resolve({ status: this.status, headers: this.headers, body });
        },
      };
      handler({ url }, res);
    });
  await call('/live?site=KTLX'); // watch, so the runtime runs
  await runtime.ingest({ key: I_KEY, lastModified: now - 500 });
  registry.health.stop();
  return { ingest, call };
}

test('/live labels the storm motion and offers dealiased and storm-relative images', async () => {
  const { ingest, call } = await mountWithChunk();
  try {
    const live = JSON.parse((await call('/live?site=KTLX&motion=240/30')).body);
    assert.equal(live.stormMotion.label, '240° / 30 kt (user)');
    const [sweep] = live.sweeps;
    assert.deepEqual(Object.keys(sweep.images), ['REF', 'VEL', 'VDA', 'SRV']);
    assert.match(sweep.images.SRV, /SRV\.png\?rev=\d+&motion=240\/30$/);

    const srv = await call(sweep.images.SRV.replace('/api/radar/l2', ''));
    assert.equal(srv.status, 200);
    assert.equal(srv.headers['X-Storm-Motion'], '240° / 30 kt');
    const vda = await call(sweep.images.VDA.replace('/api/radar/l2', ''));
    assert.equal(vda.status, 200);
    assert.equal(
      (await call(`/image/KTLX/${VOLUME}/6/SRV.png`)).status,
      400,
      'SRV without an explicit motion is refused',
    );

    const auto = JSON.parse((await call('/live?site=KTLX&motion=auto')).body);
    assert.equal(auto.stormMotion, null);
    assert.match(auto.stormMotionError, /no NWS warning/);
    assert.deepEqual(Object.keys(auto.sweeps[0].images), ['REF', 'VEL', 'VDA']);
  } finally {
    ingest.close();
  }
});

test('/value samples raw, dealiased and storm-relative velocity at a point', async () => {
  const { ingest, call } = await mountWithChunk();
  try {
    // Radials 121–240 of a 0.5° sweep cover azimuths 60°–120°, so due east.
    const lat = 35.3334;
    const east = (km) =>
      -97.2778 + km / (111.32 * Math.cos((lat * Math.PI) / 180));
    const at = (km) =>
      `/value?site=KTLX&volume=${VOLUME}&elevation=6&lat=${lat}&lon=${east(km)}`;
    // The first range east of the radar with a velocity echo.
    let km = 10;
    let plain;
    for (; km < 150; km += 1) {
      plain = JSON.parse((await call(at(km))).body);
      if (typeof plain.vel === 'number') break;
    }
    const url = at(km);
    assert.equal(plain.inRange, true);
    assert.equal(plain.azimuthDeg, 90);
    assert.ok(Math.abs(plain.rangeKm - km) < 0.5);
    assert.equal(plain.nyquistMs, 23.84);
    assert.equal(typeof plain.vel, 'number');
    // A calm day: nothing at this gate needed unfolding.
    assert.equal(plain.velDealiased, plain.vel);
    assert.equal(plain.srv, null);

    const withMotion = JSON.parse((await call(`${url}&motion=270/20`)).body);
    // Due east, a storm moving east at 20 kt recedes at 10.3 m/s.
    assert.ok(Math.abs(withMotion.srv - (plain.velDealiased - 20 / KT)) < 0.11);
    assert.equal(withMotion.stormMotion.label, '270° / 20 kt');

    assert.equal((await call('/value?site=KTLX')).status, 400);
    assert.equal((await call(`${url}&motion=fast`)).status, 400);
    assert.equal(
      (
        await call(
          `/value?site=KTLX&volume=${VOLUME}&elevation=9&lat=35&lon=-97`,
        )
      ).status,
      404,
    );
  } finally {
    ingest.close();
  }
});
