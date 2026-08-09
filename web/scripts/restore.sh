#!/usr/bin/env bash
# Restores a backup produced by backup.sh into whatever database
# DATABASE_URL points at, and optionally an uploads/ tarball alongside it
# (Phase 7 document bytes, src/lib/storage.ts). Destructive -- --clean
# drops existing objects before recreating them, and the uploads restore
# overwrites files in place -- so this requires typing the target database
# name back to confirm, the same "type it to proceed" pattern used for
# other irreversible operations.
set -euo pipefail

if [ -z "${DATABASE_URL:-}" ]; then
  echo "DATABASE_URL is not set. Example:" >&2
  echo '  DATABASE_URL="postgresql://user@localhost:5432/forgeos_dev?schema=public" scripts/restore.sh backups/forgeos-20260808-120000.dump [backups/forgeos-uploads-20260808-120000.tar.gz]' >&2
  exit 1
fi

dump_file="${1:-}"
uploads_file="${2:-}"
if [ -z "$dump_file" ] || [ ! -f "$dump_file" ]; then
  echo "Usage: scripts/restore.sh <path-to-dump-file> [path-to-uploads-tarball]" >&2
  exit 1
fi
if [ -n "$uploads_file" ] && [ ! -f "$uploads_file" ]; then
  echo "Uploads tarball not found: $uploads_file" >&2
  exit 1
fi

if ! command -v pg_restore >/dev/null 2>&1; then
  echo "pg_restore not found on PATH. It ships with postgresql@16 (brew install postgresql@16)." >&2
  exit 1
fi

db_name="$(echo "$DATABASE_URL" | sed -E 's#.*/([^/?]+).*#\1#')"

echo "This will DROP and recreate every object in database: $db_name"
echo "Restoring from: $dump_file"
if [ -n "$uploads_file" ]; then
  echo "This will also overwrite files in uploads/ from: $uploads_file"
fi
read -r -p "Type the database name to confirm: " confirm
if [ "$confirm" != "$db_name" ]; then
  echo "Aborted -- input did not match \"$db_name\"." >&2
  exit 1
fi

pg_restore --clean --if-exists --no-owner --dbname="$DATABASE_URL" "$dump_file"
echo "Restored $dump_file into $db_name"

if [ -n "$uploads_file" ]; then
  cd "$(dirname "$0")/.."
  tar -xzf "$uploads_file"
  echo "Restored uploads/ from $uploads_file"
fi
