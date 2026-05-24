# System Architecture Document

**Sistem Rasad Faza-ye Majazi (Cyberspace Monitoring Platform)**
**Version 1.0** · **Phase 1 Production Release**

---

## 1. High-Level Technical Architecture

The platform is a profile-scoped social media monitoring system that ingests data from licensed Iranian data providers, runs LLM-driven analytical workloads through a centralized prompt gateway, and presents the synthesized results through a Persian-language responsive web dashboard. Five logical components compose the system.

### 1.1 Component schematic

```
┌─────────────────────────────────────────────────────────────────────────┐
│                          Client Browser (RTL Persian UI)                 │
│   Next.js 16 · React 19 · MUI 7 · TanStack Query · jsPDF + html2canvas   │
└──────────────────────────────┬──────────────────────────────────────────┘
                               │ HTTPS · JWT Bearer · X-Profile-Id header
┌──────────────────────────────▼──────────────────────────────────────────┐
│                          NestJS Backend (port 3000)                      │
│  ┌──────────────────────────────────────────────────────────────────┐   │
│  │ Controllers (REST)                                                │   │
│  │   /api/auth · /api/profile · /api/stats · /api/posts             │   │
│  │   /api/emotions · /api/influencers · /api/ai-content             │   │
│  │   /api/ingest · /api/admin/*                                      │   │
│  └──────┬───────────────────────────────────────────────────────────┘   │
│  ┌──────▼──────────────┐  ┌─────────────────────┐  ┌─────────────────┐  │
│  │ Auth & Authorization│  │  Core Analytics     │  │  Data Orchestr. │  │
│  │  - JwtStrategy      │  │  - ContentService   │  │  - IngestWorker │  │
│  │  - RolesGuard       │  │  - AiContentService │  │  - SampleSelect.│  │
│  │  - ProfileScopeMid. │  │  - TrendService     │  │  - PlatformTot. │  │
│  │  - AuditInterceptor │  │  - BatchSentiment   │  │  - DisplayFeed  │  │
│  │                     │  │  - MacroContext     │  │  - PromiseFeed  │  │
│  └─────────────────────┘  └──────────┬──────────┘  └────────┬────────┘  │
│                                      │                      │           │
│  ┌─────────────────────┐  ┌──────────▼──────────┐  ┌────────▼────────┐  │
│  │ Cron Scheduler      │  │  Promtic Gateway    │  │ API Connection  │  │
│  │  @nestjs/schedule   │  │   (libs/promtic)    │  │  DataSourceApi  │  │
│  │  heavy/medium/light │  │   retry+poll+cache  │  │  Service (8tag) │  │
│  └─────────────────────┘  └──────────┬──────────┘  └────────┬────────┘  │
└──────────────────────────────────────┼──────────────────────┼───────────┘
                                       │                      │
                                  HTTPS │ x-api-key       HTTPS │ basic-auth
                                       ▼                      ▼
                          ┌──────────────────────┐  ┌────────────────────┐
                          │  Promtic LLM Gateway │  │  8tag Data Provider│
                          │  (papi.cyber.pish.run)│  │  (d1.8tag.ir)      │
                          │  GPT-4o · Gemini ·   │  │  Multi-platform   │
                          │  Sonar Pro Search    │  │  social media feed │
                          └──────────────────────┘  └────────────────────┘

┌─────────────────────────────────────────────────────────────────────────┐
│                  PostgreSQL 16 (port 5432, single-tenant)                │
│   profiles · users · user_profiles · selected_posts · ingest_runs       │
│   hourly_aggregates · platform_totals · ai_result_cache · global_context│
│   admin_audit_log · usage_event · data_sources                          │
└─────────────────────────────────────────────────────────────────────────┘
```

### 1.2 Component responsibilities

- **Frontend** — Renders profile-scoped dashboards; client-side data fetching with cache-aware request layer. All state mutations go through the backend; no business logic on the client.
- **Backend** — Single NestJS process exposing the REST API, hosting the cron-driven ingest scheduler, and gating all data access through guards and middleware.
- **Database** — PostgreSQL 16 stores raw selected posts, hourly rollups, run history, AI cache, and tenant config. JSONB used where shape varies (run stats, channels, weights, promises, AI cache).
- **API Connection Module** — Encapsulates outbound calls to upstream providers (currently 8tag); credential storage and signing happen here, not in business logic.
- **Promtic Gateway** — External LLM orchestration service (provided by Pishrun infrastructure). Centralizes prompt definitions, model routing, version pinning per client, and token accounting. Backend is a stateless consumer.

