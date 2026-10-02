/**
 * The common data provider interface (GW-80). See docs/DATA-PROVIDERS.md.
 *
 * Every provider moves data through the same five stages:
 *
 *   discover → fetch → decode → normalize → publish
 *
 * A provider supplies the first four as plain functions; publishing, item
 * de-duplication, error isolation, polling and subscriber bookkeeping belong
 * to the runtime here so layers stop reinventing them.
 *
 * Pull providers are polled: `discover(ctx)` returns the items available now
 * and the runtime fetches the ones it has not seen. Push providers are
 * event-driven: `subscribe(ctx, emit)` hands items to the runtime as the
 * upstream announces them (an SNS notice, a websocket frame, a file watcher)
 * and returns a function that stops the subscription.
 */

export const PROVIDER_MODES = Object.freeze(['pull', 'push']);
export const PROVIDER_STAGES = Object.freeze([
  'discover',
  'fetch',
  'decode',
  'normalize',
  'publish',
]);

const PROVIDER_ID_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const MIN_POLL_MS = 1_000;
const DEFAULT_SEEN_LIMIT = 2_048;

const identity = (value) => value;
const definitions = new WeakSet();

/** Whether a value came from defineProvider(). */
export function isProviderDefinition(value) {
  return definitions.has(value);
}

function invalid(message) {
  const error = new TypeError(`[provider] ${message}`);
  error.code = 'PROVIDER_DEFINITION_INVALID';
  return error;
}

/**
 * An error raised by one stage of one provider, keeping the failing stage and
 * item so a status surface can say exactly what broke.
 */
export class ProviderStageError extends Error {
  constructor(providerId, stage, item, cause) {
    super(
      `[provider] ${providerId} ${stage} failed: ${cause?.message || cause}`,
      { cause },
    );
    this.name = 'ProviderStageError';
    this.providerId = providerId;
    this.stage = stage;
    this.itemKey = item?.key ?? null;
  }
}

function normalizeSource(source, where) {
  if (!source || typeof source !== 'object')
    throw invalid(`${where} needs a source {name, url?, license?}`);
  if (typeof source.name !== 'string' || !source.name.trim())
    throw invalid(`${where} source.name must be a non-empty string`);
  return Object.freeze({
    name: source.name,
    ...(source.url ? { url: String(source.url) } : {}),
    ...(source.license ? { license: String(source.license) } : {}),
  });
}

/**
 * Validate and freeze a provider definition.
 *
 * @param {object} spec
 * @param {string} spec.id - kebab-case id, unique in the registry.
 * @param {string} [spec.label]
 * @param {'pull'|'push'} spec.mode
 * @param {{name: string, url?: string, license?: string}} spec.source - default provenance origin.
 * @param {number} [spec.pollMs] - pull only: polling interval.
 * @param {(ctx) => Iterable|AsyncIterable|Promise<Iterable>} [spec.discover] - pull only.
 * @param {(ctx, emit: (item) => void) => (() => void)} [spec.subscribe] - push only.
 * @param {(item, ctx) => any} [spec.fetch] - defaults to identity (push payloads often arrive inline).
 * @param {(raw, item, ctx) => any} [spec.decode] - defaults to identity.
 * @param {(decoded, item, ctx) => object|object[]|null} spec.normalize - returns record input(s).
 * @param {(server, runtime) => void} [spec.routes] - mounts HTTP routes on the dev/preview server.
 */
