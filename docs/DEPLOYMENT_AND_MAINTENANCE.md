# Deployment and Maintenance Guide

**Sistem Rasad Faza-ye Majazi (Cyberspace Monitoring Platform)**
**Version 1.0** · **Phase 1 Production Release**
**Audience:** DevOps engineers and system operators
**Companion documents:** `SYSTEM_ARCHITECTURE.md`, `SECURITY_AND_PRIVACY.md`

---

## 1. Overview

This guide is the operator's reference for deploying, configuring, monitoring, and maintaining the Cyberspace Monitoring Platform. It assumes familiarity with Linux administration, PostgreSQL, Node.js, and reverse proxy configuration. Read it end-to-end before the first deployment; refer back to specific sections during routine operations.

### 1.1 Components to deploy

| Component | Tech | Default port | Notes |
|---|---|---|---|
| Backend | NestJS 11 / Node 20+ | `3000` | REST API + cron scheduler |
| Frontend | Next.js 16 / Node 20+ | `3033` | SSR application server |
| Database | PostgreSQL 16 | `5432` | Single primary in v1 |
| Reverse proxy | Nginx | `80`, `443` | Terminates TLS, routes to backend + frontend |

### 1.2 Hardware sizing (single-node, phase-1)

| Resource | Minimum | Recommended | Notes |
|---|---|---|---|
| CPU | 4 vCPU | 8 vCPU | LLM payload preparation is CPU-bound |
| RAM | 8 GB | 16 GB | Postgres + two Node processes |
| Disk | 50 GB SSD | 100 GB SSD | Grows ~ 200 MB per active profile per month |
| Network | 100 Mbps | 1 Gbps | Outbound to 8tag and Promtic during ingest |

A single VM can comfortably host ~ 20 active profiles. Scale vertically first; horizontal scaling (separate ingest worker, read replicas) is a phase-2 concern.

---

## 2. Prerequisites

### 2.1 Operating system

- Ubuntu 22.04 LTS or Debian 12 (other distros work; commands assume Debian-family).
- Time synchronization via `chrony` or `systemd-timesyncd`. Audit timestamps depend on accurate clocks.

### 2.2 Software

```bash
# Install Node.js 20 LTS
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt install -y nodejs

# Install PostgreSQL 16
sudo apt install -y postgresql-16 postgresql-client-16

# Install supporting tools
sudo apt install -y nginx certbot python3-certbot-nginx git gpg
sudo npm install -g pm2
```

### 2.3 External services

The following must be provisioned and credentials obtained **before** deploying:

- **Promtic API key** (`PROMTIC_API_KEY`) — Issued by Pishrun infrastructure team. Confirm the prompts listed in `setup-all-prompts.js` are enabled in your Promtic workspace.
- **8tag credentials** (`HASHTAG_USERNAME`, `HASHTAG_PASSWORD`) — Account for the Iranian data provider d1.8tag.ir.
- **TLS certificate** — Either Let's Encrypt (default in this guide) or organization-issued.

### 2.4 Filesystem layout

The recommended layout on the production host:

```
/opt/cyber/
├── cyber-backend/        # Git checkout
├── cyber-frontend/       # Git checkout
├── backups/              # Encrypted pg_dump archives
└── secrets/              # .env files, GPG keys (chmod 0700, owned by app user)

/var/log/cyber/           # Application logs (rotated by logrotate)
/var/lib/postgresql/16/main/   # Database files (on encrypted volume)
```

---

## 3. Initial Deployment

### 3.1 System user

Create a dedicated unprivileged user that owns the application processes:

```bash
sudo useradd -r -m -d /opt/cyber -s /bin/bash cyber
sudo mkdir -p /opt/cyber /var/log/cyber
sudo chown cyber:cyber /opt/cyber /var/log/cyber
sudo chmod 750 /opt/cyber
```

### 3.2 Clone the repositories

```bash
sudo -iu cyber
cd /opt/cyber
git clone <BACKEND_REPO_URL> cyber-backend
git clone <FRONTEND_REPO_URL> cyber-frontend
```

### 3.3 Database setup

Create a dedicated database, role, and apply migrations in order. **The application connects with a non-superuser account; superuser privileges are reserved for the operator.**

