# Transactional Email

Status: **shipped** (infrastructure + two callers — password reset,
refund/payout request decisions). Mirrors house-maduekwe-backend's own
`server-src/helpers/emailSender.js` exactly — same Mailgun + Handlebars
shape, same four-function surface — so nothing about how this gets
extended needs to be relearned by anyone who's touched HM's version.

## Why this exists now

`requestReset` (password reset) had a standing `TODO: wire up
transactional email once an email provider is chosen` — the reset
link/token was only ever returned directly in a non-production response.
Refund/payout request decisions (see
[jobs-and-contacts-plan.md](jobs-and-contacts-plan.md)) added a second,
more pressing need: an admin declining a request with a reason is only
useful if the requester actually finds out — "you can see request denied"
by re-fetching the job works, but isn't the same as being told.

## Shape — `src/helpers/emailSender.ts` + `src/config/mailgun.ts`

- `loadTemplates()` — reads and Handlebars-compiles every file in
  `templateRegistry` (`src/emails/*.html`) once, called at server boot
  (`src/server.ts`, right after `connectDB()`) — same reasoning as HM's
  `server.js`: a broken or missing template file fails loudly at startup,
  not the first time something tries to send it mid-request.
- `sendEmail({to, subject, html})` — raw send via Mailgun.
- `renderTemplate(name, variables)` — fills a compiled template, returns
  `null` (logging, not throwing) for an unknown template name.
- `sendTemplatedEmail({to, subject, template, variables})` — the one
  callers actually use; no-ops if `renderTemplate` returned `null`.
- `config/mailgun.ts`'s `getMailgunClient()` is lazy and memoized — same
  fix as `config/stripe.ts`'s `getStripeClient()` for the same real bug
  class: constructing the Mailgun client at module-import time would mean
  the *entire app* fails to boot whenever `MAILGUN_API_KEY` isn't set
  (this file is pulled in transitively by `app.ts` via every controller
  that sends mail), not just the paths that actually send something.

Two Handlebars helpers are registered globally: `uppercase` (a name in a
greeting) and `year` (a template's footer copyright line) — both used by
HM's original templates, kept for the same reason.

## Templates — plain, not styled for their own sake

`src/emails/forgot-password.html` and
`src/emails/payment-request-decision.html`. Adapted from HM's own
templates (same table-based layout for email-client compatibility) minus
HM's logo image block — there's no equivalent hosted PolyGrid asset yet,
and the brief for this pass was explicit: *"it dose not have to be
gorgeous... just have to convey the message well enough."* Swap the
inline styles or add branding later without touching any calling code —
`sendTemplatedEmail` only cares about the variables a template expects,
not its markup.

`payment-request-decision.html` is shared by all four refund/payout
decision call sites (approve/decline × refund/payout) rather than four
near-identical templates — the only thing that differs between them is
which variables get passed in (`requestType`, `approved`, `amount`,
`currency`, `declineReason?`).

## Callers

- `userController.requestReset` — sends `forgotPassword` with
  `{name, resetUrl, expiresIn}`. The non-production response still also
  returns `resetUrl`/`token` directly, so the flow can still be exercised
  end-to-end without real Mailgun credentials configured locally; this
  gets removed once that's no longer needed for local dev.
- `jobController`'s `approveRefundRequest` / `declineRefundRequest` /
  `approvePayoutRequest` / `declinePayoutRequest` — each calls a shared
  `notifyPaymentRequestDecision()` helper, which looks up the requester
  (`refund.requestedBy`/`payout.requestedBy` — the client/provider's own
  user id) and sends `paymentRequestDecision`. A payout request whose
  `amount` was left unspecified (asked for "whatever's available") emails
  `"the full available amount"` instead of a raw `undefined`.

None of these calls are wrapped in `try/catch` — same as HM's own
callers. The underlying action (the refund/payout decision, the reset
token itself) has already been saved by the time the email send runs, so
a Mailgun outage never undoes a real decision; it does mean the HTTP
response for that request becomes a 500 if sending fails, even though
the decision itself already went through. Worth revisiting once this is
under real production load, not before.

## Tests — the module is mocked, never really called

Every test file that exercises a caller (`tests/integration/user.test.ts`,
`tests/integration/job.test.ts`) mocks the whole module at the top of the
file, identical to how HM's own test suite does it:

```ts
jest.mock("../../src/helpers/emailSender", () => ({
  sendTemplatedEmail: jest.fn().mockResolvedValue({}),
  loadTemplates: jest.fn().mockResolvedValue(undefined),
}));
```

No real Mailgun call is ever made in the test suite. `.env.test`/
`.env.test.example` carry non-empty placeholder `MAILGUN_*` values purely
so `config/mailgun.ts`'s lazy client never throws if some future test
forgets to mock the module — the same role `STRIPE_SECRET_KEY`'s
placeholder already plays.

## Not wired up yet

Verification approve/reject, dispute resolution, store order/job-payment
confirmations, digital purchase receipts — all plausible future callers
of `sendTemplatedEmail`, none built in this pass. The infrastructure is
reusable as-is; each just needs its own template + a call site, following
exactly the shape above.
