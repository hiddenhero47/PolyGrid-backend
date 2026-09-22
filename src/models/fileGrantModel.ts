import mongoose, { Document, Model, Schema, Types } from "mongoose";

// Only exists for the "shared with a few specific people" case (e.g. a KYC
// document a couple of reviewers need to see). The owner and any admin are
// checked with zero DB reads at all — ownership is encoded directly in the
// storage path (PRIVATE_DIR/<ownerId>/<fileName>, see fileStorage.ts) and
// role comes off req.user, which `protect` already fetched. A record here
// is only created when an upload actually names extra allowedUsers — a
// private file with no explicit shares never touches this collection.
export interface IFileGrant extends Document {
  ownerId: Types.ObjectId;
  fileName: string;
  allowedUsers: Types.ObjectId[];
  createdAt: Date;
  updatedAt: Date;
}

const fileGrantSchema = new Schema<IFileGrant>(
  {
    ownerId: { type: Schema.Types.ObjectId, ref: "User", required: true, index: true },
    fileName: { type: String, required: true, unique: true },
    allowedUsers: [{ type: Schema.Types.ObjectId, ref: "User" }],
  },
  { timestamps: true },
);

export const FileGrant: Model<IFileGrant> = mongoose.model<IFileGrant>(
  "FileGrant",
  fileGrantSchema,
);
