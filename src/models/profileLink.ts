import { Schema } from "mongoose";

// Shared by every pillar profile that wants to show external links
// (ConsultancyProfile, StoreProfile, and whichever comes next) —
// extracted here once a second real consumer (StoreProfile) needed the
// exact same shape, rather than duplicating it a third time later.
//
// External links only (website, a catalog PDF, Instagram, etc.) —
// deliberately NOT a place for raw contact details (phone/email/
// WhatsApp). PolyGrid's Jobs system (and, for Store, its order/checkout
// flow) exists to capture a platform fee on a real transaction; publicly
// exposing a way to reach a seller directly would make it trivial to
// arrange payment off-platform and skip that entirely — the same reason
// most real marketplaces (Upwork, Etsy, Toptal) don't surface direct
// contact info on a public profile either. A buyer/client reaches out
// through the platform's own flow instead (a Job, a store order).
export interface IProfileLink {
  label: string; // e.g. "Website", "Instagram", "Catalog"
  url: string;
}

// A handful of "where else to find me" links, not an unbounded list.
export const MAX_PROFILE_LINKS = 10;

export const profileLinkSchema = new Schema<IProfileLink>(
  {
    label: { type: String, required: true, trim: true },
    url: {
      type: String,
      required: true,
      trim: true,
      match: [/^https?:\/\//i, "url must start with http:// or https://"],
    },
  },
  { _id: false },
);

export const validateLinkCount = (links: IProfileLink[]): boolean => links.length <= MAX_PROFILE_LINKS;
