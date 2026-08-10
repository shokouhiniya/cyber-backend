# Admin Panel — Design

Status: draft, for review
Scope: v1 admin panel covering tenant management, users & access control, data source pipelines, prompt-variable management, audit log, and usage analytics.

## 1. Core concepts and decisions

Decisions locked in from discussion:

- **Tenant = `profile`.** One profile per client. A profile is the "who we're analyzing" (قالیباف, etc.) and also the tenancy unit. No separate `Client`/`Organization` entity.
- **One app, role-gated.** Super-admins see a profile picker and can view any client's dashboard exactly as the client sees it. Client users are scoped to a single profile.
- **Data is per-profile.** Each profile has its own ingestion pipeline(s) with include/exclude keywords and sort criteria. Content rows are owned by a profile.
- **Shared "current status" context is global.** Not profile-scoped. Admin-editable, used as context in prompts.
- **Prompt customization lives in Promtic.** We only manage the variables sent to Promtic (including `identifier.external_id = profile.id`).

## 2. Roles

| Role | Can do |
|------|--------|
| `super_admin` | Everything. Profile picker. Impersonate/view-as any client. Manage users, profiles, data sources, global context, see audit log and usage analytics. |
| `client_admin` | Scoped to their profile(s). Can manage their own profile settings that we allow (e.g. keyword fine-tuning, invite their own `client_viewer`s). Cannot see other profiles, cannot edit data-source credentials, cannot see cross-client analytics. |
| `client_viewer` | Scoped to their profile(s). Read-only dashboard access. |

Notes:
- A user can be linked to more than one profile (an agency scenario). The JWT carries the user's role plus the list of accessible profile ids. Super-admins get all.
- "View-as" mode: a super_admin switches profile from the picker. Dashboard API calls carry `x-profile-id` header (or query param) which the backend honors only when the user has access. Every view-as action is logged.

## 3. Data model changes

Minimal schema additions. Everything else stays.

### 3.1 Extend `profiles`

Add columns needed for tenancy and ingestion filters:

```
profiles
  + plan               text       -- 'trial' | 'standard' | 'enterprise' (free-form for now)
  + expires_at         timestamp  -- null = no expiry
  + primary_color      text       -- branding
  + logo_url           text       -- branding
  + excluded_keywords  text[]     -- pipeline exclude filter (complement to existing `keywords`)
  + sort_criteria      text       -- 'recent' | 'popular' | 'engagement'
  + promtic_identifier jsonb      -- pre-built identifier we send to Promtic: { external_id, name, type }
```

`keywords` stays as the include list. `promtic_identifier` is derived but stored so we can edit the display name/type independently of the dashboard.

### 3.2 New table `user_profiles` (M:N)

```
user_profiles
  user_id    uuid  fk users.id       not null
  profile_id uuid  fk profiles.id    not null
  primary key (user_id, profile_id)
  created_at timestamp
```

Super-admins skip this table entirely — their access is implicit from `role = 'super_admin'`.

### 3.3 Extend `data_sources`

Data sources become profile-scoped and carry their pipeline parameters:

```
data_sources
  + profile_id   uuid  fk profiles.id  nullable  -- null means a legacy/global source; v1 requires profile_id
  + params       jsonb                            -- { pageId, phrase, sort, positive, neutral, negative, limit, ... }
  + schedule_cron text                            -- e.g. '0 */6 * * *'
  + last_run_status text                          -- 'success' | 'error' | 'running'
  + last_error    text
```

Credentials stay in the existing jsonb column. Encrypt at rest in v1.1 (tracked below).

### 3.4 Add `content.profile_id`

```
content
  + profile_id  text  indexed  -- null allowed during migration, required going forward
```

This is the clean way to do tenancy. Keyword-based filtering at query time works but gets messy when two profiles share a keyword. With `profile_id` on each row, dashboards simply filter by it, and the ingestion pipeline stamps it at write time.

Migration path:
- Add column nullable.
- Backfill existing rows to the current profile (قالیباف) based on keyword match.
- Change dashboard queries to filter by `profile_id` (from JWT / view-as header).
- Later, make column not-null.

