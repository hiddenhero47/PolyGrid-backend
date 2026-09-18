# Tests

Jest + ts-jest + Supertest.

## Running

```
npm test                 # everything
npm run test:unit        # pure logic, no DB, fast
npm run test:integration # real HTTP requests against a real MongoDB
```

No setup required to just run `npm test` — if `TEST_MONGO_URI` isn't set,
the integration tests automatically spin up a disposable in-memory replica
set (`mongodb-memory-server`) and tear it down afterwards. First run
downloads a MongoDB binary (cached after that), so it's slower once.

To point at your own test database instead (recommended for CI, or to match
your real cluster's version/config exactly):

1. `cp .env.test.example .env.test`
2. Fill in `TEST_MONGO_URI`. Use a dedicated database — integration tests
   wipe every collection between tests.
3. `npm test`

`.env.test` is gitignored.

## Layout

```
tests/
  setup/
    env.ts             loads .env.test (falls back to .env)
    db.ts               connect/disconnect/clear the test DB
    globalSetup.ts      starts the in-memory replica set (once, whole run)
    globalTeardown.ts   stops it
    fixtures.ts         factories: users (basic/admin/super admin), plans,
                         subscriptions (incl. a user with an active one) +
                         JWT token generation
  unit/          pure functions/methods/middleware, no HTTP, DB used only
                 where the thing under test needs a real document
  integration/   real HTTP requests via supertest against src/app.ts
```

`src/app.ts` is the Express app builder, split out of `src/server.ts` so
tests can get an app instance without connecting to the real DB or calling
`.listen()`.

## What's covered

- **Unit** (`tests/unit/subscription.test.ts`): `Subscription.isActive()`
  status/expiry logic, and the `attachCurrentPlan`/`requireActiveSubscription`
  middleware called directly (allows/blocks based on subscription state).
- **Integration**:
  - `user.test.ts` — register/login, `GET /me`, profile update including
    password change + session invalidation (the old token must stop
    working), the persona toggle (`PATCH /account-type`), logout-everywhere,
    the full password-reset round trip, admin user management (create
    admin, list/paginate, change role, Super-Admin-can't-modify-self guard).
  - `plan.test.ts` — listing (active-only by default), get-by-id, Super
    Admin create/update, duplicate-`planTier` rejection, non-admin blocked.
  - `subscription.test.ts` — granting a subscription (Admin/Super Admin
    only) creates a history record and repoints `user.currentSubscription`;
    granting again keeps the old record (history preserved) and moves the
    pointer; unknown/inactive plan tier rejected; self/admin history
    listing; `GET /current` returns the active plan or `null`.

## Adding more tests

Use `tests/setup/fixtures.ts` for common setup instead of building documents
by hand — add a new factory there if something's missing. Integration tests
should `beforeAll(connectTestDB)`, `afterEach(clearTestDB)`,
`afterAll(disconnectTestDB)` — copy the top of
`tests/integration/user.test.ts`.
