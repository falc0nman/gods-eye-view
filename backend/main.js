import { createDatabasePool } from '../server/database/connection.js';
import { createBackend } from './server.js';
import { identityConfig } from './identity/config.js';
import { createIdentityService } from './identity/service.js';
import { administrationRoutes } from './identity/administration.js';
import { backendProviders } from '../server/providers/interface.js';

const port = Number(process.env.GEV_BACKEND_PORT || 3000);
if (!Number.isInteger(port) || port < 1 || port > 65535)
  throw new Error('Invalid backend port');
const pool = createDatabasePool();
pool.on('error', () =>
  console.error('[backend] Idle database connection failed'),
);
let stopping = false;
const config = identityConfig();
const identityService = createIdentityService({ pool, config });
// Data providers on the common interface (GW-80): radar ingest, NOAA
// notifications and feed health recorded to gev.feed_health (GW-83).
const providers = backendProviders({ pool });
const server = createBackend({
  pool,
  cookieName: process.env.GEV_SESSION_COOKIE,
  publicOrigin: process.env.GEV_PUBLIC_ORIGIN,
  isStopping: () => stopping,
  identityService,
  routes: [...administrationRoutes(pool, config), ...providers.routes],
});
providers.start();

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
      await providers.close();
      await pool.end();
      clearTimeout(deadline);
    });
    server.closeIdleConnections();
  });
