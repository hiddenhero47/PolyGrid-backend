# PolyGrid Engineering — ConsultancyProfile & Verification

Status: **shipped** — the first pillar business profile, and the template
the remaining three (Contractor, Store, Labor) should follow.

## Profile vs. engagement — a deliberate split

Researched a handful of real consultant/freelance marketplaces before
designing this (Upwork, Toptal, Clarity.fm, Contra, Houzz Pro) — the one
thing genuinely common across all of them: **the public profile/portfolio
is a separate concern from however a specific engagement is priced and
tracked.** None of them conflate "who you are and what you do" with "here's
the paid work you're doing right now."

So `ConsultancyProfile` is the discovery/presence layer only — headline,
bio, specializations, portfolio, a services/rate menu, mentorship offering.
**Booking a consultation, ordering a structural audit, or getting a
blueprint reviewed is just a `Job`** (`jobType: 'engineering'`) between the
client and this profile's `userId` — Job already owns scope agreement,
staged deliverables, escrow, and disputes, all built and tested already.
No booking/calendar/payment logic exists in this feature at all; it
doesn't need any.

## Every pillar profile's shared shape

Per your spec — `userId`, `currentSubscription`, `isVerified`, plus a
separate verification/KYC form. Two things worth explaining:

### `currentSubscription` is denormalized on purpose, and kept in sync

`ConsultancyProfile.currentSubscription` is a copy of
`User.currentSubscription`, not something read fresh via a join every
time. It exists so the public search/listing query
(`GET /api/consultancy-profiles`) is a single `$lookup` straight from the
profile collection, instead of a two-hop join through `User` for every
search. `src/helpers/profileSubscriptionSync.ts` keeps it current — the
only two places `User.currentSubscription` ever changes
(`subscriptionController.grantSubscription`, the Stripe webhook's
subscription-activation branch) both call it afterward, fanning the update
out to every profile a user owns across every pillar in
`src/constants/profileTypes.ts`'s `PROFILE_MODEL_REGISTRY` — add the next
pillar there when it's built, and this keeps working with no other change.

**Search still re-checks the subscription live, not from a stored
boolean**, because a subscription's active-ness is time-based
(`expiresAt`) — it can go stale with *no write ever happening* as the
clock passes that timestamp. `searchConsultants`'s aggregation pipeline
`$lookup`s the actual `Subscription` document and checks
`status: 'active' AND expiresAt > now` fresh, every query. The denormalized
`currentSubscription` only saves the *join hop*, not the *freshness check*
— confirmed by a test that backdates a subscription's `expiresAt` directly
(no code path "expires" one) and checks the profile drops out of search
immediately, with zero writes to the profile.

### `Verification` is its own model, reusable by every future pillar

Same instinct as `Subscription`/`Job.oldStages`: a profile can be verified
more than once over its life (rejected → resubmitted → approved), and each
submission stays a permanent record rather than being overwritten. A
profile's `isVerified`/`verification` pointer always reflects only the
*latest* one.

It's polymorphic the same way `Payment` is — `profileType` +
`profileId` (Mongoose `refPath`) instead of a `ConsultancyProfile`-specific
field, so `verificationController.ts` never needs pillar-specific code:
`PROFILE_MODEL_REGISTRY[verification.profileType]` resolves the right
model generically for both the ownership check on submission and the
`isVerified` flip on approval. The next three pillars register themselves
in that one file and this entire feature works for them unmodified.

KYC documents (license certificate, degree certificate, etc.) are private
files, uploaded as part of the verification submission itself (never a
pre-uploaded `fileName` reference — see verification-templates-plan.md's
"Submission flow" for why that earlier design let files accumulate with
nothing attached to them). Admins get access for free once a `Verification`
exists (the existing private-file access rules already grant it), no extra
sharing step needed.

**What's actually required to verify a profile is template-driven, not
hardcoded** — see [verification-templates-plan.md](verification-templates-plan.md)
for the full design (this replaced an earlier version of this feature that
hardcoded Nigeria's COREN/ARCON regulatory bodies directly into the
`Verification` schema, which doesn't generalize to a platform that isn't
Nigeria-only).

## Routes

- `POST /api/consultancy-profiles` (`protect`) — create mine (one per
  user).
- `GET /api/consultancy-profiles` (public) — search/listing, **verified
  AND currently-subscribed only** (the aggregation the original brief
  asked for). Filterable by `specialization`/`country`.
- `GET /api/consultancy-profiles/:idOrSlug` (public) — the URL itself
  always resolves once a profile exists (never a 404 just because the
  owner's subscription lapsed — an old bookmarked/shared link shouldn't
  look like the consultant never existed), but the actual content is only
  served while currently subscribed — corrected from an earlier "always
  fully reachable" version, which left a real gap: a direct link would
  keep an unsubscribed consultant fully visible to anyone who already had
  the URL, with no incentive left to resubscribe. Checked live against
  `Subscription` (same as the search aggregation, never the denormalized
  boolean), so it flips the instant a subscription expires with no write
  needed. Not subscribed → `200 { available: false, message: "..." }`,
  nothing else about the profile included. Verification status doesn't
  gate this — only subscription does.
