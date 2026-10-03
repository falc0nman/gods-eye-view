import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { readResponseTextCapped, coalesceProxyRequest } from './sources/httpBody.js';

const source = ['local.js', 'common/http.js', 'aircraft/enrichment.js', 'terrain.js']
  .map(file => readFileSync(new URL(`../server/providers/${file}`, import.meta.url), 'utf8'))
  .join('\n');
const detail = 'fixture-secret-token /internal/example <html>';

// Execute the production middleware with isolated upstreams and cache storage.
// Top-level function closing braces start in column zero in this module.
function extract(name) {
  const start = source.search(new RegExp(`(?:export )?(?:async )?function ${name}\\(`));
  assert.ok(start >= 0, `${name} must exist`);
  const end = source.indexOf('\n}', start);
  return source.slice(start, end + 2).replace(/^export /, '');
}

function fixture(name, overrides = {}, preview = false) {
  const logs = [];
  const deps = {
    readResponseTextCapped, coalesceProxyRequest,
    path, process: { cwd: () => '/fixture', env: {} },
    fsp: {
      readFile: async () => { throw new Error('cache absent'); },
      stat: async () => { throw new Error('cache absent'); },
      mkdir: async () => {}, writeFile: async () => {},
    },
    fetch: async () => { throw new Error(detail); },
    console: { warn: (...args) => logs.push(args.join(' ')), error: (...args) => logs.push(args.join(' ')) },
    setInterval: () => ({ unref() {} }),
    parseTerrainPoints: () => [[1, 2]],
    resolveTerrainHeightRequest: async () => { throw new Error(detail); },
    ...overrides,
  };
  const plugin = new Function(...Object.keys(deps), `${extract(name)}\nreturn ${name}();`)(...Object.values(deps));
  let middleware;
  plugin[preview ? 'configurePreviewServer' : 'configureServer']({ middlewares: { use(_route, handler) { middleware = handler; } } });
  return {
    logs,
    async request(url = '/', method = 'GET') {
      const response = { headersSent: false, writeHead(status, headers) { Object.assign(this, { status, headers, headersSent: true }); }, end(body) { this.body = body; } };
      await middleware({ url, method }, response);
      assert.doesNotMatch(response.body, /fixture-secret-token|internal\/example|<html>/);
      assert.doesNotMatch(logs.join('\n'), /fixture-secret-token|internal\/example|<html>/);
      return response;
    },
  };
}

test('terrain unexpected failures hide details', async () => {
  const res = await fixture('terrainHeightsProxy').request('/?points=1,2');
  assert.equal(res.status, 500);
  assert.deepEqual(JSON.parse(res.body), { error: 'terrain heights proxy error' });
});

test('terrain validation and resolver outcomes remain intact', async () => {
  const invalid = await fixture('terrainHeightsProxy', { parseTerrainPoints: () => null }).request();
  assert.equal(invalid.status, 400);
  const body = { results: [{ height: 12 }] };
  const app = fixture('terrainHeightsProxy', { resolveTerrainHeightRequest: async () => ({ status: 200, body, upstreamError: new Error(detail) }) });
  const res = await app.request('/?points=1,2');
  assert.equal(res.status, 200);
  assert.deepEqual(JSON.parse(res.body), body);
  assert.equal(app.logs.length, 1);
});

test('ADSBDB unexpected failures hide details', async () => {
  const badUrl = { toString() { throw new Error(detail); } };
  const res = await fixture('adsbdbProxy').request(badUrl);
  assert.equal(res.status, 500);
  assert.deepEqual(JSON.parse(res.body), { error: 'adsbdb proxy error' });
});

test('ADSBDB retains validation and missing-aircraft semantics', async () => {
  const app = fixture('adsbdbProxy');
  assert.equal((await app.request('/route/!')).status, 400);
  assert.equal((await app.request('/type/nope')).status, 400);
  assert.equal((await app.request('/unknown')).status, 404);
  const absent = await app.request('/type/abcdef');
  assert.equal(absent.status, 200);
  assert.deepEqual(JSON.parse(absent.body), { found: false });
});
