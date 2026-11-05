import mongoose, { Document, Model, Schema, Types } from "mongoose";

// A true singleton — exactly one document ever exists (see
// helpers/systemSettings.ts's getSystemSettings, the only way this is ever
// read or created). Holds the risk-control knobs the user wants to raise
// manually over time as they learn how real money flow behaves, rather
// than hardcoding them as env vars: a global per-transaction ceiling, a
// live cap on how much the system can have outstanding at once (frees up
// as jobs settle — see helpers/paymentGuardrails.ts), and a supported-
// countries allowlist a buyer's own country must be in before they can pay
// at all. Deliberately conservative defaults (see getSystemSettings) so
// nothing is accidentally wide open before an admin has ever configured
// this.
export interface ISystemSettings extends Document {
  maxOutstandingExposure: number;
  maxTransactionAmount: number;
  supportedCountries: string[];
  updatedBy?: Types.ObjectId;
  createdAt: Date;
  updatedAt: Date;
}

const systemSettingsSchema = new Schema<ISystemSettings>(
  {
    maxOutstandingExposure: { type: Number, required: true, min: 0 },
    maxTransactionAmount: { type: Number, required: true, min: 0 },
    supportedCountries: {
      type: [String],
      default: [],
      set: (codes: string[]) => codes.map((code) => code.toUpperCase().trim()),
    },
    updatedBy: { type: Schema.Types.ObjectId, ref: "User" },
  },
  { timestamps: true },
);

export const SystemSettings: Model<ISystemSettings> = mongoose.model<ISystemSettings>(
  "SystemSettings",
  systemSettingsSchema,
);
