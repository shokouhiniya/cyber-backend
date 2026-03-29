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
├── app.module.ts              # Root module
├── libs/                      # زیرساخت (دست نزن مگه لازم باشه)
│   ├── config/                # ConfigModule + configuration.ts
│   ├── database/              # DatabaseModule (TypeORM)
│   ├── interceptors/          # ResponseInterceptor (wrap: { meta, data })
│   └── logger/                # LoggerMiddleware
└── modules/                   # ماژول‌های بیزینس
    ├── auth/                  # JWT auth (sign-in, sign-up, me)
    ├── user/                  # User entity + service
    ├── content/               # Content entity + stats/posts/emotions/influencers/import
    ├── profile/               # Profile entity + service
    └── seed/                  # SeedService (یوزر پیش‌فرض)
```

## قوانین حیاتی

### ماژول‌ها
- هر ماژول توی `src/modules/<name>/` باشه
- entity هر ماژول توی فولدر خودش باشه (نه یه فولدر entities مشترک)
- هر ماژول: `*.module.ts`, `*.service.ts`, `*.controller.ts`, `*.entity.ts`, `*.dto.ts`

### Entity ها
- فیلدها camelCase باشن با `@Column({ name: 'snake_case' })`
- از `@PrimaryGeneratedColumn('uuid')` استفاده کن
- `@CreateDateColumn` و `@UpdateDateColumn` داشته باشن

### Controller ها
- Query params optional هستن (`@Query('limit') limit?: string`)
- برای parse عددی: `limit ? parseInt(limit, 10) : defaultValue` (نه `parseInt(limit)`)
- هرگز `parseInt` مستقیم روی `undefined` نزن

### Response Format
- ResponseInterceptor همه response ها رو wrap می‌کنه: `{ meta: { status, timestamp }, data }`
- Error ها هم wrap میشن: `{ meta, error: { message, statusCode } }`
- فرانت interceptor `response.data.data` رو extract می‌کنه

### Auth
- JWT با passport strategy
- Endpoints: `POST /api/auth/sign-in`, `POST /api/auth/sign-up`, `GET /api/auth/me`
- `GET /api/auth/me` نیاز به `@UseGuards(AuthGuard('jwt'))` داره
- یوزر پیش‌فرض: `admin@cyberspace.ir` / `Admin@123` (SeedService)

### Config
- env variables توی `src/libs/config/configuration.ts` تعریف شدن
- دسترسی: `configService.get('database')`, `configService.get('jwt')`, ...
- env file: `.env` در root

### Database
- TypeORM با `autoLoadEntities: true`
- `synchronize: true` فقط در development
- PostgreSQL

### Content Module
- یه entity (`Content`) با چند controller:
  - `StatsController` → `/api/stats`, `/api/stats/top-posts`, `/api/stats/hashtags`, `/api/stats/sources`, `/api/stats/user-distribution`
  - `PostsController` → `/api/posts` (با query params: limit, offset, emotion, keyword, username)
  - `EmotionsController` → `/api/emotions`
  - `InfluencersController` → `/api/influencers`
  - `ImportController` → `POST /api/import/json` (multipart file upload)

### Import
- فایل JSON با ساختار `{ documents: [...] }` یا آرایه مستقیم
- Batch insert با سایز 500
- `ON CONFLICT DO NOTHING` برای duplicate ها
- Normalize: emotion → UPPERCASE, sentiment → lowercase

### CORS
- فعال برای `localhost:3033` (فرانت) و `localhost:3000`

### Port
- پیش‌فرض: 3000
- Global prefix: `/api`
