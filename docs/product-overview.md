# PolyGrid — Product Overview

**Company:** Hephaestus Craft — full-circle engineering solutions.
**Product:** PolyGrid — a civil engineering, construction marketplace and
talent ecosystem.

## The four pillars

Every user account can participate in any/all of these; they aren't separate
products or separate signups.

### 1. PolyGrid Engineering — Consultancy & Mentorship
- **Consultant marketplace**: verified professionals (structural,
  geotechnical/soil, hydraulic/water, architectural). One-on-one
  consultations, structural audits, blueprint modification approval.
- **Mentorship & talent hub**: senior engineers mentor junior
  engineers/students — portfolio reviews, career pathing, design advice.

### 2. PolyGrid Tenders — Contract Bidding & Direct Hire
- **Project bidding board**: clients post project scope/specs/budget;
  registered contractors submit competitive tenders.
- **Direct hire**: clients bypass bidding and contract a vetted
  general/specialized contractor directly, based on reviews/badges/ratings.

### 3. PolyGrid Store — Digital & Physical E-Commerce
- **Digital storefront**: downloadable architectural floor plans, structural
  drafting details, site layout templates, bill-of-quantities (BOQ) sheets.
- **Physical materials marketplace**: buy/sell raw materials and site
  equipment (cement, rebar, roofing, aggregates, finishing items) with
  delivery tracking.

### 4. PolyGrid SiteForce — Skilled & Unskilled Labor
- **Location-based job board**: map-integrated short/long-term job postings
  tied to a specific site location.
- **Direct tradesperson hiring**: searchable directory of site
  personnel — foremen, carpenters, plumbers, electricians, masons, general
  laborers — with skill verification and ratings.

## Jobs & Contacts — cross-pillar trust tool

Not tied to any one pillar, and **not gated by subscription** — two people
who already know each other (or connect through the platform) can track a
piece of work between themselves regardless of account type. A job has one
or more payment-bearing stages, a mutual confirm/lock workflow, an escrow
ledger (PolyGrid takes a `platformFeePercent` cut on release), and
optional contract file attachments per party. Creating a job with someone
also adds them to your `Contact` list (mutually). Full design in
[jobs-and-contacts-plan.md](jobs-and-contacts-plan.md).

Two connected users can also message each other directly (1:1, real-time
over Socket.IO) — never reviewed by PolyGrid, and never the channel a Job
dispute gets resolved through (that stays email, see
jobs-and-contacts-plan.md). Full design in [chat-plan.md](chat-plan.md).

## Roles & personas

### System roles
- `super_admin` — exactly one in the system (enforced at the DB layer);
  full platform control.
- `admin` — verification approval, dispute management, moderation. Created
  only by a Super Admin (or by promotion), never by public registration.
- `customer_care` — read-only access to the same review queues an admin
  sees (disputes, verifications, message reports); can't act on any of
  them. Same trusted-creation restriction as `admin`. Phase 1 of a future
  workflow where customer_care pushes what they've reviewed to a queue an
  admin confirms — see [architecture-plan.md](architecture-plan.md).
- `user` — every regular account, regardless of which pillars they use.

### Dual-persona toggle (not a role)
Every `user` account carries an `activeAccountType` flag independent of
`systemRole`:
- **normal** (buyer/client) — free, no subscription required. Post tenders,
  buy digital/physical goods, hire consultants, hire site workers.
- **business** (provider/vendor) — service providers, contractors, sellers,
  tradespeople. Requires the pillar-specific business profile to exist and
  (per the subscription rule below) an active subscription to be
  searchable/bookable.

A single account can flip between the two — it's a UI/API mode switch, not a
separate signup.

## Global subscription model (PSN-style)

- **One subscription lineage per user, not per-pillar, not per-profile.**
  `Subscription` is its own collection (`user` field points at the `User`),
  not an embedded field — every subscription a user has ever had (granted,
  renewed, expired, canceled) stays as its own permanent record. `User`
  itself only holds `currentSubscription`, a pointer at the latest one — see
  [architecture-plan.md](architecture-plan.md) for the full schema.
