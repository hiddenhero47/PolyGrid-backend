import mongoose, { Document, Model, Schema, Types } from "mongoose";

// Deliberately just text — no attachments, no editing, no deleting. What's
// actually needed (see docs/chat-plan.md): two connected users exchanging
// messages, persisted (not ephemeral, so there's a real record if something
// serious ever needs looking into), delivered live over Socket.IO but
// always readable afterward via plain REST history.
const MAX_BODY_LENGTH = 4000;

export interface IMessage extends Document {
  conversationId: Types.ObjectId;
  sender: Types.ObjectId;
  body: string;
  createdAt: Date;
  updatedAt: Date;
}

const messageSchema = new Schema<IMessage>(
  {
    conversationId: { type: Schema.Types.ObjectId, ref: "Conversation", required: true, index: true },
    sender: { type: Schema.Types.ObjectId, ref: "User", required: true },
    body: { type: String, required: true, trim: true, maxlength: MAX_BODY_LENGTH },
  },
  { timestamps: true },
);

// A conversation's history is read as "everything, newest first" (with
// pagination) — this is the only query pattern messages actually need.
messageSchema.index({ conversationId: 1, createdAt: -1 });

export const Message: Model<IMessage> = mongoose.model<IMessage>("Message", messageSchema);