```bash
sudo -u postgres psql

-- inside psql
CREATE USER cyber_app WITH PASSWORD '<STRONG_PASSWORD>';
CREATE DATABASE cyber WITH OWNER cyber_app ENCODING 'UTF8'
    LC_COLLATE 'en_US.UTF-8' LC_CTYPE 'en_US.UTF-8' TEMPLATE template0;
\q
```

Apply migrations sequentially (the order matters):

```bash
cd /opt/cyber/cyber-backend
for f in scripts/init-db.sql \
         scripts/002-admin-migration.sql \
         scripts/003-seed-profiles.sql \
         scripts/004-username-migration.sql \
         scripts/005-profile-tier-weights.sql \
         scripts/006-ingest-tables.sql \
         scripts/007-ai-cache.sql \
         scripts/008-dedup-selected-posts.sql \
         scripts/009-platform-totals.sql \
         scripts/010-profile-baselines.sql \
         scripts/011-ai-topics.sql \
         scripts/012-sort-name.sql; do
  echo "Applying $f"
  PGPASSWORD='<STRONG_PASSWORD>' psql -h localhost -U cyber_app -d cyber -f "$f" -v ON_ERROR_STOP=1 || exit 1
done
```

### 3.4 Backend environment file

Create `/opt/cyber/secrets/backend.env` with mode `0600`:

```bash
# Application
NODE_ENV=production
HOST=127.0.0.1
PORT=3000

# Bootstrap admin (used only on first boot when no super_admin exists)
BOOTSTRAP_ADMIN_USERNAME=admin
BOOTSTRAP_ADMIN_EMAIL=admin@example.org
BOOTSTRAP_ADMIN_PASSWORD=<INITIAL_PASSWORD>      # Will be changed via UI on first login

# Database
DB_HOST=localhost
DB_PORT=5432
DB_NAME=cyber
DB_USERNAME=cyber_app
DB_PASSWORD=<STRONG_PASSWORD>

# JWT — use 32+ bytes from a CSPRNG
JWT_SECRET=<openssl rand -base64 48>
JWT_EXPIRES_IN=7d

# 8tag (data provider)
HASHTAG_URL=https://d1.8tag.ir
HASHTAG_USERNAME=<8TAG_USERNAME>
HASHTAG_PASSWORD=<8TAG_PASSWORD>

# Promtic (LLM gateway)
PROMTIC_BASE_URL=https://papi.cyber.pish.run
PROMTIC_API_KEY=<PROMTIC_API_KEY>
```

Generate the JWT secret:

```bash
openssl rand -base64 48
```

Symlink into the application directory:

```bash
sudo ln -s /opt/cyber/secrets/backend.env /opt/cyber/cyber-backend/.env
sudo chown -h cyber:cyber /opt/cyber/cyber-backend/.env
```

### 3.5 Backend build

```bash
cd /opt/cyber/cyber-backend
yarn install --frozen-lockfile
yarn build
```

Build artifacts land in `dist/`. The entry point is `dist/main.js`.

### 3.6 Promtic prompt setup (first deployment only)

The platform expects six base prompts in your Promtic workspace. The bootstrap script creates them via the Promtic API:

```bash
cd /opt/cyber/cyber-backend
node scripts/setup-all-prompts.js
node scripts/setup-batch-sentiment-prompt.js
node scripts/setup-scenario-prompt.js
```

Verify in the Promtic dashboard that these prompts now exist:
`dashboard_ai_summary`, `macro_context_analysis`, `smart_recommendations`, `narrative_gap_analysis`, `political_spectrum`, `scenario_simulator`, `batch_sentiment`, `macro_politics`.

### 3.7 Profile seed data (optional, for demo profile)

```bash
cd /opt/cyber/cyber-backend
node scripts/seed-profiles.js          # creates the demo profile (Ghalibaf)
node scripts/seed-sort-names.js        # populates sort_name on existing profiles
node scripts/seed-official-channels.js # populates official_channels from extra_files/
node scripts/seed-baselines.js         # historical baselines for crisis radar
node scripts/seed-promises.js          # populates promises from extra_files/promises.json
```

These seed scripts read from CSV/JSON files in `../extra_files/` and are idempotent (safe to re-run).

### 3.8 Frontend environment file

Create `/opt/cyber/secrets/frontend.env` and symlink:

```bash
NEXT_PUBLIC_SERVER_URL=https://api.example.org
```

