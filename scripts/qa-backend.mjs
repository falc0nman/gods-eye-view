import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';

const root = fileURLToPath(new URL('../', import.meta.url));
function compose(args, capture = false) {
  const result = spawnSync('docker', ['compose', ...args], {
    cwd: root,
    encoding: 'utf8',
    stdio: capture ? ['ignore', 'pipe', 'inherit'] : 'inherit',
  });
  if (result.error) throw result.error;
  if (result.status !== 0)
    throw new Error(`Compose ${args[0]} failed (${result.status})`);
  return result.stdout;
}
function qa(script, ...args) {
  compose(['run', '--rm', '--no-deps', 'qa', 'node', script, ...args]);
}

// Run against a local/CI stack. Failure checks briefly stop its own database and
// backend, never remove volumes, and always restore stopped services.
compose(['up', '--build', '--wait', 'db', 'app', 'backup', 'maintenance']);
qa('scripts/db-health-check.mjs');
qa('scripts/backend-integration.mjs');
compose(['stop', 'db']);
try {
  qa('scripts/backend-integration.mjs', '--outage');
} finally {
  compose(['up', '--wait', 'db']);
}
qa('scripts/db-health-check.mjs');
compose(['stop', '--timeout', '20', 'backend']);
try {
  const status = JSON.parse(
    compose(['ps', '--all', '--format', 'json', 'backend'], true),
  );
  assert.equal(status.State, 'exited');
  assert.equal(status.ExitCode, 0);
  console.log(
    'PASS: backend SIGTERM drains HTTP and closes the database pool cleanly',
  );
} finally {
  compose(['up', '--wait', 'backend', 'app']);
}
qa('scripts/db-health-check.mjs');
console.log('Backend integration checks passed.');
