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

## Roles & personas

### System roles
- `super_admin` — exactly one in the system (enforced at the DB layer);
  full platform control.
- `admin` — verification approval, dispute management, moderation. Created
  only by a Super Admin (or by promotion), never by public registration.
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

- **One subscription, attached to the base `User` document** — not
  per-pillar, not per-profile.
- **Rule**: if `user.subscription.status === 'active'` (and `expiresAt` is in
  the future), *every* verified business profile under that account becomes
  active/searchable across all four pillars simultaneously.
- **Non-destructive expiry**: an expired subscription does not delete or
  disable profiles in the DB — they're just filtered out of public
  search/listing queries dynamically. Nothing is lost if the user resubscribes.

## Business profiles (future work)

Each pillar's provider-side data lives in its own document, 1-to-1 with
`User` via `userId` (not modeled yet — see
[architecture-plan.md](architecture-plan.md) for build order):
`EngineeringProfile`, `ContractorProfile`, `StoreProfile`, `LaborProfile`.
All share an embedded verification block:

```
verification: {
  status: 'unverified' | 'pending' | 'approved' | 'rejected',
  documents: string[],
  verifiedAt?: Date,
}
```

Physical-goods and labor pillars additionally store location as a GeoJSON
Point (plus plain `country`/`state`/`city` strings) and a
`maxServiceRadiusKm`, for `$nearSphere`/`$geoWithin` queries.
