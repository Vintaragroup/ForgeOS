#!/usr/bin/env bash
# Restores a backup produced by backup.sh into whatever database
# DATABASE_URL points at. Destructive -- --clean drops existing objects
# before recreating them -- so this requires typing the target database
# name back to confirm, the same "type it to proceed" pattern used for
# other irreversible operations.
set -euo pipefail

if [ -z "${DATABASE_URL:-}" ]; then
  echo "DATABASE_URL is not set. Example:" >&2
  echo '  DATABASE_URL="postgresql://user@localhost:5432/forgeos_dev?schema=public" scripts/restore.sh backups/forgeos-20260808-120000.dump' >&2
  exit 1
fi

dump_file="${1:-}"
if [ -z "$dump_file" ] || [ ! -f "$dump_file" ]; then
  echo "Usage: scripts/restore.sh <path-to-dump-file>" >&2
  exit 1
fi

if ! command -v pg_restore >/dev/null 2>&1; then
  echo "pg_restore not found on PATH. It ships with postgresql@16 (brew install postgresql@16)." >&2
  exit 1
fi

db_name="$(echo "$DATABASE_URL" | sed -E 's#.*/([^/?]+).*#\1#')"

echo "This will DROP and recreate every object in database: $db_name"
echo "Restoring from: $dump_file"
read -r -p "Type the database name to confirm: " confirm
if [ "$confirm" != "$db_name" ]; then
  echo "Aborted -- input did not match \"$db_name\"." >&2
  exit 1
fi

pg_restore --clean --if-exists --no-owner --dbname="$DATABASE_URL" "$dump_file"

echo "Restored $dump_file into $db_name"
