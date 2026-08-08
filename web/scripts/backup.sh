#!/usr/bin/env bash
# Dumps the database DATABASE_URL points at to backups/ using pg_dump's
# custom format (compressed, restorable with restore.sh / pg_restore).
# Requires pg_dump on PATH -- comes with `brew install postgresql@16`,
# already a Setup-section prerequisite in README.md.
set -euo pipefail

if [ -z "${DATABASE_URL:-}" ]; then
  echo "DATABASE_URL is not set. Example:" >&2
  echo '  DATABASE_URL="postgresql://user@localhost:5432/forgeos_dev?schema=public" scripts/backup.sh' >&2
  exit 1
fi

if ! command -v pg_dump >/dev/null 2>&1; then
  echo "pg_dump not found on PATH. It ships with postgresql@16 (brew install postgresql@16)." >&2
  exit 1
fi

cd "$(dirname "$0")/.."
mkdir -p backups

timestamp="$(date +%Y%m%d-%H%M%S)"
out="backups/forgeos-${timestamp}.dump"

pg_dump --format=custom --file="$out" "$DATABASE_URL"

echo "Wrote $out ($(du -h "$out" | cut -f1))"
