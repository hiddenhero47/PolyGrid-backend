# PolyGrid Store — Physical Materials Marketplace

Status: **shipped** (Physical half of PolyGrid Store — see
`docs/digital-storefront-plan.md` for the Digital half, built as its own
pillar with a deliberately different discovery model). The second pillar
business profile, built to the same overall shape ConsultancyProfile
established, but genuinely stress-tested by one real difference: a store
can own *many* products, and ConsultancyProfile's pattern (denormalize
`currentSubscription` onto the one profile document) doesn't survive that
difference unmodified.

## The core problem this design solves

ConsultancyProfile copies `User.currentSubscription` onto itself because
it's a single document per user — syncing it on a subscription change is
one `updateMany` across every profile a user owns
(`profileSubscriptionSync.ts`). A store isn't a single document with the
content attached — it's a profile *plus* an unbounded number of `Product`
documents. Denormalizing `currentSubscription` onto every product would
mean re-touching every product a store owns on every subscription change
(grant, renewal, expiry, webhook), and the actual value being tracked
(subscription status) isn't even something a `Product` should need to know
about itself.

**The fix: subscription gating happens entirely at the store level.**
`Product` carries no subscription-related field at all — not because it
was left out, but because there is deliberately no code path that would
ever need to read one there. Every way a product is reached goes through
its store first:

