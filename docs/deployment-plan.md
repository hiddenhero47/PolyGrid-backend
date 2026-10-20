# Deployment bootstrap

Status: **shipped**. What a brand-new environment needs before the app
is actually usable — right now, a first Super Admin account and the
placeholder verification templates every profile type needs before
anyone can submit for verification at all. Modeled directly on
house-maduekwe-backend's own `helpers/ensureAdmin.js`/`helpers/appSetup.js`
+ `setupController.js`/`setupRoutes.js` pattern, adapted to this
codebase's conventions.

## The problem this solves

Every path that can create a privileged account already requires one to
exist first: `registerAdmin` and `changeUserRole` (`userController.ts`)
are both gated `secureRole(SUPER_ADMIN)`, and `userModel.ts`'s own
pre-save guard throws if you try to create a Super Admin any other way
(`_adminCreation` must be set by trusted server code, and only one Super
Admin can exist, full stop). So on a genuinely fresh environment —
empty database, nobody logged in yet — nothing in the app can create the
first admin account. Something outside the normal request/auth flow has
to.

Similarly, every profile type (`PROFILE_TYPE`/`PROFILE_MODEL_REGISTRY`,
`constants/profileTypes.ts`) needs an active `VerificationTemplate` for
its country before anyone can submit verification for it
(`helpers/verificationTemplateLookup.ts`). A fresh environment has none
at all.

## The tasks — `helpers/deploymentSetup.ts`

Each task is a small, independent, **idempotent** async function
returning `{task, status: "success" | "failed", message}` — check first,
act only if needed, never throw past its own boundary (caught and
reported as a `"failed"` result instead). Safe to call on every boot, or
a hundred times in a row; nothing it does is undone or redone once
satisfied.

- **`ensureSuperAdminExists`** — creates one `User` with
  `systemRole: SUPER_ADMIN` from `SUPER_ADMIN_NAME`/`_EMAIL`/`_PASSWORD`
  (`.env`), password hashed with the same `bcrypt.genSalt(10)` +
  `bcrypt.hash` every other admin-creation path in this codebase uses,
  `_adminCreation = true` set before `.save()` (the same transient,
  never-persisted flag `registerAdmin` sets — see `userModel.ts`). A
  no-op (`"success"`, different message) if a Super Admin already
  exists; a clear `"failed"` result (not a thrown error) if the three
  env vars aren't all set.
- **`ensureVerificationTemplatesSeeded`** — one placeholder
  `VerificationTemplate` per registered profile type, country `"NG"`,
  `state: null` (the nationwide default). **Deliberately fake content** —
  one generic `fullName` field, one generic `identity_document`
  requirement — not real per-pillar regulatory requirements. This exists
  purely so `submitVerification` has something to validate against
  during pre-launch testing; replace each one with real requirements via
  the normal `POST /api/verification-templates` admin endpoint (which
  versions properly — see `docs/verification-templates-plan.md`) before
  relying on this for real users. Only creates what's missing — a
  profile type that already has an active Nigeria template is left
  untouched.

Add more tasks here the same way house-maduekwe-backend's
`runSetupScripts` grew one `ensureX()` call per need (a plan seeded at
boot, a default setting backfilled, etc.) — each new task is its own
function, called from `deploymentController.runDeploymentSetupTasks`
alongside the existing ones.

## How this runs — `POST /api/deployment/setup`, not automatically at boot

Deliberately **not** called from `server.ts`. An earlier version ran it
automatically on every boot, but this app is deployed behind PM2, which
restarts the process on every push to main — every task here is
idempotent (a no-op after its first real run), so running them on every
single restart forever would be pure dead weight, not a safety net. Hit
the route instead, the one time it's actually needed (first real deploy,
or after adding a new task). No `protect`/`secureRole` on this route —
the entire point is to work when no admin account exists yet to
authenticate as.

## `timeWindowGuard` — why this route isn't just wide open

`middleware/timeWindowGuard.ts` gates the HTTP route to a window —
`timeWindowGuard(allowedStartIso, allowedHours)` — passed as a literal
right where the route is defined (`routes/deploymentRoutes.ts`), the same
shape house-maduekwe-backend's own `timeWindowGuard` uses
(`timeWindowGuard("2026-04-05T00:00:00Z", 24)`) to gate five separate
one-off setup/migration routes there.

**Deliberately not env-driven.** An earlier version of this read the
window from env vars instead, reasoning that editing `.env` is less
friction than editing code — but that's backwards for how this actually
gets used: there will be more one-off tasks like this later (a DB
normalization after a model change, say), each wanting its own window,
and each one is already a code change (a new route, a new controller
function) before it's deployed at all. Baking the window into that same
code means opening it is just part of writing and shipping the task —
never a separate "log into the server and change an env var" step on top.
An absolute, author-chosen date is also the only way this genuinely
closes for good afterward, regardless of how many times the server
restarts in between — a window computed relative to server boot would
quietly re-open for another full duration on every restart for as long
as the route stays in the codebase, which defeats the entire point.

Two things improved over HM's version, both free: validated *eagerly*
(at route-registration time, i.e. deploy/boot — a malformed date or
non-positive hours throws immediately instead of silently 403-ing
forever with no clue why), and every successful pass through the guard
is logged (`[TIME_WINDOW_GUARD] Allowed request to ...`), so there's an
audit trail of exactly when a sensitive setup route was actually used.

To reopen `/api/deployment/setup` (or add a new time-windowed route),
update the literal in that route's file and deploy — nothing on the live
server needs touching separately.

## Routes

- `POST /api/deployment/setup` — runs every task, returns
  `{success, timestamp, results}`; `timeWindowGuard`\-gated, see above.

## Env vars (`.env.example`)

```
SUPER_ADMIN_NAME=
SUPER_ADMIN_EMAIL=
SUPER_ADMIN_PASSWORD=
```
