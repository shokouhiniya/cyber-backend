# Deployment Packages

**Sistem Rasad Faza-ye Majazi (Cyberspace Monitoring Platform)**
**Version 1.0** · **Phase 1 Production Release**
**Companion documents:** `SYSTEM_ARCHITECTURE.md`, `DEPLOYMENT_AND_MAINTENANCE.md`

This document is the complete inventory of every package, runtime component, and external service the platform requires in a production deployment.

---

## 1. System-Level Software

These are installed on the host operating system before any application code is deployed.

| Package | Version | Purpose | Source |
|---|---|---|---|
| Linux distribution | Ubuntu 22.04 LTS or Debian 12 | Host OS | apt |
| Node.js | 20.x LTS | Runtime for both backend and frontend | NodeSource (`deb.nodesource.com/setup_20.x`) |
| PostgreSQL | 16.x | Primary database | apt (`postgresql-16`, `postgresql-client-16`) |
| Nginx | latest stable | Reverse proxy, TLS termination | apt |
| Certbot | latest stable | Automated TLS certificate issuance | apt (`certbot`, `python3-certbot-nginx`) |
| Git | latest stable | Source code retrieval and update | apt |
| GnuPG | latest stable | Backup encryption | apt (`gpg`) |
| pm2 | latest stable | Process supervisor | npm (`npm install -g pm2`) |
| Yarn | 1.22.22 | Package manager (frontend) | npm (`npm install -g yarn`) or `corepack enable` |
| OpenSSL | latest stable | JWT secret generation, backup encryption helpers | shipped with OS |
| chrony or systemd-timesyncd | shipped with OS | Time synchronization | apt |

**One-line install on a fresh Ubuntu 22.04 host:**

```bash
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash - && \
sudo apt update && \
sudo apt install -y nodejs postgresql-16 postgresql-client-16 nginx certbot python3-certbot-nginx git gpg && \
sudo npm install -g pm2 yarn
```

---

## 2. Backend Runtime Packages

The backend is a NestJS application. Production dependencies (runtime-required):

| Package | Version | Role |
|---|---|---|
| `@nestjs/common` | ^11.0.1 | Core decorators, modules, exceptions |
| `@nestjs/core` | ^11.0.1 | Application bootstrap, dependency injection |
| `@nestjs/platform-express` | ^11.1.17 | Express HTTP adapter |
| `@nestjs/config` | ^4.0.2 | Environment configuration management |
| `@nestjs/jwt` | ^11.0.0 | JWT signing and verification |
| `@nestjs/passport` | ^11.0.5 | Passport.js integration for authentication |
| `@nestjs/schedule` | ^6.1.3 | Cron decorators for scheduled tasks |
| `@nestjs/typeorm` | ^11.0.0 | TypeORM integration |
| `passport` | ^0.7.0 | Authentication middleware framework |
| `passport-jwt` | ^4.0.1 | JWT strategy for passport |
| `bcrypt` | ^6.0.0 | Password hashing (bcrypt cost 10) |
| `class-validator` | ^0.14.1 | DTO validation via decorators |
| `class-transformer` | ^0.5.1 | DTO serialization helpers |
| `joi` | ^17.13.3 | Configuration schema validation |
| `typeorm` | ^0.3.22 | Object-relational mapping |
| `pg` | ^8.15.6 | PostgreSQL driver |
| `axios` | ^1.15.1 | HTTP client (used by integrations) |
| `multer` | ^2.1.1 | Multipart form parsing (file uploads) |
| `reflect-metadata` | ^0.2.2 | Decorator metadata reflection |
| `rxjs` | ^7.8.1 | Reactive streams (used by NestJS) |

Install command:

```bash
cd cyber-backend
yarn install --frozen-lockfile --production=false  # full install for build
yarn build                                         # produces dist/
```

For a build-only install you can use `yarn install --production` and skip dev dependencies.

### 2.1 Backend development packages (build-time only, not deployed at runtime)

These are needed to build the backend on the deployment host. They can be omitted on the running container if the build is performed elsewhere.