export function defineProvider(spec) {
  if (!spec || typeof spec !== 'object')
    throw invalid('definition must be an object');
  const { id, mode } = spec;
  if (typeof id !== 'string' || !PROVIDER_ID_RE.test(id))
    throw invalid(`id must be kebab-case, got ${JSON.stringify(id)}`);
  if (!PROVIDER_MODES.includes(mode))
    throw invalid(`${id} mode must be one of ${PROVIDER_MODES.join(', ')}`);
  const source = normalizeSource(spec.source, id);
  if (typeof spec.normalize !== 'function')
    throw invalid(`${id} must implement normalize()`);
  for (const stage of ['fetch', 'decode', 'routes']) {
    if (spec[stage] !== undefined && typeof spec[stage] !== 'function')
      throw invalid(`${id} ${stage} must be a function`);
  }
  if (mode === 'pull') {
    if (typeof spec.discover !== 'function')
      throw invalid(`${id} is a pull provider and must implement discover()`);
    if (spec.subscribe !== undefined)
      throw invalid(`${id} is a pull provider and cannot subscribe()`);
    if (!Number.isFinite(spec.pollMs) || spec.pollMs < MIN_POLL_MS)
      throw invalid(`${id} pollMs must be at least ${MIN_POLL_MS}`);
  } else {
    if (typeof spec.subscribe !== 'function')
      throw invalid(`${id} is a push provider and must implement subscribe()`);
    if (spec.discover !== undefined)
      throw invalid(`${id} is a push provider and cannot discover()`);
  }
  const definition = Object.freeze({
    id,
    label: spec.label || id,
    mode,
    source,
    pollMs: mode === 'pull' ? spec.pollMs : null,
    discover: spec.discover ?? null,
    subscribe: spec.subscribe ?? null,
    fetch: spec.fetch ?? identity,
    decode: spec.decode ?? identity,
    normalize: spec.normalize,
    routes: spec.routes ?? null,
  });
  definitions.add(definition);
  return definition;
}

function toMs(value, field, providerId) {
  const ms = value instanceof Date ? value.getTime() : Number(value);
  if (!Number.isFinite(ms))
    throw new TypeError(
      `[provider] ${providerId} record ${field} must be a Date or epoch ms`,
    );
  return ms;
}

/**
 * Build the normalized record every provider publishes.
 *
 * - `validTime`: when the observation is valid (scan time, report time).
 * - `ingestTime`: when GEV received it (stamped by the runtime).
 * - `source`: the upstream that produced it.
 * - `provenance`: how GEV got it — provider id, the discovered item key and
 *   any upstream identifiers (object key, ETag, sequence number, …).
 */
export function createRecord(
  provider,
  input,
  { item = null, ingestTime } = {},
) {
  if (!input || typeof input !== 'object')
    throw new TypeError(
      `[provider] ${provider.id} normalize() returned a non-object`,
    );
  const validTime = toMs(input.validTime, 'validTime', provider.id);
  const ingested = toMs(ingestTime, 'ingestTime', provider.id);
  const key = String(input.key ?? item?.key ?? `${provider.id}:${validTime}`);
  return Object.freeze({
    key,
    source: input.source
      ? normalizeSource(input.source, `${provider.id} record`)
      : provider.source,
    validTime,
    ingestTime: ingested,
    provenance: Object.freeze({
      provider: provider.id,
      mode: provider.mode,
      item: item?.key ?? null,
      ...(input.provenance || {}),
    }),
    data: input.data,
  });
}

/**
 * Run one provider. Nothing runs until a consumer acquires it, and polling or
 * subscriptions stop again once the last consumer releases it.
 *
 * @param {ReturnType<typeof defineProvider>} provider
 * @param {object} [options]
 * @param {() => number} [options.now]
 * @param {Function} [options.setTimeout]
 * @param {Function} [options.clearTimeout]
 * @param {number} [options.retain] - newest records kept for `latest()`.
 * @param {(error: ProviderStageError) => void} [options.onError]
 * @param {object} [options.context] - extra fields handed to every stage (fetchImpl, env…).
 */