- `GET|PATCH /api/consultancy-profiles/me` (`protect`) — my own, full
  detail regardless of verified/subscribed state.
- `POST /api/consultancy-profiles/me/portfolio` (`protect`) — create a
  portfolio item, with its initial media (zero or more public images via
  `uploadHandler` — a failed image never fails the request, same
  never-throws contract as every other use of that helper; failures come
  back as a non-blocking `mediaWarnings` entry instead of being silently
  dropped). Capped at `MAX_PORTFOLIO_ITEMS` items per profile,
  `MAX_MEDIA_PER_ITEM` images per item — see "Portfolio media management"
  below.
- `POST /api/consultancy-profiles/me/portfolio/:itemId/media` (`protect`)
  — add more images to an existing item later, still capped at
  `MAX_MEDIA_PER_ITEM` total.
- `DELETE /api/consultancy-profiles/me/portfolio/:itemId/media/:fileName`
  (`protect`) — remove one image from an item (keeps the item).
- `DELETE /api/consultancy-profiles/me/portfolio/:itemId` (`protect`) —
  remove the whole item, and every media file it owns.
- `POST /api/verifications` (`protect`) — submit/resubmit KYC for any of
  my profiles, against the resolved `VerificationTemplate` for that
  profile type + location (see verification-templates-plan.md).
- `GET /api/verifications/me` (`protect`) — my own submission history.
- `GET /api/verifications` (admin) — the review queue, filterable by
  `status`/`profileType`.
- `PATCH /api/verifications/:id/approve` / `/reject` (admin) — reject
  requires a `reason`; approve is what actually flips the target profile's
  `isVerified`.

## Portfolio media management — a correction

The first version of portfolio media had three real gaps, found on review:

1. **`IPortfolioMedia`'s own comment claimed it matched `IAvatar`'s shape**
   (`{fileName, storagePath, mime, size, url}`), but the actual interface
   was just `{fileName, url}` — the comment was aspirational, not true.
2. **That missing `storagePath` broke deletion.** `removePortfolioItem`
   deleted the DB subdocument but never called `deleteStoredFile()` on any
   of its media, because it had no real path to call it with — every
   deleted item left its images orphaned on disk permanently. Fixed now:
   `IPortfolioMedia` genuinely carries `storagePath`/`mime`/`size` (still
   stripped before a public response, same as `IAvatar`), and both
   `removePortfolioItem` and the new `removePortfolioMedia` actually call
   `deleteStoredFile()`.
3. **No limits at all.** A profile could accumulate unlimited portfolio
   items, each with unlimited images. `MAX_PORTFOLIO_ITEMS` (20) and
   `MAX_MEDIA_PER_ITEM` (6) — both exported from
   `consultancyProfileModel.ts` — are enforced twice: at the controller
   level (a clean 400 *before* anything touches disk) and again as a
   Mongoose schema `validate` on the arrays themselves, as defense in
   depth. Exceeding either is a hard rejection, not a silent truncation —
   the caller finds out immediately rather than discovering later that
   only some of what they attached actually saved.

There was also no way to manage media within an item — only delete the
whole thing. `POST .../portfolio/:itemId/media` (append) and
`DELETE .../portfolio/:itemId/media/:fileName` (remove one) fill that in,
alongside the existing create/delete-whole-item routes.

`addPortfolioItem`'s non-file fields (`title`/`description`/`tags`/
`startedAt`/`completedAt`) now go through the same `parseMultipartData`
`data`-JSON convention introduced for Verification, rather than flat
per-field multipart fields — see verification-templates-plan.md for why.

A portfolio item also now carries `startedAt` alongside `completedAt` (a
date range for the project, not just a completion date) — checked both in
the controller (a clean 400 before any file is saved, if `completedAt` is
before `startedAt`) and, as a backstop, by a schema-level `validate` on
`completedAt` itself.

## `links` — public, and deliberately not raw contact details

`ConsultancyProfile.links` is a small array of `{label, url}` — a website,
LinkedIn, a portfolio site, Behance, GitHub, whatever a consultant wants to
point people at. Capped at `MAX_PROFILE_LINKS` (10); a `url` that doesn't
start with `http(s)://` is silently dropped (same "filter, don't hard-fail"
instinct already used for invalid `specializations` in this controller),
exceeding the cap is a hard 400.

**Deliberately not a place for phone/email/WhatsApp.** PolyGrid's Jobs
system exists specifically to capture a platform fee on an engagement —
publicly exposing a direct way to reach a consultant would make it trivial
to arrange payment off-platform and skip that fee, the same reason real
consultant marketplaces (Upwork, Toptal, Contra) don't surface raw contact
info on a public profile either. A client reaches out by creating a `Job`
instead. If a genuine need for direct contact info comes up later, it
should be gated behind an existing relationship (a shared `Job`/`Contact`),
not bolted onto the public profile as another open field.

## Slugs

Each profile gets a unique, human-readable `slug` (from the owner's name,
disambiguated with a short random suffix on collision) for a clean public
mini-site URL — `GET /api/consultancy-profiles/:idOrSlug` accepts either.