| Package | Version | Role |
|---|---|---|
| `@nestjs/cli` | ^11.0.0 | `nest build` command |
| `@nestjs/schematics` | ^11.0.0 | Module scaffolding |
| `@nestjs/testing` | ^11.0.1 | Jest test utilities |
| `typescript` | ^5.7.3 | TypeScript compiler |
| `ts-loader` | ^9.5.2 | TypeScript loader for the build pipeline |
| `ts-node` | ^10.9.2 | TypeScript runtime (test debug) |
| `tsconfig-paths` | ^4.2.0 | Path-mapping resolution |
| `@swc/cli` | ^0.6.0 | SWC build acceleration |
| `@swc/core` | ^1.10.7 | SWC transpiler |
| `jest` | ^29.7.0 | Test runner |
| `ts-jest` | ^29.2.5 | TypeScript transformer for Jest |
| `supertest` | ^7.0.0 | HTTP assertion library for e2e tests |
| `source-map-support` | ^0.5.21 | Stack trace mapping |
| `eslint` | ^9.18.0 | Code linter |
| `@eslint/js` | ^9.18.0 | ESLint JavaScript config |
| `@eslint/eslintrc` | ^3.2.0 | Legacy config support |
| `typescript-eslint` | ^8.20.0 | TypeScript-aware lint rules |
| `eslint-config-prettier` | ^10.0.1 | Prettier compatibility config |
| `eslint-plugin-prettier` | ^5.2.2 | Prettier-as-lint integration |
| `prettier` | ^3.4.2 | Code formatter |
| `globals` | ^16.0.0 | Standard global identifiers for lint |
| `@types/node` | ^22.10.7 | Node.js type definitions |
| `@types/express` | ^5.0.0 | Express type definitions |
| `@types/bcrypt` | ^6.0.0 | bcrypt type definitions |
| `@types/passport-jwt` | ^4.0.1 | passport-jwt type definitions |
| `@types/multer` | ^2.1.0 | multer type definitions |
| `@types/jest` | ^29.5.14 | Jest type definitions |
| `@types/supertest` | ^6.0.2 | supertest type definitions |

---

## 3. Frontend Runtime Packages

The frontend is a Next.js application. Production dependencies (required for SSR runtime and static asset serving):

### 3.1 Framework core

| Package | Version | Role |
|---|---|---|
| `next` | ^16.2.4 | Application framework, SSR, routing |
| `react` | ^19.2.5 | UI runtime |
| `react-dom` | ^19.2.5 | DOM renderer |

### 3.2 UI components and styling

| Package | Version | Role |
|---|---|---|
| `@mui/material` | ^7.0.1 | Material UI component library |
| `@mui/lab` | ^7.0.0-beta.10 | MUI experimental components |
| `@mui/material-nextjs` | ^7.0.0 | Next.js compatibility layer for MUI |
| `@mui/x-data-grid` | ^7.28.2 | Data grid component |
| `@mui/x-date-pickers` | ^7.28.2 | Date and time pickers |
| `@mui/x-tree-view` | ^7.28.1 | Tree view component |
| `@emotion/react` | ^11.14.0 | CSS-in-JS engine (used by MUI) |
| `@emotion/styled` | ^11.14.0 | Styled components for Emotion |
| `@emotion/cache` | ^11.14.0 | Emotion cache for SSR |
| `stylis` | ^4.3.6 | CSS preprocessor (used by Emotion) |
| `stylis-plugin-rtl` | ^2.1.1 | Right-to-left CSS transformation for Persian |
| `framer-motion` | ^12.6.1 | UI animation library |
| `simplebar-react` | ^3.3.0 | Custom scrollbar component |
| `@iconify/react` | ^5.2.0 | Icon component (Solar, Eva, etc. icon sets) |
| `nprogress` | ^0.2.0 | Top-of-page navigation progress bar |
| `sonner` | ^2.0.3 | Toast notification library |

### 3.3 Fonts

| Package | Version | Role |
|---|---|---|
| `@fontsource-variable/vazirmatn` | ^5.2.5 | Persian font (primary UI font) |
| `@fontsource-variable/inter` | ^5.2.5 | Latin font (alternate) |
| `@fontsource-variable/dm-sans` | ^5.2.5 | Latin font (alternate) |
| `@fontsource-variable/nunito-sans` | ^5.2.5 | Latin font (alternate) |
| `@fontsource-variable/public-sans` | ^5.2.5 | Latin font (alternate) |
| `@fontsource/barlow` | ^5.2.5 | Latin font (display) |

