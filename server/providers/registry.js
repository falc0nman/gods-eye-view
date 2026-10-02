import {
  createProviderRuntime,
  defineProvider,
  isProviderDefinition,
} from './common/provider.js';
import { createHealthMonitor } from './common/health.js';

/**
 * Central provider registry (GW-80). Providers register here once instead of
 * each layer wiring its own proxy into the server; the registry owns their
 * runtimes and their HTTP routes. See docs/DATA-PROVIDERS.md.
 *
 * Routes are declared once, in the standalone backend's shape
 * (backend/server.js, GW-86): `apiRoutes()` hands them to `createBackend`,
 * which puts every one behind its session and permission gate (GW-45).
 * `plugins()` serves the same handlers from the Vite dev server for
 * `npm run dev`, which has no sessions.
 *
 * Two kinds of entry, kept in registration order:
 *   - `register(definition)` — a provider implementing the common interface.
 *   - `registerLegacy(id, createPlugin)` — an existing per-layer proxy that
 *     has not been ported yet. It is installed unchanged, so migration can go
 *     one provider at a time.
 */
export function createProviderRegistry({
  runtimeOptions = {},
  healthThresholds = {},
  healthIntervalMs = 15_000,
} = {}) {
  /** @type {Map<string, {id: string, kind: 'provider'|'legacy', provider?: object, runtime?: object, createPlugin?: Function}>} */
  const entries = new Map();
  /** name → () => status, e.g. the notification dispatcher (GW-81). */
  const streams = new Map();
  const providerEntries = () =>
    [...entries.values()].filter((entry) => entry.kind === 'provider');
  // GW-83: health and data age for every provider on the common interface.
  const health = createHealthMonitor({
    entries: providerEntries,
    thresholds: healthThresholds,
    now: runtimeOptions.now,
  });

  function claim(id) {
    if (entries.has(id))
      throw new Error(`[provider] ${id} is already registered`);
  }

  function register(definition, options = {}) {
    const provider = isProviderDefinition(definition)
      ? definition
      : defineProvider(definition);
    claim(provider.id);
    const runtime = createProviderRuntime(provider, {
      ...runtimeOptions,
      ...options,
    });
    entries.set(provider.id, {
      id: provider.id,
      kind: 'provider',
      provider,
      runtime,
    });
    provider.attach?.(runtime);
    return runtime;
  }

  function registerLegacy(id, createPlugin) {
    if (typeof createPlugin !== 'function')
      throw new TypeError(`[provider] legacy ${id} needs a plugin factory`);
    claim(id);
    entries.set(id, { id, kind: 'legacy', createPlugin });
  }

  function describe(entry) {
    if (entry.kind === 'legacy') return { id: entry.id, kind: 'legacy' };
    const { provider, runtime } = entry;
    const {
      running,
      consumers,
      lastRunAt,
      lastIngestAt,
      lastError,
      published,
      availableToIngestMs,
    } = runtime.status();
    return {
      id: provider.id,
      kind: 'provider',
      label: provider.label,
      mode: provider.mode,
      source: provider.source,
      pollMs: provider.pollMs,
      running,
      consumers,
      lastRunAt,
      lastIngestAt,
      lastError,
      published,
      availableToIngestMs,
    };
  }

  /** Report a shared ingest stream (such as notifications) in the catalog. */
  function registerStream(name, status) {
    if (typeof status !== 'function')
      throw new TypeError(`[provider] stream ${name} needs a status function`);
    if (streams.has(name))
      throw new Error(`[provider] stream ${name} is already registered`);
    streams.set(name, status);
  }

  function streamStatus() {
    return Object.fromEntries(
      [...streams].map(([name, status]) => {
        try {
          return [name, status()];
        } catch (error) {
          return [
            name,
            { state: 'error', error: String(error?.message || error) },
          ];
        }
      }),
    );
  }

  /** Health for every entry; legacy proxies do not report any. */
  function healthReport() {
    const report = health.report();
    const byId = new Map(report.providers.map((p) => [p.id, p]));
    return {
      generatedAt: report.generatedAt,
      providers: [...entries.values()].map(
        (entry) =>
          byId.get(entry.id) ?? {
            id: entry.id,
            state: 'unmonitored',
            reason: 'legacy proxy; not on the provider interface yet',
          },
      ),
      streams: streamStatus(),
      history: report.history,
    };
  }

  function catalog() {
    const states = new Map(
      health.evaluate().providers.map((p) => [p.id, p.state]),
    );
    return {
      providers: [...entries.values()].map((entry) => ({
        ...describe(entry),
        health: states.get(entry.id) ?? 'unmonitored',
      })),
      streams: streamStatus(),
    };
  }

  /**
   * Every provider route in the backend's shape, the registry's own first:
   *   GET /api/providers         — what is registered and how it is doing
   *   GET /api/providers/health  — health, data age and recent transitions
   * Both are operational detail, so they need `system:read`.
   */
  function apiRoutes() {
    const own = [
      {
        method: 'GET',
        path: '/api/providers',
        permissions: ['system:read'],
        handler: async () => ({ status: 200, body: catalog() }),
      },
      {
        method: 'GET',
        path: '/api/providers/health',
        permissions: ['system:read'],
        handler: async () => ({ status: 200, body: healthReport() }),
      },
    ];
    const provided = providerEntries().flatMap(({ provider }) =>
      provider.api.map((route) => ({
        method: route.method,
        path: route.path,
        permissions: route.permissions,
        handler: ({ req, session }) =>
          route.handler({
            query: new URL(req.url || '/', 'http://local').searchParams,
            req,
            session,
          }),
      })),
    );
    return [...own, ...provided];
  }

  /** Write a route result to a Node/connect response (the dev server). */
  function writeResult(res, result) {
    const headers = {
      'Cache-Control': result.cacheControl ?? 'no-store',
      'X-Content-Type-Options': 'nosniff',
      ...(result.headers ?? {}),
    };
    if (result.bytes) {
      res.writeHead(result.status, {
        ...headers,
        'Content-Type': result.contentType,
      });
      res.end(result.bytes);
      return;
    }
    res.writeHead(result.status, {
      ...headers,
      'Content-Type': 'application/json',
    });
    res.end(JSON.stringify(result.body ?? {}));
  }

  /**
   * The dev server's view of `apiRoutes()`: exact method + path, like the
   * backend. There are no sessions in `npm run dev`, so permissions are not
   * checked here; production only ever serves these through the backend.
   */
  function devApiPlugin() {
    const install = (server) => {
      const routes = new Map(
        apiRoutes().map((route) => [`${route.method} ${route.path}`, route]),
      );
      server.middlewares.use(async (req, res, next) => {
        const path = new URL(req.url || '/', 'http://local').pathname;
        const method = req.method === 'HEAD' ? 'GET' : req.method || 'GET';
        const route = routes.get(`${method} ${path}`);
        if (!route) {
          next();
          return;
        }
        try {
          writeResult(res, await route.handler({ req, session: null }));
        } catch (error) {
          console.warn('[provider]', error?.message || error);
          if (!res.headersSent)
            writeResult(res, {
              status: 502,
              body: { error: 'provider_failed' },
            });
        }
      });
      // Evaluate in the background so a provider going stale is recorded in
      // the history even when nobody is asking.
      health.start(healthIntervalMs);
      // Polling and subscriptions belong to the server process: never leave a
      // timer or socket behind when the server closes.
      server.httpServer?.once?.('close', close);
    };
    return {
      name: 'gev-provider-api',
      configureServer: install,
      configurePreviewServer: install,
    };
  }

  /** Dev server plugins: the provider API first, then legacy proxies in order. */
  function plugins() {
    return [
      devApiPlugin(),
      ...[...entries.values()]
        .filter((entry) => entry.kind === 'legacy')
        .map((entry) => entry.createPlugin()),
    ];
  }

  /** Stop every runtime, provider timer and the health monitor. */
  function close() {
    health.stop();
    for (const { provider, runtime } of providerEntries()) {
      runtime.stop();
      try {
        provider.close?.();
      } catch (error) {
        console.warn(`[provider] ${provider.id} close failed:`, error?.message);
      }
    }
  }

  return Object.freeze({
    register,
    registerLegacy,
    registerStream,
    get: (id) => entries.get(id)?.runtime ?? null,
    has: (id) => entries.has(id),
    list: () => [...entries.values()].map(describe),
    /** The health monitor: evaluate(), report(), subscribe() for shared state (GW-28). */
    health,
    healthReport,
    apiRoutes,
    plugins,
    close,
  });
}
