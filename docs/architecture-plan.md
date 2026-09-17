# PolyGrid Backend — Architecture & Build Plan

Status: **Phase 1 (setup + base User) shipped.** This doc is updated as each
phase lands — see the checklist at the bottom for current state.

Structure and conventions are deliberately carried over from
[house-maduekwe-backend](https://github.com/hiddenhero47/house-maduekwe-backend)
(same author, same house style), translated to TypeScript:

| Decision | Choice | Why |
|---|---|---|
| Language | TypeScript, strict mode | Project is expected to grow into 4 large domains (Engineering, Tenders, Store, SiteForce) sharing one User model — types catch cross-module breakage that plain JS wouldn't. |
| Module system | CommonJS output (`tsc`), not ESM | Matches house-maduekwe-backend's Jest/require setup; avoids the `--experimental-vm-modules` ESM-interop tax that project pays for one ESM-only dependency. |
| HTTP framework | Express 5 | Same as house-maduekwe-backend. |
| DB | MongoDB via Mongoose, replica set | Needed for multi-document transactions once Tenders/Store checkout-style flows exist (mirrors house-maduekwe-backend's order/checkout use of `mongoose.startSession()`). |
| Tests | Jest + ts-jest + Supertest + mongodb-memory-server | Same layout/tooling as house-maduekwe-backend: `tests/setup` (env/db/fixtures/global setup+teardown), `tests/unit`, `tests/integration`. Auto-provisions a disposable in-memory replica set when `TEST_MONGO_URI` isn't set. |
| Auth | JWT + server-side `sessionId` rotation | A user document carries `sessionId`; every issued JWT embeds it. Rotating `sessionId` (password change, "log out everywhere") invalidates every previously issued token without a token blocklist. Copied verbatim from house-maduekwe-backend's `userModel`/`authMiddleware`. |
| Single Super Admin | Enforced in `userModel`'s `pre('save')` hook | Same guard as house-maduekwe-backend: at most one `super_admin` document can exist, and `admin`/`super_admin` can only be created via a trusted internal `_adminCreation` flag, never through public registration. |

## What already exists (Phase 1)

- Project scaffold: `tsconfig.json` (+ `tsconfig.build.json` for a
  tests-excluded production build), `jest.config.js`, `.env.example`,
  `.env.test.example`.
- `src/app.ts` / `src/server.ts` — app builder split from the listener (same
  split as house-maduekwe-backend, so tests can get an app instance via
  supertest without a real DB connection or `.listen()`).
- `src/config/db.ts` — Mongoose connection.
- `src/middleware/{corsMiddleware,errorMiddleware,authMiddleware}.ts`.
- `src/models/userModel.ts` — the base `User` document described in
  [product-overview.md](product-overview.md): `fullName`, `email`,
  `password`, `phone`, `systemRole`, `activeAccountType`, the embedded
  `subscription` block, `sessionId`, `tokenCache` (password-reset tokens).
- `src/controllers/userController.ts` + `src/routes/userRoutes.ts`:
  - Auth: register, login, `GET /me`, profile update (incl. password change
    + session invalidation), logout-everywhere.
  - Persona toggle: `PATCH /api/users/account-type` (explicit target or a
    blind flip).
  - Password reset: request + reset, token-cache based (same shape as
    house-maduekwe-backend; email delivery not wired up yet — see below).
  - Admin: create admin, list/filter/paginate users, change a user's
    `systemRole`.
  - `PATCH /api/users/:id/subscription` — an **interim admin tool** for
    granting/adjusting the one global subscription until a payment provider
    exists (see Phase 2).
- `requireActiveSubscription` middleware (`authMiddleware.ts`) — the global
  subscription gate described in product-overview.md. Not yet wired to any
  route, because no business-pillar route exists yet; it's ready for Phase 3+.
- Full test coverage for all of the above:
  `tests/integration/user.test.ts`, `tests/unit/subscription.test.ts`.

**Deliberately not built yet** (would be speculative without a concrete
consumer): transactional email delivery for password reset (currently
returns the token directly in non-production responses instead), OAuth
login, 2FA — house-maduekwe-backend has these but PolyGrid's brief didn't
ask for them yet. Add if/when actually needed.

## Phasing (forward-looking)

```
Phase 1  Project setup + base User (auth, persona toggle, subscription field)   <- done
Phase 2  Payment provider integration -> subscription lifecycle via webhook
         (replaces the manual PATCH /api/users/:id/subscription admin tool)
Phase 3  First pillar's business profile schema + verification pipeline
         (pick one of Engineering/Tenders/Store/SiteForce to prove the pattern)
Phase 4  Remaining three pillars' business profiles, following the same shape
Phase 5  Cross-pillar aggregation queries (active + verified + subscribed)
         and geo-spatial queries (Store physical goods, SiteForce jobs)
```

Each pillar's profile schema, controllers, and routes should get their own
plan doc in this folder before code is written (same habit as
house-maduekwe-backend's `docs/shipping-provider-architecture-plan.md`) —
`EngineeringProfile` first is a reasonable default unless product priority
says otherwise.
