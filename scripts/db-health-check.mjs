import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync, unlinkSync } from 'node:fs';

const base = 'http://127.0.0.1:4173';
const response = await fetch(`${base}/api/database/health`);
assert.equal(response.status, 200);
assert.deepEqual(await response.json(), { status: 'ready' });
assert.equal(
  (await fetch(`${base}/api/database/health`, { method: 'POST' })).status,
  405,
);
for (const directory of ['.gev-secrets', '.gev-backups']) {
  const root = new URL(`../${directory}/`, import.meta.url);
  mkdirSync(root, { recursive: true });
  const name = `qa-private-${process.pid}`;
  const file = new URL(name, root);
  writeFileSync(file, 'private-fixture', { flag: 'wx' });
  try {
    for (const path of [
      `/${directory}/${name}`,
      `/@fs/app/${directory}/${name}`,
    ]) {
      const result = await fetch(`${base}${path}`);
      assert.ok(
        [403, 404].includes(result.status),
        `private path must be denied: ${path}`,
      );
    }
  } finally {
    unlinkSync(file);
  }
}
console.log(
  'PASS: real HTTP readiness, method handling and private file protections',
);