### 1.3 Core Analytics ↔ Data Orchestration interaction

The two layers are decoupled by the database. The **data orchestration layer** (`IngestWorkerService` and helpers) is responsible for fetching and persisting; the **core analytics layer** (`ContentService`, `AiContentService`, `TrendService`, etc.) is read-only against the persisted data plus the LLM gateway.

The handoff sequence per profile per ingest run:

1. `IngestWorkerService.runForProfile()` creates an `ingest_runs` row in `running` state.
2. `SampleSelectorService` pulls a tier-sized post sample from 8tag in parallel per source, runs SimHash dedup, applies `sourceWeights`, persists to `selected_posts` keyed by the run id.
3. `PlatformTotalsService.captureForProfile()` fires 40 lightweight 8tag calls (10 sources × 4 timeframes) in the background and writes `platform_totals` rows.
4. `DisplayFeedService` / `OfficialPagesFeedService` / `PromiseFeedService` each pull additional curated post sets, all persisted to `selected_posts` with distinct `selection_reason` markers.
5. `BatchSentimentService` blocks until all newly inserted posts have been classified by the `batch_sentiment` Promtic prompt (gemini-2.5-flash-lite, batch=25, ~$0.000049 per post). Updates `selected_posts.sentiment`, `political_spectrum`, `relevance_score`, `bot_probability`, `ai_topics`.
6. `AiContentService.generateAll()` invokes five dashboard prompts (ai_summary, macro_context, recommendations, narrative_gap, political_spectrum), persisting each output to `ai_result_cache` keyed by `(profile_id, ingest_run_id, prompt_name)`.
7. The run row is marked `completed` with stat counters.

The analytics layer reads exclusively from the database (sub-100ms p95 dashboard requests) and only invokes the LLM gateway on a cache miss or scenario simulator request. Live API calls are never issued during a dashboard render.

---

## 2. Backend Architecture (Logic & Processing)

### 2.1 API Connection Module

**Module:** `src/modules/data-source/`
**Files:** `data-source.entity.ts`, `data-source.service.ts`, `data-source-api.service.ts`

**Responsibilities:**
- Persist provider credentials encrypted in the `data_sources` table (one active row per provider in v1).
- Sign and dispatch outbound requests with HTTP basic auth or token auth as required.
- Centralize timeouts, retries, and rate limiting per provider.
- Surface a normalized search response shape (`{ data: PostInput[] }`) regardless of upstream API differences.

**Key methods:**
- `search8tag({ keywords, sources, since, limit }, credentials)` — Primary post-search endpoint. Sends a single multi-source query payload, returns deduplicated raw posts.
- `pages(handle)` — Resolves a Telegram channel handle to verified-authorship posts, used by `OfficialPagesFeedService`.
- `count({ source, since, limit: 1 })` — Lightweight totals call used by `PlatformTotalsService` for the platform summary cards.

**Phase-1 connection model:**
- Single provider: 8tag (d1.8tag.ir).
- Credentials read at boot from environment variables (`HASHTAG_USERNAME`, `HASHTAG_PASSWORD`), seeded into `data_sources` via `SeedService.seedDataSources()`.
- All outbound requests use HTTPS. No outbound traffic in plain HTTP is permitted.
- Per-source rate limiting is honored via 8tag's published quotas; the orchestration layer bounds concurrency to 10 sources × 4 calls = 40 in-flight calls per profile per run.

**Provider extensibility:**
- Adding a new provider (Dataak, Datami, Mahta) requires implementing a new method on `DataSourceApiService` returning the same `PostInput[]` shape, then adding a row to `data_sources` and a quota mapping in `SampleSelectorService.SOURCE_DEFAULTS`. No changes to controllers or the orchestration pipeline.

### 2.2 Core Analytics Engine

**Modules:** `src/modules/content/`, `src/modules/ingest/`

The analytics engine is split into a real-time read layer (the controllers and service methods that respond to dashboard queries) and a batch enrichment layer (LLM-driven prompts run during ingest).

