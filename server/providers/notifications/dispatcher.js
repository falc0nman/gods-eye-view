/**
 * NOAA open-data new-object notifications (GW-81). See
 * docs/DATA-PROVIDERS.md#notifications.
 *
 * NOAA's public buckets publish an SNS message for every new object. A
 * backend subscribes a queue (SNS → SQS) and hands the raw messages to a
 * **transport**; this dispatcher parses them, drops everything no provider
 * asked for as early as possible, and routes each object to the providers
 * that subscribed to it. Push providers (GW-80) receive the objects through
 * their own `subscribe(ctx, emit)`.
 *
 * Transport contract (implemented by the backend; `createMemoryTransport`
 * is the in-process test double):
 *
 *   transport.start(onMessage, onError?) → stop()
 *     onMessage(message, { receivedAt? }) once per queue message. A message
 *     is an SQS body string or object: an SNS envelope whose `Message` is an
 *     S3 event, or the S3 event itself.
 *
 * Streams can lapse (backend down, queue misconfigured). After `lapseMs`
 * without a message, the stream is reported as lapsed, and feeds built on it
 * (./feed.js) switch to polling until messages flow again.
 */

const DEFAULT_LAPSE_MS = 2 * 60_000;
const LATENCY_SAMPLES = 100;

function parseJson(value) {
  if (typeof value !== 'string') return value;
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

/**
 * Objects announced by one queue message: [{bucket, key, size, eventTime}].
 * Accepts an SQS body, an SNS envelope or an S3 event; anything else yields
 * no objects. Keys arrive URL-encoded in S3 events.
 */
export function parseObjectNotification(message) {
  let body = parseJson(message?.Body ?? message?.body ?? message);
  if (body?.Type === 'Notification' || typeof body?.Message === 'string')
    body = parseJson(body.Message);
  const records = Array.isArray(body?.Records) ? body.Records : [];
  const objects = [];
  for (const record of records) {
    const bucket = record?.s3?.bucket?.name;
    const rawKey = record?.s3?.object?.key;
    if (typeof bucket !== 'string' || typeof rawKey !== 'string') continue;
    if (
      typeof record.eventName === 'string' &&
      !record.eventName.startsWith('ObjectCreated')
    )
      continue;
    let key;
    try {
      key = decodeURIComponent(rawKey.replace(/\+/g, ' '));
    } catch {
      continue;
    }
    const eventTime = Date.parse(record.eventTime ?? '');
    objects.push({
      bucket,
      key,
      size: Number(record.s3.object.size ?? NaN),
      eventTime: Number.isFinite(eventTime) ? eventTime : null,
    });
  }
  return objects;
}

function median(values) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
}

/**
 * @param {object} options
 * @param {{start: Function}} options.transport
 * @param {number} [options.lapseMs]
 * @param {() => number} [options.now]
 */
