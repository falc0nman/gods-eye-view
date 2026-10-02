# Team authentication and authorization (GW-45)

The production Node backend owns Discord OAuth, Google OIDC, sessions and RBAC.
The static globe remains public; every `/api` request requires a valid session.
Vite development and preview remain local provider tools and do not implement
team authentication. Production provider migration still follows GW-53.

## Configure the backend

Run `npm run db:secrets`, then `docker compose up --build -d`. This generates
an independent 32-byte authentication key in `.gev-secrets/auth`, mounted only
into the backend. Keep it stable across restarts. Losing or rotating it invalidates
Discord token ciphertext and write CSRF tokens; revoke existing sessions when
rotating it. Database backups containing encrypted tokens need this key to restore
active Discord sessions. Keep a separate protected copy of the key.

Set these server environment variables in an operator-managed `.env` or secret
store. Secret values also accept a corresponding `_FILE` path; mount those files
in a local Compose override. They are never browser build definitions.

| Variable                             | Purpose                                                     |
| ------------------------------------ | ----------------------------------------------------------- |
| `GEV_PUBLIC_ORIGIN`                  | Canonical external HTTPS origin, e.g. `https://gev.example` |
| `GEV_AUTH_KEY` / `GEV_AUTH_KEY_FILE` | 64 hex characters; Compose mounts the generated key         |
| `GEV_DISCORD_CLIENT_ID`              | Discord application ID                                      |
| `GEV_DISCORD_CLIENT_SECRET`          | Confidential OAuth client secret                            |
| `GEV_DISCORD_BOT_TOKEN`              | Bot token for authoritative guild member lookup             |
| `GEV_DISCORD_GUILD_ID`               | Required guild's stable numeric ID                          |
| `GEV_GOOGLE_CLIENT_ID`               | Google web OAuth client ID                                  |
| `GEV_GOOGLE_CLIENT_SECRET`           | Google web OAuth client secret                              |

Register exact callback URLs `<origin>/auth/discord/callback` and
`<origin>/auth/google/callback` with their providers. Add the Discord bot to the
required guild and allow member lookup. Missing credentials disable that provider;
there is no automatic production login bypass. HTTP is accepted only for explicit
loopback development, with an unprefixed cookie. HTTPS uses `__Host-gev_session`,
Secure, HttpOnly, Path=/, SameSite=Lax, no Domain, and an eight-hour lifetime.
Terminate TLS before the frontend; its published port remains loopback-only.

Discord uses a confidential authorization-code flow with `identify`; the backend
gets the authenticated subject and current guild roles using its own bot token.
Google uses authorization code, PKCE S256 and nonce, then validates RS256
signatures, issuer, audience, authorized party, time claims and verified email.
Provider subject IDs are identity keys; email equality never links accounts.
OAuth state is random, hashed, browser-cookie bound, expires in five minutes and
is atomically consumed once. Callback query strings are excluded from nginx logs.

## Bootstrap application access

Map stable Discord role IDs before the first login. Names and client claims do
not grant access. Multiple mappings and explicit local roles form a sorted union.
There are no deny roles; local overrides are additive and cannot bypass required
Discord membership. Use an approved Google identity for emergency access that
does not depend on Discord availability.

```sh
docker compose run --rm qa node scripts/auth-admin.mjs \
  --guild 123456789 --discord-role 987654321 --role administrator
```

This operator command uses the migration credential and writes an audit record.
It is never an HTTP route. It can also grant explicit roles to an identity or
link a new identity to an existing GEV user:

```sh
docker compose run --rm qa node scripts/auth-admin.mjs \
  --provider google --subject VERIFIED_GOOGLE_SUBJECT --role administrator
docker compose run --rm qa node scripts/auth-admin.mjs \
  --provider google --subject VERIFIED_GOOGLE_SUBJECT --user-id USER_UUID --role viewer
```