#### 2.2.1 Volume analysis

Implemented in `ContentService.getStats(profileId, since)` and `TrendService.getTrend(profileId, hours)`.

- **Stats endpoint** aggregates `selected_posts` by profile and timeframe using parameterized SQL: total posts, total views, total likes, total retweets. The `since` parameter rounds to the hour to maximize TanStack Query cache hits.
- **Trend endpoint** reads from `hourly_aggregates`, a write-optimized rollup populated atomically by the ingest pipeline. Each row is `(profile_id, hour, source_type, sentiment, post_count, total_views, total_likes, total_replies)` with a unique constraint on the first four columns, allowing `ON CONFLICT … DO UPDATE` upserts during ingest.
- **Spike detection** in `TrendService` compares the trailing 24-hour window against the previous 24 hours, flagging sources with > 80% volume increase.
- **Platform totals** read from `platform_totals` for the per-source post counts shown in the platform summary card. No live API calls on dashboard render.

#### 2.2.2 Sentiment analysis (Positive · Negative · Neutral)

Implemented in `BatchSentimentService` (writer) and `ContentService.getEmotions(profileId, since)` (reader).

- **Classifier:** Promtic prompt `batch_sentiment` running on Gemini 2.5 Flash Lite. Input: a numbered batch of up to 25 posts. Output: structured JSON array per post with `sentiment ∈ {positive, neutral, negative}`, `political_spectrum`, `relevance_score (1-5)`, `bot_probability (0-100)`, `keywords`, `reasoning_brief`.
- **Persistence:** Single `UPDATE … FROM unnest(...)` round-trip per batch, writes back to the source `selected_posts` rows.
- **Reader API:** `GET /api/emotions?since=<iso>` returns `{ hope, neutral, worry }` aggregates (legacy three-bucket mapping retained for the UI; backend emotion-to-sentiment translation is `positive → hope`, `negative → worry`, `neutral → neutral`).
- **Aggregations:** `hourly_aggregates` is keyed on `(profile, hour, source, sentiment)` so the sentiment timeline can be sliced per platform per hour without re-classifying.
- **Cost envelope:** ~$0.000049 per post at current Gemini pricing, ~80–100 posts per medium-tier ingest, two ingests per day → < $0.01 per profile per day.

#### 2.2.3 Top content extraction

Three independent endpoints, each backed by a dedicated SQL query on `selected_posts`:

- `GET /api/stats/top-posts?since=&limit=` — Most viewed posts, excludes official-page posts (those go to a separate feed).
- `GET /api/stats/top-commented?since=&limit=` — Highest reply counts (controversial posts).
- `GET /api/stats/top-forwarded?since=&limit=` — Highest retweet/forward counts (viral posts).

All three apply a relevance filter (`relevance_score IS NULL OR ≥ 3`) so LLM-flagged off-topic posts are suppressed from the dashboard. The `since` parameter is rounded to the hour upstream so identical timeframes share a query cache key.

#### 2.2.4 LLM-driven analytical sections

`AiContentService` orchestrates the dashboard's narrative/insight prompts:

| Prompt name (Promtic) | UI section | Trigger |
|---|---|---|
| `dashboard_ai_summary` | خلاصه هوش مصنوعی | Pre-generated per ingest run |
| `macro_context_analysis` | وضعیت کلان (per-profile) | Pre-generated per ingest run |
| `narrative_gap_analysis` | تحلیل شکاف روایت | Pre-generated per ingest run |
| `political_spectrum` | طیف سیاسی | Pre-generated per ingest run |
| `smart_recommendations` | پیشنهادات واکنش هوشمند | Pre-generated per ingest run |
| `scenario_simulator` | شبیه‌ساز سناریو | On-demand from `WhatIfChat` |
| `macro_politics` | وضعیت کلان (national) | Cron 07:00 / 19:00 daily |
| `batch_sentiment` | (internal classifier) | Per-batch during ingest |

Each pre-generated section writes a row to `ai_result_cache` keyed by `(profile_id, ingest_run_id, prompt_name)`. Dashboard requests check this cache first; on cache miss the controller invokes the prompt synchronously through the gateway.

#### 2.2.5 Crisis radar