### 3.4 Data fetching, forms, and validation

| Package | Version | Role |
|---|---|---|
| `@tanstack/react-query` | ^5.74.4 | Server-state management and caching |
| `axios` | ^1.8.4 | HTTP client |
| `react-hook-form` | ^7.55.0 | Form state management |
| `@hookform/resolvers` | ^4.1.3 | Form schema integration |
| `zod` | ^3.24.2 | Runtime schema validation |

### 3.5 Localization and date handling

| Package | Version | Role |
|---|---|---|
| `i18next` | ^24.2.3 | Internationalization core |
| `react-i18next` | ^15.4.1 | React bindings for i18next |
| `i18next-browser-languagedetector` | ^8.0.4 | Browser locale detection |
| `i18next-resources-to-backend` | ^1.2.1 | Translation resource loader |
| `dayjs` | ^1.11.13 | Date formatting and arithmetic |
| `jalaliday` | ^2.3.0 | Jalali (Persian) calendar plugin for dayjs |

### 3.6 Reports and exports

| Package | Version | Role |
|---|---|---|
| `jspdf` | ^4.2.1 | PDF generation in the browser |
| `html2canvas` | ^1.4.1 | DOM-to-canvas rasterization for PDF |

### 3.7 Utilities

| Package | Version | Role |
|---|---|---|
| `es-toolkit` | ^1.34.1 | Modern lodash-style utility library |
| `autosuggest-highlight` | ^3.3.4 | Autosuggest match highlighting |
| `minimal-shared` | ^1.0.7 | Shared utilities from the minimal-ui kit |

Install command:

```bash
cd cyber-frontend
yarn install --frozen-lockfile
yarn build
```

### 3.8 Frontend development packages (build-time only)

| Package | Version | Role |
|---|---|---|
| `@svgr/webpack` | ^8.1.0 | SVG-as-component loader |
| `eslint` | ^9.23.0 | Code linter |
| `@eslint/js` | ^9.23.0 | ESLint JavaScript config |
| `eslint-import-resolver-alias` | ^1.1.2 | Path alias resolution for lint |
| `eslint-plugin-import` | ^2.31.0 | Import-statement lint rules |
| `eslint-plugin-perfectionist` | ^4.10.1 | Sort-related lint rules |
| `eslint-plugin-react` | ^7.37.4 | React lint rules |
| `eslint-plugin-react-hooks` | ^5.2.0 | React hooks lint rules |
| `eslint-plugin-unused-imports` | ^4.1.4 | Unused-import detection |
| `prettier` | ^3.5.3 | Code formatter |
| `globals` | ^16.0.0 | Standard global identifiers for lint |

---

## 4. Database Resources

| Resource | Specification |
|---|---|
| Engine | PostgreSQL 16 |
| Encoding | UTF-8 |
| Collation | `en_US.UTF-8` (handles Persian text correctly with this collation) |
| Connection limit | 100 (PostgreSQL default; sufficient for v1) |
| Required extensions | None — `gen_random_uuid()` from PostgreSQL 13+ is built-in |
| Migration scripts | 12 sequential SQL files in `cyber-backend/scripts/` (`init-db.sql` + `002-` through `012-`) |
| Seed scripts | 6 Node.js scripts in `cyber-backend/scripts/seed-*.js` |
| Prompt setup scripts | 5 Node.js scripts in `cyber-backend/scripts/setup-*-prompts.js` |
| Demo dataset | `cyber-backend/scripts/demo-seed.sql` (optional) |

The database connection requires the application to know:

- Host, port, database name
- User and password (a non-superuser dedicated to the application)

Database user privileges: `CONNECT`, `USAGE`, `SELECT`, `INSERT`, `UPDATE`, `DELETE` on the `cyber` schema. No need for `CREATEROLE` or `SUPERUSER`.

---

## 5. External Services (Third-Party Dependencies)

These are not packages installed on the host but are required for the platform to function.

### 5.1 8tag (data provider)