### 3.5 New table `global_context`

For the shared "current status" context used in prompts:

```
global_context
  id           serial pk
  key          text unique        -- e.g. 'political_climate', 'major_events'
  value        text               -- free-form, the admin writes this
  updated_by   uuid fk users.id
  updated_at   timestamp
```

Prompt-building code pulls whichever keys it needs and injects them into `input_vars`. One row per context topic; keeps it simple and editable.

### 3.6 New table `audit_log`

```
audit_log
  id          bigserial pk
  user_id     uuid fk users.id   nullable  -- null for system events
  profile_id  uuid fk profiles.id nullable
  action      text               -- e.g. 'profile.update', 'user.invite', 'view_as.start'
  entity_type text
  entity_id   text
  diff        jsonb              -- { before, after } for updates
  ip          text
  user_agent  text
  created_at  timestamp indexed
```

Write from an interceptor on admin routes. Read-only in the UI.

### 3.7 New table `usage_event`

For usage analytics:

```
usage_event
  id          bigserial pk
  user_id     uuid fk users.id   nullable
  profile_id  uuid fk profiles.id nullable
  event_type  text               -- 'page_view' | 'feature_use' | 'api_call'
  event_name  text               -- 'dashboard.ai_summary', 'posts.filter_by_emotion', ...
  metadata    jsonb              -- anything the caller wants
  created_at  timestamp indexed
```

We aggregate on read. No separate rollup table in v1; add one if the raw table grows past a comfortable threshold.

## 4. Backend: tenant scoping

One scoping strategy applied consistently:

1. `JwtStrategy.validate` expands to also attach:
   - `user.role`
   - `user.accessibleProfileIds` (from `user_profiles`, or `['*']` for super_admin)
2. A new `ProfileScopeGuard` reads either the `X-Profile-Id` header (preferred) or the default profile for the user, validates the user has access, and attaches `req.profileId`.
3. A small decorator `@CurrentProfile()` pulls `req.profileId` into controllers.
4. All content/stats/posts endpoints filter by `req.profileId`.
5. Super-admin-only routes use a `@Roles('super_admin')` decorator + guard.

Nothing fancy. One middleware chain, applied at the module level for the new admin module, and retrofitted onto content routes.

## 5. Backend: new admin module layout

```
src/modules/admin/
  admin.module.ts
  profiles/
    admin-profiles.controller.ts    CRUD on profiles (super_admin only)
    admin-profiles.service.ts
  users/
    admin-users.controller.ts       CRUD on users, invite, role changes, link to profiles
    admin-users.service.ts
  data-sources/
    admin-data-sources.controller.ts  CRUD, test, run-now, schedule
  global-context/
    global-context.controller.ts
    global-context.service.ts
  audit-log/
    audit-log.controller.ts         read-only list with filters
  usage/
    usage.controller.ts             read-only aggregates
    usage.service.ts
```

Existing modules (content, profile, data-source) stay. The admin module is a thin orchestration layer calling into them, plus its own entities for audit-log, usage-event, global-context, and user_profiles.

## 6. Backend: API surface (v1)

All routes under `/admin`. All require `super_admin` unless noted.

