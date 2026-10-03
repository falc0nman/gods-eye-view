import test from 'node:test';
import assert from 'node:assert/strict';
import * as providers from '../../server/providers/live.js';

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
    assert.ok(routes.has(route), `registered route: ${route}`);
    const response = {
      statusCode: 200,
      headers: {},
      setHeader(key, value) {
        this.headers[key.toLowerCase()] = value;
      },
      writeHead(status, headers = {}) {
        this.statusCode = status;
        for (const [key, value] of Object.entries(headers))
          this.setHeader(key, value);
      },
      end(body) {
        this.body = body;
      },
    };
    await routes.get(route)({ url, method }, response);
    return response;
  };
}

function environment(t, values) {
  for (const [key, value] of Object.entries(values)) {
    const original = process.env[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
    t.after(() => {
      if (original === undefined) delete process.env[key];
      else process.env[key] = original;
    });
  }
}

test('live entry resolves in Node', async () => {
  const entry = await import('gods-eye-view/server/providers/live');
  assert.equal(entry.adsbLolProxy, providers.adsbLolProxy);
});

test('military aircraft route preserves fresh cache and stale response after upstream failure', async (t) => {
  let now = Date.now();
  let calls = 0;
  t.mock.method(Date, 'now', () => now);
  t.mock.method(console, 'error', () => {});
  t.mock.method(globalThis, 'fetch', async () => {
    if (++calls > 1) throw Error('offline');
    return Response.json({ ac: [{ hex: 'abc123' }] });
  });
  const request = install(providers.adsbLolProxy());
  const first = await request('/api/adsblol/mil');
  assert.equal((await request('/api/adsblol/mil')).body, first.body);
  assert.equal(calls, 1);
  now += 13_000;
  assert.equal((await request('/api/adsblol/mil')).body, first.body);
  assert.equal(calls, 2);
});

test('military aircraft route serves stale cache on an upstream 429 and cools down for Retry-After', async (t) => {
  let now = Date.now();
  let calls = 0;
  t.mock.method(Date, 'now', () => now);
  t.mock.method(console, 'warn', () => {});
  t.mock.method(globalThis, 'fetch', async () => {
    calls += 1;
    if (calls === 1) return Response.json({ ac: [{ hex: 'abc123' }] });
    return new Response(JSON.stringify({ error: 'rate limited' }), {
      status: 429,
      headers: { 'Retry-After': '20' },
    });
  });
  const request = install(providers.adsbLolProxy());
  const first = await request('/api/adsblol/mil');
  assert.equal(first.statusCode, 200);
  now += 13_000;
  const limited = await request('/api/adsblol/mil');
  assert.equal(calls, 2);
  assert.equal(
    limited.statusCode,
    200,
    'a 429 with a cached body is never relayed',
  );
  assert.equal(limited.body, first.body);
  assert.equal(limited.headers['x-ads-b-cache'], 'STALE');
  assert.equal(limited.headers['x-ads-b-upstream-status'], '429');
  assert.equal(limited.headers['x-ads-b-cache-age-ms'], '13000');
  now += 5_000;
  const cooling = await request('/api/adsblol/mil');
  assert.equal(calls, 2, 'no upstream call inside the Retry-After window');
  assert.equal(cooling.headers['x-ads-b-cache'], 'STALE');
  assert.equal(cooling.headers['x-ads-b-cache-age-ms'], '18000');
  now += 16_000;
  await request('/api/adsblol/mil');
  assert.equal(calls, 3, 'upstream is retried once Retry-After elapses');
});

test('military aircraft route relays an upstream 429 when nothing is cached', async (t) => {
  t.mock.method(console, 'warn', () => {});
  let calls = 0;
  t.mock.method(globalThis, 'fetch', async () => {
    calls += 1;
    return new Response('{"error":"rate limited"}', { status: 429 });
  });
  const request = install(providers.adsbLolProxy());
  const limited = await request('/api/adsblol/mil');
  assert.equal(limited.statusCode, 429);
  assert.ok(limited.headers['retry-after']);
  const again = await request('/api/adsblol/mil');
  assert.equal(again.statusCode, 429);
  assert.equal(
    calls,
    1,
    'the cooldown still protects upstream with nothing cached',
  );
  assert.ok(
    again.headers['retry-after'],
    'a cooling-down miss carries Retry-After',
  );
});

test('military fallback cancels a stalled 5xx body and starts cooldown at receipt', async (t) => {
  let now = 1_800_000_000_000;
  let calls = 0;
  let cancelled = false;
  t.mock.method(Date, 'now', () => now);
  t.mock.method(console, 'warn', () => {});
  t.mock.method(globalThis, 'fetch', async () => {
    if (++calls === 1) return Response.json({ ac: [] });
    now += 10000;
    return new Response(
      new ReadableStream({
        cancel() {
          cancelled = true;
        },
      }),
      {
        status: 503,
        headers: { 'Retry-After': new Date(now + 20000).toUTCString() },
      },
    );
  });
  const request = install(providers.adsbLolProxy());
  await request('/api/adsblol/mil');
  now += 1000;
  const hit = await request('/api/adsblol/mil');
  assert.equal(hit.headers['x-ads-b-cache-age-ms'], '1000');
  now += 12000;
  const fallback = await request('/api/adsblol/mil');
  assert.equal(fallback.statusCode, 200);
  assert.equal(cancelled, true);
  assert.equal(fallback.headers['x-ads-b-cache-age-ms'], '23000');
  assert.equal(fallback.headers['x-ads-b-retry-after-seconds'], '20');
  now += 19000;
  await request('/api/adsblol/mil');
  assert.equal(calls, 2);
  now += 2000;
  await request('/api/adsblol/mil');
  assert.equal(calls, 3);
});

test('military cooldown bounds untrusted Retry-After and defaults server errors', async (t) => {
  t.mock.method(console, 'warn', () => {});
  for (const [status, raw, seconds] of [
    [429, '1', 5],
    [429, '99999', 120],
    [503, 'invalid', 15],
  ]) {
    t.mock.method(
      globalThis,
      'fetch',
      async () =>
        new Response('{}', {
          status,
          headers: { 'Retry-After': raw },
        }),
    );
    const result = await install(providers.adsbLolProxy())('/api/adsblol/mil');
    assert.equal(Number(result.headers['retry-after']), seconds);
  }
});
