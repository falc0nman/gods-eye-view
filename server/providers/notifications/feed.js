/**
 * A per-site object feed built on the notification dispatcher, with an
 * automatic polling fallback (GW-81).
 *
 * Shape (shared with the polling feeds, e.g. nexrad/level2Feed.js):
 *
 *   feed.watch(site, emit) → unwatch
 *   feed.status(site) → { state, via, lastObjectAt, … }
 *     state: 'locating' | 'live' | 'stale' | 'unavailable' | 'idle'
 *     via:   'notifications' | 'polling'
 *
 * While the dispatcher's stream is flowing, objects come from notifications
 * only. When it lapses or goes down, the fallback feed's `watch()` runs for
 * the same site and `emit`; once messages flow again the fallback stops.
 * Both paths may announce the same object around a switch; GW-80 runtimes
 * drop the duplicate by key.
 */

const DEFAULT_CHECK_MS = 10_000;
const DOWN_STATES = new Set(['lapsed', 'down']);

/**
 * @param {object} options
 * @param {ReturnType<import('./dispatcher.js').createNotificationDispatcher>} options.dispatcher
 * @param {string} options.product - latency/status label, e.g. 'nexrad-level2-chunks'.
 * @param {string} options.bucket - S3 bucket name the notifications name.
 * @param {(site: string, key: string) => boolean} options.match - early per-site filter.
 * @param {{watch: Function, status?: Function}} [options.fallback] - polling feed.
 */
export function createNotificationFeed({
  dispatcher,
  product,
  bucket,
  match,
  fallback = null,
  checkMs = DEFAULT_CHECK_MS,
  now = () => Date.now(),
  setTimeout: schedule = globalThis.setTimeout,
  clearTimeout: unschedule = globalThis.clearTimeout,
}) {
  /** @type {Map<string, object>} */
  const watches = new Map();

  function check(watch) {
    const stream = dispatcher.status().state;
    if (DOWN_STATES.has(stream) && fallback && !watch.unwatchFallback) {
      watch.unwatchFallback = fallback.watch(watch.site, watch.emit);
      watch.via = 'polling';
      watch.switches += 1;
    } else if (stream === 'flowing' && watch.unwatchFallback) {
      watch.unwatchFallback();
      watch.unwatchFallback = null;
      watch.via = 'notifications';
      watch.switches += 1;
    }
  }

  function loop(watch) {
    check(watch);
    watch.timer = schedule(() => loop(watch), checkMs);
    watch.timer?.unref?.();
  }

  function watch(site, emit) {
    if (watches.has(site)) throw new Error(`${site} is already watched`);
    const entry = {
      site,
      via: 'notifications',
      lastObjectAt: null,
      switches: 0,
      unwatchFallback: null,
      timer: null,
      emit: (object) => {
        entry.lastObjectAt = now();
        emit(object);
      },
    };
    entry.unsubscribe = dispatcher.subscribe({
      product,
      bucket,
      match: (key) => match(site, key),
      emit: entry.emit,
    });
    watches.set(site, entry);
    loop(entry);
    return () => {
      if (entry.timer !== null) unschedule(entry.timer);
      entry.unwatchFallback?.();
      entry.unsubscribe();
      watches.delete(site);
    };
  }

  function status(site) {
    const entry = watches.get(site);
    if (!entry) return { state: 'idle', via: null, lastObjectAt: null };
    const stream = dispatcher.status().state;
    if (entry.via === 'polling') {
      const polled = fallback?.status?.(site) ?? {};
      return {
        ...polled,
        state: polled.state ?? 'live',
        via: 'polling',
        stream,
        lastObjectAt: entry.lastObjectAt,
        switches: entry.switches,
      };
    }
    return {
      state:
        stream === 'flowing'
          ? 'live'
          : DOWN_STATES.has(stream)
            ? 'unavailable'
            : 'locating',
      via: 'notifications',
      stream,
      lastObjectAt: entry.lastObjectAt,
      switches: entry.switches,
    };
  }

  return { kind: 'notifications', watch, status };
}
