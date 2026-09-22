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
  - `contact.test.ts` — connecting mutually (by `userId` or `email`,
    idempotent, no self-connect), listing (paginated, newest first),
    one-directional removal.
  - `job.test.ts` — creation (either party as creator, auto-confirms their
    own side, connects the two as contacts, rejects stage payments summing
    over 100%); confirm (activates once both sides are in, blocks a
    non-party, rejects double-confirm); creator-only pre-confirmation edit
    (blocked once active); view/list access (party or admin only);
    stage propose/accept/reject (only the *other* party can
    accept/reject); the done→verify sequence (provider-only done,
    client-only verify, verify requires done first, releases the correct
    `amountDisposed`/`platformFeeCollected` split, auto-completes the job
    once every stage is verified); contract upload (reuses the private-file
    system — grants the other party, who can mint and use a real signed
    link for it); dispute raise (either party) + `GET /disputes` (admin
    queue, party emails populated, non-admin blocked) + resolve (requires a
    `note`, appended to `disputeHistory`); creator-only pre-confirmation
    cancel (blocked once active); admin-only interim payment recording
    (also covered: it writes a matching `Payment` record — see below).
  - `payment.test.ts` — `GET /api/payments/me` (own history only,
    status-filterable) and `GET /api/payments` (admin-only, filterable by
    `user`/etc.); the uniqueness-index behavior specifically: many manual
    payments with no `providerPaymentId` are all allowed, but two payments
    sharing the same real `providerPaymentId` are rejected — this is the
    regression test for a real bug (see payments-plan.md) where a naive
    `sparse` compound index let a *second* manual payment collide with the
    first, breaking `grantSubscription` on a user's second subscription.
    `POST /api/payments/intent` input validation for both `targetType`s
    (invalid/missing fields, wrong-user-for-target, inactive target) and
    `POST /api/payments/stripe/webhook` signature handling
    (missing/garbled signature, irrelevant event types, unknown payment
    ids) all run with no real Stripe account needed — see "Stripe is
    tested for real" below. A **"Live Stripe round trip"** block funds a
    job's escrow and purchases a subscription end-to-end against a real
    Stripe test-mode account — skipped automatically (not failed) unless
    `STRIPE_SECRET_KEY` in `.env.test` is a real `sk_test_...` key.
  - `subscription.test.ts`'s grant test and `job.test.ts`'s payment-record
    test both also assert the `Payment` record `grantSubscription`/
    `recordPayment` write matches what was recorded.

## Stripe is tested for real — unlike OAuth

**Google/Apple OAuth login** (`POST /api/users/social/{google,apple}`) is
deliberately *not* tested beyond input validation — these verify a real
token against the provider's own servers
(`google-auth-library`/`apple-signin-auth`), and there's no sandbox for
verifying an arbitrary token without a real user actually signing in
somewhere. Mocking those SDKs deeply enough to trust the result would give
low confidence it matches real behavior — the same call house-maduekwe-
backend's own test suite documents for this exact case. `user.test.ts`
covers only that both routes 400 when their token field is missing.

**Stripe is different**, and is tested for real because of it: its test
mode provides exactly the primitives OAuth doesn't —
`stripe.webhooks.generateTestHeaderString()` signs a synthetic webhook
payload entirely offline (no tunnel needed), and test payment methods like
`pm_card_visa` let a PaymentIntent be confirmed to `succeeded` via a single
API call, no browser/redirect involved. `payment.test.ts`'s live block
uses both to genuinely exercise the verification logic that matters
(re-fetching and re-checking the intent from Stripe) against real
Stripe-returned data, not a mock standing in for it. See
[payments-plan.md](../docs/payments-plan.md) for the full breakdown of
what's offline vs. what needs the real key.

## Adding more tests

Use `tests/setup/fixtures.ts` for common setup instead of building documents
by hand — add a new factory there if something's missing. Integration tests
should `beforeAll(connectTestDB)`, `afterEach(clearTestDB)`,
`afterAll(disconnectTestDB)` — copy the top of
`tests/integration/user.test.ts`.
