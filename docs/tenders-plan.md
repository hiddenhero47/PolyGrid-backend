# PolyGrid Tenders — Contract Bidding & Direct Hire

Status: **shipped**, retrofitted once. The third pillar business
profile, in two genuinely different halves: Direct Hire (easy — the same
discovery shape ConsultancyProfile already established) and the Project
Bidding Board (harder — sealed bidding). Posting originally gated on
`requireActiveSubscription` (a generic middleware that had sat unused
since Phase 1.5); once PolyGrid SiteForce introduced `ClientProfile` — a
real profile for posters, needed so a worker could review a poster's
reputation — Tenders' posting gate moved to the same profile-based check,
for consistency across both pillars that have a posting flow. See
[siteforce-plan.md](siteforce-plan.md) for why.

## Research grounding the Bidding Board design

Real construction bid-management platforms (PlanHub, BuildingConnected)
confirmed the shape before any code was written: a poster publishes a
project with documents/specs, eligible contractors browse by trade and
submit bids, the poster compares them side by side. And construction
tendering is overwhelmingly **sealed-bid**, not open/live-auction — bids
stay confidential, visible only to the project's owner, never to
competing bidders. Both of those are structural decisions in the design
below, not guesses.

## ContractorProfile — Direct Hire, deliberately a near-copy of ConsultancyProfile

`src/models/contractorProfileModel.ts` serves *both* halves of this
pillar: Direct Hire discovery (`searchContractors`/`getContractor`,
byte-for-byte the same shape as `searchConsultants`/`getProfile`) and bid
eligibility (only a verified + currently-subscribed `ContractorProfile`
can bid on the board at all — see below). Same `currentSubscription`/
`isVerified`/`verification` trio as every other pillar profile, registered
in `PROFILE_MODEL_REGISTRY` for the usual zero-pillar-specific-code
Verification/subscription-sync payoff.

**`IPortfolioItem` was extracted out of `consultancyProfileModel.ts`** into
its own `src/models/portfolioItem.ts` the moment a second real consumer
(`ContractorProfile`) needed the exact same "past work, with photos"
shape — same instinct as `profileLink.ts`/`mediaFile.ts`'s own extraction,
not built speculatively ahead of a second consumer existing.

Direct Hire itself needed **zero new "hire" endpoint** — `ConsultancyProfile`
already proved a client just uses the existing generic `POST /api/jobs`
with the consultant's `userId` once they've found them via search/profile.
A contractor is hired exactly the same way.

## Reviews — tied to a real transaction, displayed on the profile

Built generically, across every pillar profile — not scoped to Tenders
alone. Full design in [reviews-plan.md](reviews-plan.md); the short
version: a review targets a *profile* (reputation, which is what another
prospective client actually cares about), but can only ever be created
from a real completed transaction (a `Job` or a successful `DigitalPurchase`)
— never by naming a profile directly. Originally one-way (client reviews
contractor); now two-way, since a contractor can also review the
project's poster via their `ClientProfile` (see siteforce-plan.md for why
that became possible).

## The Project Bidding Board

`src/models/tenderProjectModel.ts` / `src/models/bidModel.ts`.

### Who can do what

