# PolyGrid Backend — Architecture & Build Plan

Status: **Phase 1 (setup + base User), Phase 1.5 (Plan/Subscription split),
Phase 1.6 (public/private file uploads), Phase 1.7 (Jobs & Contacts),
Phase 1.8 (unified Payment model), Phase 2 (live Stripe integration),
Phase 3 (ConsultancyProfile + generic Verification pipeline), Phase 3.1
(Yup request validation + template-driven Verification), Phase 3.2
(country/state/city/currency reference data), and Phase 3.3 (1:1 chat over
Socket.IO) shipped.** This doc is updated as each phase lands — see the
checklist at the bottom for current state.

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
  `password`, `phoneNumber` (`{number, country}`), `avatar` (set via the
  file-upload helper — see below), `authProviders`
  (`{provider: local|google|apple, providerId}[]`), `verified`, `user2fa`
  (schema only, no otplib/qrcode wiring yet), `systemRole`,
  `activeAccountType`, `sessionId`, `tokenCache` (password-reset tokens),
  and `currentSubscription` — a pointer at this user's latest
  `Subscription`, not an embedded value.
- `src/controllers/userController.ts` + `src/routes/userRoutes.ts`:
  - Auth: register, login, `GET /me`, profile update (incl. password change
    + session invalidation), logout-everywhere.
  - OAuth: `POST /api/users/social/{google,apple}` — verifies the provider's
    id/identity token (`google-auth-library`/`apple-signin-auth`), finds or
    creates the user (email first, falling back to `authProviders.providerId`
    for Apple's later-login-omits-email case), links the provider if this is
    the account's first login with it, 409s if that provider account is
    already linked to a *different* user. A new Google user's avatar is
    pulled from their Google profile picture via the same `uploadHandler` as
    everything else (never fails the login if that fetch fails). Not covered
    by automated tests beyond input validation — see
    [tests/README.md](../tests/README.md) for why, same reasoning
    house-maduekwe-backend's own test suite documents for this exact case.
  - Persona toggle: `PATCH /api/users/account-type` (explicit target or a
    blind flip).
  - Password reset: request + reset, token-cache based (same shape as
    house-maduekwe-backend; email delivery not wired up yet — see below).
  - Admin: create admin, list/filter/paginate users, change a user's
    `systemRole`.
- `src/models/planModel.ts` (`Plan`, catalog data) + `src/models/subscriptionModel.ts`
  (`Subscription`, history) — split out from `User` so every subscription a
  user has ever had stays a permanent, queryable record instead of being
  overwritten in place:
  - `Plan`: `planTier` (unique), `name`, `privileges: string[]`, `duration`
    (days), `maxUsers` (seat cap, `null` = unlimited — stored for a future
    team/org feature, not enforced anywhere yet), `price`, `currency`,
    `isActive`. Never deleted, only deactivated (`isActive: false`) —
    historical `Subscription`s reference a `Plan` by id.
  - `Subscription`: `user` (ref), `plan` (ref), plus a **snapshot** of
    `planTier`/`privileges` taken from the `Plan` at creation time (so a
    past subscription reads correctly even if the `Plan` is edited later),
    `status`, `autoRenew`, `paymentProviderId`, `paymentId`,
    `periodStarted`, `expiresAt`. `isActive()` instance method: `status ===
    'active' && expiresAt > now`.
  - `src/controllers/planController.ts` + `routes/planRoutes.ts` —
    `GET /api/plans` (public, active-only by default), `GET /api/plans/:id`
    (public), `POST`/`PUT` (Super Admin only).
  - `src/controllers/subscriptionController.ts` + `routes/subscriptionRoutes.ts`:
    - `POST /api/subscriptions` — **interim admin tool** (Admin/Super Admin)
      that grants a user a subscription to a plan by tier: creates the
      `Subscription` record and repoints `user.currentSubscription` at it.
      Still around for admin comps/manual grants even now that a real
      Stripe purchase path exists (`POST /api/payments/intent`, see below)
      — the two aren't mutually exclusive.
    - `GET /api/subscriptions/me` / `GET /api/subscriptions/users/:userId` —
      paginated history, self or admin-on-anyone.
    - `GET /api/subscriptions/current` — the caller's current plan (or
      `null`), via `attachCurrentPlan`.