Implemented in `StatsController.getCrisisMetrics(profileId)`. Five DB-derived dimensions, all self-calibrating against the profile's own historical baseline (50 = normal):

1. `negativeSentiment` — Recent 7d negative ratio vs all-time negative ratio.
2. `spreadVelocity` — Today's `platform_totals` vs 7d average daily total.
3. `officialReach` — Recent vs all-time avg view count on official-page posts.
4. `influence` — Recent vs all-time avg view count on profile-relevant posts.
5. `interactions` — Recent vs all-time avg combined interactions per post.

Dimensions with no historical data return `null` and are excluded from the weighted score. Overall score thresholds: `< 55 = safe`, `55–69 = warning`, `≥ 70 = critical`.

### 2.3 User Management & Security Module

**Module:** `src/modules/auth/` + `src/modules/user/`

**Authentication (Passport JWT):**
- **Sign-in:** `POST /api/auth/sign-in` validates `(username, password)` against `users` table. Passwords stored as bcrypt hashes with cost factor 10.
- **Token issuance:** `JwtService.sign({ sub, username, role })`; signed with 256-bit secret from `JWT_SECRET`; `JWT_EXPIRES_IN=7d` configurable.
- **Validation:** `JwtStrategy` deserializes the bearer token on every guarded request, attaches `req.user = { sub, username, role, accessibleProfileIds }`. Profile access list is computed from `user_profiles` for `client_admin` / `client_viewer`; `super_admin` is implicit (`['*']`).
- **Self-service password change:** `POST /api/auth/change-password` requires the current password and writes a fresh bcrypt hash.
- **Bootstrap:** First super_admin is created from `BOOTSTRAP_ADMIN_USERNAME` + `BOOTSTRAP_ADMIN_PASSWORD` env vars on first boot; idempotent (skipped when a super_admin already exists). No public sign-up endpoint exists.

**Authorization (role + profile scope, two layers):**

1. **Role layer** — `RolesGuard` reads the `@Roles(...)` decorator on each controller/method. Three roles: `super_admin` (cross-profile, all admin endpoints), `client_admin` (single profile, dashboard + scoped run-now), `client_viewer` (single profile, read-only).
2. **Profile-scope layer** — `ProfileScopeMiddleware` runs on every `/api/stats/*`, `/api/posts/*`, `/api/emotions/*`, `/api/ai-content/*`, `/api/profile/*` route. Reads the `X-Profile-Id` header, validates the profile is in `req.user.accessibleProfileIds`, attaches `req.profileId` for downstream `@CurrentProfile()` parameter injection. Requests for unscoped profiles return 403 before reaching the controller.

**Audit trail:**
- `AuditInterceptor` (registered as `APP_INTERCEPTOR`) records every state-mutating admin operation (POST/PATCH/PUT/DELETE under `/api/admin/*`) into `admin_audit_log` with actor id, target entity, before/after diff (credential fields redacted), and timestamp.

**Boundary protections:**
- Password fields never leave `UserService.findById` (the auth service explicitly omits `passwordHash` from `getMe` responses).
- All input DTOs validated by `class-validator` decorators; `ValidationPipe` registered globally.
- CORS whitelist enforced in `main.ts`, restricted to known frontend origins per deployment.

---

## 3. Frontend Architecture (User Interface)

**Stack:** Next.js 16 App Router · React 19 · MUI 7 (with `stylis-plugin-rtl`) · TanStack Query 5 · Vazirmatn variable font · jsPDF + html2canvas for PDF export.

### 3.1 Application structure

```
cyber-frontend/src/
├── app/                       # Next.js App Router
│   ├── auth/jwt/sign-in/      # Public sign-in page (GuestGuard)
│   └── dashboard/             # All dashboard routes (AuthGuard + DashboardLayout)
│       ├── page.jsx           # /dashboard (Overview)
│       ├── posts/             # /dashboard/posts
│       ├── analytics/         # /dashboard/analytics
│       ├── mypages/           # /dashboard/mypages
│       ├── recommendations/   # /dashboard/recommendations + scenario simulator
│       ├── reports/           # /dashboard/reports (PDF export)
│       ├── profile/           # /dashboard/profile
│       └── admin/             # /dashboard/admin/* (super_admin only)
├── auth/                      # JWT context, AuthGuard, GuestGuard, RoleGuard
├── api/                       # TanStack Query hooks (one file per domain)
├── layouts/dashboard/         # Header + sidebar + bottom nav + content wrapper
├── lib/axios.js               # Configured client + endpoint registry
├── routes/paths.js            # Centralized route table
├── sections/cyberspace/       # Dashboard widgets and tabs
└── theme/                     # MUI theme overrides + RTL support
```

