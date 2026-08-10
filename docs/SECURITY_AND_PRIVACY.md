# Security and Privacy Protection Provisions

**Sistem Rasad Faza-ye Majazi (Cyberspace Monitoring Platform)**
**Version 1.0** · **Phase 1 Production Release**
**Companion document:** `SYSTEM_ARCHITECTURE.md`

---

## 1. Scope and Threat Model

### 1.1 Scope

This document defines the security and privacy provisions for the Cyberspace Monitoring Platform. It covers:

- Authentication and authorization
- Encryption (in transit and at rest)
- Access control (role-based and tenant-scoped)
- Data classification, minimization, and retention
- Audit logging and monitoring
- Backup and disaster recovery
- Vulnerability management and incident response

It does **not** cover physical security of the hosting facility, organizational security training, or third-party (8tag, Promtic) internal security; those are governed by their respective vendors.

### 1.2 Trust boundaries

```
┌─────────────────────────────────────────────────────────┐
│  Untrusted: Public Internet                              │
│   - Browsers, malicious actors, scanners                 │
└──────────────────────┬──────────────────────────────────┘
                       │ TLS 1.2+ only
┌──────────────────────▼──────────────────────────────────┐
│  Semi-trusted: Reverse proxy (Nginx)                     │
│   - Terminates TLS, enforces HTTPS, rate-limits          │
└──────────────────────┬──────────────────────────────────┘
                       │ Localhost loopback (HTTP)
┌──────────────────────▼──────────────────────────────────┐
│  Trusted: Application server (NestJS)                    │
│   - Auth guards, role guards, profile-scope middleware   │
│   - All business logic, no direct DB access from outside │
└──────────────────────┬──────────────────────────────────┘
                       │ Localhost / VPN / sslmode=require
┌──────────────────────▼──────────────────────────────────┐
│  Trusted: Database (PostgreSQL)                          │
│   - LUKS-encrypted volume, scoped DB user                │
│   - No direct external network exposure                  │
└─────────────────────────────────────────────────────────┘

Outbound (server-initiated only):
   ── HTTPS + basic-auth ──►  8tag (d1.8tag.ir)
   ── HTTPS + x-api-key ──►  Promtic (papi.cyber.pish.run)
```

### 1.3 Threat model summary

The following threat categories are explicitly mitigated. Each is addressed in detail later in this document.

| Threat | Mitigation |
|---|---|
| Credential theft (password reuse, brute force) | bcrypt hashing, no password storage in clear, no public sign-up |
| Session hijacking | JWT signed with 256-bit secret, HTTPS-only transport, 7-day expiry |
| Cross-tenant data leakage | Profile-scope middleware enforced before every read |
| Privilege escalation | Role guard with `@Roles(...)` on every admin endpoint |
| SQL injection | Parameterized queries throughout; ORM-managed entities |
| Cross-site scripting (XSS) | React's automatic escaping; no `dangerouslySetInnerHTML` on user content |
| Cross-site request forgery (CSRF) | JWT in `Authorization: Bearer` header (not cookies); CORS whitelist |
| Open redirect / SSRF | Outbound URLs are hardcoded in service modules, not user-supplied |
| Insecure direct object reference (IDOR) | Every profile-scoped query filters by `accessibleProfileIds` |
| Mass assignment | Global `ValidationPipe` with `whitelist: true` strips unknown fields |
| Audit evasion | `admin_audit_log` is append-only; no API to delete or modify rows |
| Backup theft | GPG-encrypted snapshots stored off-host |
| Secret exposure in source control | `.env` is gitignored; `.env.example` documents shape only |

---

## 2. Authentication

### 2.1 User accounts

User identity is stored in the `users` table with these security-relevant columns:

- `id` (UUID v4) — Primary key. Never recycled.
- `username` (unique, indexed) — Login identifier; case-sensitive.
- `email` — Optional contact field; not used as login credential.
- `password_hash` — bcrypt hash with cost factor 10.
- `role` — One of `super_admin`, `client_admin`, `client_viewer`.
- `is_active` — Soft-disable flag; deactivated users cannot log in.

There is **no public sign-up endpoint**. Accounts are provisioned in one of three ways:

1. **Bootstrap super_admin** at first boot: created from `BOOTSTRAP_ADMIN_USERNAME` and `BOOTSTRAP_ADMIN_PASSWORD` environment variables when no super_admin exists.
2. **Admin-created users**: super_admin uses `POST /api/admin/users` to create `client_admin` and `client_viewer` accounts, optionally pre-linked to one or more profiles.
3. **Development seed**: in `NODE_ENV !== 'production'` only, two demo accounts (`admin`/`Admin@123` and `client`/`Client@123`) are auto-seeded for local testing. These are skipped in production.

### 2.2 Sign-in flow

```
Client                          Backend                          Database
  │                                │                                │
  │ POST /api/auth/sign-in         │                                │
  │  { username, password }        │                                │
  │ ──────────────────────────────►│                                │
  │                                │ findByUsername(username)       │
  │                                │ ──────────────────────────────►│
  │                                │ ◄──────────────── User row     │
  │                                │ bcrypt.compare(pw, hash)       │
  │                                │ check user.is_active           │
  │                                │ JwtService.sign({ sub, role }) │
  │ ◄────────────────────────────  │                                │
  │  { accessToken: "eyJ..." }     │                                │
```

- Bcrypt cost factor 10 — verified hash on every login. Reject with HTTP 401 + generic Persian message (`نام کاربری یا رمز عبور اشتباه است`); never differentiate "user not found" vs "password wrong".
- Plaintext password appears only in the request body; it is never logged, never persisted, and never appears in error messages.
- Timing-safe comparison provided by bcrypt itself.

### 2.3 Token issuance and validation

- **Algorithm:** HS256 (HMAC SHA-256).
- **Secret:** `JWT_SECRET` from environment, minimum 32 bytes from a CSPRNG. The placeholder `secretKey` in `.env.example` MUST be replaced before any deployment.
- **Expiry:** `JWT_EXPIRES_IN=7d` by default; configurable per deployment.
- **Claims:** `sub` (user id), `username`, `role`, `iat`, `exp`. No PII or secrets in the token body (it is signed but not encrypted; clients can decode it).
- **Storage:** Frontend stores the token in `sessionStorage` (cleared on tab close) under key `JWT_STORAGE_KEY`. Not stored in cookies, not persisted to localStorage.
- **Transport:** `Authorization: Bearer <token>` header on every authenticated request. Never as a query parameter.
- **Rotation:** No silent refresh in v1. On token expiry the next request returns 401 and the client redirects to the sign-in page. This is a deliberate trade-off: simpler failure modes, no refresh-token theft surface.

### 2.4 Self-service password change

`POST /api/auth/change-password` requires:

- A valid JWT (proves the holder authenticated recently).
- The current password (proves the device owner is the account owner, not a stolen-token attacker).
- A new password ≥ 6 characters, different from the current one.

The handler verifies the current password with bcrypt before accepting the change. The new password is hashed with bcrypt cost 10 before persistence. Old hash is overwritten in place.

### 2.5 Password policy

- Minimum length: 6 characters (enforced by `class-validator` on the DTO and by the frontend Zod schema).
- No upper-bound on length (bcrypt truncates at 72 bytes; users with longer inputs get a still-strong hash of the first 72 bytes).
- No mandatory complexity rules in v1; future versions will adopt a strength meter (`zxcvbn`) and require a minimum strength score for new passwords.
- No password history; users may technically reuse a previous password. (Tracked as a phase-2 enhancement.)
- No automated password expiry; rotation is event-driven (suspected compromise, employee departure).

### 2.6 Account lockout

- v1: Not implemented. Brute-force attacks are mitigated by bcrypt's intentional slowness (~ 100 ms per attempt) and by the absence of any password leak from the system itself.
- Phase 2: Recommended addition — exponential lockout after 5 consecutive failures within 15 minutes per username.

---

## 3. Authorization

Authorization is enforced in two layers, both server-side. Frontend role checks exist for UX (hiding nav items, disabling buttons) but are never trusted as a security boundary.

### 3.1 Role-based access control

Three roles, hard-coded into the `RolesGuard` and applied via `@Roles(...)` on controllers and methods:

| Role | Scope | Can access |
|---|---|---|
| `super_admin` | Cross-tenant | All admin endpoints (`/api/admin/*`), all profile data, all user management, all data sources, global context, audit log, usage analytics |
| `client_admin` | Single profile (or several, via `user_profiles`) | Dashboard read, profile-edit (own profile), promise editing, manual ingest run-now (with cooldown), change own password |
| `client_viewer` | Single profile (or several) | Dashboard read only |