A Google user first completes verified login and receives `identity_not_approved`.
Their normalized identity is retained as pending, with no session or privileges.
An administrator inspects `GET /api/admin/users` and explicitly approves the
subject through `POST /api/admin/identities`. A fresh unapproved identity may be
linked to an existing user. Active identities cannot be reassigned. The linked
identity shares the user's local roles; Discord-derived roles apply only while
that session uses and validates Discord. Obtain a bootstrap Google subject from
the verified pending row through an operator database connection, never email.

## Roles and sensitive requests

| Role          | Operational access                                                        |
| ------------- | ------------------------------------------------------------------------- |
| administrator | Identity, role, audit, team, configuration and operational administration |
| forecaster    | Workspace editing, designation, annotation, handoff, broadcast control    |
| chaser        | Workspace/team/feed reads, annotations, handoff, own position writes      |
| support       | Workspace/team/feed reads, annotations and handoff                        |
| viewer        | Workspace/feed/broadcast reads                                            |

Every route declares required permissions; an empty list still requires a
session. Browser role checks are only presentation. Resource handlers must also
call `authorizeWorkspace(pool, session, workspaceId, permission)` and enforce
ownership for position writes. Global permission alone does not authorize a
workspace outside the user's membership. Administrators may access existing
workspaces. No operational data-writing placeholder routes ship in production.

`GET /api/session` returns the normalized user, callsign, roles, permissions,
expiry and a session-bound CSRF token. `/auth/providers` supplies the same own
session, if valid, for the account controls without an anonymous API request.
Neither response contains OAuth tokens or a session digest. All responses are
no-store. Writes require the canonical Origin and `X-GEV-CSRF` from that session;
cross-site fetch metadata is refused. Administrator routes cover approvals,
identity revocation, local role changes, guild mappings, user disablement,
session revocation and audit reads. `PATCH /api/profile` changes only one's callsign.

Each authenticated Discord request refreshes expiring access tokens, verifies
the same provider subject, and gets current guild membership and roles. Role
removal applies on the next request; guild departure and revoked provider access
revoke the session. Provider outages return 503 and fail closed. Google sessions
require continued local identity approval. Local roles, disabled status, expiry
and revocation are read each request. Logout revokes the local session before
best-effort Discord provider revocation. Tokens are AES-256-GCM encrypted and bound
to the session digest; raw session tokens are stored only in HttpOnly cookies.

Security changes and audit records commit together. Audits store actors,
resource identifiers, known actions and reason codes; they omit cookies, codes,
passwords, provider tokens and secrets. Audit rows are append-only for `gev_app`.
Login attempts are limited to 100 per socket peer per minute; behind nginx this
is a conservative shared instance limit. Forwarded headers never identify users.

## Credentials and verification

GW-87 removes `/api/setup/*`, Provider Settings and its credential-writing
exports. Pinokio manages non-secret launcher controls only; provider credentials
use the process environment, an operator-managed `.env`, or a secret store.
Changing browser-exposed Google/Cesium credentials requires a frontend rebuild.
Restart the backend after changing server secrets. There is no browser secret
editor or public provider-status endpoint.

`npm test` covers signed Google claims, Discord refresh/membership, token
encryption and removed surfaces. `npm run qa:auth` uses the real PostgreSQL schema
and HTTP gateway with fixture external providers. It covers state replay and
expiry, pending identities/linking, five-role write boundaries, live Discord role
loss, provider outage/departure, CSRF, workspace membership, expiration, rotation,
logout, identity/user revocation and secret-free audits. CI also runs backend
outage/shutdown and full backup restore checks. Live provider setup requires the
operator's client credentials and guild; tests never contact production accounts.

Provider protocols: [Discord OAuth2](https://docs.discord.com/developers/topics/oauth2),
[Discord member API](https://docs.discord.com/developers/resources/guild#get-guild-member),
[Google OIDC](https://developers.google.com/identity/openid-connect/openid-connect).
