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
                         private files, an active job, a consultancy
                         profile, a verification template + JWT token
                         generation + a real tiny PNG (base64 + Buffer) for
                         upload tests
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
    unauthenticated from `/public/:fileName`. Also covers the opt-in lock
    key (`X-File-Lock-Key`, sent only on the mint request): no header
    behaves exactly as before (`locked: false`, plain URL strings); a
    header present returns `{ iv, data }` ciphertext envelopes instead of
    strings; decrypting with the right key (`unlockUrl`) recovers a URL
    that redeems with **no extra header at all**; decrypting with the
    wrong key throws outright; and the raw envelope on its own isn't even
    parseable as a URL, proving a copied mint response is useless without
    the key.
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
  - `consultancyProfile.test.ts` — create (unique slug from name,
    collision disambiguation, one-per-user, invalid specializations
    silently dropped), get/update mine, public profile page by id/slug:
    the URL always resolves (200) but the content is withheld
    (`{ available: false }`, nothing else leaked) while not currently
    subscribed, the full profile is returned once subscribed even if
    unverified, and it goes back to unavailable the moment the
    subscription's `expiresAt` passes with no write needed — the same
    live-check-not-a-stored-boolean pattern `searchConsultants` uses.
    Search coverage: verified AND currently-subscribed only, filterable by
    specialization, and the same expiry-drops-it-out-of-search-live
    behavior, and that granting a subscription updates an existing
    profile's denormalized `currentSubscription` via the sync helper.
    `links` coverage (create and update): a malformed entry (empty label,
    or a url that doesn't start with `http(s)://`) is silently dropped
    rather than failing the request, and more than `MAX_PROFILE_LINKS`
    *valid* links
    is a hard 400 either way. Portfolio coverage: adding an item with real
    media (via `uploadHandler`) and then removing it **actually deletes
    the media files from disk** (a real bug found on review —
    `removePortfolioItem` used to silently orphan them), a missing title
    is rejected, `startedAt`/`completedAt` are accepted as a date range
    and a `completedAt` before `startedAt` is rejected, attaching more
    than `MAX_MEDIA_PER_ITEM` images to one item is rejected, adding an
    item once `MAX_PORTFOLIO_ITEMS` is already reached is rejected, a
    failed upload surfaces as a non-blocking `mediaWarnings` entry rather
    than being silently dropped, appending media to an existing item
    (`POST .../portfolio/:itemId/media`) respects the same per-item cap
    against the item's *existing* media count, an item that belongs to
    someone else's profile 404s rather than being reachable, and removing
    a single media file (`DELETE .../portfolio/:itemId/media/:fileName`)
    deletes just that file from disk and keeps the rest of the item intact.
  - `verification.test.ts` — submission is `multipart/form-data`: every
    non-file field travels as one JSON-stringified `data` field
    (`parseMultipartData`, mirroring HM's `shopItems` pattern — 400 on
    malformed JSON), and files are attached directly on the request (never
    a pre-uploaded `fileName` reference). Unknown `profileType` rejected,
    unknown profile 404s, submitting for someone else's profile 403s, 404s
    when no `VerificationTemplate` is configured yet for that
    profileType/location, `form` (a nested object inside `data`, keyed by
    the template's declared field `key`s) validated against the resolved
    template (missing required field rejected), a required document that's
    never attached at all is
    rejected, an attachment under a field name the template doesn't
    recognize is rejected, a document whose real bytes don't match the
    template's accepted formats is rejected (checked by magic bytes, not
    the claimed filename extension), **a required document's rejection
    deletes every file this same request already saved** (no orphans left
    on disk — verified by reading the submitter's actual private folder),
    an *optional* document's save failure is dropped and reported as a
    non-blocking `documentWarnings` entry instead of failing the whole
    submission, a valid submission is accepted with the real file
    genuinely written to the submitter's private folder and each document
    snapshotting the real `mime`/`size`/`uploadedAt` `uploadHandler`
    reported, state-specific templates are preferred over a country's
    nationwide default (and the nationwide one is a fallback when no
    state-specific override exists), resubmission creates a new record
    rather than overwriting (profile's pointer moves to the latest),
    `GET /me` scoped to my own submissions, admin queue + approve (flips
    the target profile's `isVerified` generically via
    `PROFILE_MODEL_REGISTRY`) + reject (requires a `reason`) +
    already-decided verifications can't be re-reviewed, non-admin blocked
    from all of the above.
  - `verificationTemplate.test.ts` — admin-only create/list (non-admin
    blocked), invalid field shape rejected (Yup), country normalized to
    uppercase, creating a template for a `(profileType, country, state)`
    combination that already has an active one deactivates the old one and
    bumps `version` rather than editing it in place, the `lookup` route
    (any authenticated user, not admin-only — the frontend needs it before
    rendering a verification form) resolves the nationwide default and
    prefers a state-specific override when one exists, 404s when nothing's
    configured for that profileType/location yet.

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
