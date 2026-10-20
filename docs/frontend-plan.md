# PolyGrid — Frontend Specification

**For:** Google Stitch (AI UI design tool) and human review. Written so
either of you can read it standalone; hand Stitch one `## Section` at a
time if you'd rather design incrementally instead of all at once.

**Platform:** Responsive web — one set of pages, designed to work on a
phone browser and a laptop, not a separate native app.

**Visual direction:** led by color, not by a prescriptive layout
metaphor — §5 (Theming) gives the actual palette for Light and Dark,
extracted/sourced from real reference sites rather than described in
the abstract. Beyond the palette and the form-state spec in §3,
treat composition, motif, and page rhythm as open — the first pass at
this doc was too constraining for Stitch's first attempt, so from here
on, give it (and any human builder) room to interpret rather than a
fixed metaphor to follow literally. §A.1 (Home) does call out one
concrete structural steer — a hero section leads the page, full stop —
sourced from a specific reference site; everything past that is open.
Two concept marks exist (`docs/assets/brand/logo-concept-a.svg`,
`-b.svg`) but neither the final mark nor the exact typography is locked
in yet — see the open questions at the end of this doc.

**How to read the route notes:** every action below has a small
`→ METHOD /path` note. That's the backend endpoint it already calls —
it's there so you (or I) can double check nothing's being designed that
isn't actually built, not something Stitch needs to render. If a page
needs something with no route note, it's either a pure frontend concern
(a filter control, a tab) or flagged explicitly as a gap in §1.

---

## 0. Product context (read this before anything else)

**Four pillars, one account.** A single `User` can participate in all of
them — there's no separate signup per pillar:
1. **PolyGrid Engineering** — consultant marketplace (structural,
   geotechnical, hydraulic, architectural) + mentorship.
2. **PolyGrid Tenders** — a sealed project-bidding board, plus direct-hire
   of vetted contractors.
3. **PolyGrid Store** — a digital storefront (downloadable drafting
   files) and a separate physical materials marketplace.
4. **PolyGrid SiteForce** — a location-based job board, plus direct-hire
   of skilled/unskilled tradespeople.

**Two independent dimensions on every account:**
- **System role** (`systemRole`): `user` (everyone, default) / `admin` /
  `super_admin` (exactly one ever exists) / `customer_care` (mostly
  read-only access to review queues — one deliberate exception, see
  §1). This is what puts someone in the Admin Dashboard (§C) or not.
- **Persona** (`activeAccountType`, any `user` can flip this): `normal`
  (buyer/client — free, no subscription needed) or `business`
  (provider/vendor — needs a pillar-specific profile + an active
  subscription to be discoverable). A single account toggles between
  these; it's a mode switch, not two accounts.

**One subscription unlocks everything.** A user has at most one
subscription lineage (`Subscription`, with full history kept). If it's
currently active, *every verified business profile that account has,
across every pillar*, becomes searchable at once. Letting it lapse
doesn't delete anything — profiles just stop appearing in search until
it's renewed.

**Verification is the same shape everywhere.** Every business profile
(Consultancy/Contractor/Labor/Store/DigitalCreator/Client) has an
`isVerified` flag and a KYC-style submission flow. What's actually
required (which form fields, which documents) is **catalog data** per
`(profileType, country[, state])` — not hardcoded — so the submission
page is always "look up what's required for me right now, then render
that," never a fixed form.

**Profile status, not just verification**: every business profile also
has `status`: `active` (default) / `inactive` (the owner can toggle this
themselves — "I'm on a break") / `banned` (admin-only, hides the profile
page outright). `inactive` still shows the profile page; `banned`
doesn't.

---

## 1. Gaps from the last review — all closed now

Everything that used to be listed here as a backend gap has since been
built. Listed here so you know it's safe to design against, with the
route(s) each one actually added:

- **In-app notification feed.** A real `Notification` model/feed now
  exists — see the new §2 "Notification feed" shared pattern and §B.17.
  `→ GET /api/notifications` · `→ GET .../unread-count` · `→ PATCH .../:id/read` · `→ PATCH .../read-all`
- **Account-level suspend.** `User.accountStatus` (`active`/`suspended`)
  — independent of, and in addition to, any one profile's own ban. See
  §C.2.
  `→ PATCH /api/users/:id/account-status`
- **Review moderation.** Both a reversible soft-hide and a permanent
  delete now exist, plus a moderation-queue listing that includes hidden
  reviews. See the new §C.3b.
  `→ GET /api/reviews/moderation` · `→ PATCH .../:id/hide` · `→ PATCH .../:id/unhide` · `→ DELETE /api/reviews/:id`
- **Reported messages now have an action.** Admin/super_admin can mark a
  report resolved, optionally redacting the reported message's text in
  the same call. See §B.16/§C.12.
  `→ PATCH /api/messages/reports/:id/resolve`
- **Per-profile photo, all six pillars.** Consultancy/Contractor/Labor/
  Client profiles each got their own optional `avatar` field + upload
  endpoint, exactly like Store's logo and DigitalCreator's avatar
  already had. See the new §2 "Avatar fallback" shared pattern.
  `→ POST /api/consultancy-profiles/me/avatar` (and the contractor-/
  labor-/client-profiles equivalents)
- **SiteForce real geo search.** `?lat=&lng=&radiusKm=` on the job board
  now runs a real radius search and returns each result's `distanceKm`
  — never the listing's actual coordinates (that's still gated to an
  accepted applicant, same as before). See §B.11/§B.12 and the new §2
  "Location picker" pattern.
  `→ GET /api/job-openings?lat=&lng=&radiusKm=&category=&country=`
- **Tender board and SiteForce job board public teasers.** Both boards
  stay gated for real browsing (you still need to be an eligible,
  subscribed contractor/worker), but each now has a public,
  unauthenticated counts-only teaser — total open + a breakdown by
  category, never any individual listing's detail. See the new §A.18/
  §A.19.
  `→ GET /api/tender-projects/public-summary?country=` · `→ GET /api/job-openings/public-summary?country=`
- **A statistics route.** Generic "top N profiles" across any of the six
  profile types (consultants, contractors, workers, stores, digital
  creators, clients/posters), ranked by `ratingAverage`/`ratingCount`,
  plus an admin-only platform overview. See the new §A.1a and §C.15.
  `→ GET /api/stats/top-profiles?profileType=&country=&limit=` · `→ GET /api/stats/overview`

One thing still true as before:

- **Refund/payout request amounts are computed automatically**, not
  entered by the requester — don't put an amount field on either
  request form, only a reason/note.

