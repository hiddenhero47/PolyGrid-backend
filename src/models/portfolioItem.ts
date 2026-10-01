import { Schema, Types } from "mongoose";
import { IMediaFile, mediaFileSchema } from "./mediaFile";

// Extracted out of consultancyProfileModel.ts once ContractorProfile needed
// the exact same "past work, with photos" shape — same "extract once a
// second real consumer needs it" instinct as profileLink.ts/mediaFile.ts,
// not built speculatively ahead of time.
export type IPortfolioMedia = IMediaFile;

// A profile can have at most this many portfolio items, and each item at
// most this many media files — unbounded arrays here would mean unbounded
// disk usage and DB document growth per profile, with no real ceiling.
// Deliberately generous for a legitimate portfolio, not a hard product
// constraint — revisit the numbers if a real user's usage says otherwise.
export const MAX_PORTFOLIO_ITEMS = 20;
export const MAX_MEDIA_PER_ITEM = 6;

export interface IPortfolioItem {
  _id: Types.ObjectId;
  title: string;
  description?: string;
  media: IPortfolioMedia[];
  tags: string[];
  startedAt?: Date;
  completedAt?: Date;
}

export const portfolioItemSchema = new Schema<IPortfolioItem>({
  title: { type: String, required: true, trim: true },
  description: { type: String },
  media: {
    type: [mediaFileSchema],
    default: [],
    // Defense in depth alongside each controller's own checks, which is
    // what actually produces a clean 400 before any file touches disk —
    // this just guarantees the limit holds even if a future code path
    // ever bypasses the controller.
    validate: {
      validator: (media: IPortfolioMedia[]) => media.length <= MAX_MEDIA_PER_ITEM,
      message: `A portfolio item can have at most ${MAX_MEDIA_PER_ITEM} media files`,
    },
  },
  tags: { type: [String], default: [] },
  startedAt: { type: Date },
  completedAt: {
    type: Date,
    validate: {
      // `this` is the portfolio item subdocument here (a plain function,
      // not an arrow, specifically so Mongoose can bind it) — a project's
      // completion can't be dated before its own start.
      validator: function (this: IPortfolioItem, value: Date) {
        if (!value || !this.startedAt) return true;
        return this.startedAt <= value;
      },
      message: "completedAt must be on or after startedAt",
    },
  },
});

export const validatePortfolioItemCount = (items: IPortfolioItem[]): boolean =>
  items.length <= MAX_PORTFOLIO_ITEMS;
