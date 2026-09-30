# PolyGrid Store — Digital Storefront

Status: **shipped**. The Digital half of PolyGrid Store (see
`docs/store-plan.md` for the Physical half). Same pillar, deliberately
separate design: direct purchase-and-download, no shipping, no Job, and a
subscription-gating problem that Physical's store-level filtering can't
solve because Digital's whole point is a flat, cross-creator feed.

## The core problem this design solves

Physical filters out unsubscribed sellers at the *store* level — search
always returns stores first, so a client never sees a bare product list
that would need per-item gating. Digital can't do that: the brief wants a
YouTube/TikTok-style feed where you scroll past products from many
different creators in one flat, paginated list, then optionally go into
one creator's page to see the rest of their catalog. There's no
"store-first" step to hide behind — the feed itself is the primary
discovery surface, and it's anchored on products, not creators.

The naive fix — denormalize a subscription flag onto every
`DigitalProduct` — has the same staleness problem ConsultancyProfile's own
`currentSubscription` copy has, except worse: a product-level flag would
need re-touching on every subscription change across however many
products a creator has, for a boolean the product shouldn't need to know
about itself.

**The actual fix: a 2-hop `$lookup`, anchored directly on the product
collection.** `listDigitalProductFeed` (`digitalProductController.ts`) runs
one aggregation:

```
DigitalProduct.aggregate([
  { $match: { isActive: true, ...category } },
  { $lookup: DigitalCreatorProfile by creatorId },  // hop 1
  { $match: { "creator.isVerified": true } },
  { $lookup: Subscription by creator.currentSubscription },  // hop 2
  { $match: { "subscription.status": "active", expiresAt > now } },
  { $sort, $skip, $limit },
])
```

This costs exactly the same as the store-level version used for
Physical — **one query per page, regardless of how many hops the lookup
chain has.** The store-level indirection Physical uses was a UX/business
choice (search returns stores, not products), not a technical necessity —
Mongo doesn't care how many collections a `$lookup` chain crosses before
it matches. Nothing is denormalized onto `DigitalProduct`; a creator's
subscription lapsing or getting un-verified drops their entire catalog out
of the feed on the very next request, with zero writes.

`getDigitalCreatorProfile` (the "go into all of this creator's work" step
from the brief) and `getDigitalProduct` (a direct product link) use the
simpler one-hop live check `getStore`/`getProduct` already established —
the 2-hop aggregation is only needed for the flat feed, where there's no
single creator already in hand to check.

## Digital creator profile — a separate profile type from StoreProfile

`DigitalCreatorProfile` is its own model, not a reuse of `StoreProfile`
with a flag, even though both sit under "PolyGrid Store." Their discovery
mechanics are incompatible: Physical is store-first (search → store →
catalog), Digital is a flat cross-creator feed with an optional creator
page. Neither shares the other's concepts (categories driving a
cascade-delete, shipping locations) so unifying them would mean one model
carrying fields that make no sense for half its rows. Registered in
`PROFILE_TYPE`/`PROFILE_MODEL_REGISTRY` (`constants/profileTypes.ts`)
exactly like ConsultancyProfile and StoreProfile were — KYC/verification
works for it with zero pillar-specific code, same payoff the registry was
built for.

## Products — public preview, private deliverable, permanent purchase

`DigitalProduct` splits its media into two arrays with two different
visibility rules, distinguished by multipart field name (`forms.any()` in
`app.ts` puts every attached file into one flat `req.files`, tagged with
its own `.fieldname` — nothing about multer config forces the split, the
controller just filters by fieldname):

- `previewImages` (`FILE_VISIBILITY.PUBLIC`) — screenshots/renders anyone
  browsing can see, same as a `Product`'s images.
- `files` (`FILE_VISIBILITY.PRIVATE`) — the actual deliverable. Required,
  non-empty at creation. Never served directly and never in
  `toPublicDigitalProduct`'s response — the only way to reach one is
  `GET /api/digital-products/:id/download`.

