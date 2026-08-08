# Agrawal Cycles — Backend API

Enterprise, API-first e-commerce backend built with **NestJS 11 · Prisma · PostgreSQL · Redis · JWT (access + refresh) · Argon2 · RBAC · Swagger**.

Designed to power the customer website, the admin panel, and a future mobile app from one versioned REST API (`/api/v1`).

## Quick start

```bash
cp .env.example .env          # fill in secrets
docker compose up -d db redis # start Postgres + Redis
npm install
npm run prisma:generate
npm run prisma:migrate        # create the schema
npm run seed                  # roles, permissions, admin, catalog
npm run start:dev
```

- API:      `http://localhost:4000/api/v1`
- Swagger:  `http://localhost:4000/api/docs`
- Health:   `GET /api/v1/health`

Or run the whole stack (api + db + redis) with `docker compose up --build`.

## Architecture

Feature-based modules under `src/`, each self-contained (controller · service · DTOs · validation):

```
src/
  common/        response envelope, global exception filter, pagination
  config/ prisma/ redis/   infrastructure
  auth/          register · login · refresh (rotating) · logout · me
                 argon2 hashing, JWT access+refresh, JwtAuthGuard + RbacGuard
  users/ products/ categories/ health/   feature modules
```

Cross-cutting behaviour is global: `ValidationPipe` (whitelist + transform), `AllExceptionsFilter`,
`ResponseInterceptor` (consistent `{ success, data, timestamp }`), `helmet`, CORS, URI versioning,
and `ThrottlerGuard` rate limiting.

### Security

- **Argon2** password hashing.
- **JWT** short-lived access tokens + **rotating refresh tokens** (hashed at rest, revocable, with device/IP metadata).
- **RBAC** — roles → permissions. Protect routes with `@RequirePermissions("products:edit")` or `@Roles("manager")`. Public routes opt out with `@Public()`.
- Helmet, CORS allow-list, rate limiting, `class-validator` input validation, Prisma parameterised queries (SQL-injection safe).

## Database

The full normalized schema lives in `prisma/schema.prisma` — 40+ models covering users/RBAC,
catalog (categories tree, brands, products, variants, attributes, tags, relations), inventory &
warehouses, cart & wishlist, orders/items/events, payments/refunds/invoices, shipments, coupons,
reviews, blog, FAQ, media, banners, settings, notifications, and activity/audit logs. Indexed on
the hot query paths (status, category, brand, price, slugs, foreign keys).

## Implemented endpoints (v1)

| Module | Endpoints |
| --- | --- |
| Auth | `POST /auth/register` · `POST /auth/login` · `POST /auth/refresh` · `POST /auth/logout` · `GET /auth/me` |
| Products | `GET /products` (search/filter/sort/paginate) · `GET /products/:id` · `GET /products/slug/:slug` · `POST/PATCH/DELETE` (RBAC) |
| Categories | `GET /categories` · `GET /categories/tree` · `GET /categories/slug/:slug` · `POST/PATCH/DELETE` (RBAC) |
| Users | `GET /users` (RBAC, paginated) |
| Health | `GET /health` (db + redis probes) |

## Roadmap (same module pattern)

Cart · Wishlist · Orders · Payments (Razorpay/Stripe/COD + webhooks) · Shipping (modular
providers: Shiprocket/Delhivery/BlueDart/DTDC) · Reviews · Coupons · Media (S3/R2 upload) ·
Notifications · Blogs · SEO · Settings · Analytics · Reports (PDF/CSV). Each adds a
`*.module.ts / *.service.ts / *.controller.ts / dto.ts` under `src/<feature>/` and registers in `app.module.ts`.

## Environment

See `.env.example` for all variables (database, redis, JWT secrets/TTLs, S3/R2, Razorpay/Stripe, SMTP/Resend).
