import mongoose, { Document, Model, Schema, Types } from "mongoose";
import { isValidCountryCode } from "../helpers/countryReference";
import { IProfileLink, profileLinkSchema, validateLinkCount, MAX_PROFILE_LINKS } from "./profileLink";
import {
  IPortfolioItem,
  portfolioItemSchema,
  validatePortfolioItemCount,
  MAX_PORTFOLIO_ITEMS,
  MAX_MEDIA_PER_ITEM,
} from "./portfolioItem";

export type { IProfileLink };
export { MAX_PROFILE_LINKS };
export type { IPortfolioItem };
export { MAX_PORTFOLIO_ITEMS, MAX_MEDIA_PER_ITEM };

// PolyGrid Tenders' provider-side profile — serves BOTH halves of the
// pillar: Direct Hire (a client browses this exactly like
// ConsultancyProfile — see docs/tenders-plan.md) and the Project Bidding
// Board (only a contractor with one of these, verified + currently
// subscribed, is eligible to bid at all — see tenderProjectModel.ts).
// Deliberately the same shape as ConsultancyProfile (discovery/presence
// layer only; actually engaging a contractor, whether through Direct Hire
// or an awarded bid, is a Job) — "mirror Consultancy" was explicit in the
// brief, and the two pillars' discovery mechanics really are the same.
export const CONTRACTOR_SPECIALTY = {
  GENERAL_CONTRACTING: "general_contracting",
  STRUCTURAL: "structural",
  ELECTRICAL: "electrical",
  PLUMBING: "plumbing",
  ROOFING: "roofing",
  ARCHITECTURAL_DESIGN: "architectural_design",
  EXCAVATION_EARTHWORKS: "excavation_earthworks",
  HVAC: "hvac",
  MASONRY: "masonry",
  CARPENTRY: "carpentry",
  PAINTING_FINISHING: "painting_finishing",
  LANDSCAPING: "landscaping",
  OTHER: "other",
} as const;
export type ContractorSpecialty = (typeof CONTRACTOR_SPECIALTY)[keyof typeof CONTRACTOR_SPECIALTY];

export interface IContractorProfile extends Document {
  userId: Types.ObjectId;
  // Denormalized from User.currentSubscription, synced by
  // profileSubscriptionSync.ts — same as every other pillar profile.
  currentSubscription: Types.ObjectId | null;
  isVerified: boolean;
  verification: Types.ObjectId | null;
  slug: string;
  headline: string;
  bio?: string;
  specialties: ContractorSpecialty[];
  country: string;
  city?: string;
  yearsOfExperience?: number;
  links: IProfileLink[];
  portfolio: Types.DocumentArray<IPortfolioItem>;
  // Running totals maintained by reviewController.applyReviewToProfile —
  // see reviewModel.ts. Never written to directly anywhere else.
  ratingAverage: number;
  ratingCount: number;
  createdAt: Date;
  updatedAt: Date;
}

const contractorProfileSchema = new Schema<IContractorProfile>(
  {
    userId: { type: Schema.Types.ObjectId, ref: "User", required: true, unique: true },
    currentSubscription: { type: Schema.Types.ObjectId, ref: "Subscription", default: null },
    isVerified: { type: Boolean, default: false },
    verification: { type: Schema.Types.ObjectId, ref: "Verification", default: null },
    slug: { type: String, required: true, unique: true },
    headline: { type: String, required: [true, "Please add a headline"], trim: true },
    bio: { type: String },
    specialties: {
      type: [String],
      enum: Object.values(CONTRACTOR_SPECIALTY),
      default: [],
    },
    country: {
      type: String,
      required: true,
      uppercase: true,
      trim: true,
      validate: {
        validator: isValidCountryCode,
        message: (props: { value: string }) => `${props.value} is not a recognized ISO country code`,
      },
    },
    city: { type: String, trim: true },
    yearsOfExperience: { type: Number, min: 0 },
    links: {
      type: [profileLinkSchema],
      default: [],
      validate: {
        validator: validateLinkCount,
        message: `A profile can have at most ${MAX_PROFILE_LINKS} links`,
      },
    },
    portfolio: {
      type: [portfolioItemSchema],
      default: [],
      validate: {
        validator: validatePortfolioItemCount,
        message: `A profile can have at most ${MAX_PORTFOLIO_ITEMS} portfolio items`,
      },
    },
    ratingAverage: { type: Number, default: 0, min: 0, max: 5 },
    ratingCount: { type: Number, default: 0, min: 0 },
  },
  { timestamps: true },
);

contractorProfileSchema.index({ specialties: 1 });
contractorProfileSchema.index({ isVerified: 1, currentSubscription: 1 });

export const ContractorProfile: Model<IContractorProfile> = mongoose.model<IContractorProfile>(
  "ContractorProfile",
  contractorProfileSchema,
);
