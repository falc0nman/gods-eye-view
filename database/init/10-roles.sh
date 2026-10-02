#!/bin/sh
set -eu
# The root entrypoint loads secrets before PostgreSQL drops OS privileges.
# Refuse to initialize passwordless roles if an operator bypasses that entrypoint.
: "${GEV_APP_SECRET:?Missing app credential}"
: "${GEV_MIGRATOR_SECRET:?Missing migration credential}"
: "${GEV_BACKUP_SECRET:?Missing backup credential}"
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
