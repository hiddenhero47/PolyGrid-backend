# Reviews

Status: **shipped**, now two-way. Cross-cutting — not scoped to one
pillar. Built while designing PolyGrid Tenders (which needed it for
Direct Hire's "past reviews, verification badges, ratings"), applies to
every pillar business profile (`ConsultancyProfile`, `StoreProfile`,
`DigitalCreatorProfile`, `ContractorProfile`, and now `ClientProfile`/
`LaborProfile` from PolyGrid SiteForce), and was generalized to let both
sides of a Job review each other once SiteForce gave the *client* side a
profile too (see "Two-way reviews" below).

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

- **Job-sourced**: the reviewer must be a real party on the job — either
  `job.client.userId` or `job.provider.userId` — and the target is
  resolved from whichever side the reviewer *isn't*. Either way, the
  lookup goes through a generic helper, `constants/profileTypes.findProfileByUserId`
  — which checks every `PROFILE_MODEL_REGISTRY` entry for one owned by
  that userId, rather than trusting `Job.jobType`. That trust would've
  been misplaced: Direct Hire (Consultancy, Tenders, SiteForce) has no
  dedicated "hire" endpoint of its own (see tenders-plan.md/siteforce-plan.md)
  — the client just uses the generic `POST /api/jobs` — so nothing
  actually guarantees a Direct-Hire job's `jobType` is set correctly.
  `findProfileByUserId` sidesteps that entirely.
- **DigitalPurchase-sourced**: the reviewer must be `purchase.buyer`. The
  target is `purchase.creator` directly — no lookup needed at all, since
  `DigitalPurchase` already stores the `DigitalCreatorProfile` id as a
  first-class field. One-way only — there's no symmetric "creator reviews
  the buyer" need, and a buyer has no profile for that review to target
  anyway.

## Two-way reviews, generalized rather than special-cased

The original design was one-way (client reviews provider) because the
brief that introduced Reviews only asked for "past project reviews" of a
contractor. PolyGrid SiteForce's safety requirements changed that: a
worker going alone to a job deserves the same "is this person reliable"
signal a client already gets — but that only became *possible* once
posters got their own profile (`ClientProfile`, see siteforce-plan.md),
since there was nothing for a reverse-direction review to point at
before.

Rather than special-case "two-way, but only for SiteForce,"
`createReview`'s Job-sourced branch is generically two-way: whichever
party didn't initiate the job is the review target, resolved the same
`findProfileByUserId` way regardless of pillar. Where the other side has
no profile — an ordinary Direct Hire client just booking a consultant,
say — that direction 404s cleanly ("no reviewable profile") instead of
erroring; two-way reviews simply don't exist where there's no profile to
attach them to. Nothing about Engineering, the existing Tenders Direct
Hire flow, or Store Physical had to change for this — it only activates
where a `ClientProfile` (or any other registered profile) happens to
exist on the client side.

## One review per reviewer per completed transaction

`{sourceType, sourceId, reviewer}` is the unique index — not just
`{sourceType, sourceId}`, now that a single Job can carry up to two
reviews (one from each party, in opposite directions). Still at most one
per direction, and still per-transaction rather than per-reviewer+profile:
a repeat client who's done three separate jobs with the same contractor
has three separate things to say each time, and real platforms (Amazon
per-purchase, Upwork per-contract) work the same way. Ownership of the
source (was *this* reviewer actually a real party on it) is enforced in
the controller, never the index.

## Rating math — simple, not atomic

`applyReviewToProfile` recomputes the average in application code
(`(oldAverage * oldCount + newRating) / (oldCount + 1)`) with an ordinary
read-then-write, the same style every other running total in this
codebase uses (e.g. `Job.amountDisbursed += ...`) — not an atomic
aggregation-pipeline update. Review volume per profile is low enough that
this isn't a real concurrency concern yet; revisit only if it becomes one.

## Routes

- `POST /api/reviews` — `{sourceType: 'Job'|'DigitalPurchase', sourceId,
  rating, comment?}`, authenticated. 403 if the requester wasn't a real
  party on the source, 404 if the other party has no reviewable profile,
  400 if the source isn't completed/successful yet or this reviewer has
  already reviewed it.
- `GET /api/reviews?profileType=&profileId=` — a profile's reviews,
  newest first, public.