### Profiles
- `GET    /admin/profiles` — list with search, pagination, counts (users, posts, last fetch).
- `POST   /admin/profiles` — create.
- `GET    /admin/profiles/:id` — detail including ingestion config.
- `PATCH  /admin/profiles/:id` — update (keywords, excluded_keywords, sort, plan, branding, etc.).
- `POST   /admin/profiles/:id/archive` — soft-disable.
- `GET    /admin/profiles/:id/impersonate-token` — returns a short-lived token scoped to that profile for "view as" mode. (Alternatively: just use `X-Profile-Id` header from super-admin's existing token. Simpler. Going with that.)

### Users
- `GET    /admin/users`
- `POST   /admin/users/invite` — email + role + profile_ids (client-admin can invite `client_viewer` into their own profile).
- `PATCH  /admin/users/:id` — role, active, profile_ids.
- `POST   /admin/users/:id/deactivate`
- `POST   /admin/users/:id/reset-password`

### Data sources
- `GET    /admin/data-sources?profileId=...`
- `POST   /admin/data-sources`
- `PATCH  /admin/data-sources/:id`
- `POST   /admin/data-sources/:id/test` — one-off pull with current params, returns preview, does not persist.
- `POST   /admin/data-sources/:id/run-now` — triggers the real ingestion.
- `DELETE /admin/data-sources/:id`

### Global context
- `GET    /admin/global-context`
- `PUT    /admin/global-context/:key` — upsert.
- `DELETE /admin/global-context/:key`

### Audit log
- `GET /admin/audit-log?userId=&profileId=&action=&from=&to=&limit=&offset=`

### Usage analytics
- `POST /usage/events` — authenticated, any logged-in user. Frontend beacons here on page view / feature use.
- `GET  /admin/usage/summary?from=&to=&profileId=` — totals by profile and by event_name.
- `GET  /admin/usage/profiles-ranking?from=&to=` — most active clients.
- `GET  /admin/usage/features-ranking?from=&to=&profileId=` — most-used features.

### Super-admin profile picker
- `GET  /admin/accessible-profiles` — for super_admin returns all profiles; for others returns their linked profiles. Used to populate the picker in the header.

## 7. Frontend structure

Keep the existing client dashboard untouched. Add an `/admin` section visible only when `role === 'super_admin'` (or `client_admin` for the limited scope).

```
cyber-frontend/src/pages/admin/
  layout.tsx                    sidebar + top bar with profile picker
  profiles/
    index.tsx                   list
    [id].tsx                    edit form (keywords, branding, plan, data sources tab)
  users/
    index.tsx
  data-sources/
    index.tsx                   grouped by profile
  global-context/
    index.tsx
  audit-log/
    index.tsx
  usage/
    index.tsx                   charts + rankings
```

Profile picker behavior:
- Header component reads `/admin/accessible-profiles`.
- On select, stores the profile id in a react context and adds `X-Profile-Id` to every axios call.
- For client-scoped users with a single profile, the picker is hidden and the profile id is always their own.

## 8. Usage analytics — what we track

Minimal set, to avoid noise. Name keys as `area.action`:

- `dashboard.view` — any dashboard page load, with `page` in metadata.
- `dashboard.section_view` — when a section scrolls into view (debounced).
- `posts.filter` — user applied a filter, with the filter in metadata.
- `post.open` — user opened a post detail.
- `export.run` — CSV/PDF export.
- `ai.refresh` — user hit the refresh button on an AI section.
- `admin.action` — any admin-panel mutation (paired with audit_log entries).

Aggregation SQL is straightforward: group by `event_name`, by `profile_id`, by date bucket. Charts on the admin usage page can be standard recharts line + bar.

## 9. Security notes

- Credentials in `data_sources.credentials` are currently plaintext jsonb. Pre-v1 release: add `pgcrypto` based encryption using a key from env, transparent through the service layer. Tracked as a v1 must-fix.
- Audit-log must capture the acting user even during impersonation. Entry format: `{ actor_user_id, effective_profile_id, ... }`.
- Rate-limit the invite/reset endpoints.

## 10. Out of scope for v1

Parked for later, confirmed acceptable:
- Cost tracking dashboard pulling from Promtic invocations API.
- Content moderation UI (flag/delete posts, re-run classification).
- System-health dashboard.
- Notifications/alerts engine.
- Feature flags beyond what `global_context` covers.
- Billing.

## 11. Implementation order (proposed)

Each step deployable on its own:

1. ✅ Schema migration: add columns/tables listed above, backfill `content.profile_id`. (`scripts/002-admin-migration.sql` + updated `init-db.sql`)
2. ✅ JWT + `ProfileScopeMiddleware` + `X-Profile-Id` flow; retrofit existing content routes.
3. ✅ Admin module skeleton + super-admin role check.
4. ✅ Profiles CRUD (backend); frontend UI pending.
5. ✅ Users & `user_profiles` CRUD backend; frontend UI pending.
6. ✅ Data sources per-profile CRUD + test/run-now (`/admin/data-sources`). Scheduler still manual.
7. ✅ Global context CRUD + auto-merge into Promtic `input_vars` as `global_<key>`.
8. ✅ Audit log write (APP_INTERCEPTOR on admin routes, credential redaction) + read endpoint.
9. ✅ Usage events write (`POST /usage/events`) + aggregates: summary, profiles-ranking, features-ranking, daily.
10. Profile picker in header, view-as mode polished (frontend work — next round).

Steps 1-9 shipped. All v1 backend foundation for multi-tenancy, admin management, and observability is in place.

## 12. Resolved decisions (was: open questions)

- **Invites:** no email system in v1. super_admin creates users with a temp password and hands it out-of-band. The user changes their own password later.
- **Sign-up:** public sign-up disabled. `POST /api/auth/sign-up` removed; only `POST /api/admin/users` (super_admin) can create accounts.
- **Scheduling:** manual for v1. `schedule_cron` column is there for later, but nothing runs it yet. Use `POST /api/data-sources/:id/test` and the existing ingestion scripts.


## 13. API reference (v1 admin)

All routes require a `Bearer <jwt>` header; super_admin-only unless noted.

```
GET    /api/admin/profiles                        — list with counts
POST   /api/admin/profiles                        — create
GET    /api/admin/profiles/:id
PATCH  /api/admin/profiles/:id
DELETE /api/admin/profiles/:id                    — soft-archive

GET    /api/admin/accessible-profiles             — any authenticated user; header picker

GET    /api/admin/users
POST   /api/admin/users                           — create + link profiles
GET    /api/admin/users/:id
PATCH  /api/admin/users/:id
POST   /api/admin/users/:id/reset-password
POST   /api/admin/users/:id/deactivate

GET    /api/admin/data-sources?profileId=<id>
POST   /api/admin/data-sources
GET    /api/admin/data-sources/:id
PATCH  /api/admin/data-sources/:id
DELETE /api/admin/data-sources/:id
POST   /api/admin/data-sources/:id/test           — dry run, no last_fetch_at stamp
POST   /api/admin/data-sources/:id/run-now        — runs + stamps last_fetch_at / last_run_status
POST   /api/admin/data-sources/:id/pages          — 8tag only
PATCH  /api/admin/data-sources/:id/toggle        — { isActive: boolean }

GET    /api/admin/global-context
GET    /api/admin/global-context/:key
PUT    /api/admin/global-context/:key             — { value }
DELETE /api/admin/global-context/:key

GET    /api/admin/audit-log                       — ?userId=&profileId=&action=&from=&to=&limit=&offset=

POST   /api/usage/events                          — any authenticated user; auto-tagged with profile
GET    /api/admin/usage/summary                   — ?from=&to=&profileId=
GET    /api/admin/usage/profiles-ranking          — ?from=&to=
GET    /api/admin/usage/features-ranking          — ?from=&to=&profileId=
GET    /api/admin/usage/daily                     — time-series for charts
```

### How global context flows into prompts

`AiContentService.invokePrompt` fetches all `global_context` rows before each Promtic call and merges them into `input_vars` as `global_<key>`. Example: a row with `key='political_climate'` becomes available to every prompt as `{{ global_political_climate }}`.

### Audit log behavior

`AdminAuditLogInterceptor` is installed as `APP_INTERCEPTOR`. It writes a row after every successful mutating request whose URL contains `/admin/`. The request body and params are captured as `diff`, with credential-looking keys (`password`, `credentials`, `token`, `apikey`, `secret`) redacted. Failed requests write nothing (the interceptor taps on success only).

### Usage event vocabulary (recommended)

Frontend should POST to `/usage/events` with:

| eventType | eventName examples |
|-----------|-------------------|
| `page_view` | `dashboard.view`, `admin.users.view` |
| `feature_use` | `posts.filter`, `ai.refresh`, `export.run`, `post.open` |
| `api_call` | rarely needed; prefer server-side |
| `admin.action` | mirrors audit_log entries when we want both streams |