---

## 2. Shared patterns — describe once, reuse on every relevant page

- **"Unavailable" state, not a 404.** A huge number of direct-view pages
  (consultant, contractor, worker, store, product, digital creator,
  digital product, client/poster, tender project, job opening) resolve
  the URL successfully but return `{ available: false, message }`
  instead of real content when the thing is banned, unverified, or not
  currently subscribed. Design one reusable "this isn't available right
  now" empty state, distinct from a real 404 (unknown id).
- **Pagination.** Nearly every list endpoint returns
  `{ data, pagination: { total, page, limit, totalPages } }`. One
  pagination component, reused everywhere.
- **Country/state/city/currency dropdowns.** Always sourced from
  `GET /api/reference/...` (countries, states-per-country,
  cities-per-country, currencies) — never hardcoded in the frontend, so
  they always match what the backend will actually accept.
- **File upload widget, two flavors.** (a) Public image (logo, avatar,
  preview image, portfolio photo) — simple drag/drop or file picker. (b)
  Private document (verification document, job contract, tender/job
  attachment) — same widget, but the result is a signed, short-lived
  download link, not a permanent public URL. Several endpoints accept
  one file *or* a base64 string *or* a remote URL for the same field —
  the widget should offer "upload a file" as the primary path and not
  worry about the other two.
- **Status badges.** Build one small badge component per enum and reuse
  it everywhere that enum shows up: profile status (active/inactive/
  banned), verification status (pending/approved/rejected), job status
  (pending_confirmation/active/completed/disputed/cancelled/closed),
  tender project status (open/awarded/closed/cancelled), bid/application
  status (pending/accepted/rejected/withdrawn), payment status
  (pending/success/failed/refunded/cancelled).
- **"Confirm with password or 2FA" pattern.** A few sensitive actions
  (payout account changes, 2FA toggle) require re-confirming identity —
  either the current password, or a 2FA code if enabled. One reusable
  confirmation modal, not duplicated per page.
- **Sealed lists.** Two places deliberately hide competing submissions
  from each other: tender bids (a contractor only ever sees their own
  bid + a bare running count; only the poster sees the full table) and
  job applications (same shape — poster sees everyone, an applicant sees
  only their own). Never build a "compare your bid to others" view for
  the submitting side.
- **Two-tier detail reveal.** SiteForce job openings show a rough
  version (area, pay, description) to any eligible worker, and unlock an
  exact version (address, map, contact info, attached files) only once
  that specific worker has been *accepted* (not just applied). Design
  the detail page to visually branch on this, not hide/show a few
  fields quietly.
- **Rating/reviews block.** Every profile type shows a denormalized
  `ratingAverage`/`ratingCount` plus a paginated review list
  (`GET /api/reviews?profileType=&profileId=`) — one reusable component
  embedded at the bottom of every profile page. Hidden reviews are
  already excluded server-side, so this list never needs its own
  moderation awareness.
- **Avatar fallback.** Consultancy/Contractor/Labor/Client profile pages
  show a photo even if the owner never uploaded a profile-specific one —
  the backend falls back to the account-level avatar (from Account
  Settings, §B.2) automatically on the single-profile-view endpoints.
  Design the picture slot as "show whatever `avatar` comes back, if
  anything" — don't build separate empty/fallback states per pillar, and
  don't expect this fallback on search/list result cards (those stay
  avatar-less by design, for performance). The profile's own upload
  endpoint always takes precedence once used.
- **Notification feed.** A bell icon (header, visible everywhere once
  logged in) showing an unread badge
  (`GET /api/notifications/unread-count`), opening a dropdown or a full
  page (`GET /api/notifications`) of past events — tender awards,
  SiteForce application decisions, verification decisions, a job stage
  marked done, a dispute resolved, a refund/payout decision. Clicking one
  marks it read (`PATCH /api/notifications/:id/read`); a "mark all read"
  action also exists. Live delivery over the same Socket.IO connection
  chat already uses — a `notification:new` event, same channel, no
  second socket needed.
- **Location picker (SiteForce job opening forms).** The backend only
  ever wants plain `{lat, lng}` numbers for `coordinates` — it has no
  opinion on how the frontend got them and needs no paid map API. Use a
  free option: **Leaflet.js + OpenStreetMap tiles** (no API key, no
  billing) for a click-to-drop-pin picker, with "use my current
  location" (browser geolocation) as the fast path and manual
  country/state/city or a pasted lat,lng pair as fallbacks for a poster
  who'd rather not share their exact location live. This is a frontend
  library choice only — nothing here changes any route or payload shape.
- **Public teaser, gated board.** Both the Tenders bidding board and the
  SiteForce job board follow the same shape: a public, unauthenticated
  counts-only page (open total + per-category breakdown, see §A.18/
  §A.19) that exists purely to show there's real activity, next to the
  actual board, which still 403s until the viewer has an eligible,
  subscribed profile. Never let the teaser page link directly into a
  specific listing — there isn't one to show.

---

## 3. Form components — states & specs

Every form control in this product — text input, textarea, select, date
select, checkbox, radio, toggle, multi-select/chips, the two file-upload
flavors from §2, search/filter inputs — is specified against the same
five states, so Stitch (or whoever builds this by hand) only ever
designs a component once per state, not once per page:

1. **Normal** — resting, unfocused. Empty fields show placeholder text
   in the muted/secondary text color; never rely on the placeholder as
   a label substitute — every field keeps its real label visible above
   or beside it even when empty.
2. **Filled / Selected** — has a value, not currently focused. A select
   shows the chosen option's label (not a placeholder); a date select
   shows the formatted date; a checkbox/radio shows its checked mark; a
   toggle shows its on position. Distinguish this from Normal mainly
   through the value itself, not a different border/background — unless
   the design specifically wants a "has a value" affordance (e.g. a
   filled vs. outline input look), keep the container identical so nothing
   jumps when a field goes from empty to filled.
3. **Active** — currently focused: keyboard tab-in, a click, or an open
   dropdown/date-picker panel. Gets the most visually assertive
   treatment — a focus ring/border in the accent color — meeting WCAG's
   visible-focus requirement. This is the one state that must never be
   dropped or left to the browser's default outline, since that default
   won't match either theme.
