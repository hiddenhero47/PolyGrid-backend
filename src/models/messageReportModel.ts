import mongoose, { Document, Model, Schema, Types } from "mongoose";

// The deliberately-minimal safety net for a chat PolyGrid otherwise never
// reviews: just a permanent, admin-visible record that a specific message
// was flagged, and why. `status` is the one bit of actual moderation
// workflow — resolve a report once an admin's looked at it (optionally
// also redacting the underlying message — see
// conversationController.resolveMessageReport), so the queue reflects
// what's actually still outstanding.
export const MESSAGE_REPORT_STATUS = {
  PENDING: "pending",
  RESOLVED: "resolved",
} as const;
export type MessageReportStatus = (typeof MESSAGE_REPORT_STATUS)[keyof typeof MESSAGE_REPORT_STATUS];

export interface IMessageReport extends Document {
  messageId: Types.ObjectId;
  conversationId: Types.ObjectId;
  reportedBy: Types.ObjectId;
  reason: string;
  status: MessageReportStatus;
  resolvedBy?: Types.ObjectId;
  resolvedAt?: Date;
  createdAt: Date;
}

const messageReportSchema = new Schema<IMessageReport>(
  {
    messageId: { type: Schema.Types.ObjectId, ref: "Message", required: true },
    conversationId: { type: Schema.Types.ObjectId, ref: "Conversation", required: true, index: true },
    reportedBy: { type: Schema.Types.ObjectId, ref: "User", required: true },
    reason: { type: String, required: true, trim: true, maxlength: 1000 },
    status: {
      type: String,
      enum: Object.values(MESSAGE_REPORT_STATUS),
      default: MESSAGE_REPORT_STATUS.PENDING,
    },
    resolvedBy: { type: Schema.Types.ObjectId, ref: "User" },
    resolvedAt: { type: Date },
  },
  { timestamps: { createdAt: true, updatedAt: false } },
);

export const MessageReport: Model<IMessageReport> = mongoose.model<IMessageReport>(
  "MessageReport",
  messageReportSchema,
);
