# Chat — 1:1 messaging between connected users

Status: **shipped**. Deliberately minimal — this was scoped as "simple and
what we need," not a full messaging platform, after an earlier discussion
about whether to build this at all vs. use a third-party (Stream/Sendbird/
PubNub). Decided to build it: the actual requirements (1:1 only, no
moderation, no presence/typing indicators) don't need what those buy —
mostly just a recurring per-MAU cost and a dependency this doesn't need.

## What this deliberately is not

No group chat, no message editing/deleting, no attachments, no typing
indicators, no online/offline presence broadcasting, no read-receipt
events pushed to the other party (just a private unread count for your own
conversation list), no blocking. Every one of these is a real, addable
feature later if an actual need shows up — none of them were asked for,
and adding them now would be exactly the over-engineering this was scoped
to avoid.

## REST does all the work; the socket only pushes

The core design decision: **sending a message is a normal REST call**
(`POST /api/conversations/:id/messages`), validated and persisted exactly
like every other write in this app. Socket.IO's only job is pushing the
resulting message to the recipient's room, live, if they happen to be
connected right now:

```
POST /api/conversations/:id/messages
  → conversationController.sendMessage (auth, ownership, validation, save)
  → emitToUser(recipientId, "message:new", message)   // best-effort, never blocks the response
```

The alternative — clients emitting a `message:send` socket event that the
server validates and persists — would mean building a second copy of the
same auth/ownership/validation logic on a different transport, for no real
benefit here (no offline-queueing requirement, no latency-critical use
case). Message history is always fetched over REST too
(`GET /api/conversations/:id/messages`), so a client that was offline when
a message arrived just gets it on next page load — no missed-message
recovery logic needed on the socket side.

## Auth — the same check, just at connect time instead of per-request

`src/socket/index.ts`'s `io.use(...)` middleware reads
`socket.handshake.auth.token` (sent once, at `io(url, { auth: { token }
})`) and verifies it through `getAuthenticatedUser` — the exact same
function `protect` calls for every HTTP request, exported from
`authMiddleware.ts` specifically so there's one place deciding what a
valid token/session is, not two that could drift. A connected socket joins
room `user:<id>`, not a per-connection room — a user with several open
tabs/devices gets the same push on all of them.

## Chat piggybacks on Contact, doesn't reinvent it

Starting a conversation (`POST /api/conversations`) requires the two users
to already be Contacts — the same connection Jobs already creates as a
side effect (`jobController.createJob` → `connectUsers`), or an explicit
`POST /api/contacts`. Chat was never meant to be an open DM channel to a
stranger; it's a way for two people who already have a real reason to be
in touch (an active or past Job, an explicit connection) to talk without
leaving PolyGrid. `Conversation` is keyed by the unordered pair of
participants (`sortParticipants`, same "one relationship, not one per
context" instinct as `Contact` itself) — one conversation between two
people, reused across every Job they ever work together, found via an
atomic `findOneAndUpdate(..., { upsert: true })` so two near-simultaneous
"start a conversation" calls can't race into duplicates.

## Persisted, never reviewed by PolyGrid — except when reported

Every message is stored permanently (`Message`), readable by its two
participants forever — this was an explicit decision from the earlier
discussion: PolyGrid isn't the one to review a chat if two connected
parties want to exchange contact info or coordinate there directly, but a
job's payment/scope disputes are still resolved through `Job`, never
through "what was said in chat." What persistence *does* buy: a genuine
record exists if something serious ever needs looking into, and a minimal
report mechanism (`POST /api/messages/:id/report`, admin-only
`GET /api/messages/reports`) gives a way to flag a specific message without
building a moderation system around it — no status/resolution workflow, no
automated action, just a permanent, admin-visible flag-and-reason. This is
the "not defenseless, not surveilling" middle ground from that discussion.

## Unread counts, without per-message read state

`Conversation.lastReadAt` is a `Map<userId, Date>` — two timestamps per
conversation (one per participant), not a `readAt` field on every message.
Unread count is computed as "messages from the other participant newer
than my own `lastReadAt` entry" at list time
(`GET /api/conversations`) — cheap, and avoids a write on every single
message just to track read state that's only ever consumed as a count.

## Testing a real-time feature without over-testing it

`conversation.test.ts` covers everything the REST layer actually does
(Contact-gating, find-or-create idempotency, validation, ownership —
404 not 403 for "not my conversation," so probing a guessed id can't
confirm a conversation exists between two other people — unread counting,
reporting, admin-only report listing). `chatSocket.test.ts` is narrowly
scoped to what only the socket layer can prove: a real `http.Server` +
`initSocket` + a real `socket.io-client` connection shows auth actually
rejects a missing/garbled token, and that sending a message over REST
delivers a live `message:new` push to the recipient's room specifically —
not broadcast, not delivered to the sender's own connection. It doesn't
re-test anything conversation.test.ts already covers.

## Routes

- `POST /api/conversations` — start or fetch the existing conversation
  with a contact (`{ userId }`); 403 if not connected, 404 for an unknown
  user, 400 for yourself.
- `GET /api/conversations` — my conversations, most recently active first,
  each with the other participant, last message preview, unread count.
- `GET /api/conversations/:id/messages` — paginated history, newest first.
- `POST /api/conversations/:id/messages` — send (`{ body }`); persists,
  pushes `message:new` to the other participant if connected.
- `PATCH /api/conversations/:id/read` — mark read up to now.
- `POST /api/messages/:id/report` — flag a message (`{ reason }`), must be
  a participant of its conversation.
- `GET /api/messages/reports` (admin) — the flagged-message list.
