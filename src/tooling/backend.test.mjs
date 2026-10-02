import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createHash } from 'node:crypto';
import {
  sessionToken,
  sessionCookie,
  authenticate,
  DEFAULT_SESSION_COOKIE,
} from '../../backend/auth.js';
import { createBackend } from '../../backend/server.js';

const token = 'a'.repeat(43);
const cookie = `${DEFAULT_SESSION_COOKIE}=${token}`;
const identity = {
  user_id: 'fixture-user',
  display_name: 'Forecaster',
  expires_at: '2099-01-01',
  roles: ['viewer'],
  permissions: [],
};
function poolFixture() {
  return {
    failed: false,
    identity: { ...identity },
    queries: [],
    async query(sql, params) {
      this.queries.push({ sql, params });
      if (this.failed) throw new Error('private-database-fixture');
      return {
        rows: params
          ? this.identity
            ? [this.identity]
            : []
          : [{ migrated: true }],
      };
    },
  };
}
async function start(t, options = {}) {
  const pool = options.pool || poolFixture();
  const server = createBackend({ pool, logger: { error() {} }, ...options });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(async () => {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  return {
    pool,
    server,
    request: (path, init) => fetch(`${base}${path}`, init),
  };
}

test('session cookie parser rejects duplicates, malformed tokens and oversized cookies', () => {
  assert.equal(sessionToken(`theme=dark; ${cookie}`), token);
  for (const value of [
    undefined,
    'session=fake',
    `${cookie}; ${cookie}`,
    `${DEFAULT_SESSION_COOKIE}=short`,
    `${DEFAULT_SESSION_COOKIE}=${'a'.repeat(9000)}`,
    `${DEFAULT_SESSION_COOKIE}=%2F${token}`,
  ])
    assert.equal(sessionToken(value), null);
  assert.match(
    sessionCookie(token),
    /Path=\/; HttpOnly; SameSite=Lax; Max-Age=28800; Secure$/,
  );
  assert.throws(
    () => sessionCookie(token, { secure: false }),
    /Invalid session cookie policy/,
  );
  assert.throws(
    () => sessionCookie(token, { name: 'bad\r\nheader' }),
    /Invalid session cookie policy/,
  );
  assert.throws(
    () => sessionCookie(token, { maxAge: Infinity }),
    /Invalid session cookie policy/,
  );
});

test('authentication hashes opaque tokens and reads current database authorization', async () => {
  const pool = poolFixture();
  const session = await authenticate({ headers: { cookie } }, pool);
  assert.equal(session.userId, 'fixture-user');
  assert.deepEqual(pool.queries[0].params, [
    createHash('sha256').update(token).digest('hex'),
  ]);
  assert.equal(JSON.stringify(session).includes(token), false);
  pool.identity = null;
  assert.equal(await authenticate({ headers: { cookie } }, pool), null);
});

test('API registration requires an explicit policy and rejects duplicate routes', () => {
  const route = {
    method: 'GET',
    path: '/api/fixture',
    handler: async () => ({ status: 200, body: {} }),
  };
  assert.throws(
    () => createBackend({ pool: poolFixture(), routes: [route] }),
    /explicit permission policy/,
  );
  assert.throws(
    () =>
      createBackend({
        pool: poolFixture(),
        routes: [
          { ...route, permissions: [] },
          { ...route, permissions: [] },
        ],
      }),
    /Duplicate API route/,
  );
});

test('anonymous API requests are denied, including unknown methods, encoded paths and fake identity headers', async (t) => {
  const { request } = await start(t);
  for (const path of [
    '/api',
    '/api/session',
    '/api/database/health',
    '/api/weather',
    '/api/new-route',
    '/%61pi/session',
  ]) {
    const response = await request(path, {
      headers: {
        'X-User-Id': 'admin',
        'X-Role': 'administrator',
        Authorization: 'Bearer fake',
      },
    });
    assert.equal(response.status, 401, path);
    assert.deepEqual(await response.json(), { error: 'unauthorized' });
    assert.equal(response.headers.get('access-control-allow-origin'), null);
  }
  assert.equal(
    (await request('/api/session', { method: 'OPTIONS' })).status,
    401,
  );
  assert.equal((await request('/api/session', { method: 'POST' })).status, 401);
  assert.equal((await request('/api/session', { method: 'HEAD' })).status, 401);
});

test('live permission checks apply to every route and unregistered routes remain forbidden', async (t) => {
  const { pool, request } = await start(t);
  const headers = { Cookie: cookie };
  assert.equal((await request('/api/session', { headers })).status, 200);
  assert.equal(
    (await request('/api/database/health', { headers })).status,
    403,
  );
  assert.equal((await request('/api/new-route', { headers })).status, 403);
  pool.identity.permissions = ['system:read'];
  assert.equal(
    (await request('/api/database/health', { headers })).status,
    200,
  );
  pool.identity.permissions = [];
  assert.equal(
    (await request('/api/database/health', { headers })).status,
    403,
  );
  pool.identity = null;
  assert.equal((await request('/api/session', { headers })).status, 401);
});

test('authorized writes require same-origin CSRF headers and reject cross-site requests', async (t) => {
  const routes = [
    {
      method: 'POST',
      path: '/api/write',
      permissions: ['write'],
      handler: async () => ({ status: 200, body: { saved: true } }),
    },
  ];
  const { pool, request } = await start(t, {
    routes,
    publicOrigin: 'https://gev.example',
  });
  pool.identity.permissions = ['write'];
  const headers = {
    Cookie: cookie,
    Origin: 'https://gev.example',
    'X-GEV-CSRF': '1',
  };
  for (const extra of [
    { Origin: 'https://attacker.example' },
    { Origin: '' },
    { 'X-GEV-CSRF': '' },
    { 'Sec-Fetch-Site': 'cross-site' },
  ]) {
    const response = await request('/api/write', {
      method: 'POST',
      headers: { ...headers, ...extra },
    });
    assert.equal(response.status, 403);
    assert.deepEqual(await response.json(), { error: 'csrf_rejected' });
  }
  assert.equal(
    (await request('/api/write', { method: 'POST', headers })).status,
    200,
  );
});

test('public liveness and readiness are separate, failures redact details and shutdown refuses work', async (t) => {
  let stopping = false;
  const { pool, request } = await start(t, { isStopping: () => stopping });
  assert.equal((await request('/healthz')).status, 200);
  assert.equal((await request('/readyz')).status, 200);
  assert.equal((await request('/readyz', { method: 'HEAD' })).status, 200);
  assert.equal((await request('/readyz', { method: 'POST' })).status, 405);
  assert.equal((await request('/backend/server.js')).status, 404);
  pool.failed = true;
  assert.equal((await request('/healthz')).status, 200);
  const response = await request('/readyz');
  assert.equal(response.status, 503);
  assert.equal(
    (await response.text()).includes('private-database-fixture'),
    false,
  );
  assert.equal(
    (await request('/api/session', { headers: { Cookie: cookie } })).status,
    503,
  );
  stopping = true;
  assert.equal((await request('/healthz')).status, 503);
});
