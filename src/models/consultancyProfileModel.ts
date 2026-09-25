import mongoose, { Document, Model, Schema, Types } from "mongoose";

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

// A profile can have at most this many portfolio items, and each item at
// most this many media files — unbounded arrays here would mean unbounded
// disk usage and DB document growth per profile, with no real ceiling.
// Deliberately generous for a legitimate portfolio, not a hard product
// constraint — revisit the numbers if a real user's usage says otherwise.
export const MAX_PORTFOLIO_ITEMS = 20;
export const MAX_MEDIA_PER_ITEM = 6;
// Same reasoning for external links — a handful of "where else to find me"
// links, not an unbounded list.
export const MAX_PROFILE_LINKS = 3;

// External links only (website, LinkedIn, a portfolio site, Behance,
// GitHub, etc.) — deliberately NOT a place for raw contact details (phone/
// email/WhatsApp). PolyGrid's whole Jobs system exists to capture a
// platform fee on an engagement; publicly exposing a way to reach a
// consultant directly would make it trivial to arrange payment off-
// platform and skip that fee entirely, the same reason most real
// consultant marketplaces (Upwork, Toptal, Contra) don't surface direct
// contact info on a public profile either. A client reaches out by
// creating a Job instead.
export interface IProfileLink {
  label: string; // e.g. "Website", "LinkedIn", "Portfolio"
  url: string;
}

// Genuinely matches IAvatar's shape now ({fileName, storagePath, mime,
// size, url}) — storagePath is what lets a deleted/replaced media entry's
// file actually be removed from disk (fileSyncStorage.deleteStoredFile
// needs a real path, not just a fileName), same reason IAvatar keeps it.
// Stripped before a public response the same way toPublicUser strips it
// off avatar — an internal filesystem path has no business leaving the
// server.
export interface IPortfolioMedia {
  fileName: string;
  storagePath: string;
  mime: string;
  size: number;
  url?: string;
}

export interface IPortfolioItem {
  _id: Types.ObjectId;
  title: string;
  description?: string;
  media: IPortfolioMedia[];
  tags: string[];
  startedAt?: Date;
  completedAt?: Date;
}

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
  createdAt: Date;
  updatedAt: Date;
}

const portfolioMediaSchema = new Schema<IPortfolioMedia>(
  {
    fileName: { type: String, required: true },
    storagePath: { type: String, required: true },
    mime: { type: String, required: true },
    size: { type: Number, required: true },
    url: { type: String },
  },
  { _id: false },
);

const portfolioItemSchema = new Schema<IPortfolioItem>({
  title: { type: String, required: true, trim: true },
  description: { type: String },
  media: {
    type: [portfolioMediaSchema],
    default: [],
    // Defense in depth alongside the controller-level checks in
    // consultancyProfileController.ts, which is what actually produces a
    // clean 400 before any file touches disk — this just guarantees the
    // limit holds even if a future code path ever bypasses the controller.
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

const serviceListingSchema = new Schema<IServiceListing>({
  title: { type: String, required: true, trim: true },
  description: { type: String },
  pricingMode: {
    type: String,
    enum: Object.values(SERVICE_PRICING_MODE),
    required: true,
  },
  price: { type: Number, required: true, min: 0 },
  currency: { type: String, default: "USD", uppercase: true, trim: true },
  durationMinutes: { type: Number, min: 1 },
});

const profileLinkSchema = new Schema<IProfileLink>(
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
    country: { type: String, required: true, uppercase: true, trim: true },
    city: { type: String, trim: true },
    yearsOfExperience: { type: Number, min: 0 },
    links: {
      type: [profileLinkSchema],
      default: [],
      validate: {
        validator: (links: IProfileLink[]) => links.length <= MAX_PROFILE_LINKS,
        message: `A profile can have at most ${MAX_PROFILE_LINKS} links`,
      },
    },
    portfolio: {
      type: [portfolioItemSchema],
      default: [],
      validate: {
        validator: (items: IPortfolioItem[]) => items.length <= MAX_PORTFOLIO_ITEMS,
        message: `A profile can have at most ${MAX_PORTFOLIO_ITEMS} portfolio items`,
      },
    },
    services: { type: [serviceListingSchema], default: [] },
    mentorship: { type: mentorshipSchema, default: () => ({}) },
  },
  { timestamps: true },
);

consultancyProfileSchema.index({ specializations: 1 });
consultancyProfileSchema.index({ isVerified: 1, currentSubscription: 1 });

export const ConsultancyProfile: Model<IConsultancyProfile> =
  mongoose.model<IConsultancyProfile>("ConsultancyProfile", consultancyProfileSchema);
