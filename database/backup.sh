#!/bin/sh
set -eu
umask 077
export PGPASSWORD="$(cat /run/secrets/db_backup)"
interval="${GEV_BACKUP_INTERVAL_SECONDS:-86400}"
keep="${GEV_BACKUP_KEEP_DAYS:-14}"
case "$interval:$keep" in *[!0-9:]*|:*|*:) echo 'Invalid backup schedule' >&2; exit 1 ;; esac
[ "$interval" -ge 60 ] && [ "$keep" -ge 1 ]
mkdir -p /backups
while :; do
  partial="$(mktemp "/backups/gev-$(date -u +%Y%m%dT%H%M%SZ)-XXXXXX.partial")"
  file="${partial%.partial}.dump"
  trap 'rm -f "$partial"' EXIT
  # Only publish completed, readable archives. Failure leaves earlier backups intact.
  pg_dump --format=custom --file="$partial"
  pg_restore --list "$partial" >/dev/null
  mv "$partial" "$file"
  find /backups -maxdepth 1 -type f -name 'gev-*.dump' -mtime +"$keep" -delete
  echo "Backup complete: $file"
  [ "${1:-}" = '--once' ] && exit 0
  sleep "$interval" &
  wait "$!"
done