### 3.2 Responsive design strategy

The application is built mobile-first with three primary breakpoints inherited from MUI:

| Breakpoint | Pixel range | Layout adaptation |
|---|---|---|
| `xs` | < 600px | Single-column stack; sidebar collapses to drawer (`NavMobile`); `BottomNav` shown for primary navigation |
| `sm` / `md` | 600–1199px | Single-column dashboard; sidebar drawer |
| `lg` / `xl` | ≥ 1200px | Persistent left sidebar (`NavVertical`); two-column report PDF layout |

- All visualization widgets use percentage widths and `flex` / `grid` containers; no fixed pixel widths.
- The MUI theme is configured with `direction: 'rtl'` and `stylis-plugin-rtl` so flex order, margins, and alignment flip automatically.
- Charts render through MUI primitives (no SVG chart library) so they reflow naturally on resize without re-rendering.
- Touch targets ≥ 44×44 px; sidebar drawer uses native swipe-to-close behavior on mobile.

### 3.3 Visualization widgets

All widgets are pure React components in `src/sections/cyberspace/`. Each fetches its own data through a domain-specific hook in `src/api/dashboard.js`, scoped automatically to the active profile via the `ProfileScopeContext`.

**Volume trends:**
- `TrendChart` (`src/sections/cyberspace/overview/`) renders the 7-day post-count timeline with sentiment-colored stacked bars. Source: `useTrendData(profileId, 168)` → `/api/admin/ingest/profiles/:id/trend`.
- `PlatformsChart` and `PlatformSummary` show per-source post volumes for the selected timeframe. Source: `useSourceStats(timeframe)` → `/api/stats/platform-totals?timeframe=…`.

**Sentiment distribution:**
- `EmotionChart` renders a horizontal stacked bar (مثبت / خنثی / منفی) with percentage labels. Source: `useEmotions()` → `/api/emotions`.
- `ReputationGauge` derives a 0–100 health score from the positive ratio.
- `CrisisRadar` renders the 5-dimension radar from `/api/stats/crisis`.

**Top content lists:**
- `MostViewedPosts`, `ControversialPosts`, `ViralPosts` (in `src/sections/cyberspace/posts/`), each fetching from its own endpoint with a shared timeframe filter. Each post renders through the unified `PostCard` component (text + media + source-aware platform icon + engagement counters).

**AI-driven sections:**
- `AISummary`, `PoliticalSpectrum`, `NarrativeGap`, `TabRecommendations`, `WhatIfChat`. All read `useAiContent('<section>')` which resolves to `GET /api/ai-content/generate?section=…` and renders the JSON response into structured Persian text.

**Report widget:**
- `TabReports` (`src/sections/cyberspace/reports/`) builds a 14-endpoint payload via `axios.allSettled`, hands it to `buildReportHtml(period, data)` for the dual-column A4 layout, then `generatePdfFromHtml(html, filename)` rasterizes to a PDF via html2canvas + jsPDF.

### 3.4 Data fetching pattern

- TanStack Query manages all server state; cache key always includes `profileId` so a profile switch invalidates everything automatically.
- `keepPreviousData` is set on paginated endpoints to avoid table flicker.
- `staleTime` is tuned per-endpoint: 5 minutes for stats, 10 minutes for post lists, 30 minutes for the macro context.
- All requests pass through the shared `axios` instance which (a) attaches the JWT bearer header, (b) attaches the current `X-Profile-Id` header from `ProfileScopeContext`, (c) intercepts 401s to trigger logout.

---

## 4. Database Design & Structure

**Engine:** PostgreSQL 16 (single primary, no replication in v1).
**Migration strategy:** Sequential SQL files in `cyber-backend/scripts/` (`002`–`012` applied in order). TypeORM `synchronize: false` in all environments.

### 4.1 Logical schema (key tables)