```bash
sudo ln -s /opt/cyber/secrets/frontend.env /opt/cyber/cyber-frontend/.env.local
sudo chown -h cyber:cyber /opt/cyber/cyber-frontend/.env.local
```

### 3.9 Frontend build

```bash
cd /opt/cyber/cyber-frontend
yarn install --frozen-lockfile
yarn build
```

### 3.10 Process management

Use `pm2` to supervise both processes. Create `/opt/cyber/ecosystem.config.js`:

```javascript
module.exports = {
  apps: [
    {
      name: 'cyber-backend',
      cwd: '/opt/cyber/cyber-backend',
      script: 'dist/main.js',
      instances: 1,           // Increase only after careful review of cron locking
      exec_mode: 'fork',
      max_memory_restart: '1G',
      out_file: '/var/log/cyber/backend.log',
      error_file: '/var/log/cyber/backend-error.log',
      time: true,
    },
    {
      name: 'cyber-frontend',
      cwd: '/opt/cyber/cyber-frontend',
      script: 'node_modules/next/dist/bin/next',
      args: 'start -p 3033',
      instances: 'max',       // One per CPU core
      exec_mode: 'cluster',
      max_memory_restart: '512M',
      out_file: '/var/log/cyber/frontend.log',
      error_file: '/var/log/cyber/frontend-error.log',
      time: true,
    },
  ],
};
```

Start the apps and persist the configuration across reboots:

```bash
sudo -iu cyber
cd /opt/cyber
pm2 start ecosystem.config.js
pm2 save
exit

# As root, install the systemd unit
sudo env PATH=$PATH:/usr/bin pm2 startup systemd -u cyber --hp /opt/cyber
```

> **Important** — Run only one backend instance. The cron scheduler is in-process; multiple instances would trigger duplicate ingests for the same profile.

### 3.11 Reverse proxy (Nginx)

Create `/etc/nginx/sites-available/cyber.conf`:

```nginx
upstream cyber_backend {
  server 127.0.0.1:3000;
  keepalive 32;
}

upstream cyber_frontend {
  server 127.0.0.1:3033;
  keepalive 32;
}

# Backend API
server {
  listen 443 ssl http2;
  server_name api.example.org;

  ssl_certificate     /etc/letsencrypt/live/api.example.org/fullchain.pem;
  ssl_certificate_key /etc/letsencrypt/live/api.example.org/privkey.pem;
  ssl_protocols TLSv1.2 TLSv1.3;
  ssl_ciphers HIGH:!aNULL:!MD5;
  add_header Strict-Transport-Security "max-age=31536000; includeSubDomains" always;

  client_max_body_size 5m;

  location / {
    proxy_pass http://cyber_backend;
    proxy_http_version 1.1;
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_read_timeout 180s;
  }
}

# Frontend
server {
  listen 443 ssl http2;
  server_name app.example.org;

  ssl_certificate     /etc/letsencrypt/live/app.example.org/fullchain.pem;
  ssl_certificate_key /etc/letsencrypt/live/app.example.org/privkey.pem;
  ssl_protocols TLSv1.2 TLSv1.3;
  ssl_ciphers HIGH:!aNULL:!MD5;
  add_header Strict-Transport-Security "max-age=31536000; includeSubDomains" always;

  location / {
    proxy_pass http://cyber_frontend;
    proxy_http_version 1.1;
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
  }
}

# HTTP redirect
server {
  listen 80;
  server_name api.example.org app.example.org;
  return 301 https://$host$request_uri;
}
```

```bash
sudo ln -s /etc/nginx/sites-available/cyber.conf /etc/nginx/sites-enabled/
sudo nginx -t
sudo systemctl reload nginx
```

### 3.12 TLS certificate

```bash
sudo certbot --nginx -d api.example.org -d app.example.org
```

Certbot installs a renewal timer automatically (`/etc/systemd/system/timers.target.wants/certbot.timer`).

### 3.13 Backend CORS update

Edit `cyber-backend/src/main.ts` to whitelist the production frontend origin (currently includes localhost variants and two Pishrun-hosted domains):

```typescript
app.enableCors({
  origin: ['https://app.example.org'],   // Your production frontend
  credentials: true,
});
```

Rebuild and restart the backend after this change.

### 3.14 First login and password rotation

