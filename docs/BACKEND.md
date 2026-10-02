# Standalone backend (GW-86)

The Docker stack serves a static frontend through unprivileged Nginx and runs
`backend/main.js` in a separate Node container. Only the frontend port is
published; Nginx forwards `/api/*`, `/healthz` and `/readyz` to the backend.
Backend and frontend contain no Vite runtime. PostgreSQL, migrations, retention
and backups retain the GW-85 setup described in [DATABASE.md](DATABASE.md).

## Start and observe

```sh
npm ci
npm run db:secrets
npm run db:up
docker compose ps
```

Open <http://localhost:4173>. Set `GEV_HTTP_PORT` to use another local frontend
port. Set `GEV_PUBLIC_ORIGIN` to the exact browser origin when changing the port
or deploying behind HTTPS. The backend port defaults to 3000 on its container
network. `/healthz` reports process liveness; `/readyz` checks the database,
PostGIS, and the initial schema migration. Both return minimal public JSON and
reject methods other than GET/HEAD. Database errors are redacted, and readiness
returns 503 during database outages or graceful shutdown.

The frontend image copies only the built `dist` directory and an Nginx config;
it receives no provider credentials or database secrets. The backend image
installs only its own locked runtime dependencies and receives only the app
identity's database credential. It runs as the `node` OS user after reading its
mounted secret and connects as `gev_app`, never the migrator or administrator.
The frontend serves built assets and denies private/source/dev-server paths.

## Authorization contract

Every `/api` request enters the session and permission gate, including unknown
routes and methods. Anonymous requests return 401; authenticated requests to
unregistered routes or routes without sufficient permissions return 403.
Declaring a route without an explicit permission policy is a startup error.
API routes cannot opt out of session validation. New public probes belong
outside `/api` and require an explicit change to the server's dispatcher.

The opaque session cookie is SHA-256 hashed before querying `gev.sessions`.
Each request checks expiry, revocation, disabled-user status and current
`user_roles`/`role_permissions`; no identity or authorization is trusted from
request headers, browser state, Discord role claims, or a stale permission cache.
No raw token or database credential is returned. Cookie values must have at least
43 URL-safe characters; GW-45 issues 32 random bytes. See
[AUTHENTICATION.md](AUTHENTICATION.md) for OAuth, live provider checks, CSRF and admin APIs.

| API                               | Required policy                    | Response                                                  |
| --------------------------------- | ---------------------------------- | --------------------------------------------------------- |
| `GET /api/session`                | Valid session                      | Own user ID, display name, roles, permissions, and expiry |
| `GET /api/database/health`        | Valid session and `system:read`    | Minimal database readiness                                |
| `GET /api/providers`              | Valid session and `system:read`    | Data providers, their status and ingest streams           |
| `GET /api/providers/health`       | Valid session and `system:read`    | Provider health, data age and recent transitions (GW-83)  |
| `GET /api/radar/l2/live`          | Valid session and `feed:read`      | Chunked Level II sweeps for one radar (GW-74)             |
| `GET /api/radar/l2/image`         | Valid session and `feed:read`      | One sweep as a PNG, `Cache-Control: private`              |
| `GET /api/radar/l2/value`         | Valid session and `feed:read`      | Raw, dealiased and storm-relative velocity at a point     |
| `GET /api/radar/l3/scan`          | Valid session and `feed:read`      | Newest Level III scan metadata for a radar and product    |
| `GET /api/radar/l3/image`         | Valid session and `feed:read`      | One Level III scan as a PNG, `Cache-Control: private`     |
| `GET /api/radar/l3/value`         | Valid session and `feed:read`      | Level III value and beam height at a point                |
| `GET /api/radar/l3/attributes`    | Valid session and `feed:read`      | Storm tracks (NST) or mesocyclones (NMD) as features      |
| `GET /api/radar/storm-attributes` | Valid session and `feed:read`      | Hail and TVS per storm cell (IEM storm attribute table)   |
| Other `/api` routes               | Denied until explicitly registered | 401 or 403                                                |

Declare future handlers through `createBackend({ pool, routes })`:

