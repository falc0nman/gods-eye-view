/**
 * Feed health and data age (GW-83). See docs/DATA-PROVIDERS.md#health.
 *
 * Every provider, and every product within it (a radar site, a model run),
 * gets one of the standard states:
 *
 *   healthy   data is current and the provider is working
 *   degraded  working, but late (data age past `degradedAfterMs`), failing
 *             intermittently, or on a fallback path it reports itself
 *   stale     data age past `staleAfterMs`: what is shown is no longer current
 *   down      repeated failures with no successful publish, or no data at all
 *             within `staleAfterMs` of starting
 *
 * plus `idle` for a provider nobody is using (not running, so neither good
 * nor bad). Data age is now minus the valid time of the newest published
 * record; ingest latency (availability → publish) is reported separately.
 *
 * Thresholds come from the provider definition's `health` and can be
 * overridden per provider or per product (`<provider>:<product>`) through
 * the monitor's `thresholds` option.
 */

export const HEALTH_STATES = Object.freeze([
  'healthy',
  'degraded',
  'stale',
  'down',
]);
const RANK = Object.freeze({
  idle: -1,
  healthy: 0,
  degraded: 1,
  stale: 2,
  down: 3,
});
const DEFAULT_DOWN_AFTER_FAILURES = 3;
const DEFAULT_HISTORY_MS = 60 * 60_000;
const DEFAULT_HISTORY_LIMIT = 500;

const worse = (a, b) => (RANK[b.state] > RANK[a.state] ? b : a);

/** Resolve thresholds: product override → provider override → definition. */
export function resolveThresholds(provider, product, overrides = {}) {
  const merged = {
    downAfterFailures: DEFAULT_DOWN_AFTER_FAILURES,
    ...withoutCheck(provider.health),
    ...(overrides[provider.id] ?? {}),
    ...(product == null ? {} : (overrides[`${provider.id}:${product}`] ?? {})),
  };
  // Without an explicit degraded threshold, data is late at half the stale one.
  if (merged.degradedAfterMs == null && merged.staleAfterMs != null)
    merged.degradedAfterMs = merged.staleAfterMs / 2;
  return merged;
}

function withoutCheck(health = {}) {
  const { check: _check, ...rest } = health;
  return rest;
}

function ageState(dataAgeMs, thresholds) {
  if (dataAgeMs == null) return null;
  if (thresholds.staleAfterMs != null && dataAgeMs > thresholds.staleAfterMs)
    return {
      state: 'stale',
      reason: `no new data for ${Math.round(dataAgeMs / 1000)} s`,
    };
  if (
    thresholds.degradedAfterMs != null &&
    dataAgeMs > thresholds.degradedAfterMs
  )
    return {
      state: 'degraded',
      reason: `data ${Math.round(dataAgeMs / 1000)} s old`,
    };
  return { state: 'healthy', reason: null };
}

function runCheck(provider) {
  if (!provider.health?.check) return [];
  try {
    const out = provider.health.check();
    return (Array.isArray(out) ? out : out ? [out] : []).filter(
      (signal) => signal && RANK[signal.state] !== undefined,
    );
  } catch (error) {
    return [
      {
        state: 'degraded',
        reason: `health check failed: ${error?.message || error}`,
      },
    ];
  }
}

/**
 * Evaluate one provider from its runtime status.
 * @returns {{id, state, reason, consecutiveFailures, lastError, products: object[]}}
 */