1. Browse to `https://app.example.org/auth/jwt/sign-in`.
2. Sign in with `BOOTSTRAP_ADMIN_USERNAME` and `BOOTSTRAP_ADMIN_PASSWORD`.
3. Navigate to `/dashboard/profile/`.
4. In the **تنظیمات حساب کاربری** card, click **تغییر رمز عبور** and set a strong password.
5. Edit `/opt/cyber/secrets/backend.env` and either remove the `BOOTSTRAP_ADMIN_PASSWORD` line or change it to an unusable value. The bootstrap path is only used when no super_admin exists in the database; the password change above creates that admin so the env variable becomes inert.
6. Restart the backend to confirm it boots without re-creating the admin: `pm2 restart cyber-backend`.

---

## 4. Configuration Reference

### 4.1 Backend environment variables

| Variable | Required | Description |
|---|---|---|
| `NODE_ENV` | yes | `production` in production. Disables dev seed users (`admin/Admin@123`, `client/Client@123`). |
| `HOST` | yes | Bind address. Use `127.0.0.1` when behind a local reverse proxy. |
| `PORT` | yes | TCP port (default 3000). |
| `BOOTSTRAP_ADMIN_USERNAME` | first boot | Username of the first super_admin. |
| `BOOTSTRAP_ADMIN_PASSWORD` | first boot | Password of the first super_admin. |
| `BOOTSTRAP_ADMIN_EMAIL` | optional | Email for the bootstrap admin. |
| `DB_HOST` / `DB_PORT` / `DB_NAME` / `DB_USERNAME` / `DB_PASSWORD` | yes | PostgreSQL connection. |
| `JWT_SECRET` | yes | 32+ byte secret. Rotating this invalidates all existing tokens (forced re-login). |
| `JWT_EXPIRES_IN` | yes | Token lifetime, e.g. `7d`, `12h`. |
| `HASHTAG_URL` / `HASHTAG_USERNAME` / `HASHTAG_PASSWORD` | yes | 8tag connection. |
| `PROMTIC_BASE_URL` / `PROMTIC_API_KEY` | yes | LLM gateway connection. |

### 4.2 Frontend environment variables

| Variable | Description |
|---|---|
| `NEXT_PUBLIC_SERVER_URL` | Base URL of the backend API (must match the backend domain in your reverse-proxy config). |
| `NEXT_PUBLIC_ASSETS_DIR` | Optional path prefix for static assets, leave empty in standard deployments. |
| `BUILD_STATIC_EXPORT` | Set to `true` only for static-export builds. Not used in standard deployments. |

### 4.3 Cron schedules

Defined in code, no operator action needed. For reference:

| Job | Schedule | Action |
|---|---|---|
| `ingest_heavy` | `0 0,6,12,18 * * *` | Profiles with `tier='heavy'` |
| `ingest_medium` | `0 3 * * *` | Profiles with `tier='medium'` |
| `ingest_light` | `0 4 */3 * *` | Profiles with `tier='light'` |
| `ingest_cleanup` | `0 2 * * 0` | Sunday 02:00 — delete data older than retention thresholds |
| `macro_politics` | `0 7,19 * * *` | Refresh national macro context briefing |

All times are in the server timezone. Set the host to UTC or Tehran (`TZ=Asia/Tehran`) consistently to avoid drift.

---

## 5. Routine Maintenance

### 5.1 Daily

- Review `/var/log/cyber/backend.log` for `ERROR` entries from the previous 24h:
  ```bash
  sudo journalctl -u pm2-cyber.service --since '24 hours ago' | grep -i error
  ```
- Confirm at least one ingest run is in `completed` status per active profile in the last 24h:
  ```sql
  SELECT profile_id, MAX(finished_at) AS last_run, status
  FROM ingest_runs
  WHERE status = 'completed'
  GROUP BY profile_id, status
  ORDER BY last_run DESC;
  ```
- Verify daily backup ran (see § 6).

### 5.2 Weekly

- Review the admin audit log for unexpected mutations (`/dashboard/admin/audit-log/`).
- Check disk usage on the database volume:
  ```bash
  df -h /var/lib/postgresql
  du -sh /opt/cyber/backups
  ```
- Review error rate and latency in PM2 logs:
  ```bash
  pm2 monit
  ```

### 5.3 Monthly

- Apply OS security updates:
  ```bash
  sudo apt update && sudo apt upgrade
  ```