| Item | Detail |
|---|---|
| Endpoint | `https://d1.8tag.ir` |
| Authentication | HTTP basic (username + password) |
| Required env vars | `HASHTAG_USERNAME`, `HASHTAG_PASSWORD` |
| Source platforms supported | Telegram, X (Twitter), Instagram, news outlets, newspapers, broadcast media, Bale, Rubika, Aparat (video platforms), forums, Eitaa |
| Rate limits | Honored via per-source quota in `SampleSelectorService.SOURCE_DEFAULTS` |

### 5.2 Promtic (LLM gateway)

| Item | Detail |
|---|---|
| Endpoint | `https://papi.cyber.pish.run` (production) |
| Authentication | API key (`x-api-key` header) |
| Required env vars | `PROMTIC_BASE_URL`, `PROMTIC_API_KEY` |
| Required prompts | `dashboard_ai_summary`, `macro_context_analysis`, `smart_recommendations`, `narrative_gap_analysis`, `political_spectrum`, `scenario_simulator`, `batch_sentiment`, `macro_politics` |
| Models invoked | GPT-4o (recommendations, scenario), Gemini 2.5 Flash Lite (batch sentiment), Sonar Pro Search (macro politics), and others depending on prompt configuration |
| Setup process | Run `node scripts/setup-all-prompts.js` once on first deployment to create the prompts in the Promtic workspace |

---

## 6. Total Package Count Summary

| Group | Count |
|---|---|
| Backend runtime dependencies | 20 |
| Backend dev (build-time) dependencies | 27 |
| Frontend runtime dependencies | 38 |
| Frontend dev (build-time) dependencies | 11 |
| System-level packages | 11 |
| External services | 2 |
| **Total distinct npm packages** | **96** |
| Total transitive dependencies (after `yarn install`) | ~ 1,200 backend, ~ 1,500 frontend (varies by lock file) |

The transitive count grows with the npm ecosystem; both repositories use lock files (`yarn.lock`) to pin exact versions and ensure reproducible installs.

---

## 7. Upgrade Path Notes

When updating packages, prefer this order:

1. Apply OS security patches (`apt update && apt upgrade`).
2. Update Node.js minor versions within the 20.x line.
3. Update direct dependencies one major version at a time, with full test runs in between.
4. Avoid mixing major upgrades of NestJS, MUI, Next.js, or React in a single deployment.

The current versions are all on actively supported releases as of the v1.0 release of the platform.

---

## 8. Quick-Reference Install Sequence

For a fresh deployment, the complete install command sequence is:

```bash
# 1. System packages
sudo apt update
sudo apt install -y nodejs postgresql-16 postgresql-client-16 nginx certbot \
                    python3-certbot-nginx git gpg
sudo npm install -g pm2 yarn

# 2. Database
sudo -u postgres createuser cyber_app
sudo -u postgres createdb cyber -O cyber_app -E UTF8 \
     --lc-collate='en_US.UTF-8' --lc-ctype='en_US.UTF-8' -T template0

# 3. Backend
cd /opt/cyber/cyber-backend
yarn install --frozen-lockfile
yarn build
for f in scripts/init-db.sql scripts/00*.sql scripts/01*.sql; do
  PGPASSWORD="$DB_PASSWORD" psql -U cyber_app -d cyber -f "$f"
done
node scripts/setup-all-prompts.js

# 4. Frontend
cd /opt/cyber/cyber-frontend
yarn install --frozen-lockfile
yarn build

# 5. Process supervision
cd /opt/cyber
pm2 start ecosystem.config.js
pm2 save
sudo pm2 startup systemd -u cyber --hp /opt/cyber

# 6. Reverse proxy + TLS
sudo cp deploy/nginx/cyber.conf /etc/nginx/sites-available/
sudo ln -s /etc/nginx/sites-available/cyber.conf /etc/nginx/sites-enabled/
sudo nginx -t && sudo systemctl reload nginx
sudo certbot --nginx -d api.example.org -d app.example.org
```

The full procedure with all details is in `DEPLOYMENT_AND_MAINTENANCE.md` § 3.

---

*This document is regenerated whenever `package.json` changes in either repository. Verify against the active lock files before each deployment.*