export function evaluateProviderHealth(
  provider,
  status,
  { now, thresholds = {} },
) {
  const t = now();
  const base = resolveThresholds(provider, null, thresholds);
  const signals = runCheck(provider);

  const products = status.products.map((p) => {
    const limits = resolveThresholds(provider, p.product, thresholds);
    const dataAgeMs = p.newestValidTime == null ? null : t - p.newestValidTime;
    let verdict = status.running
      ? (ageState(dataAgeMs, limits) ?? { state: 'healthy', reason: null })
      : { state: 'idle', reason: 'not in use' };
    if (status.running)
      for (const signal of signals)
        if (signal.product != null && String(signal.product) === p.product)
          verdict = worse(verdict, signal);
    return {
      product: p.product,
      state: verdict.state,
      reason: verdict.reason ?? null,
      dataAgeMs,
      validTime: p.newestValidTime,
      lastIngestAt: p.lastIngestAt,
      published: p.published,
      availableToIngestMs: p.availableToIngestMs,
      staleAfterMs: limits.staleAfterMs ?? null,
      degradedAfterMs: limits.degradedAfterMs ?? null,
    };
  });

  let verdict;
  if (!status.running) {
    verdict = { state: 'idle', reason: 'not in use' };
  } else {
    verdict = {
      state: 'healthy',
      reason: products.length ? null : 'waiting for first record',
    };
    for (const p of products) verdict = worse(verdict, p);
    const failures = status.consecutiveFailures;
    if (failures >= base.downAfterFailures)
      verdict = worse(verdict, {
        state: 'down',
        reason: `${failures} failures in a row: ${status.lastError?.message}`,
      });
    else if (failures > 0)
      verdict = worse(verdict, {
        state: 'degraded',
        reason: `last ${status.lastError?.stage} failed: ${status.lastError?.message}`,
      });
    if (
      !products.length &&
      base.staleAfterMs != null &&
      status.startedAt != null &&
      t - status.startedAt > base.staleAfterMs
    )
      verdict = worse(verdict, {
        state: 'down',
        reason: 'no data since start',
      });
    for (const signal of signals)
      if (signal.product == null) verdict = worse(verdict, signal);
  }
  return {
    id: provider.id,
    state: verdict.state,
    reason: verdict.reason ?? null,
    consecutiveFailures: status.consecutiveFailures,
    lastError: status.lastError,
    lastIngestAt: status.lastIngestAt,
    availableToIngestMs: status.availableToIngestMs,
    products,
  };
}

/**
 * Evaluate every provider, record state transitions, and notify listeners
 * (the hook GW-28's shared state attaches to).
 *
 * @param {object} options
 * @param {() => Array<{provider, runtime}>} options.entries
 * @param {Record<string, object>} [options.thresholds]
 * @param {number} [options.historyMs] - how long transitions are kept.
 */
export function createHealthMonitor({
  entries,
  thresholds = {},
  now = () => Date.now(),
  historyMs = DEFAULT_HISTORY_MS,
  historyLimit = DEFAULT_HISTORY_LIMIT,
  setInterval: every = globalThis.setInterval,
  clearInterval: stopEvery = globalThis.clearInterval,
}) {
  const listeners = new Set();
  /** `<provider>` or `<provider>:<product>` → last state */
  const last = new Map();
  const history = [];
  let timer = null;
  let snapshot = null;

  function transition(key, provider, product, next, reason, at) {
    const from = last.get(key) ?? null;
    if (from === next) return null;
    last.set(key, next);
    // The first evaluation sets a baseline rather than a change.
    if (from === null) return null;
    const change = { at, provider, product, from, to: next, reason };
    history.push(change);
    return change;
  }

  function prune(t) {
    while (
      history.length &&
      (history.length > historyLimit || t - history[0].at > historyMs)
    )
      history.shift();
  }

  function evaluate() {
    const t = now();
    const providers = entries().map(({ provider, runtime }) =>
      evaluateProviderHealth(provider, runtime.status(), { now, thresholds }),
    );
    const changes = [];
    for (const p of providers) {
      const change = transition(p.id, p.id, null, p.state, p.reason, t);
      if (change) changes.push(change);
      for (const product of p.products) {
        const productChange = transition(
          `${p.id}:${product.product}`,
          p.id,
          product.product,
          product.state,
          product.reason,
          t,
        );
        if (productChange) changes.push(productChange);
      }
    }
    prune(t);
    snapshot = { generatedAt: t, providers };
    for (const listener of listeners) {
      try {
        listener(snapshot, changes);
      } catch (error) {
        console.warn(
          '[provider-health] listener failed:',
          error?.message || error,
        );
      }
    }
    return snapshot;
  }

  return Object.freeze({
    evaluate,
    /** Latest evaluation plus recent transitions (newest last). */
    report() {
      const current = evaluate();
      return { ...current, history: history.slice() };
    },
    history: () => history.slice(),
    /** listener(snapshot, changes) after every evaluation. */
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    /** Re-evaluate periodically so transitions to stale are seen without requests. */
    start(intervalMs = 15_000) {
      if (timer !== null) return;
      timer = every(evaluate, intervalMs);
      timer?.unref?.();
    },
    stop() {
      if (timer !== null) stopEvery(timer);
      timer = null;
    },
  });
}