**A creator can never hard-delete a listing.** `isActive: false` is the
only removal mechanism — it hides the product from the feed, the creator
page, and direct view, but the record and its files stay exactly as they
were. This is the brief's requirement made structural: a past buyer's
access must keep working regardless of what the creator does to the
listing afterward.

**Files are append-only after creation** (`POST .../products/:id/files`) —
deliberately no remove endpoint. A file already sold to a buyer shouldn't
be pulled out from under them just because the creator is editing the
listing (e.g. uploading a revised drawing). Preview images, being public
and non-purchasable, keep the ordinary add/remove pair
(`POST`/`DELETE .../preview-images/...`) `Product`'s images already use.

## Purchase — direct, no Job, permanent once granted

Unlike every other paid interaction in this codebase, a digital purchase
never spins up a `Job`. The brief is explicit: "purchase and download
immediately," not an escrow/negotiation step — so `DigitalPurchase` plugs
straight into the existing generic `Payment`/Stripe flow
(`PAYMENT_TARGET_TYPE.DIGITAL_PURCHASE`, the polymorphic `Payment.targetId`
now pointing at a third target type) the same way `Subscription` does:
created `pending` the moment checkout starts, flipped to `success` only by
the Stripe webhook on a real successful charge — the same "exists in an
interim state before payment is real" instinct as
`SUBSCRIPTION_STATUS.PENDING`.

`handleDigitalPurchasePaymentIntent` (`paymentController.ts`) blocks:

- buying a product whose creator isn't currently verified+subscribed
  (404 — same as that product being unreachable through the feed at all),
- a creator buying their own product,
- a second purchase attempt while one already exists for that
  buyer+product, pending or successful.

**Access, once granted, is permanent — deliberately decoupled from the
creator's ongoing status.** `getDigitalProductDownloadLink` checks purely
for a `DigitalPurchase{status: success}` record (or the requester being
the product's own creator) and mints signed download links via
`signFileUrl()` directly — bypassing `FileGrant` entirely, matching the
"a domain with its own access rules calls `signFileUrl()` directly"
pattern from `docs/file-uploads-plan.md`. It never re-checks the creator's
live subscription/verification, and never re-checks `isActive`. Those two
things only ever gate *discovery* (the feed, the creator page, a direct
product view) — never a download someone already paid for. A creator
lapsing their subscription the day after a sale, or later deactivating the
listing, changes nothing about a completed purchase.

## Routes

- `POST /api/digital-creator-profiles` — create mine (one per user).
- `GET|PATCH /api/digital-creator-profiles/me` — mine.
- `POST /api/digital-creator-profiles/me/avatar` — replace avatar.
- `GET /api/digital-creator-profiles/:idOrSlug` — a creator's page
  (profile + their active products, paginated); `{ available: false }`
  unless currently verified + subscribed.
- `POST /api/digital-creator-profiles/me/products` — create a product;
  multipart, non-file fields under `data` (same convention `Product`
  uses), `previewImages` field for public images, `files` field for the
  required, non-empty private deliverables.
- `PATCH /api/digital-creator-profiles/me/products/:id` — fields + the
  `isActive` toggle only; no delete endpoint.
- `POST /api/digital-creator-profiles/me/products/:id/preview-images` /
  `DELETE .../preview-images/:fileName` — add/remove one preview image.
- `POST /api/digital-creator-profiles/me/products/:id/files` — append more
  deliverable files; no remove endpoint.
- `GET /api/digital-products/feed?category=` — the flat, cross-creator
  feed; the 2-hop `$lookup` aggregation above.
- `GET /api/digital-products/:id` — a product directly; `{ available:
  false }` unless its creator is currently verified + subscribed.
- `GET /api/digital-products/:id/download` — signed download links for
  every deliverable file; requires being the creator or holding a
  successful `DigitalPurchase`; access survives the creator's subscription
  lapsing or the product going inactive.
- `GET /api/digital-purchases/mine` — my purchase history.
- `POST /api/payments/intent` with `{targetType: "DigitalPurchase",
  targetId}` — the checkout entry point; see "Purchase" above.
