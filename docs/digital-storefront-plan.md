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

## Storage provider — internal (local disk) by default, S3 opt-in

Deliverable files (both a product's originals and a buyer's purchase
copy) go through a small adapter interface,
`providers/digitalStorageProviders/types.ts` (`DigitalStorageProviderAdapter`
— `uploadDigitalFiles`/`copyDigitalFile`/`deleteDigitalFile`/
`getDigitalFileDownloadUrl`), the same shape `providers/paymentProviders`
already established for swapping Stripe for another gateway later without
rewriting every caller. Two implementations exist today:

- `internalStorageProvider.ts` — **the default.** Local disk, under
  `STORAGE_ROOT/digital-store/` (kept separate from `public/`/`private/` —
  a distinct concern with its own buyer-copy semantics). Download links
  are minted by `helpers/digitalFileSigning.ts` (a JWT keyed by `key`,
  mirroring `fileSigning.ts`'s ownerId+fileName token but for a
  potentially-multi-segment storage key) and served by
  `digitalStoreController.downloadDigitalStoreFile` at
  `GET /digital-store/download?token=...` — no `protect`, no DB read, the
  signed token IS the authorization, exactly like `/private/download/...`.
- `s3StorageProvider.ts` — AWS S3. Requires real credentials
  (`AWS_ACCESS_KEY_ID`/`AWS_SECRET_ACCESS_KEY`/`AWS_REGION`/`S3_BUCKET`),
  which this project doesn't have set up yet.

`providers/digitalStorageProviders/index.ts`'s `getDigitalStorageProvider()`
picks between them by reading `process.env.DIGITAL_STORAGE_PROVIDER`
(`"internal"` or `"aws"`) fresh on every call — **deliberately never
exposed through any API**, and not meant to change at runtime. Which
provider is active is a deploy-time decision (edit `.env`, redeploy): a
request-level or admin-API toggle would mean existing `key`s stay pointing
at whichever store they were actually written to while new reads went
looking in the other one — there's no way to know "where to look" for a
file written under a provider that's no longer configured. Move to
`DIGITAL_STORAGE_PROVIDER=aws` once real AWS credentials exist; nothing
else about the code needs to change, since every caller goes through the
adapter interface, never a concrete provider directly.

## Products — public preview, provider-backed deliverable, buyer gets their own copy

`DigitalProduct` splits its media into two arrays with two different
visibility rules and two different storage backends, distinguished by
multipart field name (`forms.any()` in `app.ts` puts every attached file
into one flat `req.files`, tagged with its own `.fieldname` — nothing
about multer config forces the split, the controller just filters by
fieldname):

- `previewImages` (`FILE_VISIBILITY.PUBLIC`, always local disk via
  `fileStorage.ts` — never goes through the provider abstraction above,
  these are public and non-purchasable) — screenshots/renders anyone
  browsing can see, same as a `Product`'s images.
- `files` (whichever storage provider is configured, `IDigitalFile[]` —
  see `models/digitalFile.ts`) — the actual deliverable. Required,
  non-empty at creation, never in `toPublicDigitalProduct`'s response.
  Never served directly — the creator reaches their own live files via
  `GET /api/digital-products/:id/download`; a buyer never touches this
  array at all (see Purchase below).

**A creator can never hard-delete a listing.** `isActive: false` is the
only removal mechanism — it hides the product from the feed, the creator
page, and direct view, but the record stays exactly as it was.

**A creator can add, remove, or replace deliverable files** —
`POST`/`DELETE .../products/:id/files[/:fileName]`, the same add/remove
pair `previewImages` already uses ("replace" is remove-then-add; no
separate endpoint). This is safe *because* a buyer never reads from the
live product (see Purchase below) — removal moves the entry from
`DigitalProduct.files` into `DigitalProduct.bin` (`helpers/
digitalProductBin.ts`) instead of deleting it right away, with
`deleteAt` set `BIN_GRACE_MS` (1 day) out. A purchase already in flight
may still be entitled to copy it via its frozen `fileManifest`, which in
practice resolves within seconds of a successful payment — a day is a
generous, simple buffer, not a tuned value.

