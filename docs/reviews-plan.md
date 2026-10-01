# Reviews

Status: **shipped**. Cross-cutting — not scoped to one pillar. Built while
designing PolyGrid Tenders (which needed it for Direct Hire's "past
reviews, verification badges, ratings"), but applies to every pillar
business profile from day one: `ConsultancyProfile`, `StoreProfile`,
`DigitalCreatorProfile`, and `ContractorProfile`.

## The core design call

A review targets a **profile**, not the specific job/item it came from.
Per the brief this was built from: another prospective client doesn't
care about one past job — they care whether *this profile* is reliable
overall. So `ratingAverage`/`ratingCount` live on each of the four profile
models (plain additive fields, same running-total pattern already used
everywhere in this codebase — e.g. `Job.amountDisbursed`), and
`src/models/reviewModel.ts`'s `Review` documents are the audit trail
behind them, not the thing a client-facing rating reads from directly.

**What makes a review legitimate**: it must come from a real, completed
transaction — never "anyone can review anyone." `sourceType`/`sourceId` is
the same polymorphic refPath trick `Payment.targetType`/`targetId` already
uses, pointing at whichever transaction proves it:

- A completed `Job` (`status: 'completed'`) — covers Engineering, Tenders
  (both Direct Hire and an awarded bid), and Store Physical, since all
  three settle through a `Job` eventually.
- A successful `DigitalPurchase` (`status: 'success'`) — Digital
  Storefront never uses a `Job` at all, by design (see
  digital-storefront-plan.md), so it needed its own source type.

The caller never names a `profileId` directly — `POST /api/reviews` takes
only `{sourceType, sourceId, rating, comment?}`, and
`reviewController.createReview` resolves the actual target itself, which
is what stops someone from reviewing a profile they never transacted
with:

- **Job-sourced**: the reviewer must be `job.client.userId`. The target
  profile is resolved from `job.provider.userId` via a new generic helper,
  `constants/profileTypes.findProfileByUserId` — which checks every
  `PROFILE_MODEL_REGISTRY` entry for one owned by that userId, rather than
  trusting `Job.jobType`. That trust would've been misplaced: Direct Hire
  (both Consultancy and Tenders) has no dedicated "hire" endpoint of its
  own (see tenders-plan.md) — the client just uses the generic
  `POST /api/jobs` — so nothing actually guarantees a Direct-Hire job's
  `jobType` is set correctly. `findProfileByUserId` sidesteps that
  entirely.
- **DigitalPurchase-sourced**: the reviewer must be `purchase.buyer`. The
  target is `purchase.creator` directly — no lookup needed at all, since
  `DigitalPurchase` already stores the `DigitalCreatorProfile` id as a
  first-class field.

One-way only (client reviews the provider, not the reverse) — per the
brief, which asked for "past project reviews" of the contractor/profile,
not a two-way system. Simpler, and nothing asked for the reverse.

## One review per completed transaction, not per reviewer+profile

`{sourceType, sourceId}` is a unique index — one review per Job/purchase,
not one review per reviewer-profile pair. A repeat client who's done three
separate jobs with the same contractor has three separate things to say,
and real platforms (Amazon per-purchase, Upwork per-contract) work the
same way. Ownership of the source (was *this* reviewer actually the
paying party on it) is enforced in the controller, never the index.

## Rating math — simple, not atomic

`applyReviewToProfile` recomputes the average in application code
(`(oldAverage * oldCount + newRating) / (oldCount + 1)`) with an ordinary
read-then-write, the same style every other running total in this
codebase uses (e.g. `Job.amountDisbursed += ...`) — not an atomic
aggregation-pipeline update. Review volume per profile is low enough that
this isn't a real concurrency concern yet; revisit only if it becomes one.

## Routes

- `POST /api/reviews` — `{sourceType: 'Job'|'DigitalPurchase', sourceId,
  rating, comment?}`, authenticated. 403 if the requester isn't the
  source's paying party, 400 if the source isn't completed/successful yet
  or has already been reviewed.
- `GET /api/reviews?profileType=&profileId=` — a profile's reviews,
  newest first, public.
