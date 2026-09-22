# File Uploads — Public & Private

Status: **shipped**, third revision. Earlier passes: a generic `MediaFile`
CRUD resource (wrong shape), then a header-checked `/private/:userId/:fileName`
route with an owner/admin fast-path plus a `?token=` fallback for `<img>`
tags (worked, but still needed `protect` + a DB-aware "blocker" route). This
version replaces that with **signed URLs**, which is both simpler and drops
the last remaining per-request DB query.

Ported from house-maduekwe-backend's `fileManager.js`/`mediaController.js`,
extended with the piece HM doesn't need: per-file access control. HM's media
is admin-only and always public (site assets — logos, product photos);
PolyGrid needs regular users uploading files that are sometimes public
(avatars, digital storefront items) and sometimes private (a KYC document,
or a structural audit PDF, shared with one client and a couple of
reviewers, not the world).

## Shape: a helper, not a resource

Uploading is a small part of a bigger action (updating a profile, later:
submitting a structural audit) — not a standalone feature a client calls on
its own.

- **`src/helpers/fileStorage.ts`'s `uploadHandler` never throws.** It always
  returns `{ results, errorLogs }` — even "no valid file, everything
  rejected" is a normal return, not an exception. A file is often one
  optional field on a bigger form: if you're updating your profile's name
  and phone and also attach a bad image, the name/phone change must still
  go through. **Only** a route whose entire job is the upload
  (`POST /api/files/private`) is entitled to look at `results.length === 0`
  and turn that into a 400 — that's the route's own choice on its own error
  path, not something the shared helper decides for every caller.
- `userController.updateUserProfile` is the first real caller: calls
  `uploadHandler` directly, sets `user.avatar` if something was saved, and
  otherwise just proceeds — a failed avatar shows up as a non-fatal
  `avatarWarnings` array in the 200 response, never a failed request.
- There's no generic "upload any file" endpoint. When the next domain needs
  file attachments (an Engineering audit PDF, a KYC document), its own
  controller calls `uploadHandler` directly, the same way
  `updateUserProfile` does.

## The core idea: access is decided once, then a signed URL proves it

Instead of the file-serving route checking "is this person allowed" on
every request, **whoever already knows the answer mints a short-lived,
tamper-proof URL that says so** — the same pattern S3 presigned URLs use.
Concretely:

1. Something that already knows the access rule — `getPrivateFileLink`
   (the generic owner/admin/`FileGrant` check) or a future domain
   controller's own logic (e.g. a KYC feature checking "is this reviewer
   assigned to this case") — decides *once* that a given user may see a
   given file.
2. It calls `signFileUrl({ ownerId, fileName, mode })`
   (`src/helpers/fileSigning.ts`), which returns a URL with a signed,
   expiring `?token=` embedded: e.g.
   `https://server/private/view/<ownerId>/<fileName>?token=...`.