```
profiles ──┐
           │  1:N
           ├──── selected_posts (raw posts, post-classification)
           │       (profile_id, ingest_run_id, external_id, source_type,
           │        sentiment, political_spectrum, relevance_score,
           │        ai_topics[], simhash, hashtags[])
           │
           ├──── ingest_runs (one row per ingest invocation)
           │       (profile_id, status, started_at, finished_at,
           │        posts_fetched, posts_after_dedup, posts_selected,
           │        stats jsonb, error_message)
           │
           ├──── hourly_aggregates (rollup, write-optimized)
           │       UNIQUE(profile_id, hour, source_type, sentiment)
           │       (post_count, total_views, total_likes, total_replies)
           │
           ├──── platform_totals (per-source post counts per timeframe)
           │       (profile_id, source_type, timeframe, total, fetched_at)
           │
           └──── ai_result_cache
                   UNIQUE(profile_id, ingest_run_id, prompt_name)
                   (result text, model_name, latency_ms, token_usage jsonb)

users ──── user_profiles (M:N) ──── profiles
   │
   └──── admin_audit_log (immutable trail of admin mutations)
   └──── usage_event (page-view + AI-generation events for billing analytics)

global_context (key-value, jsonb) — stores macro_political_context,
    macro_political_context_7d, and admin-defined facts injected
    into LLM prompts as {{global_<key>}} substitutions.

data_sources — credentials per upstream provider (currently 8tag).
```

### 4.2 Storage optimization

- **Indexed lookups:** `selected_posts` has a composite index `(profile_id, published_at)` for time-range scans and a unique constraint `(external_id, source_type, profile_id)` for idempotent inserts.
- **JSONB for variable shapes:** `profiles.official_channels`, `profiles.source_weights`, `profiles.promises`, `ingest_runs.stats`, `ai_result_cache.token_usage`, `global_context.value`. JSONB allows schema evolution without migrations and supports indexed lookups via `jsonb_path_ops` where needed.
- **Array columns for tags:** `selected_posts.hashtags`, `selected_posts.ai_topics` use PostgreSQL native `text[]` with `unnest()` for GROUP BY queries (e.g. hashtag stats).
- **Bulk write pattern:** Sentiment classification updates use a single `UPDATE … FROM unnest($1::uuid[], $2::text[], …)` to update ≤ 25 rows in one round-trip per LLM batch.
- **Soft retention:** `ingest_cleanup` cron deletes `selected_posts` older than 90 days, `ingest_runs` older than 90 days, `hourly_aggregates` older than 365 days. Trend baselines survive in the aggregates table.

### 4.3 Data flow diagram

```
                        ┌──────────────────────┐
                        │ 8tag (HTTPS/JSON)    │
                        └──────────┬───────────┘
                                   │ search? sources, keywords, since
                                   ▼
                ┌────────────────────────────────────┐
                │  DataSourceApiService.search8tag   │  (raw post payloads)
                └─────────────────┬──────────────────┘
                                  │
                ┌─────────────────▼──────────────────┐
                │  SampleSelectorService              │
                │  - keyword filter (incl/excl)       │
                │  - SimHash dedup                    │
                │  - per-source quota (× weights)     │
                │  - hashtag spam filter              │
                └─────────────────┬──────────────────┘
                                  │ PostInput[]
            ┌─────────────────────┼─────────────────────────┐
            ▼                     ▼                         ▼
    ┌──────────────┐    ┌────────────────────┐   ┌────────────────────┐
    │ selected_posts│    │ hourly_aggregates  │   │ platform_totals    │
    │ (one row per │    │ (UPSERT per hour   │   │ (10 src × 4 tf →   │
    │  unique post)│    │  × source × sent.) │   │  40 rows/profile)  │
    └──────┬───────┘    └────────────────────┘   └────────────────────┘
           │
           │ all rows from this run
           ▼
    ┌──────────────────────────────────┐
    │ BatchSentimentService             │   (Promtic: batch_sentiment)
    │ - chunk into 25-post batches      │   ──────────────────────────►
    │ - parse JSON response             │   updates sentiment, political_
    │ - bulk UPDATE via unnest          │   spectrum, relevance_score,
    └──────────────┬───────────────────┘   ai_topics, bot_probability
                   │
                   ▼
    ┌──────────────────────────────────┐
    │ AiContentService.generateAll      │   (Promtic: 5 prompts in parallel)
    │ ai_summary · macro_context        │   ──────────────────────────►
    │ recommendations · narrative_gap   │   writes ai_result_cache
    │ political_spectrum                │
    └──────────────┬───────────────────┘
                   │
                   │ ingest_runs.status = 'completed'
                   ▼
                   ─────  ingest pipeline ends  ─────


               READ PATH (dashboard request)
               ─────────────────────────────

   Browser ──► AuthGuard ──► JwtStrategy ──► ProfileScopeMiddleware ──► Controller
                                                       │
                                                       ▼
        ┌──────────────────┬──────────────────┬──────────────────┐
        │                  │                  │                  │
        ▼                  ▼                  ▼                  ▼
   selected_posts   hourly_aggregates   platform_totals   ai_result_cache
        │                  │                  │                  │
        └────────┬─────────┴────────┬─────────┴─────────┬────────┘
                 │                  │                   │
                 ▼                  ▼                   ▼
            stats / posts        trend             ai sections
            sentiment            timeline          (cache hit)
                                                        │
                                                        ▼
                                                 Promtic gateway
                                                 (cache miss only)
```