- **Search** (`GET /api/store-profiles?category=...`) returns *stores*
  that sell a category, verified + currently-subscribed (checked live via
  `$lookup`, exactly `searchConsultants`'s pattern), each with a small
  preview of matching products — never a flat product search across every
  store on the platform.
- **A store's catalog** (`GET /api/store-profiles/:idOrSlug`) is gated the
  same way `ConsultancyProfile.getProfile` gates a consultant's page —
  the URL always resolves, but content (here, the whole product list) is
  withheld (`{ available: false }`) unless the store is currently
  subscribed, checked live.
- **A direct product link** (`GET /api/products/:id`) is the one place
  that does need an explicit subscription check on behalf of a product —
  but it's still just one extra query (fetch the product's `storeId`,
  check *that* store's live subscription status), not a stored field on
  the product. Same cost as `getStore`'s check, just one hop further.

This is what "we can filter those who aren't subscribed because we're
doing things at a store level" (the original brief) actually cashes out
to in code: subscription status is checked at exactly the two or three
places a client can ever reach a product from, never stored redundantly
on the product itself.

## Categories — a strict taxonomy that drives a real cascade

`MATERIAL_CATEGORY` (`storeProfileModel.ts`) is a fixed enum grounded in
how real building-materials suppliers actually categorize stock: cement &
concrete, steel/reinforcement, aggregates, blocks & bricks, roofing,
timber & wood, doors & windows, electrical, plumbing, paints & finishes,
tiles & flooring, tools & equipment, safety gear. A store's `categories[]`
is the source of truth for what it's *allowed* to sell — every `Product`'s
`category` must be one of them, checked in `productController.ts` at
create/update time (a schema validator can't cleanly read a sibling
document, so this lives in the controller, same as every other
cross-document business rule in this codebase).

**Removing a category cascades.** `updateMyStoreProfile` diffs the old and
new category lists; for every category that got removed, every `Product`
under it — and its image files on disk — is deleted, *before* the profile
itself saves its new (shorter) category list. A store can't end up
claiming "I sell cement" while quietly still owning cement products after
saying it doesn't anymore. `subCategory` is deliberately free text, not
its own enum — a seller-chosen finer detail ("Portland cement 42.5N") that
nothing in the system needs to reason about structurally the way the
top-level category (search filtering, the cascade delete) does.

## Shipping — a property of the product, not the store

A shop can sell both 50kg cement bags and small hand tools; those have
nothing in common logistically just because they share a seller. So
`Product.shippingLocations[]` (`{country, state?, price}`) lives on the
product, not the store. `state` omitted means "ships anywhere in this
whole country at this price" — the exact same nationwide-default-with-
state-override shape `VerificationTemplate` already uses
(`country[, state]` → one specific match or a nationwide fallback), not a
new idea invented for this feature. Required and non-empty at creation —
a product with no shipping locations at all can't be ordered by anyone,
which is precisely the "forgot to fill this in" mistake requiring it
guards against. Resolution at checkout is state-specific first, then the
nationwide entry (`resolveShippingPrice`, `productModel.ts`); a
destination matching neither — no state entry *and* no nationwide
fallback — means that product **can't ship there at all**, and the whole
order is rejected (400), not silently defaulted to some price.

## Checkout — a snapshot, plus a real Job

The physical-goods reality this had to fit: **PolyGrid isn't shipping
anything.** Construction materials aren't like HM's parcels — a shop owner
handles delivery entirely themselves right now (a future PolyGrid
Logistics would need real infrastructure this project doesn't have yet).
So "checkout" (`POST /api/store-orders`) does three things:

1. **Snapshots what was actually requested** — `StoreOrder.items[]` keeps
   `titleSnapshot`/`unitPriceSnapshot` at order time (same "don't just
   reference a mutable live value" instinct `Subscription` already uses
   snapshotting `Plan`'s fields), plus the resolved shipping price and
   destination, kept as a real products/shipping split
   (`itemsTotalSnapshot`, `shippingTotalSnapshot`, `totalSnapshot`) — so
   the order stays a genuine record even if the product is edited or
   deleted later.
2. **Spins up a real `Job`** (`jobType: 'store'` — already existed in
   `JOB_TYPE`, unused until this pillar) for the calculated total. Built
   directly (`Job.create()` inside `storeOrderController.ts`, not through
   `POST /api/jobs`), because that endpoint always makes whoever calls it
   a confirmed party — but here the roles need to be asymmetric: the
   **shop owner is the Job's `createdBy` and already-confirmed provider**
   (so they get the creator-only pre-confirmation edit right, matching
   "you can accept, decline, or adjust the price" — accept is just letting
   the buyer confirm, decline is the existing creator-only `cancelJob`,
   adjust is the existing creator-only `updateJob`), while the **buyer is
   the not-yet-confirmed client** who reviews and confirms to accept
   whatever the final price turns out to be. No new Job endpoints needed
   for any of this.
3. **Connects buyer and store owner as Contacts** — the exact same
   `connectUsers` side effect Job creation always has through its own
   HTTP endpoint, replicated here since this Job bypasses that endpoint.

**Price changes are now tracked, not silent.** `Job.amountHistory[]`
(`{previousAmount, changedBy, changedAt}`) is a new *generic* Job field —
every job type gets it, not just store checkout — populated by
`updateJob` whenever a creator-only pre-confirmation edit actually changes
`totalAmount`. This is what "a way of tracking price in case it changes,
so both sides are comfortable" turns into: a paper trail of what changed
and who changed it. The actual comfort guarantee was already structural
before this — the buyer only ever confirms once, on whatever the number
is *at that moment* — `amountHistory` just makes the "at that moment"
visible instead of a totalAmount that silently became a different number.

**Payment visibility and an optional invoice both come for free.** Once
the Job exists, the shop owner sees `amountPaid` update the same way any
job's escrow does (`POST /api/payments/intent`/the Stripe webhook, or an
admin's manual `recordPayment`) — nothing store-specific needed there.
`Job.contractFile` (built for Engineering-pillar contracts) already does
exactly what an attached invoice needs: a private file, uploaded inline
with the request, shared with the other party via `FileGrant`. A store
owner attaches an invoice (image or PDF) the same way any job's contract
file already works — zero new code. This is the payoff of Jobs having
been built as a generic escrow/trust primitive from the start, not
something specific to Engineering — the second real pillar to lean on it
for free, twice over.

**No inventory tracking, deliberately confirmed by real-world reasoning,
not just assumed.** Loose materials (sand, aggregate) genuinely can't be
discretely counted the way a countable item (tiles, tools) can — building
a real quantity-tracked inventory system would be solving a problem that
doesn't have one consistent unit of measurement across what a store might
sell. `stockStatus` stays a hand-set availability signal, never a count
the system decrements on an order.

## Shared model pieces, extracted once a second consumer needed them

`src/models/profileLink.ts` (`IProfileLink`) and `src/models/mediaFile.ts`
(`IMediaFile` — real detected `mime`/`size`, a `storagePath` for actual
deletion, stripped before any public response) both used to live only in
`consultancyProfileModel.ts`. StoreProfile needed the exact same two
things (external links, a deletable public image with real metadata) —
extracted out once there were two real consumers, not speculatively ahead
of time. `consultancyProfileModel.ts` now imports and re-exports them, so
nothing that already imports `IProfileLink`/`MAX_PROFILE_LINKS` from it
had to change.

## Digital Storefront — its own pillar, see its own doc

The brief described two halves of PolyGrid Store: Physical (this doc) and
Digital (downloadable floor plans, BOQ sheets, drafting templates).
Digital turned out structurally different enough to need its own
discovery model — a flat, cross-creator feed instead of store-first
browsing — so it's documented separately in
`docs/digital-storefront-plan.md` rather than folded into this doc.

## Routes

- `POST /api/store-profiles` — create mine (one per user); `categories`
  required, non-empty.
- `GET /api/store-profiles?category=&country=` — search, verified +
  currently-subscribed only, each result includes a small preview of
  matching products.
- `GET /api/store-profiles/:idOrSlug?category=&subCategory=` — a store's
  full catalog; `{ available: false }` if not currently subscribed.
- `GET|PATCH /api/store-profiles/me` — mine; updating `categories` runs
  the cascade delete.
- `POST /api/store-profiles/me/logo` — replace the store's logo (deletes
  the old file only after the new one saves successfully).
- `POST /api/store-profiles/me/products` — create a product; `category`
  must be one of the store's own; `shippingLocations` required and
  non-empty.
- `PATCH|DELETE /api/store-profiles/me/products/:id` — update/delete mine.
- `POST /api/store-profiles/me/products/:id/images` /
  `DELETE .../images/:fileName` — add/remove a single image, same
  management pattern as ConsultancyProfile's portfolio media.
- `GET /api/products/:id` — a product directly; gated on its owning
  store's live subscription status.
- `POST /api/store-orders` — checkout: `{storeId, items, shippingDestination,
  note?}`. Resolves each item's shipping price for the destination
  (400 if any item can't ship there), snapshots the products/shipping
  split, spins up a `Job` (`jobType: 'store'`, shop owner as creator),
  connects buyer and store owner as Contacts. 404s if the store isn't
  currently subscribed (same as it being unreachable any other way);
  blocks ordering from your own store; every item in one order must share
  a currency.
- `GET /api/store-orders/mine` / `GET /api/store-orders/store` — a buyer's
  own orders / a store owner's received orders — each includes the linked
  `job` id; use `GET /api/jobs/:id` for the Job itself (payment status,
  confirmation, contract/invoice).
