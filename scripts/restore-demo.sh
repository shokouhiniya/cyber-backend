#!/bin/bash
# Restore the demo database on the deployment server.
# Usage: DB_HOST=localhost DB_PORT=5432 DB_USERNAME=postgres DB_PASSWORD=xxx DB_NAME=cyber bash scripts/restore-demo.sh

set -e

DB_HOST="${DB_HOST:-localhost}"
DB_PORT="${DB_PORT:-5432}"
DB_USERNAME="${DB_USERNAME:-postgres}"
DB_NAME="${DB_NAME:-cyber}"

echo "🔄 Restoring demo database to $DB_HOST:$DB_PORT/$DB_NAME ..."

export PGPASSWORD="$DB_PASSWORD"

# Create database if it doesn't exist
psql -h "$DB_HOST" -p "$DB_PORT" -U "$DB_USERNAME" -tc "SELECT 1 FROM pg_database WHERE datname = '$DB_NAME'" | grep -q 1 || \
  psql -h "$DB_HOST" -p "$DB_PORT" -U "$DB_USERNAME" -c "CREATE DATABASE $DB_NAME;"

# Restore the dump
psql -h "$DB_HOST" -p "$DB_PORT" -U "$DB_USERNAME" -d "$DB_NAME" -f "$(dirname "$0")/demo-seed.sql"

echo "✅ Demo database restored: $DB_NAME"
echo "📁 Make sure static/media/ folder is deployed alongside the backend."