- `authMiddleware.ts` — `attachCurrentPlan` (populates `req.currentPlan`
  from `user.currentSubscription`, non-blocking) and `requireActiveSubscription`
  (same lookup, then 402s if there's no active plan; the gate for
  business-pillar routes once they exist — see Phase 3+). `req.currentPlan`
  is the `Subscription` document itself, not the `Plan`.
- Public/private file uploads — a reusable helper other controllers call
  directly, not a standalone CRUD resource, and access is decided once
  (upstream) rather than on every read. Full design/rationale (the
  never-throws helper contract, the signed-URL model and why it's
  app-key-only with no sessionId, why `file-type` isn't used) is in
  [file-uploads-plan.md](file-uploads-plan.md):
  - `src/helpers/{fileSignature,fileStorage,fileSigning}.ts` — magic-byte
    validation, disk I/O (`uploadHandler`, never throws; private files are
    written to `PRIVATE_DIR/<ownerId>/<fileName>`), and
    `signFileUrl`/`verifyFileUrlToken` — short-lived (10 min), app-key-signed
    (`FILE_SIGNING_SECRET`, separate from `JWT_SECRET`) URLs scoped to one
    exact `{ownerId, fileName, mode}`.
  - `src/models/fileGrantModel.ts` (`FileGrant`) — bookkeeping only
    (`ownerId`, `fileName`, `allowedUsers`), written **only** when an
    upload names extra `allowedUserIds`. An owner-only private file costs
    zero DB writes and zero DB reads to view.
  - `src/controllers/fileController.ts` + `routes/fileRoutes.ts`:
    - `POST /api/files/private` — the one upload-only route (400s on
      failure, correctly, since uploading *is* its whole job); response
      includes signed `requestUrl`/`downloadUrl` for the file just uploaded.
    - `GET /api/files/private/:ownerId/:fileName/link` — the generic
      "check access, mint links" endpoint (owner/admin cost zero extra
      queries off `req.user`; only an explicit-share check reads
      `FileGrant`). A domain with its own access rules (e.g. a future KYC
      feature) skips this and calls `signFileUrl()` directly after its own
      check.
    - `GET /private/view|download/:ownerId/:fileName?token=...`, mounted
      directly in `app.ts` — **no** `protect`, **no** DB read: the signed
      token itself is the authorization, verified via
      `res.sendFile`/`res.download` with `root` locked to that owner's
      folder (closes a path-traversal gap an earlier manual
      `fs.createReadStream` version had). This is what lets a signed URL go
      straight into `<img src>`/`<video src>`.
    - `GET /public/:fileName` is a plain `express.static` mount, no route
      of its own.
  - `User.avatar` is the first real caller: `updateUserProfile` uploads
    (always public) and silently no-ops (a soft `avatarWarnings`, not a
    failed request) if nothing valid was attached — a bad avatar must never
    fail the rest of a profile update.
- Jobs & Contacts — subscription-free trust/tracking tool, not tied to any
  one pillar. Full design (the always-one-stage simplification, the
  confirm/lock/propose-to-change workflow, the escrow ledger, what's
  deliberately simplified for v1) is in
  [jobs-and-contacts-plan.md](jobs-and-contacts-plan.md):
  - `src/models/contactModel.ts` (`Contact`) — one doc per user,
    `list: [{user, email, connectedAt}]`. Connecting is mutual
    (`contactController.connectUsers`), which `jobController.createJob`
    calls too — creating a job with someone connects you the same way
    adding them as a contact directly does.
  - `src/models/jobModel.ts` (`Job`) — `client`/`provider` (each
    `{userId, isConfirmed, contractFile?}`), `stages` (always at least
    one — a no-stages job gets one implicit 100%-payment stage, so there's
    only one completion code path), `proposedStages` (a pending revision
    once active — the *other* party must accept), `oldStages` (history,
    never overwritten), `totalAmount`/`amountPaid`/`amountDisposed`/
    `platformFeeCollected`/`platformFeePercent` (snapshotted at creation),
    `status`, dispute/cancel fields.
  - `src/controllers/jobController.ts` + `routes/jobRoutes.ts` — create,
    confirm, creator-only pre-confirmation edit, stage propose/accept/
    reject, provider-only mark-done, client-only verify (the only thing
    that releases escrow — see the plan doc for the fee math), contract
    upload (reuses `uploadHandler` exactly as `User.avatar` does, private,
    grants the other party via `FileGrant`), dispute raise (either party)
    + `GET /api/jobs/disputes` (admin queue, party emails populated) +
    admin-resolve (requires a `note`, appended to `disputeHistory` — a job
    can be disputed more than once; resolution correspondence itself
    happens by email, deliberately not an in-app chat, see the plan doc),
    creator-only pre-confirmation cancel, admin-only interim
    `POST /:id/payments` (writes to the job ledger *and* a `Payment`
    record — see below).
- Payments — one unified, polymorphic ledger across jobs and subscriptions,
  now including live Stripe integration. Full design (the real uniqueness-
  index bug the test suite caught, the lazy-Stripe-client boot-crash bug,
  the subscription-purchase design gap and how it was resolved, why this is
  the one third-party integration actually tested end-to-end) is in
  [payments-plan.md](payments-plan.md):
  - `src/models/paymentModel.ts` (`Payment`) — `targetType: 'Job' |
    'Subscription'` + `targetId` (Mongoose `refPath` polymorphic
    reference), `amount`/`currency`/`provider`/`providerPaymentId?`/
    `providerFeeAmount`/`status`/`recordedBy?`.
  - `src/models/paymentProviderModel.ts` (`PaymentProvider`) — catalog
    data (fee structure per provider), same shape as `Plan`; not consulted
    by anything yet.
  - `SUBSCRIPTION_STATUS.PENDING` (`subscriptionModel.ts`) — a subscription
    now exists in this state from the moment Stripe checkout starts, before
    payment succeeds; never becomes `user.currentSubscription` until it
    does.
  - `src/config/stripe.ts` — lazily-constructed client (see payments-plan.md
    for why eager construction broke app boot entirely without a key).
  - `src/providers/paymentProviders/` — the Stripe adapter, behind a small
    interface a second provider could implement later.
  - Wired into both existing manual/interim tools —
    `subscriptionController.grantSubscription` and
    `jobController.recordPayment` both also write a `Payment` record
    (`provider: 'manual'`) — so there's one real ledger regardless of how a
    payment was actually collected.
  - `src/controllers/paymentController.ts` + `routes/paymentRoutes.ts` —
    `GET /api/payments/me`, `GET /api/payments` (admin, filterable),
    `POST /api/payments/intent` (real Stripe PaymentIntent, Job or
    Subscription), `POST /api/payments/stripe/webhook` (raw-body-scoped in
    `app.ts`, no `protect` — authenticated by Stripe's signature instead).
  - `errorMiddleware.errorHandler` — now checks `res.headersSent` before
    writing (needed once the webhook handler started acking early and
    continuing async work after).
- Full test coverage for all of the above (Stripe's live round trip
  included — see payments-plan.md for why that's different from OAuth's
  input-validation-only coverage):
  `tests/integration/{user,plan,subscription,fileAccess,contact,job,payment}.test.ts`,
  `tests/unit/{subscription,fileSignature}.test.ts`.
- ConsultancyProfile + Verification — PolyGrid Engineering (the first
  pillar business profile), and the reusable pattern the remaining three
  pillars follow. Full design (why booking reuses Jobs instead of a new
  engine, the denormalized-but-still-live-checked `currentSubscription`,
  the polymorphic reusable `Verification` model) is in
  [consultancy-profile-plan.md](consultancy-profile-plan.md):
  - `src/models/consultancyProfileModel.ts` (`ConsultancyProfile`) —
    `userId` (unique), `currentSubscription` (denormalized, synced),
    `isVerified` + `verification` (pointer to the latest `Verification`),
    `slug` (unique), `headline`, `bio`, `specializations[]`, `country`,
    `city`, `yearsOfExperience`, `links[]` (public external links only —
    deliberately no raw contact details, see consultancy-profile-plan.md),
    `portfolio[]` (each item capped at `MAX_MEDIA_PER_ITEM` media, with a
    `startedAt`/`completedAt` date range), `services[]`, `mentorship` —
    `portfolio`/`links` both capped array-wide too
    (`MAX_PORTFOLIO_ITEMS`/`MAX_PROFILE_LINKS`).
  - `src/models/verificationModel.ts` (`Verification`) — polymorphic
    `profileType`/`profileId` (`refPath`, same pattern as `Payment`), so
    it's reusable by every future pillar profile with no pillar-specific
    code; never overwritten, every (re)submission is a new record.
  - `src/constants/profileTypes.ts` — `PROFILE_MODEL_REGISTRY`, the single
    source of truth mapping a profile-type string to its Mongoose model.
    Add each new pillar profile here.
  - `src/helpers/profileSubscriptionSync.ts` — fans a `User.currentSubscription`
    change out to every profile that user owns across every registered
    pillar; called from `subscriptionController.grantSubscription` and the
    Stripe webhook's subscription-activation branch, the only two places
    that value ever changes.
  - `src/controllers/consultancyProfileController.ts` +
    `routes/consultancyProfileRoutes.ts` — create/get-mine/update-mine,
    public search (verified AND currently-subscribed, checked live via
    aggregation, not from the denormalized boolean), public profile page
    by id or slug (the URL always resolves, but content is withheld —
    `{ available: false }` — unless currently subscribed, checked live the
    same way; verification status doesn't gate this, only subscription
    does), portfolio item/media add/remove (public images via
    `uploadHandler`, capped at `MAX_PORTFOLIO_ITEMS`/`MAX_MEDIA_PER_ITEM`
    — see "Corrections" below for the media-management fix).
  - `src/controllers/verificationController.ts` +
    `routes/verificationRoutes.ts` — submit (ownership-checked, resolves
    the applicable `VerificationTemplate`, validates `form`/`documents`
    against it), my submissions, admin queue, admin approve/reject
    (approve generically flips `isVerified` on whichever profile model the
    registry resolves).
  - `tests/integration/{consultancyProfile,verification}.test.ts`.
- Request validation with Yup, and template-driven `Verification` — a
  first-layer validation convention (new to this codebase) plus a redesign
  of what "verify a profile" requires, since it can't be hardcoded per
  country on a platform that isn't Nigeria-only. Full design (why the
  first `Verification` schema didn't generalize, the `VerificationTemplate`
  catalog-data pattern, the Yup `stripUnknown` footgun hit and fixed) is in
  [verification-templates-plan.md](verification-templates-plan.md):
  - `src/models/verificationTemplateModel.ts` (`VerificationTemplate`) —
    one document per `(profileType, country[, state])`: `fields[]` (the
    form — key/label/type/required/constraints) and `documents[]` (required
    file types + accepted formats). Never edited in place — creating a new
    one for the same combination deactivates the old and bumps `version`,
    same "Plan is never edited, only superseded" instinct, via a
    `partialFilterExpression: { isActive: true }` unique index (same
    pattern as `Payment`'s uniqueness fix).
  - `src/helpers/verificationTemplateLookup.ts` — resolves the active
    template for a profileType/location, state-specific first then
    falling back to the country's nationwide default (`state: null`).
  - `src/validators/{validate,templateFormSchema,verificationValidator,verificationTemplateValidator}.ts` —
    `validateBody(schema)` Express middleware; `buildFormSchema(fields)`
    builds a Yup object schema from a template's field definitions at
    request time (the same definitions the frontend fetches to render the
    form and build its own matching Yup schema from).
  - `src/helpers/sanitize.ts` (`pickDefinedFields`) — the habit going
    forward for turning request data into a document update: keep only
    accepted keys, drop `undefined`/`""` (no value provided), leave `null`
    alone unless a field opts in to being explicitly resettable.
  - `verificationModel.ts` now stores `location`/`templateId`/`form`
    instead of the old hardcoded `country`/`regulatoryBody`/`discipline`/
    `registrationNumber`/`additionalInfo`.
  - `src/controllers/verificationTemplateController.ts` +
    `routes/verificationTemplateRoutes.ts` — admin create/list, plus
    `GET /lookup` (any authenticated user) for the frontend to fetch the
    form definition before rendering it.
  - `tests/integration/verificationTemplate.test.ts`.
- Corrections to the above, made once reviewed: Verification's documents
  were being pre-uploaded via a separate route and only referenced
  afterward, which let a user accumulate private files with nothing ever
  attached to them (`Job.uploadContract` already avoided this — it uploads
  inline); the file-link "lock key" needed to gate *redemption* rather than
  just encrypt what's handed back, which put the key back in play on every
  fetch instead of only once; and `ConsultancyProfile.portfolio`'s media
  had no real deletion path or any limits at all. Full design in
  [verification-templates-plan.md](verification-templates-plan.md)'s
  "Submission flow" section,
  [file-uploads-plan.md](file-uploads-plan.md)'s "Lock keys" section, and
  [consultancy-profile-plan.md](consultancy-profile-plan.md)'s "Portfolio
  media management" section:
  - `POST /api/verifications` is now `multipart/form-data` — files are
    attached directly on the submission itself, one per document type,
    under a field name equal to that document's declared `type` (so a
    template's `documents[]` doubles as the exact set of expected field
    names). Every non-file field (`profileType`/`profileId`/`country`/
    `state`/`form`) travels bundled as one JSON-stringified `data` field —
    `src/helpers/parseMultipartData.ts` unpacks it, mirroring
    house-maduekwe-backend's `shopItemHelper.parseMultipartData`
    (`shopItems`' own create/update routes use the identical
    structured-fields-plus-real-files shape). `resolveAndSaveDocuments`
    (`verificationController.ts`) saves each file individually through
    `uploadHandler`, scoped to that document's own `acceptedFormats`; a
    required document's failure rejects the whole submission and **rolls
    back every file this same request already saved**, so a rejected
    submission never leaves anything orphaned on disk; an optional
    document's failure is dropped and surfaced as a non-blocking
    `documentWarnings` entry instead (same contract as `avatarWarnings`).
  - `src/helpers/fileLinkLock.ts` (`lockUrl`/`unlockUrl`) — replaced the
    first pass at a "lock key" (which hashed the key into the JWT and
    required resending it as a header on every redemption). Now
    `getPrivateFileLink` AES-256-GCM-encrypts the resulting
    `requestUrl`/`downloadUrl` themselves when a caller sends
    `X-File-Lock-Key` on the *mint* request; the frontend decrypts locally
    (Web Crypto, key derived the same way server-side does — SHA-256 of
    the lock key) and then uses the recovered plain URL exactly like an
    unlocked one. `verifyFileUrlToken` (redemption) is completely
    unmodified by this — it never sees or needs the lock key at all.
  - `IPortfolioMedia` now genuinely carries `storagePath`/`mime`/`size`
    (its own comment claimed it matched `IAvatar`'s shape already; it
    didn't) — without `storagePath`, `removePortfolioItem` couldn't
    actually delete a removed item's files, so every deletion silently
    orphaned them. Fixed, plus a new `removePortfolioMedia` for removing
    one file without deleting the whole item, plus a new
    `addPortfolioMedia` for appending to an existing item later, plus hard
    caps (`MAX_PORTFOLIO_ITEMS`, `MAX_MEDIA_PER_ITEM`) enforced both in the
    controller and as a Mongoose array `validate`.
- Reference data — every `country`/`state`/`currency` field across the app
  (`ConsultancyProfile`, `VerificationTemplate`, `Verification.location`,
  `Job`, `Payment`, `Plan`, `User.phoneNumber`) was previously just an
  uppercased free string with no check against reality. Full design
  (library choice, validation strictness per field type, the real
  Mongoose-`ValidationError`-was-a-500 bug this surfaced and fixed) is in
  [reference-data-plan.md](reference-data-plan.md):
  - `src/helpers/countryReference.ts` / `currencyReference.ts` — the only
    files that import `country-state-city`/`currency-codes`; everything
    else validates through these. Country and currency are hard-validated
    everywhere (complete, unambiguous ISO lists); state is validated only
    when the country has states listed in this dataset; city is
    deliberately never hard-validated (coverage is too uneven) but still
    has a lookup route for a frontend autocomplete.
  - `src/controllers/referenceController.ts` +
    `routes/referenceRoutes.ts` (`GET /api/reference/{countries,
    countries/:code/states, countries/:code/cities, currencies}`) —
    public, no auth, pure in-memory lookups, the same data every
    validator checks against.
  - `errorMiddleware.ts`'s `errorHandler` now converts a raw
    `mongoose.Error.ValidationError` into a clean `400` — previously it
    had no `statusCode` of its own and fell through to the generic 500
    branch, meaning *every* schema validation failure across the whole
    app (not just these new checks) surfaced as a server error instead of
    a client-input one.
- 1:1 chat between connected users, deliberately minimal (no group chat,
  no presence/typing indicators, no moderation dashboard) — scoped that
  way on purpose after weighing build-vs-third-party (Stream/Sendbird)
  earlier. Full design in [chat-plan.md](chat-plan.md):
  - `src/models/conversationModel.ts` (`Conversation`) — keyed by the
    unordered pair of participants (`sortParticipants`), one conversation
    per pair reused across every Job/contact context, found via an atomic
    `findOneAndUpdate(upsert: true)`. `lastReadAt` is a two-entry
    `Map<userId, Date>`, not per-message read state.
  - `src/models/messageModel.ts` / `messageReportModel.ts` — plain text
    messages (no attachments/editing), and a deliberately minimal
    admin-visible report record (no moderation workflow) for the one case
    PolyGrid does need to know about a chat: something genuinely reported.
  - `src/socket/index.ts` (`initSocket`, `emitToUser`) — the *only* file
    that imports `socket.io`. Authenticates a connecting socket through
    `getAuthenticatedUser` (exported from `authMiddleware.ts` for exactly
    this reuse), joins room `user:<id>`. Has no business logic of its
    own: **sending a message is a normal REST call**
    (`POST /api/conversations/:id/messages`, validated/persisted exactly
    like every other write in this app), and the controller calls
    `emitToUser` once afterward as a best-effort live push — the socket
    layer never receives or validates a chat event from the client.
  - `src/controllers/conversationController.ts` +
    `routes/{conversation,message}Routes.ts` — starting a conversation
    requires the two users to already be Contacts (chat isn't an open DM
    to a stranger); a conversation looked up by id that isn't mine 404s
    (never 403), so a guessed/foreign id can't confirm a conversation
    exists between two other people.
  - `src/server.ts` now builds an explicit `http.Server` (`initSocket`
    needs the raw server, not just the Express app) instead of calling
    `app.listen()` directly.
  - `tests/integration/chatSocket.test.ts` — a real `http.Server` +
    `socket.io-client`, narrowly scoped to what only the socket layer can
    prove (auth rejects a missing/garbled token; a REST-sent message
    delivers live to the recipient's room specifically, not the sender's).

**Deliberately not built yet** (would be speculative without a concrete
consumer): transactional email delivery for password reset (currently
returns the token directly in non-production responses instead), 2FA —
house-maduekwe-backend has these but PolyGrid's brief didn't ask for them
yet. Add if/when actually needed.

## Phasing (forward-looking)

```
Phase 1    Project setup + base User (auth, persona toggle)                    <- done
Phase 1.5  Plan/Subscription split out of User, history-tracked               <- done
Phase 1.6  Public/private file uploads                                        <- done
Phase 1.7  Jobs & Contacts (subscription-free trust/tracking tool)            <- done
Phase 1.8  Unified Payment model (Job + Subscription, polymorphic)            <- done
Phase 2    Live Stripe integration — POST /api/payments/intent + webhook,   <- done
           both Job funding and Subscription purchase. The manual admin
           tools (POST /api/subscriptions, POST /api/jobs/:id/payments)
           stay — comps/manual grants aren't going away, they're just no
           longer the only path.
Phase 3    ConsultancyProfile (PolyGrid Engineering) + generic Verification <- done
           pipeline — proves the pattern: polymorphic Verification,
           PROFILE_MODEL_REGISTRY, denormalized-but-live-checked
           currentSubscription, Jobs reused for booking instead of a new
           engine.
Phase 3.1  Yup request-validation convention + VerificationTemplate        <- done
           catalog data — what a profile needs to verify is now
           data-driven per profileType+location, not hardcoded per
           country.
Phase 3.2  country/state/city/currency reference data, applied to every   <- done
           existing free-text field of that kind app-wide + a public
           GET /api/reference/* lookup API + fixed a latent bug where
           every Mongoose ValidationError surfaced as a 500.
Phase 3.3  1:1 chat over Socket.IO — deliberately minimal (no group      <- done
           chat, no moderation dashboard); REST does all the writes,
           the socket only pushes; gated on an existing Contact
           connection, not an open DM to a stranger.
Phase 4  Remaining three pillars' business profiles (Contractor/Tenders,
         Store, Labor/SiteForce), following consultancy-profile-plan.md's
         shape and registering in PROFILE_MODEL_REGISTRY
Phase 5  Cross-pillar aggregation queries (active + verified + subscribed)
         and geo-spatial queries (Store physical goods, SiteForce jobs)
```

Each pillar's profile schema, controllers, and routes should get their own
plan doc in this folder before code is written (same habit as
house-maduekwe-backend's `docs/shipping-provider-architecture-plan.md`) —
`consultancy-profile-plan.md` is now that template for the remaining
three.