### 4.4 Concurrency and consistency

- **Ingest worker** is single-threaded per profile (sequential within a tier cron). Multiple profiles can be in flight in parallel because each acquires its own `ingest_run` row; there's no shared lock.
- **Hourly aggregate upserts** rely on the unique constraint `(profile_id, hour, source_type, sentiment)` to make `INSERT … ON CONFLICT DO UPDATE` race-safe.
- **Selected post deduplication** uses the unique constraint `(external_id, source_type, profile_id)` plus `INSERT … ON CONFLICT DO NOTHING` so re-runs are idempotent.

---

## 5. Technology Stack & Security

### 5.1 Recommended stack (production-grade)

**Backend:**
- Language: TypeScript 5.7 strict mode
- Runtime: Node.js ≥ 20 (LTS)
- Framework: NestJS 11 (modular, decorator-driven, opinionated)
- ORM: TypeORM 0.3 with `synchronize: false`; SQL migrations as source of truth
- Auth: `@nestjs/passport` + `@nestjs/jwt` + `passport-jwt`; bcrypt cost 10 for password hashing
- Scheduling: `@nestjs/schedule` (cron decorators on service methods)
- HTTP: native `fetch` for outbound (Node 20+); `axios` for browser
- Validation: `class-validator` + `class-transformer` registered as global `ValidationPipe`
- Testing: Jest + `@nestjs/testing` for unit/integration; supertest for e2e

**Frontend:**
- Framework: Next.js 16 (App Router) + React 19
- UI kit: MUI 7 with `stylis-plugin-rtl` for Persian RTL support
- Data fetching: TanStack Query 5
- Forms: React Hook Form + Zod schema validation
- PDF generation: jsPDF + html2canvas
- Internationalization: `i18next` + `react-i18next` (Persian primary, structure ready for additional locales)
- Build: Turbopack (Next.js 16 default)

**Database:**
- PostgreSQL 16 with UTF-8 + `en_US.UTF-8` collation (Persian text indexed correctly)
- pgcrypto extension for hashing where needed
- Container image: `postgres:16-alpine`

