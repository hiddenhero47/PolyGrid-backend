# PolyGrid SiteForce — Skilled & Unskilled Labor

Status: **shipped**. The fourth and final pillar business profile, in two
halves again: Direct Tradesperson Hiring (easy — the same discovery shape
every other pillar already established) and the Location-Based Job Board
(the one with real physical-safety stakes no other pillar has).

## The safety question this pillar actually had to answer

Every other pillar's "transaction" is business-to-business, or at least
brings a crew: a contractor brings their own people, a shop owner ships
via their own arrangement. A SiteForce job opening is different — a
worker very often shows up **alone**, to a site or home they've never
seen, that may belong to someone they've never met.

Research into how real platforms handle this exact risk
([Checkr/TaskRabbit](https://checkr.com/organizations/taskrabbit),
[Vetty](https://www.vetty.co/blog/ensure-reliable-background-checks-for-gig-workers-in-5-steps))
and into lone-worker safety specifically
([SafePoint](https://www.safepointapp.com/construction-lone-workers),
[Washington State Construction Center of Excellence](https://www.constructioncenterofexcellence.com/blog/protecting-lone-workers-on-jobsite))
pointed at the same two levers, consistently:

1. **Vet the person who's physically exposed** — every platform that
   sends someone alone into a stranger's property background-checks
   *that person* before they're allowed to take jobs. None of them
   background-check the customer/poster; the asymmetry is industry-wide,
   because the worker is the one at risk, not the poster.
2. **Don't hand out exact location to anyone who merely glances at a
   listing** — a worker loses "control over who they encounter," per the
   lone-worker research, in part because they're walking into an unknown,
   unsecured location with no one nearby.

Both are structural decisions in this design, not UI warnings layered on
top of an unchanged backend.

## LaborProfile — Direct Hire, same shape as every other pillar

`src/models/laborProfileModel.ts` mirrors `ContractorProfile`/
`ConsultancyProfile` almost exactly (`currentSubscription`/`isVerified`/
`verification`, `skills: LaborSkill[]`, the shared `portfolioItem.ts` —
its *third* real consumer now), registered in `PROFILE_MODEL_REGISTRY`.
Direct Hire itself needed zero new code, same as every prior pillar: once
a client finds a worker via `searchWorkers`/`getWorker`, hiring them is
the existing generic `POST /api/jobs`.

**`isVerified` is the safety mechanism, not a nice-to-have.** A worker
needs to be verified *and* currently subscribed before they're eligible
to apply to a job opening at all (`loadEligibleLaborProfile`) — this is
PolyGrid's version of lever #1 above, reusing the Verification pipeline
every other pillar already has rather than inventing a new background-
check concept.

## ClientProfile — a new, shared poster identity (not SiteForce-specific)

Before this pillar, a poster (Tenders or SiteForce) was just a bare
subscribed `User` — nothing to attach a reputation to. `src/models/clientProfileModel.ts`
fixes that: a lightweight profile (`displayName`, `bio?`, `country`/
`city?`, `ratingAverage`/`ratingCount`), registered in
`PROFILE_MODEL_REGISTRY` so Reviews can target it the same generic way
they target a provider's profile.

Posting (`TenderProject` or `JobOpening`) now requires a `ClientProfile`
with an active subscription — `loadEligibleClientProfile`
(`clientProfileController.ts`), shared by both pillars. `isVerified` is
**not** required to post, deliberately: per lever #1 above, no real
platform background-checks the person issuing the invitation, only the
person walking into an unfamiliar property. `tenderProjectController.createTenderProject`
was retrofitted to this same check, replacing the bare
`requireActiveSubscription` gate it used before `ClientProfile` existed.

`GET /api/client-profiles/:id` is deliberately never subscription-gated
the way a provider profile's page is — a poster isn't discoverable
content being paywalled; the whole point is letting a worker check a
poster's track record before engaging, which has to work regardless of
whether the poster is currently paying.

## Reviews became two-way because posters finally have a profile

See [reviews-plan.md](reviews-plan.md) for the mechanism — the short
version: `reviewController.createReview`'s Job-sourced branch now
resolves the target from *whichever* party is calling (client reviews
provider, or provider reviews client), and `ClientProfile` existing is
what makes "a worker rates the poster" possible at all. This directly
answers the physical-safety asymmetry: a worker deciding whether to take
a job gets the same "is this person reliable" signal a client already
gets about a contractor.

## The Job Board — location split into two tiers

`src/models/jobOpeningModel.ts` is **not** the same model as PolyGrid's
own escrow `Job` — it's a listing (closer in shape to `TenderProject`),
deliberately named `JobOpening` to avoid the confusion. `category` reuses
`LABOR_SKILL` directly rather than a near-duplicate enum, since "skill
needed" and "skill a worker has" are the same vocabulary.

**`generalArea`** (country/state/city) is always visible to any eligible
worker browsing the board. **`coordinates`/`address`/`googleMapsUrl`/
`contactInfo`/`files`** are withheld until a worker's application is
actually **accepted** — not merely eligible to browse, not merely having
applied (`jobOpeningController.getJobOpening` checks for a `JobApplication`
with `status: 'accepted'` before adding the gated tier back in). This is
meaningfully stricter than Tenders, where any eligible contractor sees a
project's full detail — because here the thing being withheld is exactly
where a lone person would have to physically go.

Pay is **fixed by the poster** (`payRate`/`payType`/`currency`), not bid —
workers apply, they don't compete on price, matching how real day-labor
platforms (Wonolo, Shiftgig) actually work for this kind of listing. A
posting can need multiple workers (`workersNeeded`); each accepted
application spins up its own `Job` (`jobType: 'siteforce'`, poster as
confirmed client, worker as unconfirmed provider — same default-roles
reasoning Tenders' `awardBid` uses), and the listing only moves to
`filled` once accepted applications reach `workersNeeded`, at which point
every other pending application auto-rejects.

Applications are sealed from each other the same way Tenders' bids are —
`getOpeningApplications` is poster-only — even though there's no price to
hide here, an applicant's identity shouldn't be handed to other
applicants either.

## Routes

- `POST /api/labor-profiles` / `GET /me` / `PATCH /me` — mine.
- `GET /api/labor-profiles?skill=&country=` — search, verified +
  subscribed only.
- `GET /api/labor-profiles/:idOrSlug` — a worker's page.
- `POST .../me/portfolio` + sub-resource routes — shared schema.
- `POST /api/client-profiles` / `GET /me` / `PATCH /me` — mine.
- `GET /api/client-profiles/:id` — public, never subscription-gated.
- `POST /api/job-openings` — post an opening; requires a subscribed
  `ClientProfile`.
- `GET /api/job-openings?category=&country=` — the board; eligible-worker
  only, public tier only.
- `GET /api/job-openings/:id` — gated tier added only for the poster,
  admin, or an accepted worker.
- `GET|PATCH /api/job-openings/me` — my postings / edit mine.
- `PATCH /:id/cancel` — poster-only; rejects pending applications.
- `POST /:id/applications` — apply; eligible-worker only, blocks a
  self-application and a second one.
- `GET /:id/applications` — every application on my posting; poster-only.
- `PATCH /:id/applications/mine` / `.../mine/withdraw` — revise or
  withdraw my own application.
- `GET /api/job-openings/applications/mine` — my own applications, across
  every posting.
- `PATCH /:id/applications/:applicationId/accept` — accept, spin up a
  `Job`, auto-fill/auto-reject-the-rest once `workersNeeded` is reached.
- `PATCH /:id/applications/:applicationId/reject` — explicit reject.