- Run dependency audit and apply non-breaking patches:
  ```bash
  cd /opt/cyber/cyber-backend && yarn audit
  cd /opt/cyber/cyber-frontend && yarn audit
  ```
- Verify TLS certificate auto-renewal:
  ```bash
  sudo certbot renew --dry-run
  ```
- Review LLM token usage in the **تحلیل مصرف** admin page; adjust profile tiers if costs trend upward.

### 5.4 Quarterly

- Rotate `JWT_SECRET` (forces all sessions to re-authenticate). Plan for user notification.
- Run the backup-restore drill described in § 6.4.
- Review and remove inactive user accounts.
- Patch Node.js, PostgreSQL, and Nginx to latest minor versions in a maintenance window.

### 5.5 As-needed operations

| Task | Command |
|---|---|
| Restart backend | `sudo -iu cyber pm2 restart cyber-backend` |
| Restart frontend | `sudo -iu cyber pm2 restart cyber-frontend` |
| Restart everything | `sudo -iu cyber pm2 restart all` |
| View live logs | `sudo -iu cyber pm2 logs` |
| View structured stats | `sudo -iu cyber pm2 monit` |
| Reload Nginx | `sudo systemctl reload nginx` |
| Connect to DB | `PGPASSWORD=$(grep DB_PASSWORD /opt/cyber/secrets/backend.env \| cut -d= -f2) psql -h localhost -U cyber_app -d cyber` |

---

## 6. Backup and Restore

### 6.1 Daily encrypted backup

Create `/opt/cyber/scripts/backup.sh` (chmod 0750, owned by `cyber`):

```bash
#!/usr/bin/env bash
set -euo pipefail

source /opt/cyber/secrets/backend.env
TS=$(date +%Y%m%d-%H%M%S)
OUT=/opt/cyber/backups/cyber-${TS}.dump.gpg

mkdir -p /opt/cyber/backups

PGPASSWORD="$DB_PASSWORD" pg_dump \
  -h "$DB_HOST" -U "$DB_USERNAME" -d "$DB_NAME" \
  --format=custom --compress=9 \
  | gpg --batch --yes --symmetric --cipher-algo AES256 \
        --passphrase-file /opt/cyber/secrets/backup.passphrase \
        -o "$OUT"

# Retain 30 days
find /opt/cyber/backups -name 'cyber-*.dump.gpg' -mtime +30 -delete

echo "$(date -Is) Backup OK: $OUT ($(du -h "$OUT" | cut -f1))"
```

Generate the passphrase file once:

```bash
sudo -iu cyber bash -c '
  openssl rand -base64 48 > /opt/cyber/secrets/backup.passphrase
  chmod 0600 /opt/cyber/secrets/backup.passphrase
'
```

> **Critical** — Copy the passphrase to your password manager or organizational vault. **A lost passphrase makes every encrypted backup unrecoverable.**

Schedule via cron for the `cyber` user:

```bash
sudo -iu cyber crontab -e
# add:
30 1 * * * /opt/cyber/scripts/backup.sh >> /var/log/cyber/backup.log 2>&1
```

### 6.2 Off-site backup replication

Backups stored only on the same host are not real backups. Mirror to off-host storage daily. Two common patterns:

- **rsync to a remote SSH host:**
  ```bash
  rsync -avz --delete /opt/cyber/backups/ backup-user@offsite:/srv/cyber-backups/
  ```
- **Upload to S3-compatible storage:**
  ```bash
  aws s3 sync /opt/cyber/backups/ s3://your-bucket/cyber-backups/ --delete
  ```

Add this as a follow-up step in the `backup.sh` script.

### 6.3 Weekly disk-image backup

If your host platform supports volume snapshots (cloud, libvirt, ZFS), schedule a weekly snapshot of the entire database volume. This catches transient state that `pg_dump` doesn't (in-flight transactions, replication slots) and accelerates full-stack restore.

### 6.4 Restore procedure

1. **Provision a fresh PostgreSQL 16 instance** with matching collation:
   ```sql
   CREATE USER cyber_app WITH PASSWORD '<NEW_PASSWORD>';
   CREATE DATABASE cyber WITH OWNER cyber_app ENCODING 'UTF8'
       LC_COLLATE 'en_US.UTF-8' LC_CTYPE 'en_US.UTF-8' TEMPLATE template0;
   ```
