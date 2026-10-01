import mongoose, { Document, Model, Schema, Types } from "mongoose";
import { isValidCountryCode } from "../helpers/countryReference";
import { isValidCurrencyCode } from "../helpers/currencyReference";
import { IProfileLink, profileLinkSchema, validateLinkCount, MAX_PROFILE_LINKS } from "./profileLink";
import {
  IPortfolioItem,
  IPortfolioMedia,
  portfolioItemSchema,
  validatePortfolioItemCount,
  MAX_PORTFOLIO_ITEMS,
  MAX_MEDIA_PER_ITEM,
} from "./portfolioItem";

export type { IProfileLink };
export { MAX_PROFILE_LINKS };
export type { IPortfolioItem, IPortfolioMedia };
export { MAX_PORTFOLIO_ITEMS, MAX_MEDIA_PER_ITEM };

// PolyGrid Engineering's profile — the discovery/presence layer only
// ("a personal mini-site"). Actually *engaging* a consultant — booking a
// consultation, ordering a structural audit, getting a blueprint
// reviewed — is a Job (jobType: 'engineering') between the client and this
// profile's userId, not something this model handles: Job already owns
// scope agreement, staged deliverables, escrow, and disputes, and none of
// that needs reinventing here. This mirrors how real consultant
// marketplaces (Upwork, Contra, Toptal) keep a professional's public
// profile/portfolio separate from however a specific engagement is priced
// and tracked.
export const SPECIALIZATION = {
  STRUCTURAL: "structural",
  GEOTECHNICAL: "geotechnical",
  HYDRAULIC_WATER: "hydraulic_water",
  ARCHITECTURAL: "architectural",
} as const;
export type Specialization = (typeof SPECIALIZATION)[keyof typeof SPECIALIZATION];

export const SERVICE_PRICING_MODE = {
  FIXED: "fixed", // one-off package price, e.g. "Structural audit report"
  HOURLY: "hourly",
  PER_SESSION: "per_session", // a single scheduled consultation/call
} as const;
export type ServicePricingMode =
  (typeof SERVICE_PRICING_MODE)[keyof typeof SERVICE_PRICING_MODE];

export interface IServiceListing {
  _id: Types.ObjectId;
  title: string;
  description?: string;
  pricingMode: ServicePricingMode;
  price: number;
  currency: string;
  durationMinutes?: number; // meaningful for hourly/per_session, not fixed
}

export interface IMentorship {
  isMentor: boolean;
  bio?: string;
  // Free-form tags rather than an enum — "areas of mentorship" isn't a
  // fixed taxonomy the way specializations is.
  areas: string[];
  // undefined/0 = offered free, matching how real mentorship offerings on
  // these platforms are often unpaid goodwill rather than billable work.
  ratePerSession?: number;
}

export interface IConsultancyProfile extends Document {
  userId: Types.ObjectId;
  // Denormalized from User.currentSubscription, kept in sync by
  // src/helpers/profileSubscriptionSync.ts whenever it changes (grantSubscription,
  // the Stripe webhook). Exists so the public listing/search query
  // (consultancyProfileController.searchConsultants) is a single $lookup
  // against this profile collection directly, instead of a two-hop join
  // through User for every search.
  currentSubscription: Types.ObjectId | null;
  isVerified: boolean;
  // Points at the *latest* Verification record — see verificationModel.ts
  // for why history isn't collapsed into this profile directly.
  verification: Types.ObjectId | null;
  slug: string;
  headline: string;
  bio?: string;
  specializations: Specialization[];
  country: string;
  city?: string;
  yearsOfExperience?: number;
  links: IProfileLink[];
  // DocumentArray (not a plain array) so the controller can look an item up
  // by id with `.id(itemId)`, same reasoning as Job.stages.
  portfolio: Types.DocumentArray<IPortfolioItem>;
  services: Types.DocumentArray<IServiceListing>;
  mentorship: IMentorship;
  // Running totals maintained by reviewController.applyReviewToProfile —
  // see reviewModel.ts. Never written to directly anywhere else.
  ratingAverage: number;
  ratingCount: number;
  createdAt: Date;
  updatedAt: Date;
}

const serviceListingSchema = new Schema<IServiceListing>({
  title: { type: String, required: true, trim: true },
  description: { type: String },
  pricingMode: {
    type: String,
    enum: Object.values(SERVICE_PRICING_MODE),
    required: true,
  },
  price: { type: Number, required: true, min: 0 },
  currency: {
    type: String,
    default: "USD",
    uppercase: true,
    trim: true,
    validate: {
      validator: isValidCurrencyCode,
      message: (props: { value: string }) => `${props.value} is not a recognized ISO 4217 currency code`,
    },
  },
  durationMinutes: { type: Number, min: 1 },
});

const mentorshipSchema = new Schema<IMentorship>(
  {
    isMentor: { type: Boolean, default: false },
    bio: { type: String },
    areas: { type: [String], default: [] },
    ratePerSession: { type: Number, min: 0 },
  },
  { _id: false },
);

const consultancyProfileSchema = new Schema<IConsultancyProfile>(
  {
    userId: { type: Schema.Types.ObjectId, ref: "User", required: true, unique: true },
    currentSubscription: {
      type: Schema.Types.ObjectId,
      ref: "Subscription",
      default: null,
    },
    isVerified: { type: Boolean, default: false },
    verification: { type: Schema.Types.ObjectId, ref: "Verification", default: null },
    slug: { type: String, required: true, unique: true },
    headline: { type: String, required: [true, "Please add a headline"], trim: true },
    bio: { type: String },
    specializations: {
      type: [String],
      enum: Object.values(SPECIALIZATION),
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
    // Not validated against reference data on purpose — see
    // countryReference.ts: city-level coverage is uneven enough that a
    // hard check would reject legitimate towns just for being absent from
    // one dataset. GET /api/reference/countries/:code/cities exists for a
    // frontend that wants an autocomplete/dropdown anyway.
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
    services: { type: [serviceListingSchema], default: [] },
    mentorship: { type: mentorshipSchema, default: () => ({}) },
    ratingAverage: { type: Number, default: 0, min: 0, max: 5 },
    ratingCount: { type: Number, default: 0, min: 0 },
  },
  { timestamps: true },
);

consultancyProfileSchema.index({ specializations: 1 });
consultancyProfileSchema.index({ isVerified: 1, currentSubscription: 1 });

export const ConsultancyProfile: Model<IConsultancyProfile> =
  mongoose.model<IConsultancyProfile>("ConsultancyProfile", consultancyProfileSchema);
