# Request validation with Yup, and template-driven Verification

Status: **shipped**. Two things landed together because the second one
needed the first: a first-layer request-validation convention using Yup
(new to this codebase), and a redesign of `Verification` so what's actually
required to verify a profile is data (a `VerificationTemplate`), not code.

## Why the first `Verification` design didn't survive contact

The original version baked Nigeria's COREN (engineering)/ARCON
(architecture) regulatory bodies directly into the schema —
`country`, `regulatoryBody`, `discipline`, `registrationNumber` as named
fields. Two problems, both structural, not cosmetic:

1. **"Registration number" isn't one thing.** A Nigerian engineer's COREN
   number, a Nigerian company's CAC number, and (eventually) a US
   contractor's state license number are different documents entirely —
   collapsing them into a single `registrationNumber` field was already
   wrong for a single country, let alone a platform-wide field.
2. **PolyGrid is not Nigeria-only.** Hardcoding one country's regulatory
   shape into the schema means every new country needs a code change and a
   deploy — the same mistake `Plan` deliberately avoided by being catalog
   data instead of a hardcoded tier enum.

So the fix follows that exact precedent: **what's required to verify a
profile is data, looked up at request time, not schema.**

## `VerificationTemplate` — the catalog entry

One document per `(profileType, country[, state])`, holding two things:

- `fields: ITemplateField[]` — the form. Each entry: `key`, `label`,
  `type` (`string | number | boolean | date | select | email | phone`),
  `required`, plus type-specific constraints (`pattern`/`minLength`/
  `maxLength` for strings, `min`/`max` for numbers and dates, `options` for
  selects).
- `documents: ITemplateDocument[]` — what files are required, each with a
  `type` (matches a `Verification.documents[].type` at submission),
  `label`, `required`, and `acceptedFormats` (`pdf`/`jpg`/`png`/`webp` —
  deliberately exactly the four formats `fileSignature.ts` can actually
  verify by magic bytes; no point declaring a format the upload pipeline
  can't recognize).

This is the **single source of truth for both sides**: the server builds a
Yup schema from `fields` to validate a submission
(`src/validators/templateFormSchema.ts`), and the frontend fetches the same
document (`GET /api/verification-templates/lookup?profileType=&country=&state=`)
to know what inputs to render — and, since the frontend is also React +
Yup, can build the *identical* client-side schema from the same field
definitions instead of hand-duplicating validation rules in two
codebases that could drift apart.

**Lookup**: exact `(profileType, country, state)` match first, falling back
to the country's nationwide default (`state: null`) if no state-specific
override exists. An admin configures a country once and only adds
state-level overrides where a location genuinely needs different
documents — most won't. No match at all is a real state (not an error to
work around): it means nobody's configured verification for that pillar
in that market yet, and both the lookup route and submission 404
accordingly.

**Never edited in place, only superseded**: `POST /api/verification-templates`
deactivates whatever active template already exists for that
`(profileType, country, state)` and creates the next `version`. Same
reasoning as `Plan` never being edited after a `Subscription` snapshots it
— a `Verification` stores the exact `templateId` it was validated against,
so it stays interpretable even after an admin tweaks the requirements
later. The unique index enforcing "one active template per combination" is
a `partialFilterExpression: { isActive: true }` compound index — the same
pattern already used for `Payment`'s uniqueness constraint, and for the
same reason (Mongo treats a bare `sparse` index's `null`s as colliding
platform-wide, which is wrong here too — `state: null` legitimately repeats
across many different `(profileType, country)` pairs).

## `Verification`'s new shape

Removed: `country` (flat), `regulatoryBody`, `discipline`,
`registrationNumber`, `additionalInfo`. Added:

```
location: { country, state? }   // what was submitted, kept as-is on the record
templateId: ObjectId            // the exact VerificationTemplate version validated against
form: Record<string, unknown>   // validated + cast against templateId.fields
```

`additionalInfo` (a free-form catch-all) is gone rather than kept alongside
`form` — `form` **is** the structured version of exactly what that field
was a placeholder for; keeping both would just be two schema-less places to
put the same information.

## Submission flow (`submitVerification`) — files arrive with the request

`POST /api/verifications` is `multipart/form-data`, not JSON. This is a
deliberate correction from an earlier version, which had the client call
`POST /api/files/private` first and then reference the result by `fileName`
in a separate JSON submission — that let a user accumulate private files
with nothing ever attached to them, exactly the problem the original
file-uploads design (see file-uploads-plan.md) was built to avoid
everywhere else. `Job.uploadContract` already got this right (the contract
file is attached directly on `POST /api/jobs/:id/contract`); Verification
didn't, and now does too:

0. **All non-file fields travel as one JSON-stringified `data` field**,
   alongside the real file attachments — `{profileType, profileId,
   country, state?, form}`. Multipart bodies have no native way to carry a
   nested object (multer doesn't reconstruct `location[country]`-style
   bracket notation for you), so rather than flattening everything into
   individually-named text fields, this mirrors house-maduekwe-backend's
   `shopItemHelper.parseMultipartData` (see its `shopItems` create/update
   routes) — the exact "structured fields + real files in one multipart
   request" shape HM already solved. `src/helpers/parseMultipartData.ts`
   is the reusable port of it (`JSON.parse(req.body.data)`, 400 on
   malformed JSON); any future controller with the same need — files plus
   real structure, not just flat strings — uses the same helper rather
   than reinventing it.
