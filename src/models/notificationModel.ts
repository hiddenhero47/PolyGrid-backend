import mongoose, { Document, Model, Schema, Types } from "mongoose";

// One flat type registry for every in-app notification this platform
// fires — tender awards, SiteForce application decisions, verification
// decisions, job stage/dispute/payment-request events. `data` carries
// whatever the specific type needs (a jobId, a verification id, …) for a
// frontend to deep-link into the right page; `message` is always a
// ready-to-display sentence so a client never has to know how to render
// each type.
export const NOTIFICATION_TYPE = {
  TENDER_BID_AWARDED: "tender_bid_awarded",
  JOB_APPLICATION_ACCEPTED: "job_application_accepted",
  JOB_APPLICATION_REJECTED: "job_application_rejected",
  VERIFICATION_APPROVED: "verification_approved",
  VERIFICATION_REJECTED: "verification_rejected",
  JOB_STAGE_DONE: "job_stage_done",
  JOB_DISPUTE_RESOLVED: "job_dispute_resolved",
  PAYMENT_REQUEST_DECIDED: "payment_request_decided",
  SYSTEM_PAYOUT_SETTLED: "system_payout_settled",
  PROFILE_STATUS_CHANGED: "profile_status_changed",
} as const;
export type NotificationType = (typeof NOTIFICATION_TYPE)[keyof typeof NOTIFICATION_TYPE];

export interface INotification extends Document {
  userId: Types.ObjectId;
  type: NotificationType;
  message: string;
  data?: Record<string, unknown>;
  isRead: boolean;
  createdAt: Date;
  updatedAt: Date;
}

const notificationSchema = new Schema<INotification>(
  {
    userId: { type: Schema.Types.ObjectId, ref: "User", required: true },
    type: { type: String, required: true, enum: Object.values(NOTIFICATION_TYPE) },
    message: { type: String, required: true },
    data: { type: Schema.Types.Mixed },
    isRead: { type: Boolean, default: false },
  },
  { timestamps: true },
);

// Matches the two read patterns notificationController.ts actually uses:
// "my feed, newest first" and "how many of mine are unread".
notificationSchema.index({ userId: 1, createdAt: -1 });
notificationSchema.index({ userId: 1, isRead: 1 });

export const Notification: Model<INotification> = mongoose.model<INotification>(
  "Notification",
  notificationSchema,
);
