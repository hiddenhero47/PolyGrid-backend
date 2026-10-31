import mongoose, { Document, Model, Schema, Types } from "mongoose";

// 1:1 chat only — no group conversations. A Conversation is keyed by the
// unordered pair of participants (always stored sorted — see
// sortParticipants below), so there's exactly one conversation between any
// two users regardless of who started it, reusable across every Job they
// ever work together, the same "one relationship, not one per job" instinct
// Contact already uses. Starting one requires the two users to already be
// Contacts (see conversationController.ts) — chat isn't an open DM channel
// to a stranger, it piggybacks on a connection that already exists for a
// real reason (a shared Job, or an explicit contact add).
export interface IConversation extends Document {
  participants: [Types.ObjectId, Types.ObjectId];
  // Derived (pre-validate, below) from the sorted pair — `${a}:${b}`.
  // What the unique index below actually keys on. A unique index
  // directly on `participants` (an array field) is a *multikey* index,
  // which Mongo enforces per ELEMENT, not per full-array value — it
  // would mean "no two conversations may ever share even one
  // participant," not "no two conversations may have the same pair."
  // That bug shipped once already (every user could only ever be in one
  // conversation total) — see docs/jobs-and-contacts-plan.md and the
  // deploymentSetup task that drops the old broken index on existing
  // databases.
  pairKey: string;
  lastMessageAt?: Date;
  // Short preview for a chat-list UI, so listing conversations doesn't need
  // a second query per conversation to find its last message.
  lastMessagePreview?: string;
  // Per-participant "I've read up to here" timestamp — a Map keyed by
  // userId string rather than two hardcoded fields, so this doesn't need
  // to know or care which participant is "first"/"second". Unread count is
  // computed as "messages newer than my entry here", not stored directly.
  lastReadAt: Map<string, Date>;
  createdAt: Date;
  updatedAt: Date;
}

// Both participant ids, always in the same (sorted) order regardless of
// who's asking — what makes `pairKey` (and its unique index) actually
// prevent a duplicate conversation for the same pair.
export const sortParticipants = (
  a: Types.ObjectId | string,
  b: Types.ObjectId | string,
): [string, string] => [String(a), String(b)].sort() as [string, string];

const conversationSchema = new Schema<IConversation>(
  {
    participants: {
      type: [{ type: Schema.Types.ObjectId, ref: "User" }],
      required: true,
      validate: {
        validator: (participants: Types.ObjectId[]) => participants.length === 2,
        message: "A conversation has exactly two participants",
      },
    },
    pairKey: { type: String, required: true },
    lastMessageAt: { type: Date },
    lastMessagePreview: { type: String },
    lastReadAt: { type: Map, of: Date, default: () => new Map() },
  },
  { timestamps: true },
);

// Derives pairKey itself rather than trusting a caller to have passed
// one — correct even if something else ever creates a Conversation
// directly, not just through conversationController.startOrGetConversation.
conversationSchema.pre("validate", function (next) {
  if (this.participants?.length === 2) {
    const [a, b] = sortParticipants(this.participants[0], this.participants[1]);
    this.pairKey = `${a}:${b}`;
  }
  next();
});

// The actual "one conversation per pair" constraint — see pairKey's own
// comment on IConversation for why this is a scalar field and not the
// `participants` array itself.
conversationSchema.index({ pairKey: 1 }, { unique: true });
// "My conversations, most recently active first" — the one query the
// conversation list screen actually runs.
conversationSchema.index({ participants: 1, lastMessageAt: -1 });

export const Conversation: Model<IConversation> = mongoose.model<IConversation>(
  "Conversation",
  conversationSchema,
);
