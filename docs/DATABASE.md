# PostgreSQL and PostGIS (GW-85)

GEV's optional system of record runs in a separate PostgreSQL 17 / PostGIS 3.5
container. This foundation defines storage and does not yet implement
authentication or shared-workspace APIs. Ordinary `npm run dev` works without
a database. `/api/database/health` reports `ready`, `disabled`, or `unavailable`
without connection details or credentials.

## Start the local stack

Requires Docker Desktop with Linux containers and Docker Compose v2.24 or newer.
From this checkout:

```sh
npm ci
npm run db:secrets
npm run db:up
docker compose ps
```

Open <http://localhost:4173>. The existing optional `.env` supplies provider keys;
it is passed at runtime and excluded from the image. The app's port is bound to
loopback. PostgreSQL has no published host port. This stack runs the existing
standalone Vite server locally; internet-facing hosting and authentication belong
to the deployment/access-control work.

Startup waits for PostgreSQL, runs checked migrations, then starts the app,
hourly retention worker, and daily backup worker. PostgreSQL is limited to 2 CPUs,
1 GiB memory and 256 MiB shared memory. App and workers have their own limits.
`docker compose stop` or `docker compose down` preserves the database volume.
Do not use `down --volumes` for a database containing data you need.

The named `gev_database` volume holds database files. `.gev-backups/` is a host
directory, so completed dumps survive removal of Docker volumes. Copy backups
off this computer on your organization's schedule. A Docker reinstall can erase
volumes; a code checkout alone cannot recover lost operational records.

## Credentials and identities

`db:secrets` generates four independent random passwords in `.gev-secrets/` and
preserves existing files. That directory is ignored by Git, excluded from the
image, and denied by Vite's file server. Unix permissions are restrictive; on
Windows protect secrets and backups using your account's directory ACLs.
Container entrypoints read their mounted identities' credentials before dropping
to the `node` or `postgres` OS user. This also works
when Linux host secret files are owned by a different user and have mode 0600.
Mount files from your GW-84 secret provider in deployments, or inject the
server-only `GEV_DB_PASSWORD` and `GEV_DB_MIGRATOR_PASSWORD` environment values.
Do not use browser-facing `VITE_` values for database credentials.

| Identity       | Purpose                              | Privileges                                                                                                                                  |
| -------------- | ------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------- |
| `postgres`     | Bootstrap and scratch restore checks | Container administrator; never mounted into the app                                                                                         |
| `gev_owner`    | Schema ownership                     | Cannot log in                                                                                                                               |
| `gev_migrator` | Migrations and retention             | Explicitly assumes `gev_owner`; no superuser, database creation, or role creation                                                           |
| `gev_app`      | Application pool                     | Read schema and policy; operate application tables; append audit rows; cannot change schema, migrations, audit history, or retention policy |
| `gev_backup`   | Logical backups                      | Read data via `pg_read_all_data`; cannot modify it                                                                                          |

Pools cap connections at 10 and runtime queries at 10 seconds. Migration queries
can run longer. Set `GEV_DB_SSL=require` for a remote server with a trusted TLS
certificate. The local Docker network uses unencrypted PostgreSQL. Initialization
runs only on an empty data volume. Preserve matching password files with that
volume; regenerating passwords does not rotate database roles.

## Schema and migrations

`database/migrations/0001_initial.sql` covers users, Discord links, roles,
permissions, sessions (hashed tokens), append-only application audit records,
workspaces/settings, memberships, targets, annotations, handoffs, position
history, feeds, cameras, feed health, and operator-managed retention settings.
Locations use SRID 4326 geometry with GiST indexes. Radar volumes, imagery,
recordings, and provider secrets remain outside the database; feeds store
non-secret configuration, credential references, and media URIs.

Migration files are ordered `NNNN_name.sql` scripts. Add a new migration rather
than editing an applied file. The runner acquires a PostgreSQL advisory lock,
checks SHA-256 checksums, rejects missing/modified applied migrations, and applies
each new migration and its ledger entry in one transaction. Rerunning is safe:

```sh
docker compose run --rm migrate
```

The retention worker prunes position and feed-health history older than 30 days
by default and removes expired sessions each hour. Operators change
`gev.retention_policy` using the owner identity. The app cannot alter policy.
Committed target, annotation, handoff and membership changes send workspace
invalidation hints on `gev_workspace_changes`; consumers must authorize and
re-query before serving data. Notifications are not a durable event log.

## Backup and restore

The backup worker writes a custom-format `pg_dump` immediately and every 24 hours,
keeping completed archives for roughly 14 days. It publishes a file only after
dumping and inspecting the archive succeed. A failure restarts the worker and
leaves earlier backups in place. Adjust interval and retention in Compose.

```sh
npm run db:backup
docker compose logs backup
docker compose run --rm restore-check /backups/gev-TIMESTAMP.dump
```

Replace `gev-TIMESTAMP.dump` with the actual filename. Restore verification
creates a unique scratch database, restores with `pg_restore --exit-on-error
--single-transaction`, checks schema, migrations, PostGIS and runtime grants,
and drops only that scratch database on exit. It never overwrites the live
database. Ownership and grants are retained; bootstrap roles must exist.
See the [PostgreSQL restore documentation](https://www.postgresql.org/docs/17/app-pgrestore.html).

For disaster recovery on a replacement host, preserve `.gev-backups/`, supply
password files, and start **only** the database with `docker compose up -d --wait
db`. This creates extensions and roles but leaves the `gev` schema empty. Copy
a trusted dump into the container and restore before starting the app:

```sh
docker compose cp .gev-backups/gev-TIMESTAMP.dump db:/tmp/gev-restore.dump
docker compose exec -T db psql --username=postgres --dbname=gev --set=ON_ERROR_STOP=1 --command="DROP SCHEMA gev;"
docker compose exec -T db pg_restore --exit-on-error --single-transaction --username=postgres --dbname=gev /tmp/gev-restore.dump
npm run db:up
```

Use this procedure on a fresh database only. The empty bootstrap schema must be
removed before restoration; `DROP SCHEMA` without `CASCADE` refuses if it contains
any objects. Stop on that error. Existing records require a separate recovery
plan. Connection grants and
per-role search paths come from bootstrap.

## Verification

```sh
npm run db:secrets
npm run qa:database
```

This builds and starts the stack, verifies concurrent/idempotent migrations,
checksum drift detection, denied runtime administration, spatial queries and
indexes, committed notifications, and retention behavior. It inserts a documented
QA workspace/target, restarts PostgreSQL to test persistence, produces a backup,
restores into a scratch database, verifies the spatial fixture and grants, and
removes the QA workspace. Run during local development: it briefly restarts the
local database. It never removes the persistent volume. Unit checks run in
`npm test`; CI also exercises this database and restore workflow on Linux.
