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
                         subscriptions (incl. a user with an active one),
                         private files + JWT token generation + a real tiny
                         PNG (base64 + Buffer) for upload tests
  unit/          pure functions/methods/middleware, no HTTP, DB used only
                 where the thing under test needs a real document
  integration/   real HTTP requests via supertest against src/app.ts
```

`src/app.ts` is the Express app builder, split out of `src/server.ts` so
tests can get an app instance without connecting to the real DB or calling
`.listen()`.

## What's covered

- **Unit**:
  - `subscription.test.ts` — `Subscription.isActive()` status/expiry logic,
    and the `attachCurrentPlan`/`requireActiveSubscription` middleware
    called directly (allows/blocks based on subscription state).
  - `fileSignature.test.ts` — magic-byte detection for each supported type
    (JPEG/PNG/WEBP/PDF) plus rejection of unrecognized/truncated content.
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
  - `fileAccess.test.ts` — `POST /api/files/private` (real PNG bytes; fails
    the whole request on an invalid file, since uploading is its only job;
    writes a `FileGrant` only when `allowedUserIds` names real users, none
    at all when no one's shared with; response's signed `requestUrl`/
    `downloadUrl` both work immediately); `GET /api/files/private/:ownerId/:fileName/link`
    mints links for the owner/admin/an explicitly granted user and 403s a
    stranger; the signed `/private/view|download/:ownerId/:fileName` routes
    need no `Authorization` header at all (the token is the credential),
    reject no-token/garbled/expired tokens and a token replayed against the
    wrong mode or a different file, and always set
    `Cache-Control: no-store`; a publicly-uploaded avatar is fetchable
    unauthenticated from `/public/:fileName`.
  - `user.test.ts` also covers avatar-specific behavior: uploading one via
    `PUT /profile`, that an invalid attached file surfaces as a soft
    `avatarWarnings` array **without** failing the rest of the update, and
    that replacing an avatar deletes the old file from disk.

## Adding more tests

Use `tests/setup/fixtures.ts` for common setup instead of building documents
by hand — add a new factory there if something's missing. Integration tests
should `beforeAll(connectTestDB)`, `afterEach(clearTestDB)`,
`afterAll(disconnectTestDB)` — copy the top of
`tests/integration/user.test.ts`.