`clearProductBin` is the actual deletion: called lazily wherever a
single product is read or written (`getDigitalProduct`,
`getDigitalProductDownloadLink`, `updateDigitalProduct`,
`addDigitalProductPreviewImages`/`Files`, `removeDigitalProductFile`
itself), it deletes every bin entry whose `deleteAt` has passed (via
`getDigitalStorageProvider().deleteDigitalFile`) and drops them from
`bin`. Deliberately **not** a cron sweep like `DigitalPurchase` retention
— a product nobody's touching has nothing time-sensitive riding on its
bin being cleared promptly, so there's no need for a background job; the
next time anyone looks at or edits that specific product, the check runs
and anything overdue gets swept. `bin` is never included in
`toPublicDigitalProduct` — like `files`, it holds a storage `key` that
must never leave the server.

## Purchase — direct, no Job, buyer gets their own time-limited copy

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

Deliberately **not** blocked: purchasing itself is never gated on the
*buyer's* own subscription. Subscription status only ever affects how
long the buyer's copy is retained (below) — it's not a condition of being
allowed to buy.

**At checkout-start, `DigitalPurchase.fileManifest` freezes exactly which
storage keys this purchase covers** — a snapshot of `product.files` taken
before anything else can change it. This is the race-condition fix: no
matter what the creator does to the listing while payment is still
processing (Stripe confirmation, 3D Secure, webhook delay), this purchase
is entitled to exactly these keys, and (combined with removal never
deleting the object) they're guaranteed to still exist whenever the copy
actually runs.

**Once the webhook flips a purchase to `success`**, it calls
`digitalPurchaseFiles.copyPurchaseFiles` — a standalone, directly
unit-testable helper that calls `getDigitalStorageProvider().copyDigitalFile`
for every file in `fileManifest`, copying each into a buyer-scoped key
(`digital-purchases/<buyerId>/<purchaseId>/...`), populating
`DigitalPurchase.files`: the buyer's own independent copy, from this
point on completely decoupled from the creator's product. The webhook
only calls this once per purchase —
`DigitalPurchase.updateOne({status: pending}, {status: success})`'s own
`modifiedCount` gates it, so a Stripe redelivery of an already-processed
event is a pure no-op (same idempotency instinct already used for
`Payment.status` one line above).

**Two separate download routes, not one shared by role** —
`GET /api/digital-products/:id/download` (`digitalProductController.
getDigitalProductDownloadLink`) is creator-only now, keyed by the
product, serving the live `product.files`. A buyer instead uses
`GET /api/digital-purchases/:id/download`
(`digitalPurchaseController.getDigitalPurchaseDownloadLink`), keyed by
the *purchase*, reading only `purchase.files` — it never looks up
`DigitalProduct` at all. This split matters beyond tidiness: the two
routes used to share one `DigitalProduct.findById` lookup, which meant a
buyer's download depended on the live product being found first, even
though the bytes they'd actually get were already fully independent of
it. Now a creator editing the price, swapping the file, deactivating the
listing, or (per "Abandoned-seller cleanup" below) having their catalog
cleared after a month unsubscribed literally cannot affect this route —
there's no code path left that touches `DigitalProduct` for a buyer at
all. If `purchase.files` is empty: `filesDeletedAt` set means the
retention sweep deliberately wiped it (410 Gone); unset means the copy
step hasn't completed yet — a rare operational gap, not an expiry (503,
retry).

## Retention — kept while subscribed, 7 days' grace after it lapses

A buyer's copy isn't permanent. `helpers/digitalPurchaseRetention.ts`'s
`sweepExpiredPurchaseFiles` wipes `DigitalPurchase.files` (via
`getDigitalStorageProvider().deleteDigitalFile`) once the buyer's
**own** subscription (`User.currentSubscription`, not a new profile
requirement) has been inactive for 7+ days — or 7 days from the purchase
itself if they were never subscribed at all. Everything is computed
live, nothing cached: a buyer who resubscribes before the grace period
elapses is simply never flagged on the next run. `fileManifest` and the
`DigitalPurchase` record itself are never deleted — only `files` (the
copy) and only once; the sweep's query (`files.0` must exist) makes
re-running it harmless.

This is the pure, directly-testable sweep logic — scheduling lives
separately in `jobs/`, structured like house-maduekwe-backend's own
cron setup: `jobs/status.ts` (a shared `{running, lastRun}` tracker per
job), `jobs/tasks/digitalPurchaseRetentionTask.ts` (the `node-cron`
registration + overlap guard, calling the helper above), and
`jobs/cronIndex.ts`'s `startCronJobs()` (the single entry point
`server.ts` calls once at boot). Runs weekly, Sunday ~3am UTC.