1. Identity fields — `profileType`, `profileId`, `country`, `state?` — are
   read off the parsed payload and checked manually (isKnownProfileType,
   `ObjectId.isValid`, presence), the same way they were before Yup existed
   in this codebase — there's no single static Yup schema to run as
   middleware ahead of a multipart body, so Yup still does the real
   validation work, just one step later, once the template is known.
2. Ownership check — same as before (`PROFILE_MODEL_REGISTRY[profileType]`,
   404/403 as appropriate).
3. `findActiveTemplate(profileType, country, state)` — 404 if nothing's
   configured yet for this profile type/location.
4. **`form` is a real nested object inside the parsed payload**, keyed by
   exactly the template's declared `fields[].key` (e.g. a property literally
   named `businessName`). `pickDefinedFields(form, template.fields.map(f =>
   f.key))` pulls out just those, then `buildFormSchema(template.fields)`
   (built fresh from the resolved template) validates and casts them —
   400 with every failing field at once (`abortEarly: false`) on failure.
5. **Each document is a file attached under a field name equal to the
   template's declared `documents[].type`** (e.g. a file field literally
   named `business_certificate`) — this is how a submission says which
   file fulfills which requirement, rather than a positional or
   client-labeled guess. `resolveAndSaveDocuments`
   (`verificationController.ts`):
   - Rejects outright (before touching disk) any attached field name that
     isn't a declared document type, and any type with more than one file.
   - Saves each matched file **one at a time** through the existing
     `uploadHandler`, scoped to that document's own `acceptedFormats`
     (translated to real mime types via `DOCUMENT_FORMAT_MIME`) — so a
     `business_certificate` field only ever accepts what that specific
     requirement allows, not the platform-wide default mime list.
   - A **required** document that's missing, or whose file fails to save
     (wrong format, corrupt bytes), is a blocking issue. An **optional**
     one that fails is dropped and reported as a non-blocking
     `documentWarnings` entry in the response instead (same "a bad
     attachment never fails the rest of the request" contract
     `updateUserProfile`'s `avatarWarnings` already established).
   - **If the submission ends up rejected, every file this same request
     already saved is deleted before responding** — otherwise a required
     document failing on attempt #2 of 2 would still leave attempt #1's
     file behind, unreferenced by anything, which is exactly the orphaned-
     file outcome this whole redesign exists to prevent. Only files saved
     *during this request* are ever touched; an older, superseded
     `Verification`'s files are permanent history and are never deleted.
6. Only then is the `Verification` record created — `form` holds the
   validated/cast value, and each `documents[]` entry is the real
   `mime`/`size` `uploadHandler` reported at save time plus `uploadedAt`,
   not a client-supplied guess.

A resubmission (recovering from a rejected attempt, or reacting to an
admin's rejection) means posting the whole multipart request again,
including files that succeeded last time — `Verification` records are
still permanent, immutable history, so there's no partial "finish filling
this one out" endpoint, deliberately, to avoid adding mutability to a model
built around never overwriting.

## The Yup convention, going forward

Two new pieces, meant to be reused everywhere a request touches the DB, not
just here:

- **`src/validators/validate.ts`** (`validateBody(schema)`) — a Yup schema
  run as Express middleware, before the controller. Casts, applies
  defaults, strips unknown keys, and — on failure — 400s with every
  invalid field at once instead of the first one only (what a frontend
  form actually needs for inline errors). One footgun already hit and
  fixed: a Yup `object()` field with **no declared shape** (like the
  now-fixed first draft of `form`) gets every key stripped out of it by
  `stripUnknown`, since none of its keys are "known." Anywhere a field's
  shape genuinely can't be declared statically (template-driven `form` is
  the only such case so far), it's typed `yup.mixed()` with a loose
  type-only `.test()` instead of `yup.object()`, and validated for real
  against its actual shape later once that shape is known.
- **`src/helpers/sanitize.ts`** (`pickDefinedFields`) — the second layer,
  for controllers that build a document from request data after Yup's
  shape check has already run: pull out only the accepted keys, and drop
  `undefined` (not sent) and `""` (a blank form field) — both mean "no
  value provided" and would otherwise silently overwrite an existing value
  during a partial update. `null` is left alone by default, since it's the
  one value that means something specific — "clear this field" — and a
  field that should support being explicitly reset opts in via
  `allowNull`.

Applied where the request shape allows a static schema
(`verificationTemplateValidator.ts`'s `createTemplateSchema`, and
`rejectVerification`'s plain-JSON body) and, for the genuinely dynamic
cases, via `templateFormSchema.ts`'s runtime schema builder
(`submitVerification`'s `form`, built fresh per-template — see above; its
multipart identity fields stay hand-checked, same reasoning). Not yet
retrofitted onto every older controller — that's incremental follow-up
work, not a blocking rewrite, and each controller can adopt it as it's
next touched.

## Routes added

- `POST /api/verification-templates` (admin) — create/supersede.
- `GET /api/verification-templates` (admin) — catalog listing, filterable
  by `profileType`/`country`/`isActive`.
- `GET /api/verification-templates/lookup?profileType=&country=&state=`
  (any authenticated user) — what the frontend calls before rendering a
  verification form; the exact same resolution `submitVerification` uses
  server-side.