2. **Decrypt the latest backup:**
   ```bash
   gpg --batch --decrypt --passphrase-file /opt/cyber/secrets/backup.passphrase \
       /opt/cyber/backups/cyber-LATEST.dump.gpg \
       > /tmp/cyber-LATEST.dump
   ```
3. **Restore:**
   ```bash
   PGPASSWORD='<NEW_PASSWORD>' pg_restore \
       -h localhost -U cyber_app -d cyber \
       --no-owner --no-privileges \
       /tmp/cyber-LATEST.dump
   ```
4. **Update `backend.env`** with the new database password if it changed, then restart the backend.
5. **Smoke test:** sign in, view a dashboard, run an ingest from `/dashboard/admin/profiles/`.
6. **Securely delete** the decrypted dump file: `shred -u /tmp/cyber-LATEST.dump`.

### 6.5 Recovery objectives

| Metric | Target |
|---|---|
| RPO (max acceptable data loss) | 24 hours |
| RTO (max acceptable downtime) | 2 hours |

If your contract requires tighter targets, add Postgres streaming replication or hourly base backups + WAL archiving (a phase-2 enhancement).

---

## 7. Updating the Application

### 7.1 Standard update procedure

```bash
sudo -iu cyber

# Backend
cd /opt/cyber/cyber-backend
git pull
yarn install --frozen-lockfile
yarn build
# Apply any new SQL migrations from scripts/ in numeric order

# Frontend
cd /opt/cyber/cyber-frontend
git pull
yarn install --frozen-lockfile
yarn build

# Restart
pm2 restart all
```

### 7.2 Database migrations

New migrations are added to `cyber-backend/scripts/` with sequential numeric prefixes (`013-…`, `014-…`). Always:

1. Take a backup before applying any migration: `/opt/cyber/scripts/backup.sh`.
2. Apply migrations in numeric order, one at a time.
3. Verify the application still boots before applying the next one.

### 7.3 Rolling back

If a deployment fails:

```bash
cd /opt/cyber/cyber-backend
git log --oneline -10                  # Find the previous good commit
git checkout <PREVIOUS_GOOD_SHA>
yarn install --frozen-lockfile
yarn build
pm2 restart cyber-backend
```

For database rollback, restore from the pre-deployment backup (§ 6.4). There is no in-place schema rollback in v1.

### 7.4 Container-based deployment (alternative)