export function createNotificationDispatcher({
  transport,
  lapseMs = DEFAULT_LAPSE_MS,
  now = () => Date.now(),
} = {}) {
  if (typeof transport?.start !== 'function')
    throw new TypeError('[notifications] transport.start() is required');
  /** @type {Set<{product: string, bucket: string, match: Function, emit: Function}>} */
  const routes = new Set();
  /** product → {delivered, samples[]} */
  const products = new Map();
  const counts = { messages: 0, objects: 0, unmatched: 0, malformed: 0 };
  let stop = null;
  let startedAt = null;
  let lastMessageAt = null;
  let lastError = null;

  function productStats(product) {
    let stats = products.get(product);
    if (!stats) {
      stats = { delivered: 0, samples: [] };
      products.set(product, stats);
    }
    return stats;
  }

  function onMessage(message, meta = {}) {
    const receivedAt = Number.isFinite(meta.receivedAt)
      ? meta.receivedAt
      : now();
    lastMessageAt = receivedAt;
    counts.messages += 1;
    const objects = parseObjectNotification(message);
    if (!objects.length) counts.malformed += 1;
    for (const object of objects) {
      counts.objects += 1;
      let matched = false;
      for (const route of routes) {
        // Bucket first, then the provider's own cheap key filter, so most
        // of a busy bucket's traffic is dropped before any further work.
        if (route.bucket !== object.bucket || !route.match(object.key))
          continue;
        matched = true;
        const stats = productStats(route.product);
        stats.delivered += 1;
        if (object.eventTime !== null) {
          stats.samples.push(receivedAt - object.eventTime);
          if (stats.samples.length > LATENCY_SAMPLES)
            stats.samples.splice(0, stats.samples.length - LATENCY_SAMPLES);
        }
        try {
          route.emit({
            key: object.key,
            size: object.size,
            lastModified: object.eventTime,
            notifiedAt: receivedAt,
            via: 'notification',
          });
        } catch (error) {
          lastError = String(error?.message || error);
        }
      }
      if (!matched) counts.unmatched += 1;
    }
  }

  function start() {
    if (stop) return;
    startedAt = now();
    lastError = null;
    try {
      const stopTransport = transport.start(onMessage, (error) => {
        lastError = String(error?.message || error);
      });
      stop = typeof stopTransport === 'function' ? stopTransport : () => {};
    } catch (error) {
      lastError = String(error?.message || error);
      stop = null;
    }
  }

  function close() {
    try {
      stop?.();
    } finally {
      stop = null;
      startedAt = null;
    }
  }

  /**
   * Route one product's objects to a consumer. The transport starts with
   * the first route and stops after the last one is removed.
   * @param {{product: string, bucket: string, match: (key: string) => boolean, emit: (object) => void}} route
   */
  function subscribe({ product, bucket, match, emit }) {
    if (!product || !bucket || typeof match !== 'function' || !emit)
      throw new TypeError(
        '[notifications] subscribe needs product, bucket, match and emit',
      );
    const route = { product, bucket, match, emit };
    routes.add(route);
    start();
    return () => {
      routes.delete(route);
      if (!routes.size) close();
    };
  }

  /** 'idle' | 'starting' | 'flowing' | 'lapsed' | 'down' */
  function state() {
    if (!stop) return routes.size ? 'down' : 'idle';
    const since = lastMessageAt ?? startedAt;
    if (now() - since > lapseMs) return 'lapsed';
    return lastMessageAt === null ? 'starting' : 'flowing';
  }

  function status() {
    return {
      state: state(),
      lastMessageAt,
      lastError,
      ...counts,
      products: Object.fromEntries(
        [...products].map(([product, { delivered, samples }]) => [
          product,
          {
            delivered,
            // NOAA wrote the object → the notification reached GEV.
            objectToNotifyMs: {
              last: samples.at(-1) ?? null,
              median: median(samples),
            },
          },
        ]),
      ),
    };
  }

  return Object.freeze({ subscribe, status, receive: onMessage });
}

/**
 * In-process transport: the test double, and a way to feed notifications
 * from anything that is not a queue (a file watcher, a replay).
 */
export function createMemoryTransport() {
  let handler = null;
  let errorHandler = null;
  return {
    start(onMessage, onError) {
      handler = onMessage;
      errorHandler = onError ?? null;
      return () => {
        handler = null;
        errorHandler = null;
      };
    },
    /** Deliver one queue message; false while nothing is listening. */
    publish(message, meta) {
      if (!handler) return false;
      handler(message, meta);
      return true;
    },
    fail(error) {
      errorHandler?.(error);
    },
    get running() {
      return handler !== null;
    },
  };
}

/** Build an SQS body (SNS envelope around an S3 event) for one new object. */
export function s3NotificationMessage({ bucket, key, size = 0, eventTime }) {
  return JSON.stringify({
    Type: 'Notification',
    Message: JSON.stringify({
      Records: [
        {
          eventName: 'ObjectCreated:Put',
          eventTime: new Date(eventTime).toISOString(),
          s3: {
            bucket: { name: bucket },
            object: { key: encodeURIComponent(key).replace(/%2F/g, '/'), size },
          },
        },
      ],
    }),
  });
}
