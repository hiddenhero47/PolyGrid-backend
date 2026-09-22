import mongoose, { Document, Model, Schema, Types } from "mongoose";

// One document per user — their own address book. Entries are added
// mutually (see contactController.connectUsers): connecting with someone
// puts them in your list and you in theirs.
export interface IContactEntry {
  user: Types.ObjectId;
  // Snapshotted at connection time, same reasoning as Subscription
  // snapshotting a Plan's fields — a contact should still show the email
  // it was made through even if that user later changes their email.
  email: string;
  connectedAt: Date;
}

export interface IContact extends Document {
  userId: Types.ObjectId;
  list: IContactEntry[];
}

const contactEntrySchema = new Schema<IContactEntry>(
  {
    user: { type: Schema.Types.ObjectId, ref: "User", required: true },
    email: { type: String, required: true },
    connectedAt: { type: Date, default: () => new Date() },
  },
  { _id: false },
);

const contactSchema = new Schema<IContact>(
  {
    userId: { type: Schema.Types.ObjectId, ref: "User", required: true, unique: true },
    list: [contactEntrySchema],
  },
  { timestamps: true },
);

export const Contact: Model<IContact> = mongoose.model<IContact>("Contact", contactSchema);
