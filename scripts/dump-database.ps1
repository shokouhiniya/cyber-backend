# ─────────────────────────────────────────────────────────────────────────
# Local database snapshot script (Windows / PowerShell)
#
# Reads DB credentials from cyber-backend/.env and produces a plain SQL
# dump that can be applied with `psql -f`. Restore via
# scripts/restore-database.sh on the target.
#
# Usage:
#   cd cyber-backend
#   .\scripts\dump-database.ps1
#
# Output: scripts/snapshots/cyber-snapshot-YYYYMMDD-HHMMSS.sql
# ─────────────────────────────────────────────────────────────────────────

$ErrorActionPreference = 'Stop'

# ── Resolve paths ────────────────────────────────────────────────────────
$repoRoot = Resolve-Path "$PSScriptRoot\.."
$envFile  = Join-Path $repoRoot ".env"
$snapDir  = Join-Path $PSScriptRoot "snapshots"

if (-not (Test-Path $envFile)) {
    Write-Host "ERROR: .env not found at $envFile" -ForegroundColor Red
    exit 1
}

# ── Parse .env into a hashtable ──────────────────────────────────────────
$envVars = @{}
Get-Content $envFile | ForEach-Object {
    if ($_ -match '^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*)\s*$') {
        $envVars[$matches[1]] = $matches[2].Trim('"').Trim("'")
    }
}

$dbHost     = $envVars['DB_HOST']     ; if (-not $dbHost)     { $dbHost = 'localhost' }
$dbPort     = $envVars['DB_PORT']     ; if (-not $dbPort)     { $dbPort = '5432' }
$dbName     = $envVars['DB_NAME']     ; if (-not $dbName)     { $dbName = 'cyber' }
$dbUser     = $envVars['DB_USERNAME'] ; if (-not $dbUser)     { $dbUser = 'postgres' }
$dbPassword = $envVars['DB_PASSWORD']

if (-not $dbPassword) {
    Write-Host "ERROR: DB_PASSWORD not set in .env" -ForegroundColor Red
    exit 1
}

# ── Verify pg_dump is available ─────────────────────────────────────────
$pgDumpExe = $null
$pgDump = Get-Command pg_dump -ErrorAction SilentlyContinue
if ($pgDump) {
    $pgDumpExe = $pgDump.Source
} else {
    # Fallback: scan default PostgreSQL install locations
    $candidates = Get-ChildItem -Path "C:\Program Files\PostgreSQL" -Filter "pg_dump.exe" -Recurse -ErrorAction SilentlyContinue |
        Where-Object { $_.FullName -notlike '*pgAdmin*' } |
        Sort-Object { [int]([regex]::Match($_.FullName, 'PostgreSQL\\(\d+)').Groups[1].Value) } -Descending
    if ($candidates) {
        $pgDumpExe = $candidates[0].FullName
        Write-Host "Using pg_dump from: $pgDumpExe" -ForegroundColor DarkGray
    }
}

if (-not $pgDumpExe) {
    Write-Host "ERROR: pg_dump not found in PATH or default install location." -ForegroundColor Red
    Write-Host "Install PostgreSQL client tools or add the bin folder to PATH." -ForegroundColor Yellow
    Write-Host "Typical Windows location: C:\Program Files\PostgreSQL\<version>\bin" -ForegroundColor Yellow
    exit 1
}

# ── Prepare output ──────────────────────────────────────────────────────
if (-not (Test-Path $snapDir)) {
    New-Item -ItemType Directory -Path $snapDir | Out-Null
}

$timestamp = Get-Date -Format "yyyyMMdd-HHmmss"
$outFile   = Join-Path $snapDir "cyber-snapshot-$timestamp.sql"

# ── Run pg_dump ─────────────────────────────────────────────────────────
$env:PGPASSWORD = $dbPassword

Write-Host ""
Write-Host "Dumping database '$dbName' from $dbHost`:$dbPort..." -ForegroundColor Cyan
Write-Host "Output: $outFile" -ForegroundColor DarkGray
Write-Host ""

# Plain SQL format (default), with DROP TABLE statements before CREATE so
# the dump is idempotent on a target that already has a schema. Skip the
# usage_event and admin_audit_log tables since those are dev-only metrics.
& $pgDumpExe `
    --host=$dbHost `
    --port=$dbPort `
    --username=$dbUser `
    --dbname=$dbName `
    --format=plain `
    --no-owner `
    --no-privileges `
    --clean `
    --if-exists `
    --exclude-table-data=usage_event `
    --exclude-table-data=admin_audit_log `
    --file=$outFile

if ($LASTEXITCODE -ne 0) {
    Write-Host "ERROR: pg_dump failed (exit code $LASTEXITCODE)" -ForegroundColor Red
    Remove-Item Env:PGPASSWORD -ErrorAction SilentlyContinue
    exit $LASTEXITCODE
}

Remove-Item Env:PGPASSWORD -ErrorAction SilentlyContinue

$size = (Get-Item $outFile).Length / 1MB
Write-Host ""
Write-Host "Dump complete." -ForegroundColor Green
Write-Host "  File: $outFile"
Write-Host ("  Size: {0:N2} MB" -f $size)
Write-Host ""
Write-Host "Next steps:" -ForegroundColor Cyan
Write-Host "  1. Transfer the .sql file to the production server (scp / rsync / SFTP)."
Write-Host "  2. On the server, run: bash scripts/restore-database.sh <path-to-sql>"
Write-Host ""
Write-Host "DO NOT commit the .sql file to git. The snapshots/ folder is gitignored." -ForegroundColor Yellow