3. That URL is handed back in whatever response needed it — e.g. attached
   directly to a KYC record's file metadata as `requestUrl`/`downloadUrl`,
   or returned by `uploadPrivateFile` for the file the caller just uploaded
   (they're trivially its owner).
4. **`GET /private/view/...` and `GET /private/download/...` need no
   `Authorization` header and do no DB read at all.** They just verify the
   token's signature, expiry, and that it was minted for *this exact*
   file+mode — then stream the bytes. The access decision already happened
   in step 1; this route only checks the URL wasn't forged or reused for
   something else.

This is what makes `<img src="...">` work directly — the credential lives
in the URL itself, which is the only thing a browser's plain resource
request can carry.

### Why app-key-only signing, no sessionId

`signFileUrl`/`verifyFileUrlToken` sign with a secret only — no user
sessionId in the payload, no DB read to verify. That was a deliberate
tradeoff: binding the token to the user's current session would let a
password change/logout instantly revoke an outstanding link, but checking
that means a `User.findById` on every single file view — exactly the
per-request DB cost this design exists to avoid. Instead, the token's own
short expiry (10 minutes by default) does that job: if a device is
compromised badly enough for a signed link sitting in memory to be stolen,
the normal login token sitting right next to it is already compromised too,
so session-binding buys little here for a real DB-read cost on every
request. Signed with `FILE_SIGNING_SECRET` — kept separate from
`JWT_SECRET` so a leaked one can't forge a login session, or vice versa.

## Visibility model

- **Public** (`storage/public/<fileName>`): mounted directly via
  `express.static` at `/public` — `GET /public/<fileName>` needs no
  credentials at all, same as HM.
- **Private** (`storage/private/<ownerId>/<fileName>`): never mounted as
  static. Read only through the two signed routes below.

### `res.sendFile`/`res.download` with `root` — closes a real gap

`streamPrivateFile` (`fileController.ts`) uses
`res.sendFile(fileName, { root })` (view) and
`res.download(fileName, fileName, { root })` (download), where `root` is
`PRIVATE_DIR/<ownerId>`. Both are handled by Express's underlying `send`
package (the same one `express.static` uses), which rejects — with a plain
404, not an error that could leak information — any resolved path that
would escape `root`, including encoded `../` sequences. An earlier version
of this manually did `path.join(PRIVATE_DIR, ownerId, fileName)` then
`fs.createReadStream()`, which has no equivalent protection; switching to
`sendFile`/`download` isn't just less code, it closes a real path-traversal
gap. `ownerId` itself is validated as a well-formed Mongo id before being
used to build `root`, as defense in depth (the signed token can only ever
carry a real id we generated, but there's no reason to rely on that alone).

`send` also sets `Content-Type` from the file extension automatically, so
there's no need to store or look up a mime type to serve a file correctly.

## Routes

- `POST /api/files/private` (`protect`) — the one upload-only route: body is
  multipart/base64/url (same three input paths as HM), optional
  `allowedUserIds[]`. 400s if nothing valid was uploaded. Response includes
  `requestUrl`/`downloadUrl` for the file just uploaded.
- `GET /api/files/private/:ownerId/:fileName/link` (`protect`) — the
  generic "can I see this, and if so give me links" endpoint: owner/admin
  cost zero extra queries (checked directly off `req.user`, which `protect`
  already fetched); anyone else costs one `FileGrant.exists()` read. A
  domain with its own access rules doesn't need this at all — it can call
  `signFileUrl()` directly after its own check.
- `GET /public/<fileName>` — static, no auth.
- `GET /private/view/<ownerId>/<fileName>?token=...` — inline (`<img>`,
  `<video>`, `<iframe>` for a PDF).
- `GET /private/download/<ownerId>/<fileName>?token=...` — forces
  `Content-Disposition: attachment`.

  Both signed routes set `Cache-Control: private, max-age=0, no-store`, and
  a token is scoped to one exact `{ownerId, fileName, mode}` — a view token
  can't be replayed against the download route, or against a different file,
  just by editing the URL.

## `FileGrant` — the simple-sharing primitive

`src/models/fileGrantModel.ts` is bookkeeping only (`ownerId`, `fileName`,
`allowedUsers`) — not a user-facing resource. A record is written **only**
when an upload names `allowedUserIds`; an owner-only private file costs zero
DB writes and zero DB reads, ever. It exists for "just share this one file
with a couple of people, no domain feature needed." A domain with richer
rules (KYC's "assigned reviewer" concept, say) can ignore it entirely and
decide access its own way before calling `signFileUrl()` directly.

## Magic-byte validation without the `file-type` package

`src/helpers/fileSignature.ts` hand-rolls signature checks for the types
PolyGrid actually supports (JPEG/PNG/WEBP/PDF) instead of depending on the
`file-type` npm package. Every version of that package compatible with
CommonJS/Jest (v16 and earlier) has a known infinite-loop DoS in its ASF
parser ([GHSA-5v7r-6r5c-r473](https://github.com/advisories/GHSA-5v7r-6r5c-r473)),
which runs on every buffer regardless of which mime types are allowlisted.
The fixed version (v22+) is ESM-only, which would reintroduce the
`--experimental-vm-modules` Jest complexity this project's setup was built
to avoid.

## Limits

- 10MB per file (`MAX_FILE_SIZE_BYTES` in `fileStorage.ts`).
- Allowed types: `image/jpeg`, `image/png`, `image/webp`, `application/pdf`
  (`DEFAULT_ALLOWED_MIME_TYPES`). Add a case to `fileSignature.ts`'s
  `detectFileSignature()` to support more (e.g. `.dwg`/CAD files, video).
- Signed URLs expire after 10 minutes by default
  (`signFileUrl`'s `expiresInSeconds`) — long enough to load a modal, short
  enough to keep a leaked link's exposure small.

## Storage location

`storage/{public,private}` at the repo root (`STORAGE_ROOT` env var,
defaults to `./storage`) — deliberately outside `src/`/`dist/`. PolyGrid
compiles TypeScript to `dist/`; keeping runtime-written files inside either
the source tree or the build output directory would conflate build
artifacts with runtime data. HM doesn't have this problem since it ships as
plain JS run directly (`__dirname` at runtime always matches its source
layout).

Private files are grouped by owner id only (no further split by file
type/images-vs-videos) — there's no concrete need for that split yet, and
it's easy to add a subfolder segment later without disrupting anything,
since storage layout is an implementation detail behind `fileStorage.ts`.

## Deliberately not built

Thumbnailing/image resizing, virus/malware scanning, a CDN, an admin
"browse everything" media library, and a delete route for private files
(would need `:ownerId` in its path, mirroring the view/download routes, to
avoid an ownership-lookup ambiguity for files with no `FileGrant`) — none of
these were asked for and each is its own scoped decision. When a domain
needs richer access rules than "owner, admin, or a flat allow-list" (e.g. a
KYC review flow), give that domain's own controller the responsibility of
deciding, then have it call `signFileUrl()` directly — don't grow this
generic layer to know about every domain's rules.
