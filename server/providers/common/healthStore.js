/**
 * Persist provider health (GW-83) to the GW-85 schema.
 *
 * Each provider, and each product it reports (a radar site), is one shared
 * `gev.feeds` row (`kind = 'weather'`, no workspace). Health is written to
 * `gev.feed_health` when a state changes and as a periodic sample of every
 * running product, so operators get history within the retention policy.
 *
 * States map onto the table's statuses: healthy, degraded and stale as is,
 * down → unavailable. Idle (nobody using the provider) is not recorded.
 * Database failures are logged and never interrupt ingest.
 */

const STATUS = Object.freeze({
  healthy: 'healthy',
  degraded: 'degraded',
  stale: 'stale',
  down: 'unavailable',
});
const DEFAULT_SAMPLE_MS = 5 * 60_000;

export const UPSERT_FEED_SQL = `INSERT INTO gev.feeds (name, kind, provider, config)
VALUES ($1, 'weather', $2, $3::jsonb)
ON CONFLICT (provider, name) WHERE workspace_id IS NULL
DO UPDATE SET config = EXCLUDED.config
RETURNING id`;
export const INSERT_HEALTH_SQL = `INSERT INTO gev.feed_health (feed_id, observed_at, status, latency_ms, reason_code)
VALUES ($1, to_timestamp($2 / 1000.0), $3, $4, $5)`;

const latencyOf = (stats) => {
  const v = stats?.last;
  return Number.isFinite(v) ? Math.max(0, Math.round(v)) : null;
};

/** The rows one health snapshot produces (pure; exported for tests). */
export function healthRows(snapshot, { only = null } = {}) {
  const rows = [];
  for (const provider of snapshot.providers) {
    const targets = [
      { product: null, ...provider },
      ...provider.products.map((p) => ({ ...p })),
    ];
    for (const target of targets) {
      const status = STATUS[target.state];
      if (!status) continue; // idle
      const name = target.product
        ? `${provider.id}:${target.product}`
        : provider.id;
      if (only && !only.has(name)) continue;
      rows.push({
        name,
        provider: provider.id,
        product: target.product,
        status,
        latencyMs: latencyOf(target.availableToIngestMs),
        reasonCode: target.code ?? null,
        observedAt: snapshot.generatedAt,
      });
    }
  }
  return rows;
}

/**
 * @param {object} options
 * @param {{query: Function}} options.pool - the backend's `gev_app` pool.
 * @param {object} options.monitor - registry.health (createHealthMonitor).
 * @param {number} [options.sampleMs]
 */
export function createHealthRecorder({
  pool,
  monitor,
  sampleMs = DEFAULT_SAMPLE_MS,
  now = () => Date.now(),
  logger = console,
}) {
  const feedIds = new Map(); // name → uuid
  let lastSampleAt = -Infinity;
  let failing = false;
  let queue = Promise.resolve();

  async function feedId(row) {
    if (feedIds.has(row.name)) return feedIds.get(row.name);
    const config = JSON.stringify(row.product ? { product: row.product } : {});
    const { rows } = await pool.query(UPSERT_FEED_SQL, [
      row.name,
      row.provider,
      config,
    ]);
    feedIds.set(row.name, rows[0].id);
    return rows[0].id;
  }

  async function write(rows) {
    try {
      for (const row of rows) {
        await pool.query(INSERT_HEALTH_SQL, [
          await feedId(row),
          row.observedAt,
          row.status,
          row.latencyMs,
          row.reasonCode,
        ]);
      }
      if (failing) logger.warn?.('[provider-health] recording resumed');
      failing = false;
    } catch (error) {
      // Log once per outage, without connection details.
      if (!failing) logger.error?.('[provider-health] recording failed');
      failing = true;
      feedIds.clear();
    }
  }

  function onEvaluate(snapshot, changes) {
    const sample = now() - lastSampleAt >= sampleMs;
    let rows;
    if (sample) {
      lastSampleAt = now();
      rows = healthRows(snapshot);
    } else {
      const changed = new Set(
        changes.map((c) =>
          c.product ? `${c.provider}:${c.product}` : c.provider,
        ),
      );
      if (!changed.size) return;
      rows = healthRows(snapshot, { only: changed });
    }
    if (!rows.length) return;
    // Writes stay ordered; a slow database never stacks parallel inserts.
    queue = queue.then(() => write(rows));
  }

  const unsubscribe = monitor.subscribe(onEvaluate);
  return {
    /** Resolves once queued writes have finished (tests, shutdown). */
    flush: () => queue,
    stop() {
      unsubscribe();
      return queue;
    },
  };
}
