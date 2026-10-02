# Data providers

Status: interface defined (GW-80), notification dispatch defined (GW-81).
Reference implementation: chunked NEXRAD Level II (GW-74).
Existing per-layer proxies are registered as **legacy** entries and move over
one at a time.

Every GEV data provider implements one interface, so layers stop
reimplementing fetch, parse and cache logic. The code is in
[`server/providers/common/provider.js`](../server/providers/common/provider.js)
(contract and runtime) and
[`server/providers/registry.js`](../server/providers/registry.js) (central
registration).

## Lifecycle

```
discover → fetch → decode → normalize → publish
```

| Stage       | Provider supplies                                                                                                              | Runtime does                                                              |
| ----------- | ------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------- |
| `discover`  | Pull: `discover(ctx)` returns the items available now. Push: `subscribe(ctx, emit)` emits items as the upstream announces them | Removes duplicate items by `item.key` (bounded memory)                    |
| `fetch`     | `fetch(item, ctx)` → raw bytes or text (identity by default)                                                                   | Passes `ctx.signal`, which is aborted on stop                             |
| `decode`    | `decode(raw, item, ctx)` → a native structure (identity by default)                                                            | —                                                                         |
| `normalize` | `normalize(decoded, item, ctx)` → zero, one or many record inputs                                                              | Stamps `ingestTime` and builds the normalized record                      |
| `publish`   | —                                                                                                                              | Keeps the newest records (`latest()`, `records()`) and notifies consumers |

A stage that throws produces a `ProviderStageError` carrying `providerId`,
`stage` and `itemKey`. It is logged, shown in the provider's status, and the
item becomes eligible again on the next discovery. One failed item never
blocks the others.

## Normalized records

```js
{
  key,          // stable id, defaults to the discovered item key
  source,       // { name, url?, license? }: the upstream that produced the data
  validTime,    // epoch ms when the observation is valid (scan or report time)
  ingestTime,   // epoch ms when GEV received it (stamped by the runtime)
  provenance,   // { provider, mode, item, ...upstream identifiers (object key, ETag, sequence) }
  data,         // the provider's payload
}
```

`normalize()` returns `{ validTime, data, key?, source?, provenance? }`.
`source` defaults to the provider's declared source. The runtime fills in the
rest.

## Pull and push

```js
import { defineProvider } from './common/provider.js';

// Pull: polled every pollMs while at least one consumer holds it.
defineProvider({
  id: 'example-pull',
  mode: 'pull',
  source: { name: 'NOAA', url: 'https://…' },
  pollMs: 30_000,
  discover: async ({ fetchImpl, signal }) => [{ key: 'obj/1' }],
  fetch: async (item, { fetchImpl, signal }) => …,
  decode: (raw) => …,
  normalize: (decoded, item) => ({ validTime: decoded.scanMs, data: decoded }),
});

// Push: subscribe() returns its own unsubscribe function.
defineProvider({
  id: 'example-push',
  mode: 'push',
  source: { name: 'Upstream feed' },
  subscribe: (ctx, emit) => {
    const socket = open(…);
    socket.on('message', (m) => emit({ key: m.id, payload: m }));
    return () => socket.close();
  },
  fetch: (item) => item.payload,
  normalize: (payload) => ({ validTime: payload.t, data: payload }),
});
```

Runtimes are lazy. Nothing polls or subscribes until a consumer calls
`runtime.acquire(listener?)`, and everything stops when the last consumer
releases it or when the server closes. Stage functions get `ctx = { provider,
signal, now, ...context }`, where `context` comes from runtime options (for
example an injected `fetchImpl` for tests).

## Registration

[`server/providers/local.js`](../server/providers/local.js) builds the
standalone set in `localProviderRegistry()`:

```js
registry.register(definition); // implements this interface
registry.registerLegacy('nexrad-level3', nexradLevel3Proxy); // not yet ported
```

Ids are unique across both kinds. `registry.plugins()` returns the server
plugins in registration order. The first is the catalog route:

- `GET /api/providers`: every registered provider with its mode, source,
  running state, consumer count, `lastRunAt`, `lastIngestAt`, `lastError` and
  `published` count. Legacy entries are listed as `{ id, kind: 'legacy' }`.

A provider's own HTTP routes go in `routes(server, runtime)`, which is
installed on both dev and preview servers. Routes read from `runtime.latest()`
or `runtime.records()`, or acquire the runtime for as long as a client stays
connected (for example a server-sent events stream).

To port a legacy proxy, split its handler into the stages above, move its
routes into `routes()`, and change its `registerLegacy` line to `register`.
Keep its URLs stable so the browser layer does not change.

## Notifications (GW-81)

NOAA's public buckets publish an SNS message for every new object. Providers
use those messages instead of polling, which gives lower latency at lower
cost. The code is in
[`server/providers/notifications/`](../server/providers/notifications/).

```
SNS topic → SQS queue → transport → dispatcher → feed.watch(site) → provider.subscribe(emit) → runtime
                                                   ↘ polling fallback (stream lapsed or down)
```

### Transport contract (backend)

The queue consumer is part of the backend, so GEV only defines the contract.
`createMemoryTransport()` is the in-process test double and implements the
same contract.

```js
transport.start(onMessage, onError?) → stop()
// onMessage(message, { receivedAt? }) once per queue message.
// message: an SQS body (string or { Body }) holding an SNS envelope whose
// `Message` is an S3 event, or the S3 event itself.
```

