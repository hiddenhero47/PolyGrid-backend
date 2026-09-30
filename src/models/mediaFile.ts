import { Schema } from "mongoose";

// The shape a public, deletable image needs everywhere one shows up
// (ConsultancyProfile.portfolio[].media, StoreProfile's logo, Product
// images) — matches IAvatar's shape. `storagePath` is what lets a
// removed/replaced file actually be deleted from disk
// (fileStorage.deleteStoredFile needs a real path, not just a fileName);
// `mime`/`size` are the real values `uploadHandler` detected by magic
// bytes at save time, not a client-supplied guess. Stripped before any
// public API response the same way toPublicUser strips it off avatar —
// an internal filesystem path has no business leaving the server.
export interface IMediaFile {
  fileName: string;
  storagePath: string;
  mime: string;
  size: number;
  url?: string;
}

export const mediaFileSchema = new Schema<IMediaFile>(
  {
    fileName: { type: String, required: true },
    storagePath: { type: String, required: true },
    mime: { type: String, required: true },
    size: { type: Number, required: true },
    url: { type: String },
  },
  { _id: false },
);

// Strips storagePath — the one field that must never leave the server —
// leaving everything a client actually needs to render/identify the file.
export const toPublicMediaFile = (media: IMediaFile) => ({
  fileName: media.fileName,
  mime: media.mime,
  size: media.size,
  url: media.url,
});
