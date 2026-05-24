---
inclusion: auto
---

# قوانین پروژه بک‌اند (nestjs-starter)

## ساختار کلی

NestJS با TypeORM + PostgreSQL.
ساختار فعلی رو حفظ کن و تغییرش نده.

## ساختار فولدرها

```
src/
├── main.ts                    # Bootstrap, CORS, ValidationPipe, prefix: /api
├── app.module.ts              # Root module + ProfileScopeMiddleware wiring
├── libs/                      # زیرساخت (دست نزن مگه لازم باشه)
│   ├── config/                # ConfigModule + configuration.ts
│   ├── database/              # DatabaseModule (TypeORM)
│   ├── interceptors/          # ResponseInterceptor (wrap: { meta, data })
│   ├── logger/                # LoggerMiddleware
│   └── promtic/               # Promtic LLM client
└── modules/                   # ماژول‌های بیزینس
    ├── auth/                  # JWT auth + RolesGuard + ProfileScopeMiddleware
    ├── user/                  # User entity + UserProfile link entity
    ├── content/               # Content (scoped by profile_id)
    ├── profile/               # Profile entity (= tenant)
    ├── data-source/           # Ingestion sources (scoped by profile_id)
    ├── admin/                 # Admin panel: profiles, users, accessible-profiles
    └── seed/                  # SeedService (default users + profile + backfill)
```

## معماری Multi-Tenant

**پروفایل = تنانت.** هر پروفایل یک کلاینت (مثلاً قالیباف) است. محتوا، منابع داده و تحلیل‌ها همگی به `profile_id` وصل می‌شوند.

### Roles
- `super_admin`: دسترسی به همه پروفایل‌ها، پنل ادمین، ساخت کاربران و پروفایل‌ها.
- `client_admin`: دسترسی به پروفایل(های) لینک‌شده خود.
- `client_viewer`: فقط خواندن پروفایل(های) لینک‌شده.

لینک کاربر ↔ پروفایل در جدول `user_profiles` نگهداری می‌شود. `super_admin` از این جدول استفاده نمی‌کند — دسترسی ضمنی از طریق role دارد.

### Request scoping
- `ProfileScopeMiddleware` روی route های داشبورد (stats, posts, emotions, influencers, ai-content, profile) اعمال شده.
- `req.profileId` از این منابع به ترتیب اولویت ساخته می‌شود:
  1. هدر `X-Profile-Id` (برای view-as توسط super_admin؛ برای بقیه در صورت داشتن دسترسی)
  2. `?profileId=...` در query
  3. تنها پروفایل لینک‌شده به کاربر احراز هویت شده
  4. تنها پروفایل فعال در DB (fallback برای v1)
- Controller ها با دکوراتور `@CurrentProfile()` آن را می‌خوانند.
- Service های content/ai-content همه یک پارامتر `profileId?: string | null` دارند و در صورت وجود، query را محدود می‌کنند.

### Roles guard
- `@Roles('super_admin')` + `@UseGuards(AuthGuard('jwt'), RolesGuard)` برای route های ادمین.
- `RolesGuard` از `src/modules/auth/roles.guard.ts` می‌آید.

## قوانین حیاتی

### ماژول‌ها
- هر ماژول توی `src/modules/<name>/` باشه
- entity هر ماژول توی فولدر خودش باشه
- هر ماژول: `*.module.ts`, `*.service.ts`, `*.controller.ts`, `*.entity.ts`, `*.dto.ts`

### Entity ها
- فیلدها camelCase باشن با `@Column({ name: 'snake_case' })`
- از `@PrimaryGeneratedColumn('uuid')` استفاده کن
- `@CreateDateColumn` و `@UpdateDateColumn` داشته باشن
- هر entity جدید که content یا dashboard data دارد باید `profile_id` بگیرد.

### Controller ها
- Query params optional هستن (`@Query('limit') limit?: string`)
- برای parse عددی: `limit ? parseInt(limit, 10) : defaultValue`
- Controller های داشبورد باید `@CurrentProfile() profileId: string | null` را دریافت و به service پاس دهند.
- Route های ادمین: `@UseGuards(AuthGuard('jwt'), RolesGuard)` + `@Roles('super_admin')`.

### Response Format
- ResponseInterceptor همه response ها رو wrap می‌کنه: `{ meta: { status, timestamp }, data }`
- فرانت interceptor `response.data.data` رو extract می‌کنه

### Auth
- JWT با passport strategy
- Endpoints: `POST /api/auth/sign-in`, `GET /api/auth/me`
- **Sign-up عمومی غیرفعال است.** ساخت کاربر فقط از `POST /api/admin/users` (super_admin).
- `JwtStrategy.validate` علاوه بر user اطلاعات `accessibleProfileIds` را هم برمی‌گرداند.
- یوزر پیش‌فرض:
  - super_admin: `admin@cyberspace.ir` / `Admin@123`
  - client_admin نمونه: `client@cyberspace.ir` / `Client@123`

### Config
- env variables توی `src/libs/config/configuration.ts` تعریف شدن
- دسترسی: `configService.get('database')`, `configService.get('jwt')`, ...

### Database
- TypeORM با `autoLoadEntities: true`, `synchronize: true` فقط در development
- PostgreSQL
- Migration اولیه v1.1 ادمین: `scripts/002-admin-migration.sql` (idempotent)
- Schema کامل برای DB جدید: `scripts/init-db.sql`

### Content Module
- Routes با `@CurrentProfile()` تزریق می‌شوند و در صورت وجود `profile_id` محدود می‌گردند.
  - `StatsController` → `/api/stats`, `/api/stats/top-posts`, `/api/stats/hashtags`, `/api/stats/sources`, `/api/stats/user-distribution`
  - `PostsController` → `/api/posts` (با query params: limit, offset, emotion, keyword, username, since)
  - `EmotionsController` → `/api/emotions`
  - `InfluencersController` → `/api/influencers`
  - `AiContentController` → `/api/ai-content/generate`, `/api/ai-content/generate-all`, `/api/ai-content/prompts`
  - `ImportController` → `POST /api/import/json` (multipart file upload)

### Admin Module
- `/api/admin/profiles` — CRUD پروفایل (فقط super_admin)
- `/api/admin/users` — CRUD کاربر و لینک کاربر↔پروفایل (فقط super_admin)
- `/api/admin/accessible-profiles` — لیست پروفایل‌های قابل دسترس برای هر کاربر احراز شده (برای profile picker در header)
- `/api/admin/data-sources` — CRUD منابع per-profile + `test`, `run-now`, `pages`, `toggle`
- `/api/admin/global-context` — CRUD متغیرهای مشترک؛ هنگام هر Promtic invoke به صورت `global_<key>` در input_vars تزریق می‌شوند.
- `/api/admin/audit-log` — خواندن لاگ ادمین. نوشتن به صورت خودکار از طریق `AdminAuditLogInterceptor` روی route های `/admin/*` که mutation هستند انجام می‌شود (credential ها redact می‌شوند).
- `/api/admin/usage/*` — گزارش‌های مصرف (summary, profiles-ranking, features-ranking, daily). نوشتن از `POST /api/usage/events` انجام می‌شود.

### Import
- فایل JSON با ساختار `{ documents: [...] }` یا آرایه مستقیم
- Batch insert با سایز 500
- `ON CONFLICT DO NOTHING` برای duplicate ها
- **TODO:** attach به `profile_id` هنگام import بر اساس keyword matching یا پارامتر API.

### CORS
- فعال برای `localhost:3033` (فرانت) و `localhost:3000`

### Port
- پیش‌فرض: 3000
- Global prefix: `/api`