**Posting** a `TenderProject` requires a subscribed `ClientProfile`
(`loadEligibleClientProfile`, `clientProfileController.ts`) — never
`isVerified`, since posting doesn't carry the same physical-safety stakes
bidding/applying does (see siteforce-plan.md's research). This replaced
an earlier version gated on the bare `User` via `authMiddleware.requireActiveSubscription`
(built in Phase 1.5, unused until Tenders first shipped) — once
`ClientProfile` existed as a real profile posters could be reviewed
through, checking it directly became the more consistent choice, the
same shape every other pillar's eligibility check already uses.
`requireActiveSubscription` itself is unused again now, but stays in
`authMiddleware.ts` as general infrastructure for a future pillar that
genuinely has no profile concept of its own.

**Bidding** requires a verified + currently-subscribed `ContractorProfile`
(`loadEligibleContractorProfile`, checked live against `Subscription`,
same rule as every other pillar's reachability check) — never just "has a
subscription," since bidding is this pillar's actual provider-side action.

### No public teaser — full detail is the browsing surface itself

Unlike Digital/Physical products, a `TenderProject`'s full detail
(description, specs, attached files) is never shown to an anonymous or
ineligible viewer as a public preview — there's no browse-then-buy moment
here, just browse-then-decide-to-bid, so the "teaser" *is* the full
listing, gated to the poster, an eligible contractor, or an admin.
Attachments are private files; `getTenderProject` mints signed view links
inline for an eligible viewer rather than exposing a separate
download-link endpoint, since there's no purchase step to gate — the
eligibility check itself is the whole gate.

### Sealed bidding, enforced structurally

A contractor's own `submitBid`/`updateMyBid`/`withdrawMyBid` only ever
touch their own `Bid` (`{project, contractorId}` unique together — one
bid per contractor per project, revise it instead of submitting a second
one). `getProjectBids` — the only endpoint that lists every bid on a
project — is poster-only; a competing contractor has no route that would
ever return someone else's bid. The one signal a competing contractor
*does* get is `TenderProject.bidCount` — a running total, incremented on
submit and decremented on withdrawal — "12 bids so far," never amounts or
identities, the same compromise PlanHub/BuildingConnected-style boards
make in real life.

### Awarding — reuses Job with the *default* roles, unlike Store's trick

`PATCH /:id/award` accepts one pending bid, rejects every other pending
bid on the project, and creates a real `Job` (`jobType: 'tenders'`).
Unlike PolyGrid Store's checkout (where the buyer calls the endpoint but
the *shop owner* needs to end up as the confirmed party, requiring an
asymmetric-roles workaround), here the **poster is the one calling
award**, so the default `createJob` role assignment already does the
right thing: poster = confirmed client, contractor = not-yet-confirmed
provider, who then confirms to activate the job. No asymmetric trick
needed — just `Job.create()` with the obvious roles.

`TenderProject.status` flips to `awarded`, `awardedBid`/`job` get set, and
`connectUsers` is called manually (same reason Store checkout does: this
Job bypasses the generic `POST /api/jobs` endpoint that would have
triggered it automatically).

### Budget — optional, deliberately

`budgetMin`/`budgetMax` are both optional. A poster can legitimately
decline to disclose a budget at all — common in real tenders, specifically
to avoid bids converging on a revealed number. Set both equal for a fixed,
disclosed budget.

## Routes

- `POST /api/contractor-profiles` / `GET /me` / `PATCH /me` — mine.
- `GET /api/contractor-profiles?specialty=&country=` — search, verified +
  subscribed only.
- `GET /api/contractor-profiles/:idOrSlug` — a contractor's page;
  `{available: false}` if not currently subscribed.
- `POST .../me/portfolio` + sub-resource routes — same shape as
  ConsultancyProfile's.
- `POST /api/tender-projects` — post a project; requires a subscribed
  `ClientProfile`.
- `GET /api/tender-projects?category=&country=` — the bidding board;
  eligible-contractor only.
- `GET /api/tender-projects/:id` — full detail with signed file links;
  poster/eligible-contractor/admin only, `{available: false}` otherwise.
- `GET|PATCH /api/tender-projects/me` — my posted projects / edit mine
  (while open).
- `PATCH /:id/cancel` — poster-only, while open; auto-rejects pending bids.
- `POST /:id/bids` — submit a bid; eligible-contractor only, blocks a
  self-bid and a second bid.
- `GET /:id/bids` — every bid on my project; poster-only.
- `PATCH /:id/bids/mine` / `.../bids/mine/withdraw` — revise or withdraw
  my own bid.
- `GET /api/tender-projects/bids/mine` — my own bids, across every
  project.
- `PATCH /:id/award` — accept a bid, reject the rest, spin up a `Job`.
