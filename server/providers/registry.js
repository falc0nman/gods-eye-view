import {
  createProviderRuntime,
  defineProvider,
  isProviderDefinition,
} from './common/provider.js';

/**
 * Central provider registry (GW-80). Providers register here once instead of
 * each layer wiring its own proxy into the server; the registry owns their
 * runtimes and turns them into the server plugins the standalone config
 * installs. See docs/DATA-PROVIDERS.md.
 *
 * Two kinds of entry, kept in registration order:
 *   - `register(definition)` — a provider implementing the common interface.
 *   - `registerLegacy(id, createPlugin)` — an existing per-layer proxy that
 *     has not been ported yet. It is installed unchanged, so migration can go
 *     one provider at a time.
 */
export function createProviderRegistry({ runtimeOptions = {} } = {}) {
  /** @type {Map<string, {id: string, kind: 'provider'|'legacy', provider?: object, runtime?: object, createPlugin?: Function}>} */
  const entries = new Map();
  /** name → () => status, e.g. the notification dispatcher (GW-81). */
  const streams = new Map();

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

  /** `GET /api/providers` — what is registered and how each provider is doing. */
  function catalogPlugin() {
    const install = (server) => {
      server.middlewares.use('/api/providers', (req, res, next) => {
        const path = new URL(req.url || '/', 'http://local').pathname;
        if (req.method !== 'GET' || (path !== '/' && path !== '')) {
          next();
          return;
        }
        res.writeHead(200, {
          'Content-Type': 'application/json',
          'Cache-Control': 'no-store',
        });
        res.end(
          JSON.stringify({
            providers: [...entries.values()].map(describe),
            streams: streamStatus(),
          }),
        );
      });
    };
    return {
      name: 'gev-provider-catalog',
      configureServer: install,
      configurePreviewServer: install,
    };
  }

  function providerPlugin({ provider, runtime }) {
    const install = (server) => {
      provider.routes?.(server, runtime);
      // Polling and subscriptions belong to the server process: never leave a
      // timer or socket behind when the server closes.
      server.httpServer?.once?.('close', () => runtime.stop());
    };
    return {
      name: `gev-provider-${provider.id}`,
      configureServer: install,
      configurePreviewServer: install,
    };
  }

  /** Server plugins in registration order, catalog first. */
  function plugins() {
    return [
      catalogPlugin(),
      ...[...entries.values()].map((entry) =>
        entry.kind === 'legacy' ? entry.createPlugin() : providerPlugin(entry),
      ),
    ];
  }

  return Object.freeze({
    register,
    registerLegacy,
    registerStream,
    get: (id) => entries.get(id)?.runtime ?? null,
    has: (id) => entries.has(id),
    list: () => [...entries.values()].map(describe),
    plugins,
  });
}
