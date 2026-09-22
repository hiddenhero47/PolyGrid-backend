# PolyGrid Backend — Architecture & Build Plan

Status: **Phase 1 (setup + base User), Phase 1.5 (Plan/Subscription split),
Phase 1.6 (public/private file uploads), Phase 1.7 (Jobs & Contacts),
Phase 1.8 (unified Payment model), and Phase 2 (live Stripe integration)
shipped.** This doc is updated as each phase lands — see the checklist at
the bottom for current state.

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
