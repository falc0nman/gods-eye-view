import { spawnSync } from 'node:child_process';
import { readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
function compose(...args) {
  const result = spawnSync('docker', ['compose', ...args], {
    cwd: root,
    stdio: 'inherit',
  });
  if (result.error) throw result.error;
  if (result.status !== 0)
    throw new Error(`Docker Compose ${args[0]} failed (${result.status})`);
}

// Uses the local stack; only the documented QA workspace and scratch restore DB
// are cleaned. Never remove volumes or overwrite an existing database.
compose('up', '--build', '--wait', 'db', 'app', 'backup', 'maintenance');
try {
  compose('run', '--rm', 'qa');
  compose('restart', 'db');
  compose('up', '--wait', 'db');
  compose(
    'run',
    '--rm',
    'qa',
    'node',
    'scripts/db-integration.mjs',
    '--persisted',
  );
  compose('run', '--rm', 'backup', '--once');
  const archive = readdirSync(new URL('../.gev-backups/', import.meta.url))
    .filter((file) => /^gev-.*\.dump$/.test(file))
    .sort()
    .at(-1);
  if (!archive) throw new Error('No completed backup archive');
  compose(
    'run',
    '--rm',
    '-e',
    'GEV_RESTORE_EXPECT_FIXTURE=1',
    'restore-check',
    `/backups/${archive}`,
  );
  console.log(
    'PASS: persistent volume, automated backup, complete restore, spatial fixture and runtime grants',
  );
  compose('exec', '-T', 'app', 'node', 'scripts/db-health-check.mjs');
} finally {
  compose(
    'run',
    '--rm',
    'qa',
    'node',
    'scripts/db-integration.mjs',
    '--cleanup',
  );
}
