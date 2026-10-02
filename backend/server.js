import { createServer } from 'node:http';
import {
  authenticate,
  DEFAULT_SESSION_COOKIE,
  sameOriginWrite,
} from './auth.js';
import { coreRoutes, databaseReady } from './routes.js';

function json(req, res, status, body) {
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'Referrer-Policy': 'same-origin',
  });
  res.end(req.method === 'HEAD' ? undefined : JSON.stringify(body));
}

/** Standalone HTTP service. Public probes are outside the closed API namespace. */
export function createBackend({
  pool,
  routes = [],
  cookieName = DEFAULT_SESSION_COOKIE,
  publicOrigin,
  logger = console,
  isStopping = () => false,
} = {}) {
  if (!pool) throw new Error('Backend requires a database pool');
  if (!/^[A-Za-z0-9_-]+$/.test(cookieName))
    throw new Error('Invalid session cookie name');
  if (publicOrigin && new URL(publicOrigin).origin !== publicOrigin)
    throw new Error('Expected a canonical public origin');
  const registry = new Map();
  for (const route of [...coreRoutes(pool), ...routes]) {
    if (
      !/^\/api\/[A-Za-z0-9_/-]+$/.test(route.path) ||
      !['GET', 'POST', 'PUT', 'PATCH', 'DELETE'].includes(route.method) ||
      !Array.isArray(route.permissions) ||
      route.permissions.some((value) => typeof value !== 'string' || !value) ||
      typeof route.handler !== 'function'
    )
      throw new Error('API routes require an explicit permission policy');
    const key = `${route.method} ${route.path}`;
    if (registry.has(key)) throw new Error(`Duplicate API route: ${key}`);
    registry.set(
      key,
      Object.freeze({ ...route, permissions: [...route.permissions] }),
    );
  }

  const server = createServer(
    {
      requestTimeout: 30000,
      headersTimeout: 15000,
      keepAliveTimeout: 5000,
      maxHeaderSize: 16384,
    },
    (req, res) => {
      void handle(req, res).catch(() => {
        logger.error('[backend] Request failed');
        if (!res.headersSent && !res.destroyed)
          json(req, res, 503, { error: 'service_unavailable' });
        else res.destroy();
      });
    },
  );
  server.maxRequestsPerSocket = 100;
  server.on('upgrade', (_req, socket) => socket.destroy());

  async function handle(req, res) {
    let path;
    try {
      path = decodeURIComponent(req.url.split('?')[0]);
    } catch {
      return json(req, res, 400, { error: 'invalid_path' });
    }
    if (
      !path.startsWith('/') ||
      /[\\\0]/.test(path) ||
      path.split('/').some((part) => part === '.' || part === '..')
    ) {
      return json(req, res, 400, { error: 'invalid_path' });
    }
    if (isStopping())
      return json(req, res, 503, { error: 'service_unavailable' });
    if (path === '/healthz' || path === '/readyz') {
      if (!['GET', 'HEAD'].includes(req.method)) {
        res.setHeader('Allow', 'GET, HEAD');
        return json(req, res, 405, { error: 'method_not_allowed' });
      }
      if (path === '/healthz') return json(req, res, 200, { status: 'ok' });
      const ready = await databaseReady(pool);
      return json(req, res, ready ? 200 : 503, {
        status: ready ? 'ready' : 'unavailable',
      });
    }
    if (path === '/api' || path.startsWith('/api/')) {
      const session = await authenticate(req, pool, cookieName);
      if (!session) return json(req, res, 401, { error: 'unauthorized' });
      const route = registry.get(
        `${req.method === 'HEAD' ? 'GET' : req.method} ${path}`,
      );
      if (
        !route ||
        !route.permissions.every((permission) =>
          session.permissions.includes(permission),
        )
      ) {
        return json(req, res, 403, { error: 'forbidden' });
      }
      if (
        !['GET', 'HEAD'].includes(req.method) &&
        !sameOriginWrite(req, publicOrigin)
      ) {
        return json(req, res, 403, { error: 'csrf_rejected' });
      }
      const result = await route.handler({ req, session, pool });
      return json(req, res, result.status, result.body);
    }
    return json(req, res, 404, { error: 'not_found' });
  }
  return server;
}
