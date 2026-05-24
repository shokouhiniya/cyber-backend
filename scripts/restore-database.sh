#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────
# Production database restore script (Linux / Bash)
#
# Reads DB credentials from cyber-backend/.env and applies a pg_dump archive
# produced by scripts/dump-database.ps1.
#
# Usage:
#   bash scripts/restore-database.sh path/to/cyber-snapshot-YYYYMMDD-HHMMSS.dump
#
# Behavior:
#   - Drops and recreates all tables (--clean --if-exists). Existing data
#     in the target database is destroyed.
#   - Skips usage_event and admin_audit_log data (already excluded at dump time).
#
# WARNING: This is destructive. Always back up the target database first:
#   pg_dump $DB > pre-restore-backup.sql
# ─────────────────────────────────────────────────────────────────────────

set -euo pipefail

# ── Resolve paths ────────────────────────────────────────────────────────
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
ENV_FILE="$REPO_ROOT/.env"

if [[ ! -f "$ENV_FILE" ]]; then
  echo "ERROR: .env not found at $ENV_FILE" >&2
  exit 1
fi

# ── Argument check ──────────────────────────────────────────────────────
if [[ $# -lt 1 ]]; then
  echo "Usage: $0 <path-to-dump-file>" >&2
  echo "" >&2
  echo "Example: bash scripts/restore-database.sh /tmp/cyber-snapshot-20260524-150000.dump" >&2
  exit 1
fi

DUMP_FILE="$1"

if [[ ! -f "$DUMP_FILE" ]]; then
  echo "ERROR: dump file not found: $DUMP_FILE" >&2
  exit 1
fi

# ── Load .env into the environment (safely) ─────────────────────────────
set -a
# shellcheck disable=SC1090
source "$ENV_FILE"
set +a

DB_HOST="${DB_HOST:-localhost}"
DB_PORT="${DB_PORT:-5432}"
DB_NAME="${DB_NAME:-cyber}"
DB_USERNAME="${DB_USERNAME:-postgres}"

if [[ -z "${DB_PASSWORD:-}" ]]; then
  echo "ERROR: DB_PASSWORD not set in .env" >&2
  exit 1
fi

# ── Verify pg_restore is available ──────────────────────────────────────
if ! command -v pg_restore >/dev/null 2>&1; then
  echo "ERROR: pg_restore not found in PATH. Install postgresql-client-16." >&2
  exit 1
fi

# ── Confirmation prompt ─────────────────────────────────────────────────
echo ""
echo "═══════════════════════════════════════════════════════════════════"
echo "  Target database: $DB_NAME @ $DB_HOST:$DB_PORT (user: $DB_USERNAME)"
echo "  Source dump:     $DUMP_FILE"
echo "  Dump size:       $(du -h "$DUMP_FILE" | cut -f1)"
echo "═══════════════════════════════════════════════════════════════════"
echo ""
echo "This will DROP AND RECREATE all tables in the target database."
echo "Any existing data in '$DB_NAME' will be permanently lost."
echo ""

read -p "Type the database name '$DB_NAME' to confirm: " confirmation
if [[ "$confirmation" != "$DB_NAME" ]]; then
  echo "Aborted." >&2
  exit 1
fi

# ── Run pg_restore ──────────────────────────────────────────────────────
export PGPASSWORD="$DB_PASSWORD"

echo ""
echo "Restoring..."

pg_restore \
  --host="$DB_HOST" \
  --port="$DB_PORT" \
  --username="$DB_USERNAME" \
  --dbname="$DB_NAME" \
  --clean \
  --if-exists \
  --no-owner \
  --no-privileges \
  --verbose \
  "$DUMP_FILE" 2>&1 | grep -E "^(pg_restore:|ERROR|FATAL)" || true

unset PGPASSWORD

echo ""
echo "Restore complete."
echo ""
echo "Next steps:"
echo "  1. Restart the backend so it sees the new data:"
echo "       pm2 restart cyber-backend"
echo "  2. Sign in and verify a profile loads with its avatar."
echo "  3. Trigger one ingest run from /admin/profiles/ to confirm the"
echo "     pipeline is wired correctly with the new data."