## Abandoned-seller cleanup — a product's files, not just a purchase's

Separate from buyer-side retention above: `helpers/profileProductCleanup.ts`'s
`sweepInactiveProfileProducts`, scheduled every 2 hours by
`jobs/tasks/profileProductCleanupTask.ts`, reclaims storage from a
**creator's own listings** once their subscription (`DigitalCreatorProfile.
currentSubscription`) has lapsed 30+ days — not a buyer's purchase copy,
the creator's original catalog. Shared with the Store pillar (see
store-plan.md's "Abandoned-store cleanup") — the same "lapsed since"
aggregation (expiresAt if the subscription's nominally ACTIVE but timed
out, else updatedAt; a profile that never subscribed at all is excluded
entirely, not swept) runs against both `StoreProfile` and
`DigitalCreatorProfile`, `BATCH_SIZE_PER_TYPE` (2) of each per run — a
little at a time throughout the day rather than one large monthly sweep,
specifically to avoid a thundering-herd spike once a month. The query
only ever selects a profile that still has something left to clear
(`"products.0"`/`"activeProducts.0"` must exist), so a profile that's
already been fully processed naturally drops out of the next run's
candidate pool — no field is ever written onto the profile itself to
mark it "done."

**Store and Digital are handled differently, deliberately matching each
pillar's own already-established rule about hard-deleting:**

- **Store**: `Product` documents (and their image files) are genuinely
  hard-deleted. Safe to do — `StoreOrder` already snapshots
  price/title/totals at checkout, never re-reading the live `Product`
  for display, and `Review` never targets a `Product` at all. This is
  the same pattern `storeProfileController`'s category-removal cascade
  and `productController.deleteProduct` already use.
- **Digital**: `DigitalProduct` is never hard-deleted, exactly per the
  "creators can never hard-delete a listing" rule already stated on the
  model. Instead, every file (`previewImages`, `files`, and anything
  still sitting in `bin` — forced out immediately here rather than
  waiting on its own `deleteAt`) gets deleted and the listing is
  permanently set `isActive: false`. A buyer's own download
  (`GET /api/digital-purchases/:id/download`) never looks up
  `DigitalProduct` at all, so hard-deleting it wouldn't touch that route
  either way — but `getMyDigitalPurchases` still populates
  title/category/previewImages *live* off `DigitalProduct` rather than
  snapshotting them, so hard-deleting it would blank those fields in a
  buyer's own purchase history (price/status/date are fine — those are
  snapshotted directly on `DigitalPurchase`). Deactivating instead of
  deleting keeps that history intact too. (The `files` schema validator
  was relaxed to allow an empty array specifically when `isActive` is
  already `false`, so this emptying doesn't trip the model's own
  min-one-file rule for active listings.)

One accepted edge case, not engineered around: a purchase that starts
checkout in the narrow window right before this runs could have its
webhook-triggered copy fail if the source file was just deleted — logged,
surfaced to that buyer as the existing 503 "still being prepared" state.
Considered acceptable because a creator unsubscribed and untouched for a
full month is, in practice, not actively making sales.

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
- `POST /api/digital-creator-profiles/me/products/:id/files` /
  `DELETE .../files/:fileName` — add/remove a deliverable file (whichever
  storage provider is configured); removal moves it into the product's
  bin for a day before the underlying object is actually deleted (see
  Products above).
- `GET /api/digital-products/feed?category=` — the flat, cross-creator
  feed; the 2-hop `$lookup` aggregation above.
- `GET /api/digital-products/:id` — a product directly; `{ available:
  false }` unless its creator is currently verified + subscribed.
- `GET /api/digital-products/:id/download` — creator-only; short-lived
  download links for the live `product.files`.
- `GET /digital-store/download?token=...` — the internal storage
  provider's own file-serving route (unused when
  `DIGITAL_STORAGE_PROVIDER=aws`, where links point straight at S3).
- `GET /api/digital-purchases/mine` — my purchase history.
- `GET /api/digital-purchases/:id/download` — a buyer's own download
  links, from their own `DigitalPurchase.files` copy; never looks up the
  live product at all (410 once retention has wiped it, 503 if the copy
  hasn't landed yet).
- `POST /api/payments/intent` with `{targetType: "DigitalPurchase",
  targetId}` — the checkout entry point; purchasing itself is never gated
  on the buyer's own subscription (see "Purchase" above).