4. **Error** — failed validation, whether a client-side shape check or a
   400 from the matching backend endpoint. Border/icon in the semantic
   error color (never the brand accent — keep those two visually
   distinct), an inline error message directly below the field, and
   `aria-invalid`/`aria-describedby` wired to that message. Error can
   combine with Filled (a value was entered and it's still wrong) or
   with Normal (a required field left empty on submit) — design both
   combinations, not just one.
5. **Disabled** — not editable right now, and visually distinct from an
   empty Normal field. Covers: a field gated on another field (`state`
   disabled until `country` is chosen), a field locked by a business
   rule (self-service `status` can never reach `banned`), or a submit
   button while its request is in flight. Lower contrast/reduced
   opacity, never the same visual weight as Normal, and never
   focusable.

**Two controls get an extra note, since this product's selects and
dates are narrower than a generic form library's:**

- **Select.** Every select here (specialization, specialty, skill(s),
  category, country/state/city, pay type, employment type, profile
  type, …) is a closed enumerated list straight from a model's own
  `Object.values(ENUM)` or a `GET /api/reference/...` lookup — never
  free text, and never a list the frontend invents on its own. Only add
  search/typeahead once a list is long enough to need it (country,
  state, city); the short fixed enums (specialization, category,
  status) are fine as a plain dropdown.
- **Date select.** Every date here (`startedAt`/`completedAt` on a
  portfolio item, `applicationDeadline`, …) is a calendar date with no
  time component — one calendar-picker control is enough, don't build
  separate day/month/year dropdowns. `completedAt` must visually carry
  the "can't be before `startedAt`" rule the backend already enforces —
  grey out the earlier dates once `startedAt` is picked, rather than
  only surfacing that as an Error state after submit.

Reuse this same five-state spec for the two file-upload flavors from
§2: Normal = empty dropzone, Filled/Selected = the attached file's name
plus a thumbnail for images, Active = drag-hover highlighted, Error =
wrong file type/too large with the specific reason shown inline,
Disabled = the relevant cap already reached (`MAX_PORTFOLIO_ITEMS`,
`MAX_MEDIA_PER_ITEM`, `MAX_OPENING_FILES`, …).

---

## 4. Build roadmap — phases, priority, and Stitch vs. hand-built

Some pages are good first-pass candidates for Stitch — it's strong at a
static visual layout, weaker at an interactive state machine; others
are easier to just hand-build directly against the state spec in §3.
"Priority" here means "what has to exist before the next phase is even
testable," not importance in the abstract — Phase 0 blocks everything
else, so it goes first regardless of how exciting it is.

| Phase | Contents | Priority | Stitch? | Why |
|---|---|---|---|---|
| **0 — Foundation** | Theming tokens (§5), the form-component state set (§3), shared patterns (§2): pagination, the "unavailable" state, status badges | Must exist first — every later phase reuses it | Yes, for the static look of each state; the state *logic* (which state fires when) is hand-built regardless | Doing this once, correctly, is what stops every later page from reinventing its own input/button/badge look |
| **1 — Public / Basic View (§A)** | Home, Register, Login, Forgot/Reset, all four pillars' browse + profile pages, the two public board teasers (§A.18/§A.19), the top-rated strip (§A.1a) | Highest — nobody can sign up or be found without it | Yes — these are mostly static/read-only pages, Stitch's strongest case | Conversion-facing, first impression, worth the most visual polish per hour spent |
| **2 — Account & Business Profile core (§B.1–B.5)** | Dashboard Home, Account Settings, Business Profile Hub + all six profile editors, Verification Center, Subscription & Billing | High — a provider can't go live without this | Mixed — the editors' forms are good Stitch candidates (apply §3 directly); Verification Center's "look up what's required, render that" dynamic form isn't a static layout — build that one by hand | Everything downstream (posting a tender, applying to a job, selling a product) needs a verified, subscribed profile first |
| **3 — Transactional dashboard (§B.6–B.17)** | My Jobs, Tenders both sides, SiteForce both sides (incl. geo search/location picker), Store Orders, Digital Purchases, Contacts, Messages, Notifications | High — this is the actual product | No, mostly hand-built | Sealed bidding/applications, the two-tier reveal, real-time chat, and the live notification feed are all interaction-heavy; a static Stitch mock would need near-total rebuilding anyway |
| **4 — Admin Dashboard (§SECTION C)** | Everything in §C, including review moderation (§C.3b) and platform stats (§C.15) | Lower — internal-only; can trail Phase 3 a little if the team handles moderation manually/via API meanwhile | Yes — data-table-heavy utility screens are a fast, low-risk Stitch case; visual polish matters least here | Nobody outside the team ever sees these pages |

This isn't strict phase-by-phase with zero overlap — §0 and the first
few §1 pages (Home, Register, Login) can go into Stitch the same week.
It means: don't start §B.6's job detail page before §B.3's profile
editors exist, since the former needs a real profile to test against.

---

## 5. Theming

Two themes for now — **Light** and **Dark** — built on one shared token
*structure* from day one, so a future seasonal theme (x-mas, Easter, …)
is a palette swap, not a rebuild. This section leads with color,
deliberately — the previous version of this section described a mood/
metaphor ("blueprint sketch," "folded paper panels") instead of giving
real values, and that was too constraining for Stitch to work from.
What follows is sourced from four real reference images instead
(saved under `docs/assets/inspiration/`), with concrete starting hex
values. Composition, motif, and how literally any one reference gets
followed are all open — see the intro's Visual direction note.

### 5.1 Reference images

- `dark-theme-inspiration-halden.jpg` — a dark fraud-detection SaaS
  landing page. Source for the **Dark** theme's near-black surfaces and
  its warm red-orange accent (used there for data-viz dots and
  highlight numbers against the dark background).
- `dark-theme-inspiration-accent-grid.webp` — a 2x2 brand-reference
  grid: a black-and-white portrait, a glossy orange-red abstract 3D
  mark, and a dark dashboard mockup with the same orange accent.
  Reinforces the same red-orange accent family and shows it paired with
  monochrome photography and a near-black dashboard UI.
- `light-theme-palette.png` — a direct 4-color palette (not a UI
  screenshot) — see §5.2 below, used as-is rather than extracted by eye.
- `home-page-style-reference-exery.webp` — a dark e-commerce homepage
  (leather goods brand). Structural reference for §A.1 Home (hero
  section first, trust-badge row, alternating image/text feature
  blocks, bold condensed headline type) and another real sample of the
  same warm orange accent on a dark/black UI.

### 5.2 The two themes — palettes

**Light** — taken directly from `light-theme-palette.png`, a 4-color
set, used as given rather than reinterpreted:

| Token | Hex | Role |
|---|---|---|
| `neutral-50` (background) | `#F7F7F7` | Page background |
| `neutral-100` (surface) | `#EEEEEE` | Card/elevated surface, default border |
| `neutral-900` (ink) | `#393E46` | Primary text, dark UI elements |
| `neutral-500` (muted) | `#929AAB` | Secondary text, placeholder, muted border |

That palette has no accent color in it on its own — it's four
neutrals. Pull the brand accent (below) in on top of it for anything
that needs to read as "clickable" or "active."

**Dark** — estimated by eye from the three dark-theme references above
(not pixel-sampled — treat these as a starting point to fine-tune with
an actual eyedropper against the saved files, not final locked values):

| Token | Hex (approx.) | Role |
|---|---|---|
| `neutral-900` (background) | `#0B0D12` | Page background — near-black, faint cool undertone |
| `neutral-800` (surface) | `#14171F` | Card/elevated surface |
| `neutral-50` (ink) | `#F2F2F2` | Primary text |
| `neutral-400` (muted) | `#9CA3AF` | Secondary text, muted border |

**Shared brand accent** — the one color family all three dark
references and the Exery home-page reference converge on
independently: a warm red-orange. Estimated starting values, same
caveat as Dark above:

| Token | Hex (approx.) | Role |
|---|---|---|
| `accent-default` | `#FF5B3D` | Primary actions, active/focus state (§3), links |
| `accent-emphasis` | `#E8482C` | Hover/pressed on top of `accent-default` |
| `accent-subtle` | `#FF8C70` | Tints/backgrounds behind accent content, light-mode-friendly variant |

Use the same three accent tokens in both themes to start — re-tune
`accent-default` per theme only if contrast testing says it has to
(a vivid coral that pops on near-black in Dark may need to shift
slightly for comfortable contrast against Light's `#F7F7F7`).

### 5.3 Token groups

Each theme is the same flat set of token *names* (as tabulated above),
with different values per theme — this is what makes "add a theme" a
one-file palette swap instead of a hunt through every component. Group
by role, not by raw color family:

- **Color — Neutral scale.** The four-to-five-step ramp from §5.2
  (background → surface → muted → ink), extended with a couple more
  intermediate steps as real components need them.
- **Color — Brand/Accent.** `accent-default` / `accent-emphasis` /
  `accent-subtle` from §5.2 — carries both "this is clickable" and
  "this is active" in different places (e.g. a selected nav item that's
  also hoverable), so needs both a resting and a pressed/hover value.
- **Color — Semantic/status.** Success, warning, error, info — kept
  visually distinct from the brand accent in both themes (see §3's
  Error state note) and tuned per theme for contrast, not shared
  verbatim between Light and Dark. Not sourced from a reference image;
  pick standard, accessible values and move on.
- **Color — Surface.** Background, elevated surface/card, overlay/modal
  scrim — at least two elevation steps per theme (`neutral-50`/
  `neutral-100` in Light, `neutral-900`/`neutral-800` in Dark).
- **Color — Text.** Primary (`ink`), secondary/muted, placeholder,
  inverse (text-on-accent, e.g. a button label), link (`accent-default`).
- **Color — Border.** Default (`neutral-100`/`neutral-800`), focus
  (`accent-default` — see §3's Active state), error (semantic error
  color).
- **Color — Interactive state overlays.** Hover, active/pressed,
  disabled — ideally as an opacity/overlay rule applied on top of a
  base color rather than a fully separate hand-picked color per state,
  so a new component automatically gets correct hover/disabled
  behavior for free.
- **Typography.** Not finalized — direction only: a technical/
  industrial-leaning sans-serif, comfortable at both a bold condensed
  display size (hero headlines, per the Exery reference) and a smaller
  UI size. Exact family is an open question below.
- **Spacing / radius / elevation.** Not finalized yet either; flagged
  here so the token file has a slot for them once decided, rather than
  being bolted on later as inline values.

### 5.4 Brand marks (concept stage)

Two concept marks exist, AI-generated drafts with no final palette
chosen — treat both as directional, not decided:

- `docs/assets/brand/logo-concept-a.svg` — a two-tone mark (rust
  `#BE7745` + dark navy `#12263E` in the draft file).
- `docs/assets/brand/logo-concept-b.svg` — a single-tone mark (dark navy
  `#0D2038` in the draft file).

Those hex values are whatever the generation tool happened to output —
not the chosen brand palette; re-color both to the real
`accent-default` (or a `currentColor` single-tone version, so the mark
sits on either theme's ink color without a separate light/dark export)
once §5.2's estimates are confirmed. Don't treat either file's current
colors as final anywhere in the frontend build.

---

## SECTION A — Public / Basic View

No login required (a couple of pages still make sense logged-in, noted
inline). This is "go find and search for what you need."

### A.1 Home
**Purpose:** entry point — explain the four pillars, route into each
one's search/browse page, and into Register/Login.
**Layout:** a hero section leads the page, before anything else —
that's the one non-negotiable structural rule here, per
`docs/assets/inspiration/home-page-style-reference-exery.webp`
(§5.1). Past the hero, loosely follow that same reference's rhythm:
trust-badge/logo row, then alternating image/text feature blocks (one
per pillar works well — Engineering, Tenders, Store, SiteForce — each
getting its own section rather than being squeezed into a 4-up card
grid), a closing CTA band, footer. Treat the exact section order/count
past the hero as open — it's a reference for *feel and rhythm*, not a
section-by-section template to copy exactly. Secondary nav: Register,
Login.

### A.1a "Top rated" strip (Home + any browse page)
Optional, reusable: "Top 5/10" cards for any one profile type, ranked by
rating — e.g. "Top Consultants," "Top Contractors," a row of each on
Home, or one focused row at the top of a given browse page (A.5/A.7/
A.15). Public, no auth.
`→ GET /api/stats/top-profiles?profileType=ConsultancyProfile&country=&limit=10`
(`profileType` is any of `ConsultancyProfile`/`ContractorProfile`/
`LaborProfile`/`StoreProfile`/`DigitalCreatorProfile`/`ClientProfile`)

### A.2 Register
Email + password, or continue with Google/Apple. Fields: full name,
email, password, phone number (number + country).
`→ POST /api/users` · `→ POST /api/users/social/google` · `→ POST /api/users/social/apple`

### A.3 Login
Email + password (plus a 2FA code field that only appears if the account
has 2FA enabled — the backend will say so), or continue with
Google/Apple.
`→ POST /api/users/login` · social equivalents as above

### A.4 Forgot / Reset Password
Two steps: request a reset link by email (always shows the same generic
confirmation, regardless of whether the email exists), then set a new
password from the emailed link/token.
`→ POST /api/users/request-reset` · `→ POST /api/users/reset-password`

### A.5 Browse Consultants (PolyGrid Engineering)
**Layout:** filter sidebar (specialization, country) + result cards
(headline, specialization, rating, country) + pagination.
`→ GET /api/consultancy-profiles?specialization=&country=`

### A.6 Consultant Profile Page
Headline, bio, specializations, years of experience, links, services
offered, mentorship availability, portfolio gallery (title/description/
tags/images per item), rating/review block. "Unavailable" state if
banned/unsubscribed.
`→ GET /api/consultancy-profiles/:idOrSlug`

### A.7 Browse Contractors (Tenders — Direct Hire)
Same layout as A.5, filter is `specialty` (not `specialization` — the
two pillars use different field names despite looking parallel).
`→ GET /api/contractor-profiles?specialty=&country=`

### A.8 Contractor Profile Page
Same shape as A.6 (portfolio, rating/reviews). No "hire" button here
beyond linking into the authenticated Job flow (§B.6) once logged in.
`→ GET /api/contractor-profiles/:idOrSlug`

### A.9 Browse Stores (PolyGrid Store — Physical)
**Store-first**, not a flat product list — this is the one deliberate
difference from the Digital feed (A.12). Filter sidebar (material
category, country) + store cards, each showing a small preview of
matching products.
`→ GET /api/store-profiles?category=&country=`

### A.10 Store Page
Store name/bio/logo/categories, then its full catalog — filterable by
category/sub-category within the store.
`→ GET /api/store-profiles/:idOrSlug?category=&subCategory=`

### A.11 Product Page (Physical)
One product's detail — title, price, images, shipping info, stock
status. Gated on the owning store's live subscription, same
"unavailable" pattern.
`→ GET /api/products/:id`

### A.12 Digital Feed (PolyGrid Store — Digital)
**Flat, cross-creator**, TikTok/YouTube-style scroll — not store-first.
Filter by category; each card shows the product + its creator's name/
avatar/slug.
`→ GET /api/digital-products/feed?category=`

### A.13 Digital Creator Page
Creator's profile (displayName/bio/avatar) + their active, verified
products, paginated.
`→ GET /api/digital-creator-profiles/:idOrSlug`

### A.14 Digital Product Page
Title/description/price/preview images. No download here (that's
purchase-gated, §B.14) — this page is discovery/marketing only, with a
"Buy" action that routes into checkout once logged in.
`→ GET /api/digital-products/:id`

### A.15 Browse Workers (PolyGrid SiteForce — Direct Hire)
Same layout as A.5/A.7. Filter: skill, country.
`→ GET /api/labor-profiles?skill=&country=`

### A.16 Worker Profile Page
Same shape as A.6/A.8 — portfolio, skills, rating/reviews.
`→ GET /api/labor-profiles/:idOrSlug`

### A.17 Client / Poster Profile Page
A poster's reputation page — only ever reached by following a link from
a job/project/opening (there's no search/browse for this one; posters
aren't discoverable content on their own). **Never gated by subscription
or verification** — only a ban hides it. Shows displayName/bio/rating/
reviews.
`→ GET /api/client-profiles/:id`

### A.18 Tenders — Public Teaser
**Purpose:** show that the bidding board has real activity, without
exposing a single project to a visitor who isn't an eligible,
subscribed contractor yet. Counts only — total open projects + a
per-category breakdown — with a clear "become eligible to see them" call
to action into Register/the Contractor Profile editor (§B.3b). Don't
link any count to an actual project; there's nothing to link to here.
`→ GET /api/tender-projects/public-summary?country=`

### A.19 SiteForce — Public Teaser
Same shape as A.18, for the job board.
`→ GET /api/job-openings/public-summary?country=`

---

## SECTION B — User Dashboard (logged in)

Everything behind login. Organized by concern, not strictly by pillar,
since several things (profiles, verification, subscription) are shared
machinery across all four pillars.

### B.1 Dashboard Home
**Purpose:** the landing page right after login. Lead with the
notification bell's recent items (§2's "Notification feed" pattern) —
tender awards, SiteForce application decisions, verification decisions,
job stage/dispute/refund/payout events. Below that, still surface
"things that need you" pulled live from the queues that already exist
(unconfirmed jobs, pending bids/applications on things you posted,
unread conversations, your verification status if pending/rejected) —
the notification feed tells you something *happened*; these queues are
what's still *waiting on you*, which the feed doesn't cover. Plus quick
links into every section below.

### B.2 Account Settings
One page, several sections:
- **Profile**: full name, phone, avatar (image/base64/url, exactly one
  source — extra sources produce a soft warning, not a failure).
  `→ PUT /api/users/profile`
- **Password**: change password (needs current password).
  `→ PUT /api/users/profile`
- **Payout account**: bank details a provider needs on file before any
  payout request can be approved — account name/number, bank name,
  optional bank code, country. Behind the confirm-identity pattern.
  `→ PUT /api/users/payout-account`
- **Two-factor authentication**: set up (shows a QR code), verify with a
  6-digit code to enable, toggle on/off later (behind confirm-identity).
  `→ POST /api/users/2fa/setup` · `→ POST /api/users/2fa/verify` · `→ PUT /api/users/2fa/toggle`
- **Persona switch**: normal ↔ business toggle.
  `→ PATCH /api/users/account-type`
- **Log out everywhere**: invalidates every issued session at once.
  `→ PATCH /api/users/invalidate`

### B.3 Business Profile Hub
A switcher/overview: which business profile(s) does this account have
(Consultancy/Contractor/Labor/Store/DigitalCreator/Client), and a
"create" card for any pillar it doesn't have yet. Each existing profile
shows its verification + status + subscription-eligibility at a glance,
linking into its own editor below.

#### B.3a Consultancy Profile Editor
Create/edit headline, bio, specializations, country/city, years of
experience, links, services, mentorship availability, and the
active/inactive status toggle (never `banned` here — that's admin-only).
An optional profile photo upload — shows a preview of whichever avatar
is currently in effect (this profile's own if set, else the
account-level one from §B.2, else empty — see §2's "Avatar fallback"
pattern) with a simple "replace" action, not a separate "remove" one.
Portfolio manager below it: add/edit/remove portfolio items (title,
description, tags, start/completion dates), each with its own image
gallery (add/remove individual images, cap 6 per item, cap 20 items
total).
`→ POST /api/consultancy-profiles` · `→ PATCH /api/consultancy-profiles/me` · `→ POST .../me/avatar` · `→ POST .../me/portfolio` · `→ POST .../portfolio/:itemId/media` · `→ DELETE .../media/:fileName` · `→ DELETE .../portfolio/:itemId`

#### B.3b Contractor Profile Editor
Identical shape to B.3a, including the avatar upload (field name is
`specialty`, not `specialization`).
`→ POST /api/contractor-profiles` · `→ POST .../me/avatar` · same portfolio routes under `/contractor-profiles/me`

#### B.3c Labor Profile Editor
Same shape again, including the avatar upload (skill(s), not
specialization/specialty).
`→ POST /api/labor-profiles` · `→ POST .../me/avatar` · same portfolio routes under `/labor-profiles/me`

#### B.3d Store Profile Editor + Products
Store name/bio/country/categories (choosing categories determines what
products the store can sell — removing a category cascade-deletes any
products under it, including their images, so the category editor
should warn clearly before a removal), logo upload. Below it: a product
manager — create/edit/delete products (title, price, category, unit,
shipping locations, stock status), each with an image gallery (add/
remove individual images).
`→ POST /api/store-profiles` · `→ PATCH /api/store-profiles/me` · `→ POST .../me/logo` · `→ POST .../me/products` · `→ PATCH/DELETE .../me/products/:id` · `→ POST .../products/:id/images` · `→ DELETE .../images/:fileName`

#### B.3e Digital Creator Profile Editor + Products
Display name/bio/country, avatar upload. Below it: a product manager —
create products (title/description/price/category, preview images
[public], deliverable files [private, required]); edit fields and the
active/inactive toggle (**there's no delete** — deactivating is the only
removal, by design, so past buyers keep their access); separately manage
preview images (add/remove) and deliverable files (add/remove — removal
is a ~1-day soft-delete grace period, not instant). Each product should
show its own verification status clearly (see §1's note — a product
needs *both* creator verification/subscription *and* its own admin
verification before it appears in the public feed; "pending admin
review" is a real, expected state to surface here, not an error).
`→ POST /api/digital-creator-profiles` · `→ PATCH .../me` · `→ POST .../me/avatar` · `→ POST .../me/products` · `→ PATCH .../me/products/:id` · `→ POST/DELETE .../preview-images[/:fileName]` · `→ POST/DELETE .../files[/:fileName]`

#### B.3f Client Profile Editor
Display name, bio, country/city, active/inactive toggle, and the same
optional avatar upload as B.3a (falls back to the account avatar until
set). This is the *poster* identity — needed before this account can
post a Tender project or a SiteForce job opening (see B.7, B.10).
`→ POST /api/client-profiles` · `→ PATCH /api/client-profiles/me` · `→ POST .../me/avatar`

### B.4 Verification Center
For whichever profile needs it: look up what's required
(`profileType`+country[+state]) → render that exact form (the fields and
required documents are catalog data, never hardcoded) → submit the form
answers + one file per required document in one go. Below the form: a
history of every past submission for this profile (including old
rejections — nothing is ever overwritten), each showing its status
(pending/approved/rejected) and, if rejected, why. Resubmitting means
filling out and submitting the whole form again, not editing a draft.
`→ GET /api/verification-templates/lookup?profileType=&country=&state=` · `→ POST /api/verifications` · `→ GET /api/verifications/me`

### B.5 Subscription & Billing
Current plan (or none), its status/expiry. A plan comparison (catalog —
tier, privileges, duration, price) with a "Subscribe" action that starts
real checkout. Subscription history (every past subscription, not just
the current one). Payment history (every charge, any target type).
`→ GET /api/plans` · `→ GET /api/subscriptions/current` · `→ GET /api/subscriptions/me` · `→ POST /api/payments/intent` (`targetType: "Subscription"`) · `→ GET /api/payments/me`

### B.6 My Jobs
**Jobs are the cross-pillar trust/escrow tool** — created directly
between two people (hiring a contractor/worker/consultant, or generated
automatically from a Tender award, a SiteForce acceptance, or a Store
order), never subscription-gated.
- **List**: filterable by status, light summary cards.
  `→ GET /api/jobs/mine?status=`
- **Detail**: full stage breakdown, both parties, amount history, signed
  contract links. Actions, shown contextually by role/status: confirm
  (the non-creator locks the job in), edit (creator, pre-confirmation
  only), cancel (creator, pre-confirmation only), propose new stages
  (either side), accept/reject proposed stages (the other side), mark a
  stage done (provider), verify a done stage (client — this is what
  actually releases that stage's share of escrow), upload/replace a
  contract file, raise a dispute, request a refund (client) or a payout
  (provider) — both as a reason/note only, never an amount (§1).
  `→ GET /api/jobs/:id` · `→ PATCH /api/jobs/:id` · `→ PATCH .../confirm` · `→ PATCH .../cancel` · `→ POST .../stages/propose` · `→ PATCH .../stages/accept` · `→ PATCH .../stages/reject` · `→ PATCH .../stages/:stageId/done` · `→ PATCH .../stages/:stageId/verify` · `→ POST .../contract` · `→ PATCH .../dispute` · `→ POST .../refund-requests` · `→ POST .../payout-requests`
- **Create a job** (the generic "hire someone directly" action, used
  from a Contractor/Consultant/Worker profile page or anywhere else two
  users want to track paid work): counterparty, your role
  (client/provider), title/description, job type, total amount +
  currency, optional stage breakdown (omit for one simple 100% stage).
  `→ POST /api/jobs`

### B.7 Tenders — My Posted Projects (poster side)
Requires a verified, active, subscribed Client Profile (B.3f) first —
show that gate clearly if missing. List of everything you've posted, any
status. Create/edit a project (title, description, specs, budget,
category, attached files — specs/drawings/photos, cap 10) while still
open; cancel it (auto-rejects any pending bids).
`→ GET /api/tender-projects/me` · `→ POST /api/tender-projects` · `→ PATCH /api/tender-projects/:id` · `→ POST/DELETE .../files[/:fileName]` · `→ PATCH .../cancel`

### B.8 Tenders — Browse Open Board + My Bids (contractor side)
Requires a verified, active, subscribed Contractor Profile — the board
itself 403s otherwise, so show the "become eligible" gate (linking into
B.3b), not an empty list — the public teaser (§A.18) is what a
not-yet-eligible visitor sees instead. Browse open projects (filter:
category, country). Separately: a flat "my bids across every project"
list.
`→ GET /api/tender-projects?category=&country=` · `→ GET /api/tender-projects/bids/mine`

### B.9 Tender Project Detail
Branches hard by role:
- **As the poster**: full detail + the complete bid table (every bid,
  amount, contractor) + an "Award" action on any pending bid (rejects
  every other pending bid, spins up a real Job).
  `→ GET /api/tender-projects/:id` · `→ GET .../bids` · `→ PATCH .../award`
- **As a contractor**: full project detail, but bids are sealed — you
  only ever see *your own* bid plus a bare running count of total bids
  (never other contractors' amounts). Submit a bid (blocked: bidding on
  your own project, bidding twice), revise your pending bid, or withdraw
  it.
  `→ GET /api/tender-projects/:id` · `→ POST .../bids` · `→ PATCH .../bids/mine` · `→ PATCH .../bids/mine/withdraw`

### B.10 SiteForce — My Postings (poster side)
Same shape as B.7, for job openings instead of tender projects: list,
create/edit (title, description, category, workers needed, pay rate/
type, currency, employment type, general area, **exact location** via
the Leaflet/OpenStreetMap picker from §2, application deadline, attached
files), cancel.
`→ GET /api/job-openings/me` · `→ POST /api/job-openings` · `→ PATCH /api/job-openings/:id` · `→ POST/DELETE .../files[/:fileName]` · `→ PATCH .../cancel`

### B.11 SiteForce — Browse Job Board + My Applications (worker side)
Same shape as B.8 (public teaser at §A.19, eligibility gate links into
B.3c). Two ways to search: the plain filters (category, country), or a
"search near me" mode — browser geolocation by default, with a manual
pin/coordinate entry fallback (§2's "Location picker" pattern) — which
calls the same endpoint with `lat`/`lng`/`radiusKm` and sorts results by
`distanceKm`. Never shown: the listing's actual coordinates — that stays
gated per §B.12.
`→ GET /api/job-openings?category=&country=` · `→ GET /api/job-openings?lat=&lng=&radiusKm=` · `→ GET /api/job-openings/applications/mine`

### B.12 Job Opening Detail — the two-tier reveal
**Design this branch visibly, not as a few hidden fields.**
- **Rough tier** (shown to the poster, any admin, or any eligible
  worker — whether or not they've applied): title, description,
  category, workers needed/filled, pay, employment type, **general
  area** (country/state/city — no exact address), deadline, status.
- **Exact tier** (unlocked only for the poster, an admin, or a worker
  whose application has been *accepted* — merely applying is not
  enough): exact coordinates, address, a map link, contact info, and any
  attached files.
Actions for a worker: apply, revise my application, withdraw it. Actions
for the poster: see every application (sealed from other applicants,
same as tender bids), accept one (spins up a Job, auto-fills/rejects the
rest once the worker count is met), reject one.
`→ GET /api/job-openings/:id` · `→ POST .../applications` · `→ PATCH .../applications/mine` · `→ PATCH .../applications/mine/withdraw` · `→ GET .../applications` · `→ PATCH .../applications/:id/accept` · `→ PATCH .../applications/:id/reject`

### B.13 Store Orders
- **As a buyer**: checkout from a store's catalog (select items, a
  shipping destination, optional note — the backend resolves per-item
  shipping and will reject per-item if something can't ship to that
  destination, so surface that per line, not as one generic error), then
  an order history list, each linking to its underlying Job (B.6) for
  payment/confirmation status.
  `→ POST /api/store-orders` · `→ GET /api/store-orders/mine`
- **As a seller**: the orders your store has received.
  `→ GET /api/store-orders/store`

### B.14 Digital Purchases
- **Checkout**: start a purchase from a product page (A.14).
  `→ POST /api/payments/intent` (`targetType: "DigitalPurchase"`)
- **My purchases**: history list. Note: title/category/preview image are
  read live off the current listing (so a deactivated/cleaned-up listing
  can show blank there), while price/status/date are permanently
  snapshotted on the purchase itself and always display correctly.
  `→ GET /api/digital-purchases/mine`
- **Download Center**: for a completed purchase, mint download links for
  *your own* copy of the files — this never depends on the live product
  still existing. Two expected non-error states: "retention period
  ended" (your copy was cleared because your subscription lapsed a while
  back) and "still being prepared" (rare, retry shortly).
  `→ GET /api/digital-purchases/:id/download`

### B.15 Contacts
List of connected contacts (created automatically whenever you start a
Job with someone, or add manually by user id/email), remove one from
your own list (one-directional — doesn't remove you from theirs).
`→ GET /api/contacts` · `→ POST /api/contacts` · `→ DELETE /api/contacts/:userId`

### B.16 Messages
Conversation list (other participant, last message preview, unread
count) → a conversation thread (paginated history, send a plain-text
message, mark read). Real-time delivery over Socket.IO (connect with the
same JWT; new messages arrive as a `message:new` event — no typing/
presence indicators exist, don't design for them). Can only message an
existing Contact — starting one with a non-contact is blocked. A report
action on an individual message (reason only) — moderation of the
report itself (resolve, optionally redact the message) is admin-side
only, see §C.12; the reporter never sees that outcome directly.
`→ GET /api/conversations` · `→ POST /api/conversations` · `→ GET .../:id/messages` · `→ POST .../:id/messages` · `→ PATCH .../:id/read` · `→ POST /api/messages/:id/report`

### B.17 Notifications
The bell icon's full-page view (§2's "Notification feed" pattern) —
paginated list, each item showing its type/message/date and whether
it's been read, with a "mark all read" action. Clicking an item should
deep-link into whatever it's about (a job, a verification, a tender
project) using the `data` payload each notification carries.
`→ GET /api/notifications` · `→ PATCH /api/notifications/:id/read` · `→ PATCH /api/notifications/read-all`

---

## SECTION C — Admin Dashboard

For `admin`, `super_admin`, and `customer_care`. **customer_care is
mostly read-only** — it can view every queue below, but can only ever
*act* on one of them (digital product verification). Design every queue
page to work in a read-only "viewer" mode when the logged-in role is
customer_care, hiding the action buttons that role can't actually use —
except on the one queue where it can.

### C.1 Admin Home
Queue counts at a glance (pending verifications, open disputes, pending
refund/payout requests, pending digital-product-verification items,
pending message reports, hidden-but-not-deleted reviews) with links into
each. Same "surface what needs attention" instinct as B.1 — plus a
platform-overview snapshot, see §C.15.

### C.2 User Management — super_admin only
List/filter/paginate every user (by role, by id). Create a new admin or
customer_care account. Change any user's role (can't change your own, or
another Super Admin's). Suspend or reinstate any user's account
(`accountStatus`) — independent of any profile-level ban (§C.3) — with
the same can't-touch-yourself, can't-touch-another-Super-Admin guards as
the role change.
`→ GET /api/users` · `→ POST /api/users/admin-create` · `→ PATCH /api/users/:id/role` · `→ PATCH /api/users/:id/account-status`

### C.3 Profile Moderation — admin/super_admin only (not customer_care)
One generic tool across all six profile types: find a profile (by type +
id), ban or unban it. Banning hides that profile's public page outright;
unbanning restores it to `active`.
`→ PATCH /api/admin/profiles/:profileType/:id/status`

### C.3b Review Moderation — admin/super_admin only (not customer_care)
Look up a profile's reviews (by `profileType` + `profileId`, same
params as the public review block, §2) in a moderation view that — unlike
the public one — includes hidden reviews with who hid them, when, and
why. Two actions per review: **hide** (reversible — asks for an optional
reason, immediately backs its rating out of the profile's
`ratingAverage`/`ratingCount` and drops it from the public list) or
**unhide** (puts it back, reapplies the rating). A separate, clearly
more destructive **delete** action removes the review permanently — no
undo, so give it its own confirmation step distinct from hide's.
customer_care can view this queue but none of the three actions render
for that role.
`→ GET /api/reviews/moderation?profileType=&profileId=` · `→ PATCH .../:id/hide` · `→ PATCH .../:id/unhide` · `→ DELETE /api/reviews/:id`

### C.4 Verification Review Queue
List, filterable by status/profileType, showing each submission's full
detail inline or in a side panel (requester name/email, location,
template version, submitted form answers, each document with its file
link). customer_care can browse this list and open any record, but the
approve/reject buttons only render for admin/super_admin.
`→ GET /api/verifications` · `→ PATCH .../:id/approve` · `→ PATCH .../:id/reject` (reason required)

### C.5 Verification Template Manager — admin/super_admin only
List every template (filter by profileType/country/active), including
old superseded versions. Create a new one for a `(profileType, country[,
state])` combo — this is also how you "retire" the current one, since
creating a replacement is the only way a template ever deactivates
(there's no separate deactivate/edit action). Design the create form to
make this version-bump behavior clear, not look like a quiet edit-in-
place.
`→ GET /api/verification-templates?profileType=&country=&isActive=` · `→ POST /api/verification-templates`

### C.6 Digital Product Verification Queue
The one queue customer_care can actually act on, not just view. List of
digital products pending/awaiting a listing-authenticity check, with a
confirm/revoke toggle.
`→ PATCH /api/digital-products/:id/verify` (admin, super_admin, **and customer_care**)

### C.7 Disputes Queue
List of disputed jobs (both parties' emails shown). customer_care views;
only admin/super_admin resolves (a required note gets appended to the
dispute's history).
`→ GET /api/jobs/disputes` · `→ PATCH /api/jobs/:id/dispute/resolve`

### C.8 Refund Requests Queue
Pending refund requests across all jobs. customer_care views; admin/
super_admin approves (closes the job, emails the requester) or declines
(reason required, emails the requester).
`→ GET /api/jobs/refund-requests` · `→ PATCH .../approve` · `→ PATCH .../decline`

### C.9 Payout Requests Queue
Same shape as C.8, for provider payout requests. Approving requires that
provider to already have a payout account on file (B.2) — the action
should surface that clearly if missing rather than just erroring.
`→ GET /api/jobs/payout-requests` · `→ PATCH .../approve` · `→ PATCH .../decline`

### C.10 Payments Ledger — admin/super_admin only (not customer_care)
Every payment record platform-wide, filterable by status/targetType/
target/user/provider.
`→ GET /api/payments`

### C.11 Job Payments (contextual)
From inside a specific job's admin view: every payment tied to that one
job. customer_care can view this one even though it can't view the full
ledger (C.10).
`→ GET /api/jobs/:id/payments`

### C.12 Message Reports — admin/super_admin resolves, customer_care views
List of reported messages, filterable by status (pending/resolved).
customer_care can browse and open any report; only admin/super_admin
sees the "resolve" action, which optionally redacts the reported
message's text (replacing it with a standard "[message removed by
moderator]" notice, never deleting the Message record itself) in the
same call. A resolved report can't be resolved again — show it as
closed, not re-actionable.
`→ GET /api/messages/reports` · `→ PATCH /api/messages/reports/:id/resolve`

### C.13 Plans Manager — super_admin only
Catalog CRUD for subscription plans (tier, name, privileges, duration,
price, currency, max seats). Plans are never deleted, only deactivated.
`→ GET /api/plans?includeInactive=true` · `→ POST /api/plans` · `→ PUT /api/plans/:id`

### C.14 Manual Subscription Tools — admin/super_admin only
An interim "grant a subscription by hand" tool (for support cases
outside the normal Stripe checkout) and a way to pull up any user's
subscription history.
`→ POST /api/subscriptions` · `→ GET /api/subscriptions/users/:userId`

### C.15 Platform Stats — REVIEW_ROLES (admin/super_admin/customer_care)
A read-only overview snapshot for Admin Home (§C.1) — platform-wide
counts across jobs, payments, verifications, and the other queues this
section already lists individually. This is the one place that view is
assembled in one call instead of several.
`→ GET /api/stats/overview`

---

## What's deliberately NOT in this doc

- `POST /api/deployment/setup` — an ops/deploy action (bootstraps the
  first Super Admin), not something any UI should ever call.
- Anything about `SystemPayout` — an internal finance ledger with no
  route exposed; nothing for the frontend to build against yet.

## Open questions for you

1. Anything in the public section (A) you'd rather keep gated behind
   login that I've listed as public, or vice versa?
2. §A.1a/§A.18/§A.19 are all new, optional "give people a reason to
   subscribe" surfaces (top-rated strips, board teasers) — do you want
   all three live on launch, or held back for a later pass?
3. §5.2's Dark palette and the shared accent are by-eye estimates off
   the reference images, not pixel-sampled — want these run through an
   actual eyedropper against the saved files for exact values before
   anything gets built, or are the estimates close enough to start
   from and refine later?
4. Between the two concept marks (§5.4) — is one of them closer to
   right, should both go back for another pass, or is it still too
   early to choose between them?
5. §4's roadmap assumes Phase 0 (theming + form states) gets built
   before any real page — fine to lock that in, or is there a reason
   to prototype a Phase 1 page first to pressure-test the tokens?
6. Typography is still a placeholder description, not a chosen family
   — any fonts you already have in mind, or leave that one to Stitch/a
   designer to propose against §5.2's palette?