**Infrastructure:**
- Container runtime: Docker + Docker Compose for development; production deployment to a managed Linux VM with `pm2` / systemd
- Reverse proxy: Nginx terminating TLS (Let's Encrypt or organization-issued certificate)
- Process supervision: pm2 cluster mode (one Node process per CPU core in production)
- Log aggregation: file-based with logrotate; structured JSON logging via NestJS `Logger`
- Backups: `pg_dump` nightly to encrypted off-host storage; weekly full image backups

### 5.2 Security measures

#### Data encryption

- **In transit:** All client–server, server–8tag, and server–Promtic traffic uses TLS 1.2+ (HTTPS enforced; HTTP redirected at the reverse proxy). Internal database connections use the `sslmode=require` flag in production.
- **At rest:** Database files reside on a LUKS-encrypted disk volume on the host; daily `pg_dump` archives are encrypted with GPG before upload to backup storage. Avatar uploads are converted to 200px JPEG base64 in the user's browser and stored inline in the `profiles.avatar` column (no separate file store, no leaked file paths).
- **Passwords:** bcrypt cost factor 10. Plaintext passwords appear only in the request body during `/api/auth/sign-in` and `/api/auth/change-password`, never logged, never persisted.
- **Secrets:** `.env` is `.gitignore`d; production secrets injected through the orchestrator (Docker Compose `env_file`, systemd `EnvironmentFile`, or similar). `JWT_SECRET` is a 32+ byte random value rotated per deployment.

#### Secure API handling

- **Outbound to providers:** Credentials in `.env` only; signed via HTTP basic auth over HTTPS. Network errors retried up to 3 times with exponential backoff (1s, 2s, 4s) before surfacing.
- **Outbound to Promtic:** `x-api-key` header authentication; the API key is rotated per environment. Network errors retried; long-running invocations polled for up to 60 attempts × 2 s = 2 minutes.
- **Inbound to backend:**
  - JWT bearer validation on every guarded route via `JwtStrategy`.
  - `RolesGuard` enforces `@Roles(...)` declarations.
  - `ProfileScopeMiddleware` validates `X-Profile-Id` against the user's `accessibleProfileIds`; cross-tenant access returns 403 before reaching any controller.
  - Global `ValidationPipe` rejects malformed payloads with 400.
  - CORS whitelist restricted to known frontend origins per deployment.
- **Audit:** Every admin-side mutation is recorded in `admin_audit_log` with credential redaction. Audit rows are append-only — there is no API to delete or modify them.

#### Hardening checklist for launch

- Rotate every credential in `.env` (database, JWT secret, 8tag, Promtic) with deployment-specific values.
- Verify `.env` is not present in git history (`git log --all --full-history -- cyber-backend/.env`); if it is, rewrite history before public deployment.
- Set `NODE_ENV=production` to disable the dev seed users (`admin / Admin@123` and `client / Client@123`).
- Configure the bootstrap super_admin via `BOOTSTRAP_ADMIN_USERNAME` + `BOOTSTRAP_ADMIN_PASSWORD`; force password change on first login.
- Drop `localhost` origins from the CORS whitelist in production builds.
- Ensure `JWT_SECRET` ≥ 32 bytes from a CSPRNG; never use the placeholder `secretKey`.

#### Backup and disaster recovery

- **Daily snapshot:** `pg_dump --format=custom --compress=9` to an encrypted off-host store (S3-compatible or organization SAN). Retention: 30 days rolling.
- **Weekly full image:** Disk-level snapshot of the database volume. Retention: 12 weeks.
- **Quarterly restore drill:** The `scripts/restore-demo.sh` workflow (originally written for the demo dataset) doubles as a documented restore procedure; an operator runs it against a fresh Postgres instance to validate the latest backup.
- **RPO target:** ≤ 24 hours (one daily snapshot).
- **RTO target:** ≤ 2 hours (restore from latest snapshot, replay WAL if available, restart application stack).
- **No PII at rest beyond what users provide:** Profiles store public political figure data; user accounts store name, email, username. No payment data, no health data, no children's data.

### 5.3 Operational readiness summary

| Concern | Phase 1 status |
|---|---|
| Authentication | JWT, bcrypt, no public sign-up. ✅ |
| Authorization | Role guard + profile-scope middleware. ✅ |
| Data ingestion | Cron-driven, idempotent, retry-safe. ✅ |
| LLM cost control | Per-batch sentiment, cached AI sections, ~$0.01/profile/day. ✅ |
| Backups | `pg_dump` workflow defined; daily run requires operator setup. ⚠️ |
| Observability | Structured logs + admin audit log + usage events. ✅ |
| Secret rotation | Bootstrap admin via env; full rotation policy documented for launch. ⚠️ |
| Disaster recovery | Restore procedure documented, drill recommended quarterly. ⚠️ |
| HTTPS / TLS | Required at reverse proxy in production. ⚠️ |

✅ implemented and production-ready · ⚠️ implemented in code, requires operator action at deployment time.

---

This document reflects the as-built state of the platform at the close of phase 1. Subsequent phases will introduce per-tenant data isolation in PostgreSQL, geographic content tagging, real-time websocket notifications for crisis-level changes, and a multi-channel ingest broker for Dataak / Datami / Mahta integration.
