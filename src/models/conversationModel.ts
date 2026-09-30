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
// who's asking — what makes the {participants:1} unique index below
// actually prevent a duplicate conversation for the same pair.
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
    lastMessageAt: { type: Date },
    lastMessagePreview: { type: String },
    lastReadAt: { type: Map, of: Date, default: () => new Map() },
  },
  { timestamps: true },
);

conversationSchema.index({ participants: 1 }, { unique: true });
// "My conversations, most recently active first" — the one query the
// conversation list screen actually runs.
conversationSchema.index({ participants: 1, lastMessageAt: -1 });

export const Conversation: Model<IConversation> = mongoose.model<IConversation>(
  "Conversation",
  conversationSchema,
);
