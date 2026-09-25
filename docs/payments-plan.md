# Payments

Status: **shipped, including live Stripe integration** — the model, the
manual-tool wiring, and real PaymentIntent creation + webhook processing
for both jobs and subscriptions. This is also the one third-party
integration in this codebase that's genuinely tested end-to-end against a
real (test-mode) account, not just input-validated — see "Testing this
against real Stripe" below for why that's different from OAuth.

Ported from house-maduekwe-backend's `paymentModel.js`/`paymentProviderModel.js`,
generalized: HM's `Payment` always references one `Order` (single-purpose
e-commerce checkout). PolyGrid needs one `Payment` model that can be *for*
either a `Job` (funding escrow) or a `Subscription` (buying/renewing a
plan) — and, later, whatever else needs paying for.

## `Payment` — polymorphic by design

```
targetType: 'Job' | 'Subscription'
targetId:   ObjectId, refPath: targetType   <- resolves to the right collection automatically
user, userEmail (snapshotted)
amount, currency
provider:    'stripe' | 'manual'
providerPaymentId?   (e.g. a Stripe PaymentIntent id — absent for 'manual')
providerFeeAmount    (the gateway's *actual* reported cut, 0 for manual)
status:      'pending' | 'success' | 'failed' | 'refunded' | 'cancelled'
rawProviderPayload?  (snapshot of the gateway event, for audit only)
recordedBy?          (which admin, when provider === 'manual')
```

`targetId`'s `refPath: targetType` is Mongoose's standard polymorphic-
reference mechanism — `.populate('targetId')` resolves to a `Job` or a
`Subscription` document automatically based on the sibling `targetType`
field, no second near-identical model needed. Add a case to
`PAYMENT_TARGET_TYPE` (and to the `refPath` target) if a third kind of
purchase — a Store order, say — needs payments later.

### The uniqueness index bug, and why it mattered

`Payment` needs to guarantee the same gateway transaction is never recorded
twice — a duplicate/replayed webhook shouldn't create two `Payment` rows.
The first version of this used:

```ts
paymentSchema.index({ provider: 1, providerPaymentId: 1 }, { unique: true, sparse: true });
```

This looks right and isn't — verified by actually running it, not just by
reading the docs. `sparse` on a *compound* index only excludes a document
when **every** indexed field is missing. `provider` is always set (`stripe`
or `manual`), so a manual entry — which never sets `providerPaymentId` at
all — still gets indexed with it as `null`. A **second** manual entry then
collides with the first on `{ provider: 'manual', providerPaymentId: null }`
and throws `E11000`. This broke `grantSubscription` on a user's *second*
subscription (the second `Payment.create()` call failed), caught by the
existing subscription test suite once `Payment` was wired in.

Fixed with a partial index instead, which excludes a document by field
*existence*, independent of what else is indexed:

```ts
paymentSchema.index(
  { provider: 1, providerPaymentId: 1 },
  { unique: true, partialFilterExpression: { providerPaymentId: { $exists: true } } },
);
```

`tests/integration/payment.test.ts`'s "Payment uniqueness" block covers
both directions: many manual entries with no `providerPaymentId` are fine;
two entries sharing a real one are rejected.

## `PaymentProvider` — catalog, not yet consulted

Same shape as HM's: `provider` (unique), `percentageFee`, `flatFee`,
`isActive`. Exists so a provider's fee structure isn't hardcoded and a new
provider can be added without a schema change — mirrors `Plan` being
catalog data for `Subscription`. Nothing reads from it yet; once live
Stripe integration exists, its `percentageFee`/`flatFee` would be
config/estimate, while a `Payment`'s own `providerFeeAmount` stays the
*actual* reported cut for that one transaction (same "estimate vs. ground
truth" split HM makes with `PaymentProvider.percentageFee` vs.
`Payment.transactionFee`).

## Wired into the existing manual tools

