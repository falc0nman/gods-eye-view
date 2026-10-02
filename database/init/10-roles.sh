#!/bin/sh
set -eu
# Secret values travel through process environment, never shell command arguments.
export GEV_APP_SECRET="$(cat /run/secrets/db_app)"
export GEV_MIGRATOR_SECRET="$(cat /run/secrets/db_migrator)"
export GEV_BACKUP_SECRET="$(cat /run/secrets/db_backup)"
psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" <<'SQL'
\getenv app_password GEV_APP_SECRET
\getenv migrator_password GEV_MIGRATOR_SECRET
\getenv backup_password GEV_BACKUP_SECRET
CREATE ROLE gev_owner NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE;
CREATE ROLE gev_migrator LOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE PASSWORD :'migrator_password';
CREATE ROLE gev_app LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE PASSWORD :'app_password';
CREATE ROLE gev_backup LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE PASSWORD :'backup_password';
GRANT pg_read_all_data TO gev_backup;
GRANT gev_owner TO gev_migrator;
REVOKE ALL ON DATABASE gev FROM PUBLIC;
GRANT CONNECT ON DATABASE gev TO gev_app, gev_migrator, gev_backup;
REVOKE CREATE ON SCHEMA public FROM PUBLIC;
CREATE EXTENSION IF NOT EXISTS postgis;
CREATE SCHEMA gev AUTHORIZATION gev_owner;
ALTER ROLE gev_app IN DATABASE gev SET search_path = gev, public;
ALTER ROLE gev_migrator IN DATABASE gev SET search_path = gev, public;
ALTER DEFAULT PRIVILEGES FOR ROLE gev_owner IN SCHEMA gev REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC;
SQL
unset GEV_APP_SECRET GEV_MIGRATOR_SECRET GEV_BACKUP_SECRET