export function createProviderRuntime(
  provider,
  {
    now = () => Date.now(),
    setTimeout: schedule = globalThis.setTimeout,
    clearTimeout: unschedule = globalThis.clearTimeout,
    retain = 64,
    onError = (error) => console.warn(error.message),
    context = {},
  } = {},
) {
  const listeners = new Set();
  const seen = new Map(); // item key → true; insertion-ordered, bounded
  const records = [];
  const status = {
    id: provider.id,
    mode: provider.mode,
    running: false,
    consumers: 0,
    lastRunAt: null,
    lastIngestAt: null,
    lastError: null,
    published: 0,
  };
  let controller = null;
  let timer = null;
  let unsubscribe = null;
  let running = null;

  const ctx = (signal) => ({ ...context, provider, signal, now });

  function fail(stage, item, cause) {
    const error = new ProviderStageError(provider.id, stage, item, cause);
    status.lastError = {
      stage,
      item: error.itemKey,
      message: String(cause?.message || cause),
      at: now(),
    };
    onError(error);
    return error;
  }

  function publish(record) {
    records.push(record);
    if (records.length > retain) records.splice(0, records.length - retain);
    status.published += 1;
    status.lastIngestAt = record.ingestTime;
    for (const listener of listeners) {
      try {
        listener(record);
      } catch (cause) {
        fail('publish', { key: record.key }, cause);
      }
    }
  }

  function markSeen(key) {
    seen.set(key, true);
    while (seen.size > DEFAULT_SEEN_LIMIT)
      seen.delete(seen.keys().next().value);
  }

  /** fetch → decode → normalize → publish for one discovered item. */
  async function ingest(item, signal = controller?.signal) {
    const key = item?.key;
    if (typeof key !== 'string' || !key)
      return fail('discover', item, new Error('item.key must be a string'));
    if (seen.has(key)) return null;
    markSeen(key);
    const stageCtx = ctx(signal);
    let stage = 'fetch';
    try {
      const raw = await provider.fetch(item, stageCtx);
      stage = 'decode';
      const decoded = await provider.decode(raw, item, stageCtx);
      stage = 'normalize';
      const out = await provider.normalize(decoded, item, stageCtx);
      if (signal?.aborted) return null;
      const ingestTime = now();
      const published = [];
      for (const input of [out].flat()) {
        if (input == null) continue;
        const record = createRecord(provider, input, { item, ingestTime });
        publish(record);
        published.push(record);
      }
      return published;
    } catch (cause) {
      // A failed item may succeed later (object not yet complete, timeout).
      seen.delete(key);
      if (signal?.aborted) return null;
      return fail(stage, item, cause);
    }
  }

  /** One pull cycle: discover, then ingest every new item in order. */
  async function poll() {
    if (provider.mode !== 'pull')
      throw new Error(`[provider] ${provider.id} is not a pull provider`);
    if (running) return running;
    const signal = controller?.signal ?? new AbortController().signal;
    running = (async () => {
      status.lastRunAt = now();
      let items;
      try {
        items = await provider.discover(ctx(signal));
      } catch (cause) {
        if (!signal.aborted) fail('discover', null, cause);
        return;
      }
      for await (const item of items ?? []) {
        if (signal.aborted) return;
        await ingest(item, signal);
      }
    })();
    try {
      await running;
    } finally {
      running = null;
    }
  }

  function loop() {
    if (!status.running) return;
    poll().finally(() => {
      if (status.running) timer = schedule(loop, provider.pollMs);
    });
  }

  function start() {
    if (status.running) return;
    status.running = true;
    controller = new AbortController();
    if (provider.mode === 'pull') {
      loop();
      return;
    }
    try {
      const stop = provider.subscribe(ctx(controller.signal), (item) => {
        if (status.running) ingest(item);
      });
      unsubscribe = typeof stop === 'function' ? stop : null;
    } catch (cause) {
      fail('discover', null, cause);
    }
  }

  function stop() {
    if (!status.running) return;
    status.running = false;
    controller?.abort();
    controller = null;
    if (timer !== null) unschedule(timer);
    timer = null;
    try {
      unsubscribe?.();
    } catch (cause) {
      fail('discover', null, cause);
    }
    unsubscribe = null;
  }

  /** Register a consumer; the first one starts the provider. */
  function acquire(listener) {
    if (listener) listeners.add(listener);
    status.consumers += 1;
    start();
    let released = false;
    return () => {
      if (released) return;
      released = true;
      if (listener) listeners.delete(listener);
      status.consumers -= 1;
      if (status.consumers === 0) stop();
    };
  }

  return Object.freeze({
    provider,
    acquire,
    poll,
    ingest,
    stop,
    latest: () => records.at(-1) ?? null,
    records: () => records.slice(),
    status: () => ({ ...status }),
  });
}