If preferred, use the included `docker-compose.yml`. It expects `.env` in the project root and starts both Postgres and the backend container. The frontend runs separately (it's not in compose because static asset serving is typically platform-specific).

```bash
cd /opt/cyber/cyber-backend
docker compose up -d --build
```

> **Note** — When using compose, run migrations against the running Postgres container:
>   ```bash
>   docker exec -i cyberspace_db psql -U cyber_app -d cyber < scripts/init-db.sql
>   ```

---

## 8. Monitoring and Observability

### 8.1 Logs

| Location | Content |
|---|---|
| `/var/log/cyber/backend.log` | Application logs from NestJS (request lines, ingest run summaries, LLM invocation results) |
| `/var/log/cyber/backend-error.log` | Stack traces and error-level logs |
| `/var/log/cyber/frontend.log` | Next.js server logs |
| `/var/log/cyber/backup.log` | Daily backup script output |
| `/var/log/nginx/access.log` | HTTP access log (rate, status codes) |
| `/var/log/nginx/error.log` | Reverse proxy errors |
| `/var/log/postgresql/postgresql-16-main.log` | Database query log, connection events |

Configure rotation in `/etc/logrotate.d/cyber`:

```
/var/log/cyber/*.log {
    daily
    rotate 14
    missingok
    notifempty
    compress
    delaycompress
    copytruncate
    su cyber cyber
}
```

### 8.2 Health checks

There is no dedicated health endpoint in v1. Recommended checks:

- **Backend liveness:** `curl -f https://api.example.org/api/auth/me` (returns 401 when not authenticated, but proves the process is alive).
- **Frontend liveness:** `curl -f https://app.example.org/auth/jwt/sign-in` (returns 200 with the sign-in page).
- **Database liveness:** `pg_isready -h localhost -U cyber_app -d cyber`.
- **Cron health:** the most-recent `ingest_runs.finished_at` should be no older than the slowest tier (3 days for `light`).

### 8.3 In-application diagnostics

| Path | Purpose |
|---|---|
| `/dashboard/admin/audit-log/` | Trail of every admin action |
| `/dashboard/admin/usage/` | Per-user, per-profile, per-feature usage |
| `/dashboard/admin/profiles/` | Per-profile ingest run history with error messages |

### 8.4 Alerting (recommended for phase 2)

Phase 1 relies on manual log inspection. For phase 2, integrate Prometheus + Grafana or a hosted alerting service. Suggested alerts:

- Ingest failure rate > 10% over 6 hours → email/SMS to operator
- Authentication failure rate > 50/min → potential brute-force attempt
- Database disk usage > 80% → capacity warning
- LLM gateway p95 latency > 30 s → upstream issue
- Backup script exit code != 0 → backup failure

---

## 9. Troubleshooting

### 9.1 "Cannot log in — invalid username or password"

- Verify the user exists and is active:
  ```sql
  SELECT username, role, is_active FROM users WHERE username = '<USERNAME>';
  ```
- If you locked yourself out as super_admin: shut down the backend, remove the super_admin from the DB (`DELETE FROM users WHERE id='<UUID>';`), update `BOOTSTRAP_ADMIN_*` in `.env`, restart the backend. The bootstrap path will recreate the account.

### 9.2 "Dashboard shows no data after a fresh deployment"

- Confirm the seed scripts ran (§ 3.7).
- Check the cron schedule — a freshly-deployed `medium`-tier profile won't have data until 03:00 next morning.
- Trigger a manual run from `/dashboard/admin/profiles/` (the ⟳ icon) or from the **آماده‌سازی اولیه** banner on the overview page.

### 9.3 "Ingest runs are failing for all profiles"

Likely causes, in order of likelihood:

1. **8tag credentials wrong or expired.** Check `/dashboard/admin/data-sources/` and use the test connection feature.
2. **Promtic API key invalid.** Check the backend log for `Promtic: Invalid or inactive API key`. Rotate the key in the Promtic dashboard and update `PROMTIC_API_KEY`.
3. **Outbound network blocked.** Verify outbound HTTPS to `d1.8tag.ir` and `papi.cyber.pish.run`:
   ```bash
   curl -I https://d1.8tag.ir
   curl -I https://papi.cyber.pish.run
   ```

### 9.4 "Database connection refused after reboot"

```bash
sudo systemctl status postgresql
sudo systemctl start postgresql
```

Then restart the backend: `sudo -iu cyber pm2 restart cyber-backend`.

### 9.5 "Disk full on the database volume"

```bash
# Free up space immediately by trimming oldest data:
PGPASSWORD='...' psql -h localhost -U cyber_app -d cyber -c "
  DELETE FROM selected_posts WHERE created_at < NOW() - INTERVAL '60 days';
  DELETE FROM ingest_runs WHERE started_at < NOW() - INTERVAL '60 days';
  VACUUM FULL;
"
```

For long-term resolution: expand the volume, then revisit retention thresholds in `IngestWorkerService.cleanup`.

### 9.6 "All users are getting logged out"

`JWT_SECRET` was changed. This is intentional behavior — the new secret invalidates all existing tokens. If unintentional, restore the previous secret from your backup of `.env`.

### 9.7 "PDF reports are blank"

The frontend builds the PDF in the browser. Check:
- The user has at least one completed ingest run for the active profile.
- The browser doesn't block popups (jsPDF triggers a download).
- For weekly/monthly/quarterly reports, daily-only sections (AI summary, recommendations, narrative gap) are intentionally omitted.

### 9.8 "Audit log is empty even after admin operations"

The admin audit interceptor is registered globally. If audit rows aren't appearing:

- Verify the backend was restarted after the most recent build.
- Check the backend log for interceptor errors.
- Inspect with:
  ```sql
  SELECT * FROM admin_audit_log ORDER BY created_at DESC LIMIT 20;
  ```

### 9.9 "PM2 process keeps restarting"

```bash
sudo -iu cyber pm2 logs cyber-backend --lines 200
```

Common causes: malformed `.env`, database unreachable, port already in use, out-of-memory kill (raise `max_memory_restart`).

---

## 10. Scaling Considerations (forward-looking)

When the platform grows beyond ~ 20 active profiles or ~ 10 concurrent dashboard users, consider:

1. **Separate ingest worker.** Move the cron-driven ingest pipeline to a second backend process (with `INGEST_WORKER_ONLY=1` flag — to be added in phase 2). The web-serving backend then handles only API requests, and you can scale that horizontally with a shared session store.

2. **Read replica for dashboards.** Stand up a Postgres streaming replica and route dashboard read queries to it. Ingest writes still go to the primary.

3. **Shared cache layer.** Add Redis for session storage and TanStack Query result caching across multiple backend instances.

4. **CDN for static assets.** Move the Next.js build artifacts to a CDN (Cloudflare, Bunny, ArvanCloud) and serve only API + page rendering from the origin.

5. **Per-profile ingest queue.** Replace the in-process scheduler with a job queue (BullMQ / Sidekiq-equivalent) so failed runs can be retried and back-pressure is managed.

These are phase-2 work items and not required for phase-1 production.

---

## 11. Appendix — File Reference Quick Card

| Question | Where to look |
|---|---|
| What env vars does the backend need? | `cyber-backend/.env.example` |
| What env vars does the frontend need? | `cyber-frontend/src/global-config.js` (CONFIG block) |
| What migrations exist? | `cyber-backend/scripts/00*-*.sql` (numerical order) |
| What seed scripts exist? | `cyber-backend/scripts/seed-*.js` |
| What prompt-setup scripts exist? | `cyber-backend/scripts/setup-*.js` |
| What does the database schema look like? | `SYSTEM_ARCHITECTURE.md` § 4 |
| What are the security provisions? | `SECURITY_AND_PRIVACY.md` |
| What is in `extra_files/`? | Demo/seed source data: profiles CSV, promises JSON, official channels list, profile contexts, prompt test inputs |
| One-off scripts that ran historically? | `cyber-backend/scripts/archive/` (kept for reference, not invoked) |

---

## 12. Operator Sign-Off Checklist

Use this checklist before declaring a deployment complete and handing the system over.

### Infrastructure
- [ ] Hardware meets minimum sizing (§ 1.2)
- [ ] OS time synchronization is active and accurate
- [ ] Database volume is encrypted at rest (LUKS / cloud KMS / equivalent)
- [ ] PostgreSQL is bound to localhost only or behind a private network
- [ ] Outbound connectivity to `d1.8tag.ir` and `papi.cyber.pish.run` is verified

### Application
- [ ] Backend is built and running under pm2 (`pm2 list` shows `online`)
- [ ] Frontend is built and running under pm2
- [ ] Cron schedules are registered (verify by tailing logs at next scheduled time)
- [ ] All migration scripts applied in order
- [ ] Promtic prompts are seeded (verify in Promtic dashboard)
- [ ] At least one profile is created and at least one successful ingest has run

### Security
- [ ] `NODE_ENV=production` is set
- [ ] `JWT_SECRET` is ≥ 32 random bytes (not the placeholder)
- [ ] First super_admin password is rotated from the bootstrap value
- [ ] `BOOTSTRAP_ADMIN_PASSWORD` is removed or invalidated in `.env`
- [ ] CORS whitelist excludes `localhost` origins
- [ ] TLS 1.2+ is enforced; HTTP redirects to HTTPS
- [ ] HSTS header is configured at the reverse proxy
- [ ] `.env` files have mode `0600` and are not in git

### Reliability
- [ ] Daily backup cron is installed and a test backup completed successfully
- [ ] Backup decryption passphrase is stored in the organizational vault
- [ ] Off-site backup replication is configured
- [ ] Logrotate is configured for `/var/log/cyber/`
- [ ] pm2 startup is registered with systemd (survives reboot)
- [ ] Restored a backup at least once on a separate environment to confirm the procedure works

### Documentation
- [ ] `SYSTEM_ARCHITECTURE.md`, `SECURITY_AND_PRIVACY.md`, this file, and `user-guides/` are accessible to the operator team
- [ ] User credentials (super_admin password, DB password, JWT secret, 8tag credentials, Promtic key, GPG passphrase) are stored in the organizational secret vault — not in any chat or email thread
- [ ] On-call rotation and escalation contacts are documented

When every box above is checked, the deployment is ready for production traffic.

---

*Document maintained alongside the codebase. Update on any change to the deployment surface (new env vars, new migrations, new external services).*
