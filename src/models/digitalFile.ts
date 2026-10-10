import { Schema } from "mongoose";

// The S3-backed counterpart to mediaFile.ts's IMediaFile — used wherever a
// file lives in S3 rather than on local disk: DigitalProduct.files (a
// creator's deliverables) and DigitalPurchase.fileManifest/files (a
// buyer's frozen entitlement and their own copied snapshot). No
// `url`/`storagePath`: these are never public, and a download URL only
// ever exists as a short-lived presigned S3 link minted on demand by
// s3Storage.getDigitalFileDownloadUrl — `key` is everything needed to
// get/copy/delete the underlying object.
export interface IDigitalFile {
  fileName: string;
  key: string;
  mime: string;
  size: number;
}

export const digitalFileSchema = new Schema<IDigitalFile>(
  {
    fileName: { type: String, required: true },
    key: { type: String, required: true },
    mime: { type: String, required: true },
    size: { type: Number, required: true },
  },
  { _id: false },
);
