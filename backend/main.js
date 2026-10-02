import { createDatabasePool } from '../server/database/connection.js';
import { createBackend } from './server.js';

const port = Number(process.env.GEV_BACKEND_PORT || 3000);
if (!Number.isInteger(port) || port < 1 || port > 65535)
  throw new Error('Invalid backend port');
const pool = createDatabasePool();
pool.on('error', () =>
  console.error('[backend] Idle database connection failed'),
);
let stopping = false;
const server = createBackend({
  pool,
  cookieName: process.env.GEV_SESSION_COOKIE,
  publicOrigin: process.env.GEV_PUBLIC_ORIGIN,
  isStopping: () => stopping,
});

server.listen(port, process.env.GEV_BACKEND_HOST || '127.0.0.1', () => {
  console.log(`[backend] Listening on port ${port}`);
});
server.on('error', async () => {
  console.error('[backend] Listener failed');
  await pool.end();
  process.exitCode = 1;
});
for (const signal of ['SIGINT', 'SIGTERM'])
  process.once(signal, () => {
    if (stopping) return;
    stopping = true;
    const deadline = setTimeout(() => process.exit(1), 15000);
    deadline.unref();
    server.close(async () => {
      await pool.end();
      clearTimeout(deadline);
    });
    server.closeIdleConnections();
  });
