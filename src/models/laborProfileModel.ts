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

// PolyGrid SiteForce's provider-side profile — serves both Direct
// Tradesperson Hiring (browse/hire exactly like ConsultancyProfile/
// ContractorProfile) and the Location-Based Job Board (only a worker with
// one of these, verified + currently subscribed, is eligible to apply at
// all — see jobOpeningModel.ts and docs/siteforce-plan.md). `isVerified`
// here is the safety mechanism, not a nice-to-have: real platforms that
// send someone alone to a stranger's property (TaskRabbit, Handy)
// background-check that person before they're allowed to take jobs —
// this is PolyGrid's equivalent, reusing the Verification pipeline every
// other pillar already has, not a new concept invented for this one.
export const LABOR_SKILL = {
  FOREMAN: "foreman",
  CARPENTRY: "carpentry",
  PLUMBING: "plumbing",
  ELECTRICAL: "electrical",
  MASONRY: "masonry",
  PAINTING: "painting",
  WELDING: "welding",
  ROOFING: "roofing",
  GENERAL_LABOR: "general_labor",
  OTHER: "other",
} as const;
export type LaborSkill = (typeof LABOR_SKILL)[keyof typeof LABOR_SKILL];

export interface ILaborProfile extends Document {
  userId: Types.ObjectId;
  currentSubscription: Types.ObjectId | null;
  isVerified: boolean;
  verification: Types.ObjectId | null;
  slug: string;
  headline: string;
  bio?: string;
  skills: LaborSkill[];
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

const laborProfileSchema = new Schema<ILaborProfile>(
  {
    userId: { type: Schema.Types.ObjectId, ref: "User", required: true, unique: true },
    currentSubscription: { type: Schema.Types.ObjectId, ref: "Subscription", default: null },
    isVerified: { type: Boolean, default: false },
    verification: { type: Schema.Types.ObjectId, ref: "Verification", default: null },
    slug: { type: String, required: true, unique: true },
    headline: { type: String, required: [true, "Please add a headline"], trim: true },
    bio: { type: String },
    skills: {
      type: [String],
      enum: Object.values(LABOR_SKILL),
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

laborProfileSchema.index({ skills: 1 });
laborProfileSchema.index({ isVerified: 1, currentSubscription: 1 });

export const LaborProfile: Model<ILaborProfile> = mongoose.model<ILaborProfile>(
  "LaborProfile",
  laborProfileSchema,
);
