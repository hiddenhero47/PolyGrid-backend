# Docs

- [product-overview.md](product-overview.md) — what PolyGrid is: the four
  pillars, user roles/personas, and the global subscription model. Read this
  first if you're new to the product.
- [architecture-plan.md](architecture-plan.md) — the technical plan this
  backend is being built against: stack decisions, schema shape, and the
  phased build order. Kept up to date as phases land.
- [file-uploads-plan.md](file-uploads-plan.md) — the public/private file
  uploader: storage layout, visibility/access-control model, and where it
  deliberately diverges from house-maduekwe-backend's media handling.
- [jobs-and-contacts-plan.md](jobs-and-contacts-plan.md) — the subscription-
  free trust/tracking tool: contacts, job stages/escrow ledger, contract
  files (reuses the file-uploads system as-is), and what's deliberately
  simplified for v1 (disputes resolved by email not chat, cancellation).
- [payments-plan.md](payments-plan.md) — the unified `Payment` model (one
  collection, either a `Job` or a `Subscription` payment via a polymorphic
  `refPath`), a real uniqueness-index bug caught by the test suite and how
  it was fixed, and a proposal (not yet built — needs a decision first) for
  live Stripe integration.

New feature areas should get their own plan doc here (mirroring
`architecture-plan.md`'s format) before code is written, same convention as
[house-maduekwe-backend](https://github.com/hiddenhero47/house-maduekwe-backend)'s
`docs/`.
