import mongoose, { Document, Model, Schema } from "mongoose";
import { PROFILE_TYPE, ProfileType } from "../constants/profileTypes";
import { isValidCountryCode, isValidStateCode } from "../helpers/countryReference";

// What verification actually requires varies by pillar (a consultant's KYC
// looks nothing like a store's business registration) AND by where the
// business operates (PolyGrid is not Nigeria-only) — so instead of hardcoding
// per-country logic (an earlier version of this feature did exactly that for
// Nigeria's COREN/ARCON bodies, and it doesn't generalize), the requirements
// themselves are catalog data: one VerificationTemplate per
// (profileType, country[, state]) combination, the same instinct as `Plan`
// being catalog data rather than hardcoded tiers. It declares both what
// documents are needed and what form fields need to be filled in — and is
// the single source of truth both the server (build a Yup schema from
// `fields` to validate a submission) and the frontend (fetch this to know
// what to render, and build its own Yup schema from the same definition)
// read from, so the two never drift out of sync with each other.
export const TEMPLATE_FIELD_TYPE = {
  STRING: "string",
  NUMBER: "number",
  BOOLEAN: "boolean",
  DATE: "date",
  SELECT: "select",
  EMAIL: "email",
  PHONE: "phone",
} as const;
export type TemplateFieldType = (typeof TEMPLATE_FIELD_TYPE)[keyof typeof TEMPLATE_FIELD_TYPE];

export interface ITemplateField {
  key: string; // the property name this ends up under in Verification.form
  label: string; // human-readable, shown by the frontend and used in error messages
  type: TemplateFieldType;
  required: boolean;
  options?: string[]; // SELECT only
  pattern?: string; // STRING only — a regex source, e.g. a business registration number format
  minLength?: number;
  maxLength?: number;
  min?: number; // NUMBER; epoch ms for DATE
  max?: number; // NUMBER; epoch ms for DATE
  helpText?: string;
}

// Limited to what fileSignature.ts can actually verify by magic bytes —
// no point declaring a format the upload pipeline can't recognize.
export const TEMPLATE_DOCUMENT_FORMAT = {
  PDF: "pdf",
  JPG: "jpg",
  PNG: "png",
  WEBP: "webp",
} as const;
export type TemplateDocumentFormat =
  (typeof TEMPLATE_DOCUMENT_FORMAT)[keyof typeof TEMPLATE_DOCUMENT_FORMAT];

// What uploadHandler's allowedMimeTypes actually needs — a document
// requirement declares accepted formats as the same short extensions the
// admin thinks in ("pdf", "jpg"), so this is the one place that translates
// them into the mime types fileSignature.ts's magic-byte detection deals in.
export const DOCUMENT_FORMAT_MIME: Record<TemplateDocumentFormat, string> = {
  [TEMPLATE_DOCUMENT_FORMAT.PDF]: "application/pdf",
  [TEMPLATE_DOCUMENT_FORMAT.JPG]: "image/jpeg",
  [TEMPLATE_DOCUMENT_FORMAT.PNG]: "image/png",
  [TEMPLATE_DOCUMENT_FORMAT.WEBP]: "image/webp",
};

export interface ITemplateDocument {
  type: string; // matches Verification.documents[].type, e.g. "business_certificate"
  label: string;
  required: boolean;
  acceptedFormats: TemplateDocumentFormat[];
}

export interface IVerificationTemplate extends Document {
  profileType: ProfileType;
  country: string; // ISO 3166-1 alpha-2
  state?: string | null; // null = the country's nationwide default
  name: string;
  version: number;
  isActive: boolean;
  fields: ITemplateField[];
  documents: ITemplateDocument[];
  createdAt: Date;
  updatedAt: Date;
}

const templateFieldSchema = new Schema<ITemplateField>(
  {
    key: { type: String, required: true, trim: true },
    label: { type: String, required: true, trim: true },
    type: { type: String, enum: Object.values(TEMPLATE_FIELD_TYPE), required: true },
    required: { type: Boolean, default: false },
    options: { type: [String], default: undefined },
    pattern: { type: String },
    minLength: { type: Number },
    maxLength: { type: Number },
    min: { type: Number },
    max: { type: Number },
    helpText: { type: String },
  },
  { _id: false },
);

const templateDocumentSchema = new Schema<ITemplateDocument>(
  {
    type: { type: String, required: true, trim: true },
    label: { type: String, required: true, trim: true },
    required: { type: Boolean, default: true },
    acceptedFormats: {
      type: [String],
      enum: Object.values(TEMPLATE_DOCUMENT_FORMAT),
      default: [TEMPLATE_DOCUMENT_FORMAT.PDF],
    },
  },
  { _id: false },
);

const verificationTemplateSchema = new Schema<IVerificationTemplate>(
  {
    profileType: { type: String, enum: Object.values(PROFILE_TYPE), required: true },
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
    state: {
      type: String,
      trim: true,
      uppercase: true,
      default: null,
      // `this` is the template document — a plain function so Mongoose
      // binds it, same technique as the portfolio item's completedAt
      // check. A country with no states in the reference data has nothing
      // to check against (see countryReference.isValidStateCode).
      validate: {
        validator: function (this: IVerificationTemplate, value: string | null) {
          if (!value) return true;
          return isValidStateCode(this.country, value);
        },
        message: "Not a recognized state/province for this country",
      },
    },
    name: { type: String, required: true, trim: true },
    version: { type: Number, default: 1 },
    isActive: { type: Boolean, default: true },
    fields: { type: [templateFieldSchema], default: [] },
    documents: { type: [templateDocumentSchema], default: [] },
  },
  { timestamps: true },
);

// Only one *active* template per profileType+country+state — `state: null`
// is the nationwide default, and Mongo's unique index already treats null as
// one distinct value, so this also caps it at one active nationwide template
// per profileType+country for free. Never edited in place once it exists:
// createTemplate deactivates the previous active one and creates a new
// version instead (same "Plan is never edited, only deactivated" instinct),
// so a Verification's stored `templateId` always resolves to the exact
// version it was validated against, even after admins tweak requirements.
verificationTemplateSchema.index(
  { profileType: 1, country: 1, state: 1 },
  { unique: true, partialFilterExpression: { isActive: true } },
);

export const VerificationTemplate: Model<IVerificationTemplate> =
  mongoose.model<IVerificationTemplate>("VerificationTemplate", verificationTemplateSchema);
