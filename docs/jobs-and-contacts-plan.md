# Jobs & Contacts

Status: **shipped** (v1 — see "Deliberately simplified for v1" below for
what's intentionally not built yet).

Two pieces of core, subscription-free infrastructure — a job doesn't need
either party to have an active PolyGrid subscription, unlike the business
profile visibility rule in [product-overview.md](product-overview.md).
Jobs are a trust/tracking tool available to every account, not a paid
feature; that was an explicit product decision, not an oversight.

## Contacts

`src/models/contactModel.ts` — one document per user (`userId`, unique),
holding `list: [{ user, email, connectedAt }]`. Connecting is always
**mutual**: `contactController.connectUsers(a, b)` adds each to the
other's list, idempotently (a repeat connection is a no-op, not a
duplicate entry). This is exported for `jobController.createJob` to call
directly — creating a job with someone connects you the same way adding
them as a contact does.

`email` is snapshotted at connection time (same reasoning as `Subscription`
snapshotting a `Plan`'s fields) so a contact entry still shows the address
it was made through even if that user later changes their email.

Routes (`/api/contacts`, all `protect`): `POST /` (by `userId` or `email`),
`GET /` (paginated, newest first), `DELETE /:userId` (removes from *my*
list only — one-directional; unfriending someone doesn't force-remove you
from theirs).

## Jobs

`src/models/jobModel.ts`. The shape follows the brief closely, with a few
gaps filled in — flagged below rather than silently decided.

### Always at least one stage

A job created with no `stages` gets a single implicit stage covering 100%
of `totalAmount`. This means "provider marks done → client verifies →
payment releases" is the *only* completion code path `jobController.ts`
needs — there's no separate branch for a lump-sum job with no milestones,
because structurally there's no such thing; it's just a job with one stage.

### Confirmation & editing

Either party can create a job (`myRole: 'client' | 'provider'` in the
request body says which side the creator is taking) — the creator's side
is auto-confirmed, the other party's isn't. The creator can freely edit
(`PATCH /api/jobs/:id`) — title, description, amount, stages — only while
`status: 'pending_confirmation'`. Once the other party confirms
(`PATCH /api/jobs/:id/confirm`), the job is `active` and locked: further
stage changes go through `proposedStages` — either party proposes
(`POST /:id/stages/propose`), the *other* party accepts
(`PATCH /:id/stages/accept`, pushing the current `stages` into
`oldStages` first — never overwritten, same instinct as `Subscription`'s
history) or rejects (`PATCH /:id/stages/reject`).

### Per-stage execution & the escrow ledger

`PATCH /:id/stages/:stageId/done` — provider only. `.../verify` — client
only, and only once `isDone` — the client verifies *completed* work, not a
promise. Verifying a stage is the only thing that moves money in the
model: `amountDisposed` (released to the provider) and
`platformFeeCollected` (PolyGrid's cut) both increment by that stage's
share of `totalAmount`, split by `platformFeePercent` — which is
**snapshotted onto the job at creation**, so changing the platform's
default fee later doesn't retroactively change an existing job's math. Once
every stage is verified, `status` auto-flips to `completed`. `amountPaid`
(the client's total *into* escrow, as opposed to `amountDisposed` *out of*
it) isn't touched by verification at all — see payments below.

### Contract files — reuses the file-upload system as-is

`POST /:id/contract` uploads through the exact same `uploadHandler` every
other private upload goes through (`visibility: 'private'`,
`ownerId: <the uploading party>`), then writes a `FileGrant` naming the
*other* party — no new file infrastructure needed, this was exactly the
kind of second consumer [file-uploads-plan.md](file-uploads-plan.md)
anticipated. Re-uploading deletes the old copy from disk and its
`FileGrant`. To view it, the other party goes through the same generic flow
as any other private file: `GET /api/files/private/:ownerId/:fileName/link`
to check access and mint a signed link, then `GET /private/view/...`.

### Payments — a ledger, not (yet) a payment gateway

`amountPaid`/`amountDisposed`/`platformFeeCollected` on the job are the
running totals; the actual line-item history now lives in the unified
`Payment` model (see [payments-plan.md](payments-plan.md)) — every job
payment, however it's eventually collected, is `targetType: 'Job'`. The
interim admin-only `POST /:id/payments` both bumps `amountPaid` and writes
a `Payment` record (`provider: 'manual'`) — same stand-in pattern as
`subscriptionController.grantSubscription`, to be replaced by a real
gateway webhook doing the same two things once one is wired up.

## Deliberately simplified for v1

- **Disputes are flag-and-record, resolved by email, not in-app chat —
  still true even now that chat exists** (see [chat-plan.md](chat-plan.md)).
  `PATCH /:id/dispute` (either party, with a `reason`) puts a job on the
  admin queue: `GET /api/jobs/disputes` (admin-only, `client`/`provider`/
  `disputedBy` populated with `fullName`/`email` so an admin can reach both
  sides without a second lookup). The actual back-and-forth with the two
  parties happens over email, outside this system, on purpose: chat is
  deliberately 1:1 between the two users and never reviewed by PolyGrid
  (see chat-plan.md's "persisted, never reviewed" section) — the exact
  opposite of what an admin mediating a dispute needs, which is a visible,
  three-way record. `PATCH /:id/dispute/resolve` requires
  a `note` (the admin's own record of the outcome, e.g. "refunded stage 2
  per agreement over email") and appends it to `disputeHistory` — a job can
  be disputed more than once over its life, so this is a history, not a
  single latest-resolution field, same instinct as `oldStages`. Still no
  in-app mediation/evidence/refund *workflow* — that's a real feature of
  its own, not a field on this model.
- **Cancellation only works pre-confirmation.** Once both parties have
  confirmed (and possibly put money in escrow), a unilateral cancel isn't
  safe — a dispute is the mechanism for problems on an active job instead.
  A mutual-agreement cancellation flow could be added later if needed.
- **The counterparty must already be a registered user.** `createJob`
  requires a real `userId` (resolves via the same lookup `addContact`
  uses) — no invite-a-stranger-by-email flow. That's its own feature if
  ever needed.
- **`jobType` is a light enum tied to the 4 pillars** (`engineering`,
  `tenders`, `store`, `siteforce`, `other`) rather than a free string, for
  consistency with the rest of the product — defaults to `other`.
