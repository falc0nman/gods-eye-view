import { readFileSync } from 'node:fs';
import { spawn } from 'node:child_process';

// Compose file-backed secrets retain host ownership on Linux. Read only the
// identity mounted into this container, then drop OS privileges before starting
// the app/worker. Passwords never enter shell arguments or browser defines.
for (const name of [
  'GEV_DB_PASSWORD',
  'GEV_DB_MIGRATOR_PASSWORD',
  'GEV_AUTH_KEY',
  'GEV_DISCORD_CLIENT_SECRET',
  'GEV_DISCORD_BOT_TOKEN',
  'GEV_GOOGLE_CLIENT_SECRET',
]) {
  const file = process.env[`${name}_FILE`];
  if (file) {
    process.env[name] = readFileSync(file, 'utf8').trim();
    delete process.env[`${name}_FILE`];
  }
}
process.setgid('node');
process.setuid('node');
const [command, ...args] = process.argv.slice(2);
const child = spawn(command, args, { stdio: 'inherit' });
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => child.kill(signal));
}
child.on('error', () => process.exit(1));
child.on('exit', (code, signal) => {
  if (signal) process.exit(signal === 'SIGINT' ? 130 : 143);
  else process.exit(code ?? 1);
});
