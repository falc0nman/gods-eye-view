# Data providers

Status: interface defined (GW-80). Reference implementation pending: chunked
NEXRAD Level II (GW-74). Existing per-layer proxies are registered as
**legacy** entries and move over one at a time.

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

## Reference implementation: chunked Level II (GW-74)

GW-74 is the first provider written against this interface, and the interface
was shaped to fit it:

| Stage       | Level II chunks                                                                                                                   |
| ----------- | --------------------------------------------------------------------------------------------------------------------------------- |
| mode        | `push` when fed by the bucket's new-object notifications, or `pull` with short `pollMs` listing the current volume's chunk prefix |
| `discover`  | One item per chunk object (`<site>/<volume>/<timestamp>-<seq>-<S                                                                  | I   | E>`), keyed by object key, so redelivery is harmless |
| `fetch`     | Download one chunk (byte-capped, `ctx.signal`)                                                                                    |
| `decode`    | bzip2-decompress and parse Message 31 radials                                                                                     |
| `normalize` | One record per chunk: `validTime` = first radial time, `provenance` = `{ object, volume, sequence, chunkType }`                   |
| `publish`   | Consumers (the radar route) assemble partial sweeps from `records()` while a volume is in progress                                |

When GW-74 lands, this section links to it, and its tests serve as the
worked example of the interface.
