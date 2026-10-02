import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { createBackend } from '../../backend/server.js';
import { DEFAULT_SESSION_COOKIE } from '../../backend/auth.js';
import { readinessSql } from '../../backend/routes.js';
import { backendProviders } from '../../server/providers/interface.js';
import { defineProvider } from '../../server/providers/common/provider.js';
import { createProviderRegistry } from '../../server/providers/registry.js';
import {
  createHealthRecorder,
  healthRows,
  INSERT_HEALTH_SQL,
  UPSERT_FEED_SQL,
} from '../../server/providers/common/healthStore.js';

const root = new URL('../../', import.meta.url);
const token = 'b'.repeat(43);
const cookie = `${DEFAULT_SESSION_COOKIE}=${token}`;

/** The backend's session query answers with this identity's permissions. */
function poolWith(permissions) {
  return {
    async query(_sql, params) {
      return {
        rows: params
          ? [
              {
                user_id: 'u1',
                display_name: 'Chaser',
                expires_at: '2099-01-01',
                roles: ['chaser'],
                permissions,
              },
            ]
          : [{ migrated: true }],
      };
    },
  };
}

async function start(t, { permissions, routes }) {
  const server = createBackend({
    pool: poolWith(permissions),
    routes,
    logger: { error() {} },
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(async () => {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  return (p, { auth = true } = {}) =>
    fetch(`${base}${p}`, auth ? { headers: { cookie } } : {});
}

test('provider routes go through the backend session and permission gate', async (t) => {
  const providers = backendProviders();
  t.after(() => providers.close());
  const routes = providers.routes;
  assert.deepEqual(
    routes.map((r) => [r.path, r.permissions]),
    [
      ['/api/providers', ['system:read']],
      ['/api/providers/health', ['system:read']],
      ['/api/radar/l2/live', ['feed:read']],
      ['/api/radar/l2/image', ['feed:read']],
    ],
  );

  const viewer = await start(t, { permissions: ['feed:read'], routes });
  assert.equal(
    (await viewer('/api/radar/l2/live', { auth: false })).status,
    401,
  );
  // Reaches the handler (which validates input before any upstream work).
  assert.equal((await viewer('/api/radar/l2/live?site=../x')).status, 400);
  assert.equal(
    (
      await viewer(
        '/api/radar/l2/image?site=KTLX&volume=20260930-182908&elevation=6&product=REF',
      )
    ).status,
    404,
  );
  // Operational detail needs system:read.
  assert.equal((await viewer('/api/providers')).status, 403);

  const nobody = await start(t, { permissions: [], routes });
  assert.equal((await nobody('/api/radar/l2/live?site=KTLX')).status, 403);

  const forecaster = await start(t, { permissions: ['system:read'], routes });
  const catalog = await (await forecaster('/api/providers')).json();
  assert.deepEqual(
    catalog.providers.map((p) => [p.id, p.kind]),
    [['nexrad-level2', 'provider']],
  );
  assert.equal(catalog.streams.notifications.state, 'idle');
  const health = await (await forecaster('/api/providers/health')).json();
  assert.equal(health.providers[0].state, 'idle');
});

test('the backend serves provider images privately, from a fixed list of types', async (t) => {
  const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47]);
  const registry = createProviderRegistry();
  registry.register(
    defineProvider({
      id: 'test-image',
      mode: 'push',
      source: { name: 'Test' },
      subscribe: () => () => {},
      normalize: () => null,
      api: [
        {
          method: 'GET',
          path: '/api/test/image',
          permissions: ['feed:read'],
          handler: async ({ query }) =>
            query.get('kind') === 'bad'
              ? { status: 200, bytes: png, contentType: 'text/html' }
              : {
                  status: 200,
                  bytes: png,
                  contentType: 'image/png',
                  cacheControl:
                    query.get('cache') === 'public'
                      ? 'public, max-age=60'
                      : 'private, max-age=60',
                  headers: {
                    'X-Storm-Motion': '240° / 30 kt',
                    'Set-Cookie': 'x=1',
                  },
                },
        },
      ],
    }),
  );
  t.after(() => registry.close());
  const request = await start(t, {
    permissions: ['feed:read'],
    routes: registry.apiRoutes(),
  });
  const ok = await request('/api/test/image');
  assert.equal(ok.status, 200);
  assert.equal(ok.headers.get('content-type'), 'image/png');
  assert.equal(ok.headers.get('cache-control'), 'private, max-age=60');
  assert.equal(ok.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(ok.headers.get('x-storm-motion'), '240° / 30 kt');
  assert.equal(ok.headers.get('set-cookie'), null, 'only X- headers pass');
  assert.deepEqual(new Uint8Array(await ok.arrayBuffer()), png);
  // Authorized data is never cached publicly.
  assert.equal(
    (await request('/api/test/image?cache=public')).headers.get(
      'cache-control',
    ),
    'no-store',
  );
  // A type outside the list is a server error, not a response.
  assert.equal((await request('/api/test/image?kind=bad')).status, 503);
});

test('the backend image copies every module the providers import', () => {
  const dockerfile = readFileSync(new URL('backend/Dockerfile', root), 'utf8');
  const copied = [
    ...dockerfile.matchAll(/^COPY --chown=\S+ (.+) \S+$/gm),
  ].flatMap((m) => m[1].split(/\s+/));
  const covered = (file) =>
    copied.some((src) => file === src || file.startsWith(`${src}/`));
  const seen = new Set();
  const external = new Set();
  const walk = (file) => {
    if (seen.has(file)) return;
    seen.add(file);
    const text = readFileSync(new URL(file, root), 'utf8');
    for (const [, spec] of text.matchAll(
      /^\s*(?:import|export)[^'"]*?from\s+['"]([^'"]+)['"]/gm,
    )) {
      if (spec.startsWith('.'))
        walk(
          path.posix.normalize(path.posix.join(path.posix.dirname(file), spec)),
        );
      else if (!spec.startsWith('node:')) external.add(spec);
    }
  };
  walk('server/providers/interface.js');
  const missing = [...seen].filter((file) => !covered(file));
  assert.deepEqual(missing, []);
  const deps = Object.keys(
    JSON.parse(readFileSync(new URL('backend/package.json', root), 'utf8'))
      .dependencies,
  );
  for (const name of external)
    assert.ok(deps.includes(name), `backend depends on ${name}`);
});

test('readiness waits for the newest migration', () => {
  const migrations = readdirSync(new URL('database/migrations/', root))
    .filter((name) => /^\d{4}_[a-z0-9_]+\.sql$/.test(name))
    .sort();
  assert.match(readinessSql, new RegExp(migrations.at(-1).replace('.', '\\.')));
  const sql = readFileSync(
    new URL('database/migrations/0003_provider_health.sql', root),
    'utf8',
  );
  assert.match(
    sql,
    /'healthy', 'degraded', 'stale', 'unavailable', 'disabled'/,
  );
  assert.match(
    sql,
    /ON gev\.feeds \(provider, name\) WHERE workspace_id IS NULL/,
  );
});

const snapshot = (providers, generatedAt = 1_000) => ({
  generatedAt,
  providers,
});
const provider = (state, products = [], extra = {}) => ({
  id: 'nexrad-level2',
  state,
  code: state === 'healthy' ? null : 'x',
  availableToIngestMs: { last: 812.4 },
  products,
  ...extra,
});

test('health maps onto gev.feed_health statuses; idle is not recorded', () => {
  const rows = healthRows(
    snapshot([
      provider('degraded', [
        {
          product: 'KTLX',
          state: 'stale',
          code: 'data_stale',
          availableToIngestMs: { last: -3 },
        },
        {
          product: 'KEAX',
          state: 'down',
          code: 'no_data',
          availableToIngestMs: {},
        },
        {
          product: 'KFWS',
          state: 'idle',
          code: 'idle',
          availableToIngestMs: {},
        },
      ]),
    ]),
  );
  assert.deepEqual(
    rows.map((r) => [r.name, r.status, r.latencyMs, r.reasonCode]),
    [
      ['nexrad-level2', 'degraded', 812, 'x'],
      ['nexrad-level2:KTLX', 'stale', 0, 'data_stale'],
      ['nexrad-level2:KEAX', 'unavailable', null, 'no_data'],
    ],
  );
});

test('the recorder writes changes and periodic samples, and survives outages', async () => {
  const queries = [];
  let down = false;
  const pool = {
    async query(sql, params) {
      if (down) throw new Error('connection refused at db:5432');
      queries.push({ sql, params });
      return sql === UPSERT_FEED_SQL
        ? { rows: [{ id: `feed-${params[0]}` }] }
        : { rows: [] };
    },
  };
  let listener;
  const monitor = {
    subscribe: (fn) => ((listener = fn), () => (listener = null)),
  };
  let t = 0;
  const errors = [];
  const recorder = createHealthRecorder({
    pool,
    monitor,
    sampleMs: 300_000,
    now: () => t,
    logger: { error: (m) => errors.push(m), warn() {} },
  });
  const healthy = snapshot([
    provider('healthy', [
      { product: 'KTLX', state: 'healthy', availableToIngestMs: {} },
    ]),
  ]);

  // First evaluation is a full sample: one feed row per target, upserted once.
  listener(healthy, []);
  await recorder.flush();
  assert.deepEqual(
    queries.filter((q) => q.sql === UPSERT_FEED_SQL).map((q) => q.params),
    [
      ['nexrad-level2', 'nexrad-level2', '{}'],
      ['nexrad-level2:KTLX', 'nexrad-level2', '{"product":"KTLX"}'],
    ],
  );
  assert.equal(queries.filter((q) => q.sql === INSERT_HEALTH_SQL).length, 2);

  // Before the next sample, only changed targets are written.
  queries.length = 0;
  t = 60_000;
  listener(
    snapshot(
      [
        provider('stale', [
          {
            product: 'KTLX',
            state: 'stale',
            code: 'data_stale',
            availableToIngestMs: {},
          },
        ]),
      ],
      60_000,
    ),
    [
      {
        provider: 'nexrad-level2',
        product: 'KTLX',
        from: 'healthy',
        to: 'stale',
      },
    ],
  );
  await recorder.flush();
  assert.deepEqual(
    queries.map((q) => [
      q.sql === INSERT_HEALTH_SQL,
      q.params[0],
      q.params[2],
      q.params[4],
    ]),
    [[true, 'feed-nexrad-level2:KTLX', 'stale', 'data_stale']],
  );
  listener(healthy, []); // no changes, no sample due: nothing written
  await recorder.flush();
  assert.equal(queries.length, 1);

  // An outage is logged once, without connection details, then recovers.
  down = true;
  t = 400_000;
  listener(healthy, []);
  listener(healthy, [
    { provider: 'nexrad-level2', product: null, to: 'healthy' },
  ]);
  await recorder.flush();
  assert.deepEqual(errors, ['[provider-health] recording failed']);
  down = false;
  t = 800_000;
  listener(healthy, []);
  await recorder.flush();
  assert.ok(queries.length > 1);
  await recorder.stop();
  assert.equal(listener, null);
});
