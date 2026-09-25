import mongoose, { Document, Model, Schema, Types } from "mongoose";

// The deliberately-minimal safety net for a chat PolyGrid otherwise never
// reviews: not a moderation system (no status/resolution workflow, no
// automated action) — just a permanent, admin-visible record that a
// specific message was flagged, and why, so there's something to act on if
// a real report (harassment, a scam, anything genuinely bad) ever comes in.
export interface IMessageReport extends Document {
  messageId: Types.ObjectId;
  conversationId: Types.ObjectId;
  reportedBy: Types.ObjectId;
  reason: string;
  createdAt: Date;
}

const messageReportSchema = new Schema<IMessageReport>(
  {
    messageId: { type: Schema.Types.ObjectId, ref: "Message", required: true },
    conversationId: { type: Schema.Types.ObjectId, ref: "Conversation", required: true, index: true },
    reportedBy: { type: Schema.Types.ObjectId, ref: "User", required: true },
    reason: { type: String, required: true, trim: true, maxlength: 1000 },
  },
  { timestamps: { createdAt: true, updatedAt: false } },
);

export const MessageReport: Model<IMessageReport> = mongoose.model<IMessageReport>(
  "MessageReport",
  messageReportSchema,
);
