import { randomBytes } from 'node:crypto';
import { mkdirSync, writeFileSync, existsSync } from 'node:fs';

const directory = new URL('../.gev-secrets/', import.meta.url);
mkdirSync(directory, { recursive: true, mode: 0o700 });
for (const name of ['postgres', 'app', 'migrator', 'backup', 'auth']) {
  const file = new URL(name, directory);
  if (!existsSync(file))
    writeFileSync(file, randomBytes(32).toString('hex'), {
      mode: 0o600,
      flag: 'wx',
    });
}
console.log(
  'Database secret files are ready in .gev-secrets (existing credentials preserved).',
);