```js
const routes = [
  {
    method: 'POST',
    path: '/api/workspace-example',
    permissions: ['workspace:write'],
    async handler({ req, session, pool }) {
      // Also authorize the specific workspace/resource before reading or changing it.
      return { status: 200, body: { saved: true } };
    },
  },
];
```

An explicit empty permissions array still requires authentication. Global route
permissions do not replace workspace membership or resource ownership checks.
OAuth callbacks, login, session issuance/logout, Discord guild checks, role
mapping, and audit policies are implemented by the backend identity service;
there is no HTTP endpoint that manufactures an unverified privileged session.

For cookie-authenticated writes, the browser must send `Origin` equal to
`GEV_PUBLIC_ORIGIN` and `X-GEV-CSRF` containing the token from the authenticated session. Cross-site fetch metadata is rejected and
the backend does not allow cross-origin API access. Keep this check on new write
routes; the identity service enforces OAuth state and nonce checks.

The default session cookie is `__Host-gev_session`. The shared `sessionCookie`
helper enforces HttpOnly, SameSite=Lax, Path=/ and Secure. The local HTTP Compose
stack uses `gev_session` for loopback HTTP and `__Host-gev_session` for HTTPS,
with Secure, HttpOnly, SameSite=Lax and an eight-hour lifetime.
HTTPS selects the host-prefixed cookie automatically. See the
[cookie prefix requirements](https://developer.mozilla.org/en-US/docs/Web/HTTP/Guides/Cookies#cookie_prefixes).

## Data providers

Providers on the common interface (GW-80, [DATA-PROVIDERS.md](DATA-PROVIDERS.md))
declare their routes in the shape above. `backend/main.js` registers them
through `server/providers/interface.js`, so the session and permission gate
covers them like any other route. Only an authorized request can make the
backend start ingesting a radar. Route handlers may return a binary body
(`bytes`); the server accepts only `image/png`, and only `private` cache
policies (anything else becomes `no-store`), because the data is authorized.
Extra response headers are limited to `X-` names.

The backend also runs provider health monitoring. It records each provider
and product as a shared `gev.feeds` row (`kind = 'weather'`) and writes
`gev.feed_health` on every state change and every 5 minutes. Migration 0003
adds the `stale` status and a unique index for these shared rows. Readiness
waits for that migration. The backend image copies only the provider modules
it imports; `src/tooling/backendProviders.test.mjs` fails if the Dockerfile
misses one.

## Development and deferred proxy migration

`npm run dev` still runs the existing Vite development experience and its
legacy provider plugins. It is a local development tool, not the production
container. Production containers never register `server/providers/local.js`.
Run `npm run backend:dev` with database configuration supplied in `.env` or your
shell to work on the backend independently; it binds to loopback by default.

GW-53 is still in progress. After its removal work merges, migrate the surviving
legacy provider handlers onto the provider interface, which serves them as
backend routes with explicit permissions. Then update development proxying to
this backend and retire Vite plugin routing. Providers already on the
interface (Level II, Level III, storm attributes) are served by the backend now. `npm run dev` serves the
same handlers without sessions, for local development only. Until then, production `/api/weather`, provider settings, and other
legacy proxy endpoints are deliberately unavailable. The static globe can load
its bundled/keyless content; backend-provided live features require that follow-up
and team login. This foundation does not claim that proxy migration is complete.

## Verification

```sh
npm test
npm run qa:backend
npm run qa:database
```

Backend unit tests cover default denial, cookie parsing, permission changes,
CSRF, probes and error redaction. Container tests use real PostgreSQL sessions
through both the backend and frontend proxy, verify permission revocation,
expired/revoked sessions and disabled users, interrupt the database to verify
failure/recovery, and send SIGTERM to check clean shutdown. They remove only
their generated QA identity and role. The database QA retains migration,
spatial, persistence, backup and restore checks and checks the static frontend.
These commands briefly restart local services. Use `COMPOSE_PROJECT_NAME` and
`GEV_HTTP_PORT` to run an isolated test stack alongside another checkout.
