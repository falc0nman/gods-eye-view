import { createDatabasePool } from '../database/connection.js';

/** Connect configured deployments to PostGIS without exposing database credentials. */
export function databasePlugin({
  env = process.env,
  createPool = createDatabasePool,
} = {}) {
  function install(server) {
    let pool;
    if (env.GEV_DB_HOST) {
      pool = createPool({ env });
      pool.on('error', () =>
        console.error('[database] Idle connection failed'),
      );
      server.httpServer?.once('close', () => void pool.end());
    }
    server.middlewares.use('/api/database/health', async (req, res, next) => {
      if (req.url.split('?')[0] !== '/' && req.url.split('?')[0] !== '')
        return next();
      res.setHeader('Content-Type', 'application/json');
      res.setHeader('Cache-Control', 'no-store');
      if (req.method !== 'GET') {
        res.statusCode = 405;
        res.setHeader('Allow', 'GET');
        res.end(JSON.stringify({ status: 'method_not_allowed' }));
        return;
      }
      if (!pool) {
        res.statusCode = 503;
        res.end(JSON.stringify({ status: 'disabled' }));
        return;
      }
      try {
        await pool.query(
          'SELECT PostGIS_Version(), count(*) FROM gev.schema_migrations',
        );
        res.end(JSON.stringify({ status: 'ready' }));
      } catch {
        res.statusCode = 503;
        res.end(JSON.stringify({ status: 'unavailable' }));
      }
    });
  }
  return {
    name: 'gev-database',
    configureServer: install,
    configurePreviewServer: install,
  };
}
