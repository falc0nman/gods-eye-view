import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fsp } from 'node:fs';
import { celestrakProxy } from 'gods-eye-view/server/providers/space';
import { celestrakTleUrl } from 'gods-eye-view/sources/space';

function install(plugin, preview = false) {
  const routes = new Map();
  plugin[preview ? 'configurePreviewServer' : 'configureServer']({
    middlewares: {
      use(route, handler) {
        routes.set(route, handler);
      },
    },
  });
  return async (route, url = '/', method = 'GET') => {
    const res = {
      headersSent: false,
      writeHead(status, headers) {
        Object.assign(this, { status, headers, headersSent: true });
      },
      end(body) {
        this.body = body;
      },
    };
    await routes.get(route)({ url, method }, res);
    return res;
  };
}
function isolateDisk(t) {
  t.mock.method(fsp, 'readFile', async () => {
    throw Error('no cache');
  });
  t.mock.method(fsp, 'stat', async () => {
    throw Error('no cache');
  });
  t.mock.method(fsp, 'mkdir', async () => {});
  t.mock.method(fsp, 'writeFile', async () => {});
}

test('portable requests keep fixed origins and encode group data', () => {
  const tle = celestrakTleUrl('stations&FORMAT=json');
  assert.equal(tle.origin, 'https://celestrak.org');
  assert.equal(tle.pathname, '/NORAD/elements/gp.php');
  assert.equal(tle.searchParams.get('GROUP'), 'stations&FORMAT=json');
  assert.equal(tle.searchParams.get('FORMAT'), 'tle');
});

test('exported CelesTrak plugin coalesces refreshes, retains stale TLEs, and reads disk in a new instance', async (t) => {
  isolateDisk(t);
  let now = Date.now();
  t.mock.method(Date, 'now', () => now);
  t.mock.method(console, 'warn', () => {});
  const tle = 'ISS\n1 25544U fixture\n2 25544 fixture';
  let calls = 0,
    release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  t.mock.method(globalThis, 'fetch', async (url) => {
    calls++;
    assert.equal(new URL(url).searchParams.get('GROUP'), 'stations');
    await gate;
    return new Response(tle);
  });
  const request = install(celestrakProxy());
  assert.equal((await request('/api/celestrak', '/../bad')).status, 400);
  assert.equal(calls, 0);
  const first = request('/api/celestrak', '/stations');
  const second = request('/api/celestrak', '/stations');
  release();
  for (const res of await Promise.all([first, second]))
    assert.equal(res.body, tle);
  assert.equal(calls, 1);
  assert.equal(
    (await request('/api/celestrak', '/stations')).headers['x-tle-cache'],
    'HIT',
  );
  now += 6 * 3600_000;
  t.mock.method(globalThis, 'fetch', async () => new Response('not a TLE'));
  const stale = await request('/api/celestrak', '/stations');
  assert.equal(stale.body, tle);
  assert.equal(stale.headers['x-tle-cache'], 'STALE-ERROR');
  t.mock.method(fsp, 'readFile', async () =>
    JSON.stringify({ at: now, body: tle }),
  );
  t.mock.method(globalThis, 'fetch', async () => {
    throw Error('fresh disk must prevent fetch');
  });
  const disk = await install(celestrakProxy())('/api/celestrak', '/stations');
  assert.equal(disk.headers['x-tle-cache'], 'HIT');
  assert.equal(disk.body, tle);
});