Both interim admin tools now also write a `Payment` record, so there's one
unified ledger across jobs and subscriptions even before any real gateway
exists:

- `subscriptionController.grantSubscription` — `targetType: 'Subscription'`,
  `amount: plan.price`, `provider: 'manual'`, `recordedBy: <admin>`.
- `jobController.recordPayment` — `targetType: 'Job'`, `provider: 'manual'`,
  `recordedBy: <admin>`.

Read access: `GET /api/payments/me` (protect — my own history) and
`GET /api/payments` (admin — everyone's, filterable by `status`/
`targetType`/`targetId`/`user`/`provider`).

## Live Stripe integration

- `src/config/stripe.ts` — `getStripeClient()`, **lazily constructed and
  memoized**, not a top-level `new Stripe(...)`. The SDK throws immediately
  if the key is missing, and this module is pulled in transitively by
  `app.ts` (via `paymentController.ts`) — constructing eagerly meant the
  *entire app*, every route, failed to boot the moment `STRIPE_SECRET_KEY`
  was unset. Caught by the existing test suite the moment this file was
  added: every other test file failed too, not just payment ones. Only
  code that actually calls Stripe pays the cost of needing a real key, and
  only when it runs — the app (and, in production, its non-payment routes)
  stays up even if Stripe isn't configured yet.
- `src/providers/paymentProviders/` — a small adapter interface
  (`createIntent`, `retrieveIntent`, `constructWebhookEvent`) with a
  `stripeProvider.ts` implementation. `'manual'` payments don't go through
  this at all (still a direct `Payment.create()` in the controller); this
  exists so a second real gateway later is a new file implementing the
  same shape, not a rewrite — mirrors house-maduekwe-backend's dispatch-by-
  provider pattern for shipping/webhooks.
- `POST /api/payments/intent` — body `{ targetType: 'Job'|'Subscription',
  ... }`, branches:
  - **Job**: `{ targetId, amount }`. Requester must be that job's client;
    job must be `active`. Creates a `Payment` (`pending`), a Stripe
    PaymentIntent with `metadata: { paymentId }`, returns `clientSecret`.
  - **Subscription**: `{ planTier, autoRenew? }`. No existing `Subscription`
    to attach to yet (see "the subscription-purchase gap" below) — creates
    one in `SUBSCRIPTION_STATUS.PENDING` first, then the `Payment` and
    Stripe intent same as the job path.