`RolesGuard` algorithm:

1. Read `@Roles(...)` decorator metadata on the handler and class.
2. If no decorator: allow (public endpoint — applies to `/api/auth/sign-in` only).
3. Read `req.user.role` (set by `JwtStrategy` after token validation).
4. Permit if `req.user.role` is in the allowed list; otherwise return HTTP 403 with Persian message.

### 3.2 Profile-scope (tenant) isolation

`ProfileScopeMiddleware` runs on every dashboard route group:

```
/stats/*  /posts/*  /emotions/*  /influencers/*
/ai-content/*  /profile/*  /usage/events
```

The middleware:

1. Reads JWT from the `Authorization` header, decodes claims, queries `user_profiles` to compute `accessibleProfileIds`.
2. Reads the requested profile from the `X-Profile-Id` header (set by the frontend's `ProfileScopeContext`).
3. Validates: `super_admin` may scope to any profile; others must have the profile in their `accessibleProfileIds` list.
4. Cross-tenant access attempts return HTTP 403 (`به این پروفایل دسترسی ندارید`) **before any database read happens**.
5. On success, attaches `req.profileId` so `@CurrentProfile()` parameter decorators resolve it for downstream services.

This means **every read query in `ContentService`, `AiContentService`, `TrendService`, etc. is automatically scoped to the validated profile**. There is no code path where a controller can serve cross-profile data without going through this middleware.

The middleware is registered in `AppModule.configure()` and applies before any controller. Admin-CRUD routes under `/api/admin/*` skip this middleware because they operate cross-profile by design and are gated by `@Roles('super_admin')` instead.

### 3.3 Object-level access (IDOR mitigation)

Every database query that touches profile data includes a `profile_id = $1` filter parameterized from `req.profileId`. Examples:

- `ContentService.getPosts(...)` builds a TypeORM query with `qb.andWhere('p.profile_id = :profileId', { profileId })`.
- `StatsController.getCrisisMetrics` rejects with empty array if `profileId` is null.
- `getPromisePerception` reads the profile row first to confirm ownership, then queries `selected_posts` filtered by both `profile_id` and `selection_reason`.

There is no endpoint that accepts a `profileId` argument and returns data without first validating it through the middleware-attached `req.profileId`.

### 3.4 Privilege boundaries

- **Self-service operations** (anyone can call as long as they're authenticated):
  - `GET /api/auth/me`
  - `POST /api/auth/change-password`
  - `GET /api/profile` (returns the current scoped profile, read-only)

- **Profile-scope operations** (`super_admin`, `client_admin`, `client_viewer`):
  - All `/api/stats/*`, `/api/posts/*`, `/api/emotions/*`, `/api/influencers/*`, `/api/ai-content/*` reads
  - `GET /api/ingest/latest-run` (their own profile only)

- **Profile-management operations** (`super_admin`, `client_admin`):
  - `POST /api/ingest/run-now` (with 15-minute cooldown per profile)
  - `PATCH /api/profile` (edit own profile fields like keywords, official channels, promises, avatar)

- **Tenant administration** (`super_admin` only):
  - All `/api/admin/*` endpoints: profiles CRUD, users CRUD, data sources CRUD, global context, audit log, usage analytics
  - Cross-profile ingest controls (`/api/admin/ingest/*`)

### 3.5 Service-account credentials

- 8tag credentials and Promtic API keys are not user accounts; they live in environment variables and are never exposed to end users. They are used exclusively for server-to-server traffic.
- These credentials grant only the access negotiated with the respective vendors (read-only data retrieval and prompt invocation, respectively). They cannot mutate data on the vendor side.

---

## 4. Encryption

### 4.1 Encryption in transit

| Channel | Protection | Notes |
|---|---|---|
| Browser ↔ Reverse proxy | TLS 1.2+, modern cipher suite | Let's Encrypt or organization-issued certificate; HSTS recommended |
| Reverse proxy ↔ App server | Localhost loopback (HTTP) | Both processes on the same host; no network segment exposed |
| App server ↔ PostgreSQL | `sslmode=require` in production | Same host or private subnet; cert pinning optional |
| App server ↔ 8tag | TLS 1.2+ + HTTP basic auth | Outbound only; credentials in `Authorization` header |
| App server ↔ Promtic | TLS 1.2+ + `x-api-key` header | Outbound only; key rotated per environment |

- HTTP requests at the reverse proxy are 301-redirected to HTTPS.
- HSTS header (`Strict-Transport-Security: max-age=31536000; includeSubDomains`) recommended at the reverse proxy.
- TLS 1.0 and TLS 1.1 disabled at the reverse proxy.
- Self-signed certificates are not used in production.

### 4.2 Encryption at rest

| Asset | Protection |
|---|---|
| Database files | Host-level disk encryption (LUKS on Linux). The PostgreSQL data directory and WAL live on the encrypted volume |
| Database backups | `pg_dump` output encrypted with GPG before being uploaded to off-host storage |
| Application logs | Reside on the same encrypted volume as the database; no separate handling |
| Avatars | Stored as inline base64 JPEG inside `profiles.avatar` (no separate file store, no path traversal surface) |
| Secrets (`.env`) | Plaintext on the encrypted volume; never committed to git, never copied to CI logs |
| JWT secret | Plaintext in `.env`; requires the host to be compromised for exposure |

The platform does not encrypt individual table columns at the database level (column-level encryption is a phase-2 enhancement). Disk-level encryption protects the database against offline attacks (stolen disk, decommissioned hardware) but does not protect against an attacker who has compromised the running database process.

### 4.3 Cryptographic primitives

| Use | Algorithm | Library | Parameters |
|---|---|---|---|
| Password hashing | bcrypt | `bcrypt` (Node.js) | cost factor 10 |
| Token signing | HMAC-SHA256 | `@nestjs/jwt` (jsonwebtoken) | 256-bit secret |
| TLS | TLS 1.2+ ECDHE/AES-GCM | OpenSSL (via Nginx + Node `tls`) | Modern cipher suite |
| Backup encryption | OpenPGP (AES-256) | `gpg` | Symmetric key or RSA-4096 recipient |
| Random IDs | UUID v4 | PostgreSQL `gen_random_uuid()` | 122 bits of entropy |
| SimHash (dedup) | 64-bit fingerprint | Application-layer | NOT cryptographic; not used for security |

No custom cryptography is implemented anywhere in the codebase. All cryptographic operations go through well-vetted libraries.

### 4.4 Secret management

- All secrets are loaded from environment variables at boot via `@nestjs/config`.
- `.env` is in `.gitignore`; `.env.example` documents required keys with placeholder values only.
- Secrets are never logged. The default NestJS `Logger` does not log request bodies, and the audit interceptor explicitly redacts fields whose names contain `password`, `credentials`, `token`, `apikey`, `api_key`, or `secret` (case-insensitive substring match).
- Production deployments inject secrets through the orchestrator: `docker-compose.yml` uses `env_file: .env`; systemd uses `EnvironmentFile=/etc/cyber/.env` with file permissions `0600` owned by the application user.

**Required rotation events:**

1. Initial production deployment: rotate every secret carried over from development.
2. Personnel change: rotate `JWT_SECRET`, database password, 8tag credentials, Promtic API key.
3. Suspected compromise: rotate all secrets in the affected scope; force-logout all sessions by rotating `JWT_SECRET` (which invalidates all existing tokens).

---

## 5. Privacy and Data Protection

### 5.1 Data classification

The platform handles three categories of data, each with distinct handling requirements.

| Class | Examples | Source | Handling |
|---|---|---|---|
| **Public political content** | Social media posts about monitored political figures, post text, screen names, view/like counts | Ingested from 8tag | Stored in `selected_posts`; visible to authorized users; subject to 90-day retention |
| **Tenant configuration** | Profile names, keywords, official channel handles, promises, source weights, avatars | Created by admin users | Stored in `profiles`; visible to users with access to the profile |
| **Account credentials and metadata** | Username, password hash, email, role, profile-access map, audit trail | Created by admin operations | Stored in `users`, `user_profiles`, `admin_audit_log`; password hashes are never returned by any endpoint |

The platform does **not** store:
- Payment card data or financial information
- Health records or medical data
- Children's personal data
- Government identification numbers
- Biometric data

### 5.2 Subjects and lawful basis

Two distinct subject populations:

1. **Operator users** (super_admins, client_admins, client_viewers): Provide credentials and contact info as part of using the system. Lawful basis: contractual necessity (operating the service).

2. **Public political figures** (the monitored profiles): The system ingests publicly published social media content about them. No private messages, no closed-group content, no inferred identity attributes beyond what is publicly stated. Lawful basis: legitimate interest in public political discourse analysis. Data subjects have no operational relationship with the platform.

### 5.3 Data minimization

- The ingest pipeline retrieves only what 8tag returns for the configured keywords; no broad scrapes.
- The `SampleSelectorService` applies `excludedKeywords` and a hashtag spam filter to drop irrelevant posts at intake.
- The `BatchSentimentService` adds a `relevance_score` (1–5); posts scored 1 or 2 are filtered out at read time and not shown on the dashboard. They remain in storage in case classification needs to be revisited.
- No browser fingerprinting, no third-party analytics scripts, no advertising trackers. The frontend ships zero analytics.
- The `usage_event` table records page navigations (path, profile id, user id, timestamp) for billing/usage analytics. It does not record the contents of any page or any user-supplied data.

### 5.4 Data retention

Defined in `IngestWorkerService.cleanup()`, scheduled at 02:00 every Sunday:

| Table | Retention | Rationale |
|---|---|---|
| `selected_posts` | 90 days | Dashboard timeframes go up to 90 days (quarterly report); older raw posts no longer drive any UI |
| `ingest_runs` | 90 days | Run history visible on the admin profiles page |
| `hourly_aggregates` | 365 days | Long-term trend baselines for crisis radar self-calibration |
| `ai_result_cache` | Tied to `ingest_runs` (CASCADE delete) | LLM output is meaningful only with the run that produced it |
| `platform_totals` | Overwritten per-run | Always represents current state |
| `admin_audit_log` | Indefinite (immutable) | Compliance trail |
| `users`, `user_profiles` | Indefinite (until user is hard-deleted) | Active accounts |

Retention can be reconfigured per deployment by adjusting the cron and cutoffs in `ingest-worker.service.ts`.

### 5.5 Data subject rights

Operator users can:
- View their own profile and account data (`GET /api/auth/me`, `GET /api/profile`)
- Change their own password (`POST /api/auth/change-password`)
- Request deletion of their account (manual process via super_admin who calls `DELETE /api/admin/users/:id`)

Monitored political figures (the public-content data subjects):
- Have no self-service interface in v1.
- Removal of a profile is a manual super_admin operation that cascades to delete all `selected_posts`, `hourly_aggregates`, `platform_totals`, `ingest_runs`, and `ai_result_cache` rows for that profile via `ON DELETE CASCADE` foreign keys.

### 5.6 Personally identifiable information in code samples

Generic placeholders are used in code examples, mock data, seed scripts, and tests. The single demo profile (محمدباقر قالیباف) refers to a public political figure and contains only public information. Real operator account credentials are never committed to source control.

---

## 6. Audit Logging and Monitoring

### 6.1 Admin audit log

The `AdminAuditLogInterceptor` is registered as a global `APP_INTERCEPTOR` and writes a row to `admin_audit_log` for every state-mutating operation under `/api/admin/*` (HTTP `POST`, `PATCH`, `PUT`, `DELETE`).

Each audit row contains:

- `user_id` — Actor (from `req.user.sub`)
- `profile_id` — Tenant context (from `req.profileId` if set)
- `action` — `<entity>.<method>` (e.g. `users.post`, `profiles.patch`, `data-sources.delete`)
- `entity_type` — Path-derived (e.g. `users`, `profiles`)
- `entity_id` — From route params (`:id` or `:key`)
- `diff` — Request body, with sensitive fields redacted
- `ip` — Client IP from `X-Forwarded-For` (when behind a reverse proxy) or socket
- `user_agent` — From `User-Agent` header
- `created_at` — Auto-populated, indexed for time-range queries

**Redacted field names (case-insensitive substring match):**

```
password · credentials · token · apikey · api_key · secret
```

These are replaced with the literal string `[REDACTED]` in the persisted `diff` column. The redactor recurses into nested objects and arrays.

The audit log is **append-only** by application contract. There is no API to delete or modify audit rows; super_admins can only read them through `GET /api/admin/audit-log`. Direct database access (which the application user technically has) is the only way to mutate the table — and any such operation should itself be audited at the database level.

### 6.2 Application logs

NestJS structured logger writes to stdout/stderr in production. In a typical deployment:

- pm2 or systemd captures stdout/stderr to log files.
- `logrotate` rotates daily, keeps 14 days, compresses with gzip.
- Logs include: HTTP request method/path/status (via `LoggerMiddleware`), authentication failures, ingest run start/finish summaries, LLM invocation results, and exceptions.
- Logs do **not** include: passwords, JWT tokens, full request bodies, user PII beyond username, full LLM response bodies (only metadata: prompt name, latency, token usage).

### 6.3 Usage events

The `usage_event` table records page-view beacons for billing/usage analytics. Each event has:
- `user_id`, `profile_id`, `event_type` (e.g. `page.view`, `ai.generate`)
- `path`, `metadata` (jsonb, may include section name)
- `created_at`

Aggregation is performed on read by `UsageController`. Per-user daily totals, per-feature popularity, and per-profile activity rankings are derived from this table without a rollup table.

### 6.4 Monitoring and alerting

- Phase 1 (current): Manual log inspection. The admin profiles page surfaces ingest run history and failure messages to super_admins.
- Phase 2 (recommended): Integrate Prometheus metrics export from NestJS, alert on:
  - Ingest run failure rate > 10% over a 6-hour window
  - Authentication failure rate > 50/min (potential brute force)
  - LLM gateway latency p95 > 30 seconds
  - Database connection pool saturation
  - Disk usage > 80% on the database volume

---

## 7. Backup and Disaster Recovery

### 7.1 Backup policy

| Asset | Frequency | Method | Retention | Storage |
|---|---|---|---|---|
| PostgreSQL database | Daily | `pg_dump --format=custom --compress=9` | 30 days | Off-host, GPG-encrypted |
| Database volume snapshot | Weekly | LVM/cloud snapshot | 12 weeks | Same provider as host, separate region if cloud |
| Application source code | On every deploy | Git tag + container image | Indefinite | Git repository + container registry |
| Configuration (`.env`) | Out-of-band | Operator-managed secret store | Indefinite | Vault / 1Password / manual |

### 7.2 Recovery objectives

- **RPO (Recovery Point Objective):** ≤ 24 hours. Worst case: restore from yesterday's daily snapshot. Loss is bounded by a single ingest cycle plus user actions in the last day.
- **RTO (Recovery Time Objective):** ≤ 2 hours. Restore from latest snapshot, replay WAL if the binary log is intact, restart the application stack.

### 7.3 Restore procedure

The `cyber-backend/scripts/restore-demo.sh` workflow doubles as a documented restore procedure (originally written for the demo dataset). High-level steps:

1. Provision a fresh PostgreSQL 16 instance with a matching collation.
2. Apply the schema migrations in order: `init-db.sql`, `002-…012-*.sql`.
3. Restore the most recent encrypted `pg_dump` archive: `gpg -d backup.sql.gpg | pg_restore -d cyber`.
4. Run seed scripts to reconcile any missing reference data (`seed-profiles.js`, `seed-official-channels.js`, `seed-promises.js`, `setup-all-prompts.js`).
5. Restart the application stack with the production `.env`.
6. Smoke-test sign-in, dashboard read, and a manual ingest run-now.

### 7.4 Disaster recovery testing

- Quarterly restore drill recommended: an operator runs the procedure against a fresh Postgres instance to validate the latest backup is intact and complete.
- Drills are tracked in operator runbooks (out of scope for this document).

---

## 8. Vulnerability Management

### 8.1 Dependency hygiene

- All dependencies are pinned to a minor version range in `package.json`; major upgrades are deliberate.
- `npm audit` (backend) and `yarn audit` (frontend) run on every CI build.
- Critical and high-severity advisories are remediated within 7 days; medium within 30 days.
- The platform is built on actively maintained packages (NestJS 11, Next.js 16, MUI 7, React 19, PostgreSQL 16) — all on current supported releases as of the v1.0 release.

### 8.2 Supply chain

- New dependencies require review: maintained, popular, no obvious typosquatting variants.
- Dependencies are installed exactly per `package-lock.json` / `yarn.lock` in production builds.
- Container images are built from official base images (`node:20-alpine`, `postgres:16-alpine`); no unverified third-party base images.

### 8.3 Static analysis

- TypeScript strict mode catches a meaningful class of bugs at compile time.
- ESLint with `eslint-plugin-react`, `eslint-plugin-react-hooks`, and `eslint-plugin-import` runs in CI.
- Prettier enforces consistent formatting.
- Automated SAST (e.g. SonarQube, Semgrep) is recommended for phase 2 but not currently integrated.

### 8.4 Penetration testing

- v1: Internal review only.
- Recommended: third-party penetration test before any external customer onboarding. Scope should cover authentication, authorization (especially profile-scope bypass), input validation, and the LLM gateway integration.

### 8.5 Reporting vulnerabilities

- Internal: Direct issue in the project repository, marked confidential.
- External (post-launch): Security contact published in a `SECURITY.md` at the repository root.

---

## 9. Incident Response

### 9.1 Detection

- Application logs surface authentication failures, authorization rejections, and unhandled exceptions.
- The admin audit log surfaces unusual administrative activity (e.g. mass user creation, data source credential changes).
- Failed ingest runs are visible on the admin profiles page with their error message.
- Users report visible incidents (account lockouts, dashboard errors, suspected unauthorized access) to the super_admin team.

### 9.2 Response procedure

If a security incident is suspected:

1. **Contain.** Rotate `JWT_SECRET` to invalidate all sessions. Disable affected accounts via `PATCH /api/admin/users/:id/deactivate`. If a credential is suspected leaked, rotate it immediately (database password, 8tag credentials, Promtic API key).
2. **Investigate.** Query `admin_audit_log` and application logs for the affected time window. Identify the actor, the affected data, and the entry vector.
3. **Eradicate.** Remove malicious data, revert unauthorized changes (audit log preserves the prior state), patch the entry vector.
4. **Recover.** Restart services, force users to re-authenticate, restore from backup if data integrity was compromised.
5. **Document.** Write a post-incident report covering timeline, impact, root cause, and remediation. Update this document if any provision needs strengthening.

### 9.3 Notification

Phase 1 deployments are operated by Pishrun internally. External notification policies will be defined per-customer in their contractual agreements.

---

## 10. Hardening Checklist

This checklist is the operator's pre-launch verification. Every item should be confirmed before exposing the platform to non-operator users.

### 10.1 Secrets

- [ ] `.env` is not in git history (`git log --all --full-history -- cyber-backend/.env`).
- [ ] `JWT_SECRET` is ≥ 32 bytes from a CSPRNG (e.g. `openssl rand -base64 48`); not the placeholder `secretKey`.
- [ ] All `.env` values are deployment-specific, not copied from development.
- [ ] `BOOTSTRAP_ADMIN_USERNAME` and `BOOTSTRAP_ADMIN_PASSWORD` are set; the bootstrap admin password is rotated immediately after first login via `POST /api/auth/change-password`.
- [ ] `NODE_ENV=production` is set; the dev seed users (`admin`/`Admin@123`, `client`/`Client@123`) are not present in the production database.

### 10.2 Network

- [ ] Reverse proxy terminates TLS 1.2+; HTTP redirects to HTTPS.
- [ ] HSTS header set with `max-age=31536000; includeSubDomains`.
- [ ] CORS whitelist excludes `localhost` origins in production.
- [ ] PostgreSQL is not directly exposed to the public internet; bound to localhost or a private subnet only.
- [ ] PostgreSQL connection uses `sslmode=require` if not on localhost.

### 10.3 Application

- [ ] Latest deployment uses pinned versions of all dependencies.
- [ ] `npm audit` reports zero critical or high-severity advisories.
- [ ] Static file serving is restricted to the `/static/` prefix; the `static/` directory contains no sensitive files.
- [ ] Health check endpoint (if added in phase 2) does not leak sensitive system info.

### 10.4 Database

- [ ] Database volume is encrypted at rest.
- [ ] Application connects with a non-superuser DB account scoped to the `cyber` database.
- [ ] Unused legacy users (`postgres` superuser used only for migrations) are restricted to admin-only operations.

### 10.5 Backups

- [ ] Daily `pg_dump` cron is configured and tested.
- [ ] Backup destination is off-host and access-controlled.
- [ ] Backup encryption key is stored separately from the backup files.
- [ ] Most recent restore drill was within the last quarter.

### 10.6 Logging and audit

- [ ] Application logs rotate daily and retain ≥ 14 days.
- [ ] `admin_audit_log` is populating (check after performing any admin action).
- [ ] Sensitive fields (`password`, `apikey`, etc.) appear as `[REDACTED]` in audit `diff` rows.

### 10.7 Operational

- [ ] Bootstrap super_admin has a documented break-glass procedure (in case the only admin loses access).
- [ ] Deployment runbook documents the secret-rotation workflow.
- [ ] Incident response contact list is current.
- [ ] Time on the application and database servers is synchronized (NTP) to support reliable audit timestamps.

---

## Appendix A — Provision-to-Code Cross-Reference

For audit and review purposes, this table maps each provision in this document to its implementation location in the source tree.

| Provision | Implementation file |
|---|---|
| Password hashing (bcrypt cost 10) | `src/modules/auth/auth.service.ts`, `src/modules/seed/seed.service.ts` |
| Sign-in endpoint | `src/modules/auth/auth.controller.ts` (`POST /api/auth/sign-in`) |
| Change-password endpoint | `src/modules/auth/auth.controller.ts` (`POST /api/auth/change-password`) |
| Bootstrap super_admin | `src/modules/seed/seed.service.ts` (`seedDefaultUser`) |
| JWT signing and validation | `src/modules/auth/jwt.strategy.ts`, `src/modules/auth/auth.module.ts` |
| Role guard | `src/modules/auth/roles.guard.ts`, `src/modules/auth/roles.decorator.ts` |
| Profile-scope middleware | `src/modules/auth/profile-scope.middleware.ts` |
| Current-profile decorator | `src/modules/auth/current-profile.decorator.ts` |
| Audit interceptor and redaction | `src/modules/admin/audit-log/admin-audit-log.interceptor.ts` |
| Audit log entity | `src/modules/admin/audit-log/admin-audit-log.entity.ts` |
| Global validation pipe | `src/main.ts` (`useGlobalPipes(new ValidationPipe(...))`) |
| CORS whitelist | `src/main.ts` (`app.enableCors(...)`) |
| Data retention cleanup cron | `src/modules/ingest/ingest-worker.service.ts` (`cleanup` + `ingest_cleanup` cron) |
| Outbound HTTP client (provider) | `src/modules/data-source/data-source-api.service.ts` |
| Outbound HTTP client (LLM) | `src/libs/promtic/promtic.service.ts` |
| Run-now cooldown enforcement | `src/modules/ingest/ingest-public.controller.ts` (`COOLDOWN_MS`) |
| User account entity | `src/modules/user/user.entity.ts` |
| Profile-access mapping | `src/modules/user/user-profile.entity.ts` |

---

## Appendix B — Glossary

- **Profile** — A monitored political figure or organization. The primary tenancy unit. Each profile has its own ingest schedule, posts, AI cache, and access list.
- **Profile scope** — The constraint that limits a non-super-admin user's data access to the profiles they're explicitly linked to via `user_profiles`.
- **Super admin** — System-wide administrator. Has implicit access to all profiles and all admin endpoints.
- **Client admin** — Tenant administrator. Can edit their profile's configuration and trigger manual ingest runs (with cooldown).
- **Client viewer** — Read-only tenant user.
- **Ingest run** — One execution of the data collection pipeline for a single profile. Identified by a UUID stored in `ingest_runs`.
- **Promtic** — Pishrun's centralized LLM gateway service. Hosts prompt definitions, dispatches to providers (OpenAI, Google, Perplexity), and tracks token usage.
- **8tag** — The licensed Iranian social media data provider used as the sole data source in phase 1.
- **Sentiment classification** — The Promtic-driven labeling of each post as `positive`, `negative`, or `neutral`, plus secondary attributes (`political_spectrum`, `relevance_score`, `bot_probability`).
- **JWT** — JSON Web Token. The bearer credential used for stateless authentication.
- **bcrypt** — A password hashing algorithm with a configurable work factor; used at cost 10 in this platform.

---

*This document is reviewed at least annually and after every security-relevant change to the codebase. Last reviewed: at the close of phase 1.*