`parseObjectNotification()` accepts all three forms. It URL-decodes keys,
keeps only `ObjectCreated*` events, and returns `{ bucket, key, size,
eventTime }` for each record. Messages it can't read are counted as
`malformed` and otherwise ignored.

### Dispatcher

`createNotificationDispatcher({ transport, lapseMs })` routes objects to
subscribers:

```js
dispatcher.subscribe({ product, bucket, match: (key) => boolean, emit }) → unsubscribe
```

- **Early filtering:** each object is checked against the bucket first, then
  the subscriber's `match` (for example a `KTLX/` prefix for a chase-zone
  site). Everything else is counted as `unmatched` and dropped.
- **Lifecycle:** the transport starts with the first subscription and stops
  after the last one ends.
- **State:** `idle`, `starting`, `flowing`, `lapsed` (nothing within
  `lapseMs`, default 2 min) or `down` (the transport failed to start).
- **Latency:** `status().products[product].objectToNotifyMs` measures the
  time from NOAA writing the object to GEV receiving the notification.

### Feeds and polling fallback

`createNotificationFeed({ dispatcher, product, bucket, match(site, key),
fallback })` gives a provider a per-site feed:

```js
feed.watch(site, emit) → unwatch
feed.status(site) → { state, via: 'notifications' | 'polling', stream, lastObjectAt, switches }
```

When the stream lapses or goes down, the feed runs `fallback.watch(site,
emit)` (a polling feed with the same shape). Once messages flow again, it
stops the fallback. Around a switch both paths can announce the same object;
the runtime drops the duplicate by key. For Level II chunks the fallback is
`createChunkListingFeed()` in
[`nexrad/level2Feed.js`](../server/providers/nexrad/level2Feed.js), which
finds the volume being scanned with a rotated binary search over the
`1…999` volume directories (about ten listings), then follows it.

### Latency per product

| Measure               | Where                                     | Meaning                                                             |
| --------------------- | ----------------------------------------- | ------------------------------------------------------------------- |
| `objectToNotifyMs`    | dispatcher `status().products`            | NOAA wrote the object → GEV received the notification               |
| `availableToIngestMs` | each provider in `GET /api/providers`     | object available (`provenance.availableAt`) → decoded and published |
| `dataAgeMs`           | provider responses (e.g. Level II sweeps) | newest observation → the moment the client was answered             |

Register the dispatcher with `registry.registerStream('notifications', () =>
dispatcher.status())` so `GET /api/providers` reports it under `streams`.

## Reference implementation: chunked Level II (GW-74)

GW-74 is the first provider written against this interface, and the
interface was shaped to fit it. Read
[`server/providers/nexrad-level2.js`](../server/providers/nexrad-level2.js)
and its tests in
[`src/layers/nexrad/level2Ingest.test.mjs`](../src/layers/nexrad/level2Ingest.test.mjs)
as the worked example. The decoder (`level2.js`), sweep assembly
(`level2Volume.js`) and chunk-listing feed (`level2Feed.js`) are in
[`server/providers/nexrad/`](../server/providers/nexrad/).

| Stage       | Level II chunks                                                                                                                     |
| ----------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| mode        | `push`: a notification feed (GW-81) with the chunk-listing feed as its polling fallback                                             |
| `discover`  | One item per chunk object (`<site>/<volume>/<timestamp>-<seq>-<S\|I\|E>`), keyed by object key, so redelivery is harmless           |
| `fetch`     | Download one chunk (byte-capped, `ctx.signal`)                                                                                      |
| `decode`    | bzip2-decompress and parse Message 31 radials                                                                                       |
| `normalize` | One record per chunk: `validTime` = first radial time; `provenance` = `{ object, volumeId, sequence, chunkType, availableAt, via }` |
| `publish`   | The radar route assembles partial sweeps while a volume is in progress                                                              |

### Level II routes

- `GET /api/radar/l2/live?site=KTLX` watches the radar for the next three
  minutes and returns what has arrived so far:
  - `mode`: `chunks`, `volume` (completed-volume fallback) or `pending`
  - `feed`: `via` (`notifications` or `polling`), `state` and `backfill`
  - `volume`: id, number, VCP, `complete` and location
  - `sweeps[]`: elevation, `radials` / `expectedRadials`, `complete`,
    `dataAgeMs` and image URLs
  - `nextVolume`: a volume that has started but has no radials yet
  - `latency`: `radialToIngestMs` and `objectToIngestMs` (last and median)
- `GET /api/radar/l2/image/<SITE>/<volumeId>/<elevation>/<REF|VEL>.png?rev=n`
  returns one sweep as a PNG in the Level III projection. A sweep in progress
  renders as the wedge scanned so far. Complete sweeps are cached as
  immutable.

### Behaviour

- **Watching a radar:** its chunks are announced by notifications, or by
  listing the volume's prefix every 4 s when the notification stream is down.
  When notifications are in use, the chunks already written for the volume
  in progress are backfilled once. Backfilled chunks are not counted as
  latency samples.
- **New volumes:** clients keep getting the previous volume until the new
  one has radials (`nextVolume` names it in the meantime).
- **Fallback:** until chunks for a radar are assembled, or while the feed is
  unavailable or stale, the newest completed volume is served.
- **Latency:** on the polling fallback (2026-10-02, KTLX), a chunk was decoded
  about 2.4 s after NOAA wrote it and about 4 s after the radar collected its
  last radial. The completed volume file appears about 4 minutes after the
  scan starts.
- **Memory:** only REF and VEL are kept, for the two newest volumes per
  watched radar. Radars nobody has asked about for three minutes are dropped.