- `POST /api/payments/stripe/webhook` — raw-body-scoped (registered before
  `express.json()` in `app.ts`, same ordering HM uses for exactly this
  reason: Stripe's signature is computed over the exact raw bytes). Verifies
  the signature, acks Stripe with `200` immediately (its own async work
  continues after — see the `errorMiddleware.headersSent` note below), then
  on `payment_intent.succeeded`: **re-fetches the intent from Stripe**
  (never trusts the webhook payload's own claims about amount/status/
  currency, same as HM), checks it actually matches the `Payment` it claims
  to be for, and only then marks it `success` and activates the target —
  `job.amountPaid` bumped for a Job, or the pending `Subscription` flipped
  to `active` (with `periodStarted`/`expiresAt` computed fresh at this
  point, not at checkout time — the clock starts when payment actually
  clears) and `user.currentSubscription` repointed at it.
- `errorMiddleware.errorHandler` now checks `res.headersSent` before
  writing a response. Needed because the webhook handler responds `200`
  immediately and keeps working — a later throw in that async work can't
  send a second response; Express's own docs recommend exactly this
  `res.headersSent` check, delegating to Express's built-in final handler
  instead. General-purpose fix, not payments-specific, but this is the
  first handler in the codebase to actually need it.

### The subscription-purchase gap — resolved

Job funding always has an existing `Job` to attach a `Payment` to; a *new*
subscription purchase doesn't, since `grantSubscription` is what used to
*create* the `Subscription`, and that only happened after payment. Went
with adding `SUBSCRIPTION_STATUS.PENDING` (over the alternative of keying
the payment off `Plan` and correlating a newly-created `Subscription`
afterward by `user`+timestamp) — a pending subscription is a real,
queryable state ("who started checkout and never finished"), not just
payments plumbing, and it keeps a `Payment`'s `targetId` a direct
reference in both branches rather than only one of them.

### Testing this against real Stripe — why it's different from OAuth

Google/Apple OAuth login is deliberately *not* tested beyond input
validation (see `tests/README.md`) — there's no sandbox for verifying an
arbitrary id/identity token without a real user actually signing in
somewhere. Stripe's test mode doesn't have that problem, so
`tests/integration/payment.test.ts` goes further:

- **Signature verification** (`POST /api/payments/stripe/webhook`'s
  no-signature/garbled-signature/irrelevant-event/unknown-payment cases) is
  tested fully offline — `stripe.webhooks.generateTestHeaderString()`
  signs a synthetic payload with the same `STRIPE_WEBHOOK_SECRET` the app
  verifies against, no network call and no real Stripe account needed at
  all. `STRIPE_SECRET_KEY` still has to be *some* non-empty string for the
  SDK to construct (`.env.test` defaults it to a placeholder) even for
  these — but that string is never actually sent anywhere for a pure
  signature check.
- **The full round trip** (`"Live Stripe round trip"`, skipped unless
  `STRIPE_SECRET_KEY` is a real `sk_test_...` key) creates a real
  PaymentIntent through `POST /api/payments/intent`, confirms it server-side
  with Stripe's `pm_card_visa` test payment method (`confirm: true`, no
  browser/redirect needed — succeeds synchronously), then POSTs a
  *fabricated* webhook notification (Stripe itself never delivered one; no
  tunnel needed) naming that intent's real id. The part that actually
  matters for correctness — the handler re-fetching and re-verifying the
  intent — hits genuinely real, genuinely-succeeded Stripe data, so this is
  a real test of the verification logic, not a mock standing in for it.

Both caught something real the first time they ran against an actual test
account, not hypothetically:

- **`createIntent` needed `automatic_payment_methods.allow_redirects: 'never'`.**
  Without it, Stripe rejects confirmation with "you must provide a
  `return_url`" — some automatic payment method types redirect the customer
  off-site and back, and Stripe won't let a PaymentIntent confirm without
  knowing where to send them back to. There's no frontend built yet to own
  that return leg, so this restricts intents to methods (card) that confirm
  without leaving the page. A real gap in the actual `createIntent` code,
  not a test-only workaround — revisit together with whatever eventually
  confirms these client-side, if redirect-based methods are ever needed.
- **The test itself had a race** the first time it asserted on the DB right
  after the webhook responded. The handler acks Stripe with `200` *before*
  finishing its DB writes (deliberately — see above), and supertest's
  request resolves the instant that response is sent, not when the
  handler's background work finishes. Fixed by polling for the *final*
  state the background chain produces (`user.currentSubscription`
  repointed, not just the `Subscription`'s own status flip, which happens
  earlier in the same chain and so isn't itself race-free to poll on
  either) instead of asserting immediately. Worth remembering for any
  future test against a handler that acks-then-works.
- **The exact same class of bug turned up again later**, in the job-funding
  round trip specifically: it polled `Payment.status === 'success'`, but
  the handler saves that *before* its subsequent `Job.updateOne(...
  amountPaid ...)` — so the poller could resolve while the job's own update
  was still in flight, and the very next assertion (`Job.amountPaid`) would
  occasionally read a stale value. It went unnoticed for a while because it
  only failed under enough system load to widen that window. Fixed the same
  way: poll the actual field being asserted (`Job.amountPaid === 250`), not
  an earlier write in the same chain. The lesson from the first bullet
  generalizes: for any handler that keeps writing after its response is
  sent, a test must poll the *last* relevant write, not merely *a* write
  that happens to run before it.
