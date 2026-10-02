#!/bin/sh
set -eu
# Compose bind-mounted secrets retain host ownership on Linux. Read them while
# still root, before the official entrypoint switches to the postgres OS user.
GEV_APP_SECRET="$(cat /run/secrets/db_app)"
GEV_MIGRATOR_SECRET="$(cat /run/secrets/db_migrator)"
GEV_BACKUP_SECRET="$(cat /run/secrets/db_backup)"
[ -n "$GEV_APP_SECRET" ] && [ -n "$GEV_MIGRATOR_SECRET" ] && [ -n "$GEV_BACKUP_SECRET" ]
export GEV_APP_SECRET GEV_MIGRATOR_SECRET GEV_BACKUP_SECRET
exec /usr/local/bin/docker-entrypoint.sh "$@"
