<p align="center">
  <a href="https://pish.run/" target="_blank"><img src="https://pish.run/wp-content/uploads/2025/02/نماد-پیشران.svg" width="120" alt="Pishrun" /></a>
</p>

# Cyber Backend — سامانه رصد فضای مجازی

NestJS API for the Pishrun cyberspace monitoring platform. Ingests social media data from 8tag, runs LLM analysis (sentiment, summary, narrative, recommendations) through the Promtic gateway, and exposes the results through a profile-scoped REST API consumed by `cyber-frontend`.

## Stack

- NestJS 11 (TypeScript), Node ≥ 20
- PostgreSQL 16 (TypeORM, `synchronize: false`)
- JWT auth with role-based guards (`super_admin`, `client_admin`, `client_viewer`)
- `@nestjs/schedule` for ingest crons
- Promtic for LLM invocation, 8tag for data

## Setup

```bash
npm install
cp .env.example .env  # then fill in real credentials
```

### Environment variables

All required vars are documented in `.env.example`. At minimum you must set:

| Group | Variables |
|---|---|
| App | `NODE_ENV`, `HOST`, `PORT` |
| Database | `DB_HOST`, `DB_PORT`, `DB_NAME`, `DB_USERNAME`, `DB_PASSWORD` |
| JWT | `JWT_SECRET` (use a 32+ byte random string), `JWT_EXPIRES_IN` |
| 8tag | `HASHTAG_URL`, `HASHTAG_USERNAME`, `HASHTAG_PASSWORD` |
| Promtic | `PROMTIC_BASE_URL`, `PROMTIC_API_KEY` |

> `.env` is gitignored. Never commit it. Rotate `JWT_SECRET` and all data-source passwords for each deployment.

### Database

Apply migrations in order from `scripts/`:

```bash
psql -d cyber -f scripts/init-db.sql
psql -d cyber -f scripts/002-admin-migration.sql
psql -d cyber -f scripts/003-seed-profiles.sql
psql -d cyber -f scripts/004-username-migration.sql
psql -d cyber -f scripts/005-profile-tier-weights.sql
psql -d cyber -f scripts/006-ingest-tables.sql
psql -d cyber -f scripts/007-ai-cache.sql
psql -d cyber -f scripts/008-dedup-selected-posts.sql
psql -d cyber -f scripts/009-platform-totals.sql
psql -d cyber -f scripts/010-profile-baselines.sql
psql -d cyber -f scripts/011-ai-topics.sql
psql -d cyber -f scripts/012-sort-name.sql
```

Then seed profiles, official channels, and prompts:

```bash
node scripts/seed-profiles.js
node scripts/seed-sort-names.js
node scripts/seed-official-channels.js
node scripts/seed-baselines.js
node scripts/seed-promises.js
node scripts/setup-all-prompts.js          # creates the LLM prompts in Promtic
```

## Run

```bash
# development (auto-reload)
npm run start:dev

# production
npm run build
npm run start:prod
```

In `NODE_ENV=development` the app seeds two demo accounts on every boot:

| Email | Password | Role |
|---|---|---|
| `admin@cyberspace.ir` | `Admin@123` | `super_admin` |
| `client@cyberspace.ir` | `Client@123` | `client_admin` (scoped to قالیباف) |

These are skipped automatically when `NODE_ENV=production`. Create your first super_admin out of band on production deployments.

## Cron schedule

Defined in `IngestWorkerService` and `MacroContextService`:

| Job | Schedule | Action |
|---|---|---|
| `ingest_heavy` | every 6h (00:00, 06:00, 12:00, 18:00) | Run pipeline for `heavy`-tier profiles (>10k posts/day) |
| `ingest_medium` | daily 03:00 | Run pipeline for `medium`-tier profiles (500–10k posts/day) |
| `ingest_light` | every 3 days 04:00 | Run pipeline for `light`-tier profiles (<500 posts/day) |
| `ingest_cleanup` | Sundays 02:00 | Delete posts > 90d, runs > 90d, hourly aggregates > 365d |
| `macro_context` | 07:00 and 19:00 daily | Refresh the macro political briefing |

The pipeline per profile: 8tag fetch → dedup → store → platform totals → display feeds → official-pages feed → promise feed → batch sentiment → AI section pre-generation. Trigger manually via `POST /api/admin/ingest/profiles/:id/run` (super_admin).

## Docker

`docker-compose.yml` brings up Postgres + the API. It reads its config from `.env` (mounted via `env_file`):

```bash
docker compose up -d
```

## Adding a new profile

1. Open `/dashboard/admin/profiles/` as super_admin.
2. Click "پروفایل جدید" and fill in: name, sort name (family name), keywords, primary color, tier, and official channels.
3. Save. The profile is immediately available; on the next cron tick (or via "Run Now") the ingest pipeline starts populating it.

The profile's Promtic identifier is auto-derived from its name. Promtic dispatches to a custom prompt version when a matching identifier exists in the Promtic workspace; otherwise the base version is used.

## Tests

```bash
npm run test
npm run test:e2e
npm run test:cov
```