- **Rule**: if the user's current `Subscription.status === 'active'` (and
  `expiresAt` is in the future), *every* verified business profile under
  that account becomes active/searchable across all four pillars
  simultaneously.
- **Non-destructive expiry**: an expired subscription does not delete or
  disable profiles in the DB — they're just filtered out of public
  search/listing queries dynamically. Nothing is lost if the user resubscribes.
- **Plans are catalog data**, not hardcoded — an `AvailablePlan`
  (`planTier`, `privileges[]`, `duration`, `price`, optional `maxUsers` seat
  cap) is what a `Subscription` is created against. A `Subscription`
  snapshots the plan's `planTier`/`privileges` at the moment it's
  created/renewed, so past subscriptions read correctly even if the plan
  they were bought under later changes.

## Business profiles

Each pillar's provider-side data lives in its own document, 1-to-1 with
`User` via `userId`. **`ConsultancyProfile` (PolyGrid Engineering),
`StoreProfile` (PolyGrid Store, Physical Materials Marketplace),
`DigitalCreatorProfile` (PolyGrid Store, Digital Storefront),
`ContractorProfile` (PolyGrid Tenders), and `LaborProfile` (PolyGrid
SiteForce) — all four pillars — are now built**, plus `ClientProfile`, a
fifth, cross-pillar profile for the poster side of Tenders/SiteForce —
see [consultancy-profile-plan.md](consultancy-profile-plan.md) /
[store-plan.md](store-plan.md) /
[digital-storefront-plan.md](digital-storefront-plan.md) /
[tenders-plan.md](tenders-plan.md) / [siteforce-plan.md](siteforce-plan.md)
for the full designs and [architecture-plan.md](architecture-plan.md) for
what shipped. StoreProfile and DigitalCreatorProfile are the ones to look
at first for why *not* every profile can reuse ConsultancyProfile's
denormalize-subscription-onto-the-profile pattern unmodified —
StoreProfile because a store owns many `Product` documents, not one
piece of content (see store-plan.md's "core problem" section);
DigitalCreatorProfile because Digital's discovery is a flat cross-creator
feed with no store-first step to hide behind, solved with a two-hop
`$lookup` anchored directly on the product collection instead (see
digital-storefront-plan.md's "core problem" section). ContractorProfile
and LaborProfile, by contrast, genuinely *are* near-copies of
ConsultancyProfile — Direct Hire's discovery model is the same shape
everywhere — but each pillar's *other* half (Tenders' Project Bidding
Board, SiteForce's Location-Based Job Board) has its own "core problem"
worth reading about directly: sealed bidding for Tenders, and a
two-tier location reveal (driven by real lone-worker-safety research,
not assumed) for SiteForce.

Reviews (`ratingAverage`/`ratingCount` on every profile above, backed by
`src/models/reviewModel.ts`) are cross-cutting, not specific to any one
pillar, and — since `ClientProfile` gave posters a real profile to
target — two-way: a provider can review the client's profile, not just
the other direction. See [reviews-plan.md](reviews-plan.md).

Every pillar profile shares `userId`, a denormalized-but-live-checked
`currentSubscription`, `isVerified`, and a pointer at its latest
`Verification` record — `Verification` itself is one shared, polymorphic
model (`profileType`/`profileId`), not duplicated per pillar:

```
status: 'pending' | 'approved' | 'rejected'  // absence of a record = unverified
location: { country, state? }
templateId  // the VerificationTemplate this was validated against
form        // validated against templateId's field definitions
documents: { type: string, fileName: string }[]
```

**What's actually required to verify a profile is data, not hardcoded per
country** — a `VerificationTemplate` catalog entry per
`(profileType, country[, state])` declares both the form fields and the
required documents for that pillar/location combination, the same
"catalog data, not a hardcoded enum" instinct `Plan` already uses. See
[verification-templates-plan.md](verification-templates-plan.md).

`JobOpening` (SiteForce) now stores real coordinates (`{lat, lng}`,
gated — see siteforce-plan.md) alongside plain `country`/`state`/`city`
strings, but as a plain subdocument, not yet a proper GeoJSON Point with
a `2dsphere` index — proximity search (`$nearSphere`/`$geoWithin`,
"jobs near me") is still Phase 7 work, not wired up yet.
