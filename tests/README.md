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
    fixtures.ts         factories: users (basic/admin/super admin/
                         customer care), plans, subscriptions (incl. a
                         user with an active one), private files, an
                         active job, a contact connection, a consultancy
                         profile, a verification template, a store
                         profile, a product, a digital creator profile, a
                         digital product, a digital purchase, a
                         contractor profile, a tender project, a bid, a
                         review + JWT token generation + a real tiny PNG
                         (base64 + Buffer) for upload tests
  unit/          pure functions/methods/middleware, no HTTP, DB used only
                 where the thing under test needs a real document
  integration/   real HTTP requests via supertest against src/app.ts
```

`src/app.ts` is the Express app builder, split out of `src/server.ts` so
tests can get an app instance without connecting to the real DB or calling
`.listen()`.

## What's covered

`customer_care` read-only-queue access is covered inline, once per queue
it applies to, rather than its own file: `job.test.ts` (can view
`/disputes`, blocked from `/dispute/resolve`), `verification.test.ts`
(can view the queue, blocked from `/approve`), `conversation.test.ts`
(can view `/api/messages/reports`) — plus `user.test.ts` covering the
role promotion itself.

- **Unit**:
  - `subscription.test.ts` — `Subscription.isActive()` status/expiry logic,
    and the `attachCurrentPlan`/`requireActiveSubscription` middleware
    called directly (allows/blocks based on subscription state).
  - `fileSignature.test.ts` — magic-byte detection for each supported type
    (JPEG/PNG/WEBP/PDF) plus rejection of unrecognized/truncated content.
  - `countryReference.test.ts` — real ISO country/state codes accepted,
    made-up ones rejected, a state check against a country with no states
    listed in the dataset accepts anything (found dynamically, not
    hardcoded), `getDefaultCurrencyForCountry`/`getCitiesOfState` return
    real data.
  - `currencyReference.test.ts` — real ISO 4217 codes accepted, a made-up
    one rejected, decimal digits are correct for a normal currency (2) and
    a zero-decimal one (JPY, 0).
- **Integration**:
  - `user.test.ts` — register/login, `GET /me`, profile update including
    password change + session invalidation (the old token must stop
    working), the persona toggle (`PATCH /account-type`), logout-everywhere,
    the full password-reset round trip (also asserts the mocked
    `sendTemplatedEmail` was called with the `forgotPassword` template and
    the user's real email, and — for an unknown email — that it's never
    called at all, on top of the response's own no-account-revealed
    shape), admin user management (create admin, list/paginate, change
    role, Super-Admin-can't-modify-self guard), and `phoneNumber.country`
    rejecting a made-up 2-letter code that isn't a real ISO country (the
    field used to only check the shape — 2 letters — not that it meant
    anything). Mocks `src/helpers/emailSender.ts` at the top of the file
    (see "Email is mocked, never really sent" below) — no real Mailgun
    call is ever made.
  - `plan.test.ts` — listing (active-only by default), get-by-id, Super
    Admin create/update, duplicate-`planTier` rejection, non-admin blocked,
    and a made-up `currency` rejected as a clean `400` — `planController`
    has no manual pre-check for this, so it's what actually exercises the
    `mongoose.Error.ValidationError` → 400 conversion in
    `errorMiddleware.ts` (see reference-data-plan.md).
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
  - `conversation.test.ts` — starting a conversation requires an existing
    Contact connection (403 otherwise, 404 for an unknown user, 400 for
    yourself); starting one twice (from either side) returns the same
    conversation rather than creating a duplicate; sending requires a
    non-empty body and updates the conversation's `lastMessageAt`/
    `lastMessagePreview`; a non-participant 404s the same conversation id
    (never 403 — so a guessed id can't confirm a conversation exists
    between two other people); unread count is per-recipient (my own sent
    messages never count against me) and clears via
    `PATCH /:id/read`; reporting a message requires a `reason`, is blocked
    for a non-participant, and an admin-only `GET /api/messages/reports`
    lists it without deleting the underlying message.
  - `chatSocket.test.ts` — a real `http.Server` + `initSocket` +
    `socket.io-client`, scoped to only what the socket layer itself can
    prove (everything else is REST, covered above): connecting with no
    token or a garbled one is rejected; sending a message over REST
    delivers a live `message:new` event to the recipient's socket
    specifically, not the sender's own connection.
  - `job.test.ts` — creation (either party as creator, auto-confirms their
    own side, connects the two as contacts, rejects stage payments summing
    over 100%, rejects a made-up `currency` as a clean `400`); confirm
    (activates once both sides are in, blocks a
    non-party, rejects double-confirm); creator-only pre-confirmation edit
    (blocked once active; changing `totalAmount` records
    `{previousAmount, changedBy}` on `amountHistory`, an unchanged value
    doesn't); view/list access (party or admin only);
    stage propose/accept/reject (only the *other* party can
    accept/reject); the done→verify sequence (provider-only done,
    client-only verify, verify requires done first, releases the correct
    `amountDisbursed`/`platformFeeCollected` split, auto-completes the job
    once every stage is verified); contract upload (reuses the private-file
    system — grants the other party, who can mint and use a real signed
    link for it); dispute raise (either party) + `GET /disputes` (admin
    queue, party emails populated, non-admin blocked) + resolve (requires a
    `note`, appended to `disputeHistory`); creator-only pre-confirmation
    cancel (blocked once active); admin-only interim payment recording
    (also covered: it writes a matching `Payment` record — see below);
    `GET /:id/payments` (admin and customer_care can both list every
    `Payment` recorded against the job, everyone else blocked, 404 for an
    unknown job); refund requests (`POST /:id/refund-requests`,
    client-only — blocks the provider and a stranger; requires a positive
    `amount` and a `reason`; rejects a request that would exceed
    `amountPaid`; blocks a second pending request while one is already
    pending; **doesn't touch `totalRefunded` or `status` until approved**)
    + `GET /refund-requests` (admin/customer_care queue, everyone else
    blocked) + approve (`PATCH .../approve`, admin-only, moves
    `totalRefunded`, closes the job on the first approval, and a
    **second, corrective request approved on an already-closed job
    appends without re-closing it or moving `closedAt`**, and emails the
    client via the mocked `sendTemplatedEmail`) + decline
    (`PATCH .../decline`, admin-only, requires a `declineReason`, leaves
    the job's balance/status untouched, and emails the client the
    decline reason); payout requests
    (`POST /:id/payout-requests`, provider-only — blocks the client;
    `amount` optional; blocked when nothing's available, while disputed,
    cancelled, or closed, or while a request is already pending) +
    `GET /payout-requests` (admin/customer_care queue, includes a freshly
    recomputed `available` per job) + approve (`PATCH .../approve`,
    admin-only, resolves the final amount — admin's override, else the
    request's, else everything available — moves `amountPaidOut`, rejects
    exceeding what's currently available, never changes job status, all
    verified across multiple stage-verify calls, emails the provider) +
    decline (same `declineReason` requirement, leaves `amountPaidOut`
    untouched, emails the provider — asserted to fall back to the string
    `"the full available amount"` when the original request never
    specified a concrete number). Mocks `src/helpers/emailSender.ts` at
    the top of the file (see "Email is mocked, never really sent" below).
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
    silently dropped, a made-up `country` rejected as a clean `400`),
    get/update mine, public profile page by id/slug:
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
  - `reference.test.ts` — `GET /api/reference/{countries,
    countries/:code/states, countries/:code/cities, currencies}` are all
    public (no auth) and return real data (Nigeria is in the country
    list with its real currency, Lagos is a real Nigerian state, JPY
    really has 0 decimal digits); an unknown country code 404s on the
    states/cities routes; cities can be scoped to a state via `?state=`.
  - `storeProfile.test.ts` — create (requires at least one valid
    category), one-per-user; the category-removal cascade delete
    (removing a category from `PATCH /me` deletes every product under
    it **and their image files from disk**, keeps products under
    categories that weren't removed), rejecting removing every category
    down to zero; the store page (`GET /:idOrSlug`) withholds content
    unless currently subscribed and drops back to unavailable the moment
    a subscription expires — same live-check pattern as
    `consultancyProfile.test.ts`; search (verified + currently-subscribed
    only, filterable by category, **each result includes a preview of
    matching products** via the aggregation sub-pipeline); logo upload
    replaces (and deletes) the previous one.
  - `product.test.ts` — creating a product with a category the store
    didn't declare it sells is rejected; a valid create snapshots real
    image metadata (magic-byte-detected mime, not a client guess);
    attaching more than `MAX_PRODUCT_IMAGES` is rejected; updating/
    deleting a product that belongs to someone else's store 404s (even
    when the caller has their own, different store); deleting a product
    deletes its image files too; the add/remove single-image sub-
    resource routes; `shippingLocations` requires at least one entry, a
    made-up country or an out-of-country state (e.g. a US state for a
    Nigerian shipping entry) is rejected, and a state-specific entry can
    coexist with a nationwide default for the same product;
    `GET /api/products/:id` — the one place a product needs a live
    subscription check on its own behalf — withholds the product unless
    its *owning store* is currently subscribed, and drops back to
    unavailable the moment that store's subscription expires.
  - `storeOrder.test.ts` — placing an order 404s for a store that isn't
    currently subscribed (same as it being unreachable through search/the
    store page), blocks ordering from your own store, requires a
    shipping destination, rejects a product that doesn't belong to the
    given store, a destination none of the order's products ship to, and
    a quantity under 1; a state-specific shipping price is resolved over
    a product's nationwide default when both exist; a valid order
    snapshots `titleSnapshot`/`unitPriceSnapshot` plus the products/
    shipping split (`itemsTotalSnapshot`/`shippingTotalSnapshot`/
    `totalSnapshot`), **spins up a real `Job`** with the shop owner as
    `createdBy` and the already-confirmed provider and the buyer as the
    not-yet-confirmed client (`jobType: 'store'`, `totalAmount` matching
    the order), and **connects buyer and store owner as Contacts**
    (verified via a real `Contact` document); the shop owner can adjust
    that Job's price pre-confirmation via the existing creator-only
    `PATCH /api/jobs/:id` (recorded in `amountHistory`) and the buyer
    still confirms afterward to activate it; `GET /mine` (buyer) and
    `GET /store` (owner, populated with the buyer's name/email) each
    scope correctly, and `/store` 404s for a caller with no store
    profile.
  - `digitalCreatorProfile.test.ts` — create (one-per-user); update mine;
    avatar upload/replace; the creator page (`GET /:idOrSlug`) withholds
    products unless currently subscribed and drops back to unavailable
    the moment the subscription expires, same live-check pattern as
    `storeProfile.test.ts`; 404s for an unknown slug.
  - `digitalProduct.test.ts` — creating a product distinguishes
    `previewImages` (public) from `files` (private deliverables) **by
    multipart field name**, not multer config; rejects an invalid
    category or zero deliverable files; rejects more than
    `MAX_PREVIEW_IMAGES` preview images; updating/deleting a product that
    belongs to someone else's profile 404s; the `isActive` toggle with no
    hard-delete endpoint anywhere; preview-images add/remove sub-resource;
    the deliverable-files sub-resource is **append-only, no remove route**
    (verified by checking the download link's file count grows);
    `GET /api/digital-products/feed` — **the centerpiece two-hop
    `$lookup`** (`DigitalProduct` -> `DigitalCreatorProfile` ->
    `Subscription`) — excludes an unsubscribed *or* unverified creator's
    products, includes a verified+subscribed creator's active products
    with the creator's info attached, filters by category, and drops out
    of the feed live the instant a subscription expires, no write needed;
    `GET /api/digital-products/:id` withholds a product unless its
    creator is verified+subscribed; `GET /.../:id/download` blocks a
    stranger and a buyer whose purchase is still pending, allows the
    product's own creator, and — the key guarantee —**a successful
    buyer's download access survives the creator's subscription later
    lapsing and the product going inactive**.
  - `payment.test.ts` also covers `targetType: "DigitalPurchase"` —
    requires a valid `targetId`; 404s for an unknown/inactive/unverified/
    unsubscribed product; blocks a creator buying their own product;
    blocks a duplicate purchase whether the existing one is pending or
    already successful; the live-Stripe round trip (skipped without a
    real key) flips a `DigitalPurchase` to `success` via the webhook and
    confirms the download link works immediately afterward.
  - `contractorProfile.test.ts` — create (unique slug, filters invalid
    `specialties`, one-per-user, `MAX_PROFILE_LINKS`); update mine; the
    contractor page withholds content unless currently subscribed and
    drops back to unavailable the moment the subscription expires; search
    (verified + subscribed only, filterable by `specialty`); the
    portfolio sub-resource (shared schema with `consultancyProfileModel.ts`'s
    own portfolio — media upload/delete round-trips to disk the same way).
  - `tenderProject.test.ts` — posting requires an active subscription
    (`402` — `requireActiveSubscription`'s first real exercise), rejects
    a past `bidDeadline` or an invalid `category`; the bidding board
    (`GET /`) 403s a non-eligible browser (no contractor profile, or
    unverified/unsubscribed), filters by category, excludes a project
    past its own deadline; `GET /:id` withholds full detail from a
    non-eligible viewer and shows it to the poster/an eligible
    contractor; **sealed bidding** — submitting blocks a non-eligible
    contractor and a self-bid, increments `bidCount`, blocks a second
    bid from the same contractor, and — the core guarantee — a competing
    contractor's `GET /:id/bids` 404s (poster-only) while the poster's
    own call sees every bid; revising/withdrawing my own bid
    (withdrawal decrements `bidCount`); awarding accepts the chosen bid,
    rejects every other pending bid, and spins up a real `Job`
    (`jobType: 'tenders'`, poster as confirmed client, contractor as
    unconfirmed provider); cancelling an open project rejects its
    pending bids too; `GET /me` and `GET /bids/mine` each scope to the
    caller correctly.
  - `review.test.ts` — requires a valid `sourceType`/`sourceId`/rating;
    Job-sourced: blocks reviewing a job that isn't completed, blocks
    anyone but the job's own client, resolves the target profile from
    the job's provider (not a client-supplied id), updates the running
    `ratingAverage`/`ratingCount` correctly across multiple reviews, and
    blocks a second review of the same job; DigitalPurchase-sourced:
    resolves the target directly from `purchase.creator` (no lookup),
    blocks anyone but the buyer; `GET /api/reviews` lists a profile's
    reviews newest-first and validates `profileType`/`profileId`.

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

## Email is mocked, never really sent

Unlike Stripe, there's no equivalent offline test-mode for Mailgun that
would let a real send be verified without actually delivering mail
somewhere — so every test file that exercises a controller calling
`sendTemplatedEmail` (`user.test.ts`, `job.test.ts`) mocks
`src/helpers/emailSender.ts` entirely at the top of the file, identical to
how house-maduekwe-backend's own test suite mocks its equivalent module:

```ts
jest.mock("../../src/helpers/emailSender", () => ({
  sendTemplatedEmail: jest.fn().mockResolvedValue({}),
  loadTemplates: jest.fn().mockResolvedValue(undefined),
}));
```

Both files also `jest.clearAllMocks()` in `afterEach`, alongside
`clearTestDB()`, so a call asserted in one test never leaks into the
next. What gets asserted is the *call* — recipient, template name, and the
relevant variables — not that mail actually arrived anywhere, the same
boundary the rest of this file draws around every other third-party
integration that has no safe way to test for real. See
[email-plan.md](../docs/email-plan.md).

## Adding more tests

Use `tests/setup/fixtures.ts` for common setup instead of building documents
by hand — add a new factory there if something's missing. Integration tests
should `beforeAll(connectTestDB)`, `afterEach(clearTestDB)`,
`afterAll(disconnectTestDB)` — copy the top of
`tests/integration/user.test.ts`.
