# Reference data — country, state, city, currency

Status: **shipped**. A single source of truth for "is this a real
country/state/currency," applied everywhere the app previously accepted a
free-text `country`/`state`/`currency` field with no check against reality,
plus a public API so the frontend can populate dropdowns from the exact
same data instead of hand-maintaining its own copy.

## Why this needed doing

Every `country`/`state`/`currency` field across the app (`ConsultancyProfile`,
`VerificationTemplate`, `Verification.location`, `Job`, `Payment`, `Plan`,
`User.phoneNumber`) was just an uppercased/trimmed string, at best checked
by a shape regex (`User.phoneNumber.country` required 2 letters, which
"ZZ" satisfies just as well as "NG"). Nothing actually confirmed the value
meant anything — a typo, a made-up code, or a full country *name* where a
code was expected would all save silently.

## Libraries, and why these two

- **`country-state-city`** — bundled (no network call) Country → State →
  City data, ISO 3166-1/3166-2 codes, and each country's associated ISO
  4217 currency. Chosen because it covers all three (country/state/city)
  from one dependency with a synchronous API built exactly for this
  "cascading dropdown" use case.
- **`currency-codes`** — ISO 4217 lookup, more recently maintained and
  currency-specific. Its `digits` field (decimal places — 2 for USD/NGN, 0
  for JPY) is the part `country-state-city` doesn't have, and it matters
  beyond validation: it's exactly what real money math needs to know
  before assuming every currency has 2 decimal places (Stripe's own
  "zero-decimal currency" list is a live example of why that assumption is
  wrong).

Both are pure, synchronous, in-memory lookups — no DB read, no API call,
so validating or listing this data costs nothing per request.

## `src/helpers/countryReference.ts` / `currencyReference.ts`

The only two files that import the underlying packages — everything else
in the app goes through these. `isValidCountryCode`, `isValidStateCode`,
`isValidCurrencyCode`, plus lookups (`getStatesOfCountry`,
`getCitiesOfCountry`/`getCitiesOfState`, `getDefaultCurrencyForCountry`,
`getCurrencyDecimalDigits`, `getAllCurrencyCodes`).

## Validation strictness — country/currency hard, state conditional, city soft

- **Country and currency are hard-validated everywhere**: ISO 3166-1 and
  ISO 4217 are both complete, unambiguous, universal lists — there's no
  legitimate value that wouldn't appear in them, so rejecting anything
  else outright is safe and exactly what "reference data" should mean.
- **State is validated *if* the country has states listed in this
  dataset** — `isValidStateCode` treats a country with zero listed states
  (mostly small nations/territories) as nothing to check against, so it
  passes anything, rather than rejecting every submission for that country
  as if every state were invalid.
- **City is deliberately never hard-validated.** City-level coverage is
  uneven enough (a real town missing from any bundled dataset is entirely
  plausible) that rejecting one would be a false positive with real cost —
  a legitimate profile blocked over a data-completeness gap, not a data
  error. `city` fields stay free text; `GET /api/reference/countries/:code/cities`
  exists for a frontend that wants an autocomplete/dropdown anyway, without
  the server ever hard-requiring a match.

## Wired into every existing field

- `ConsultancyProfile.country` (hard), `.city` (unchanged, free text),
  `services[].currency` (hard).
- `VerificationTemplate.country` (hard), `.state` (conditional on the
  country's own state list).
- `Verification.location.country` (hard), `.state` (conditional) —
  defense in depth; `submitVerification` only reaches this via a template
  that already resolved for that country/state, so this mostly protects
  against a code path bypassing that lookup later, not today's request
  flow.
- `Job.currency`, `Payment.currency`, `Plan.currency` (all hard).
- `User.phoneNumber.country` — replaced the old "any 2 letters" regex with
  the real check.

## A real gap this surfaced: Mongoose `ValidationError` was a 500

None of the above (`ConsultancyProfile.country`, `Job.currency`,
`Plan.currency`, etc.) had a controller-level pre-check before `.save()`/
`.create()` — a bad value was always going to be caught by the schema
`validate` itself. But `errorMiddleware.ts`'s `errorHandler` had no case
for a raw `mongoose.Error.ValidationError`, which carries no `statusCode`
of its own — so *every* schema validation failure across the whole app
(not just these new ones — the pre-existing portfolio-item limits,
`completedAt`-after-`startedAt`, `expiresAt`-after-`periodStarted`, all of
it) was falling through to the generic 500 branch. A client-input problem
reported as a server failure. Fixed once, centrally: `errorHandler` now
catches `mongoose.Error.ValidationError` and responds 400 with every
field's message joined, before the generic status-code fallback runs.
Covered by `plan.test.ts`/`job.test.ts`/`consultancyProfile.test.ts`'s
invalid-currency/-country tests, which exercise exactly this path (no
controller pre-check, so the schema validator + this fix are the only
thing standing between a bad value and a 500).

## Routes — public, no auth, pure reference data

- `GET /api/reference/countries` — `{isoCode, name, currency, phonecode}[]`.
- `GET /api/reference/countries/:countryCode/states` — 404s for an unknown
  country code; an empty array is a valid answer (no states in this
  dataset), not an error.
- `GET /api/reference/countries/:countryCode/cities` (optional
  `?state=<isoCode>` to scope it) — 404s for an unknown country code.
- `GET /api/reference/currencies` — `{code, digits}[]`.

No auth needed — this is the same data every signup/profile-creation form
needs before a user even exists, and there's nothing private about it.
