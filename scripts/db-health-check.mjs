import assert from 'node:assert/strict';

const base = process.env.GEV_TEST_BASE_URL || 'http://localhost:4173';
for (const path of ['/healthz', '/readyz']) {
  assert.equal((await fetch(`${base}${path}`)).status, 200);
}
const index = await fetch(base);
assert.equal(index.status, 200);
const html = await index.text();
assert.ok(html.includes('/assets/'));
assert.equal(html.includes('/@vite/client'), false);
const asset = html.match(/src="(\/assets\/[^\"]+\.js)"/)[1];
assert.equal((await fetch(`${base}${asset}`)).status, 200);
for (const path of [
  '/api/session',
  '/api/database/health',
  '/api/weather',
  '/api/unregistered',
]) {
  const result = await fetch(`${base}${path}`);
  assert.equal(result.status, 401, path);
  assert.deepEqual(await result.json(), { error: 'unauthorized' });
}
for (const path of [
  '/.env',
  '/.gev-secrets/app',
  '/.gev-backups/test.dump',
  '/@vite/client',
  '/@fs/app/.gev-secrets/app',
  '/backend/main.js',
  '/assets/missing.js',
]) {
  assert.equal((await fetch(`${base}${path}`)).status, 404, path);
}
console.log(
  'PASS: static frontend assets, backend probes, API default denial and private/source file protections',
);
