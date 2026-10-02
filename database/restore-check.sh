#!/bin/sh
set -eu
# Always create a new scratch database; never clean or overwrite a database.
archive="${1:?Usage: restore-check.sh /backups/gev-TIMESTAMP.dump}"
case "$archive" in /backups/gev-*.dump) ;; *) echo 'Expected a GEV backup archive' >&2; exit 1 ;; esac
export PGUSER=postgres PGHOST=db PGDATABASE=postgres
export PGPASSWORD="$(cat /run/secrets/db_postgres)"
target="gev_restore_$(date -u +%Y%m%d%H%M%S)_$$"
createdb --template=template0 "$target"
trap 'dropdb --if-exists "$target"' EXIT
psql --dbname="$target" -v ON_ERROR_STOP=1 --command='CREATE EXTENSION postgis; CREATE SCHEMA gev AUTHORIZATION gev_owner; DROP SCHEMA gev;'
pg_restore --exit-on-error --single-transaction --dbname="$target" "$archive"
psql --dbname="$target" -v ON_ERROR_STOP=1 <<'SQL'
DO $$
BEGIN
  IF NOT EXISTS (SELECT FROM gev.schema_migrations WHERE name = '0001_initial.sql') THEN
    RAISE EXCEPTION 'Initial migration missing from restore';
  END IF;
  IF (SELECT count(*) FROM pg_tables WHERE schemaname = 'gev') < 19 THEN
    RAISE EXCEPTION 'Restored schema is incomplete';
  END IF;
  IF NOT ST_Intersects(ST_SetSRID(ST_MakePoint(-97.7, 30.3), 4326),
    ST_MakeEnvelope(-98, 30, -97, 31, 4326)) THEN
    RAISE EXCEPTION 'PostGIS restore failed';
  END IF;
  IF has_table_privilege('gev_app', 'gev.schema_migrations', 'INSERT') OR
    NOT has_table_privilege('gev_app', 'gev.targets', 'INSERT') THEN
    RAISE EXCEPTION 'Restored application grants are incorrect';
  END IF;
END;
$$;
SELECT 'Restored and verified' AS result,
  (SELECT count(*) FROM gev.users) AS users,
  (SELECT count(*) FROM gev.targets) AS targets;
SQL
if [ "${GEV_RESTORE_EXPECT_FIXTURE:-0}" = '1' ]; then
  psql --dbname="$target" -v ON_ERROR_STOP=1 <<'SQL'
DO $$
BEGIN
  IF NOT EXISTS (SELECT FROM gev.targets WHERE id = '85858585-8585-4585-8585-858585858585'
    AND label = 'GW-85 restore fixture' AND ST_X(location) = -97.7 AND ST_Y(location) = 30.3) THEN
    RAISE EXCEPTION 'Fixture data did not survive backup/restore';
  END IF;
END;
$$;
SQL
fi
echo "Restore verified in temporary database $target"
