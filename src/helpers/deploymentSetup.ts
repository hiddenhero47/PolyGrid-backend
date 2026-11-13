import bcrypt from "bcryptjs";
import { Types } from "mongoose";
import { User, SYSTEM_ROLE } from "../models/userModel";
import { VerificationTemplate, TEMPLATE_FIELD_TYPE, TEMPLATE_DOCUMENT_FORMAT } from "../models/verificationTemplateModel";
import { PROFILE_TYPE, ProfileType } from "../constants/profileTypes";
import { Conversation } from "../models/conversationModel";
import { SystemSettings } from "../models/systemSettingsModel";
import { splitFullName } from "./nameMatch";
import { PayoutKyc, PAYOUT_KYC_STATUS } from "../models/payoutKycModel";
import { PayoutKycHistory } from "../models/payoutKycHistoryModel";

// Mirrors house-maduekwe-backend's helpers/ensureAdmin.js +
// helpers/appSetup.js pattern — a set of idempotent "ensure X exists"
// setup tasks, each returning a loggable result, run together by
// deploymentController.runDeploymentSetupTasks, reachable only via
// POST /api/deployment/setup (timeWindowGuard-gated — never run
// automatically at boot, see server.ts). Safe to call repeatedly — each
// task checks before it acts and no-ops once already done.
//
// Every result here is the ONLY thing that route returns, to an
// unauthenticated caller (within the open window) — never include an
// email, password, or raw internal error text in a `message`. Log
// anything sensitive server-side instead.

export interface SetupTaskResult {
  task: string;
  status: "success" | "failed";
  message: string;
}

// @task Ensure Super Admin — the one bootstrap step every other admin
// action depends on: registerAdmin/changeUserRole (userController.ts)
// both require an existing Super Admin to call them, so nothing else can
// create the first one. Credentials come from env (SUPER_ADMIN_NAME/
// _EMAIL/_PASSWORD) — never hardcoded, never logged. The userModel's own
// pre-save guard (userModel.ts) already throws if a Super Admin exists,
// but checking first here keeps this idempotent without relying on
// catching that as the "already exists" signal.
export const ensureSuperAdminExists = async (): Promise<SetupTaskResult> => {
  try {
    const existing = await User.findOne({ systemRole: SYSTEM_ROLE.SUPER_ADMIN });

    if (existing) {
      return { task: "Ensure Super Admin", status: "success", message: "Super Admin already exists" };
    }

    const name = process.env.SUPER_ADMIN_NAME;
    const email = process.env.SUPER_ADMIN_EMAIL;
    const password = process.env.SUPER_ADMIN_PASSWORD;

    if (!name || !email || !password) {
      return {
        task: "Ensure Super Admin",
        status: "failed",
        message: "SUPER_ADMIN_NAME, SUPER_ADMIN_EMAIL, and SUPER_ADMIN_PASSWORD must all be set in .env",
      };
    }

    const salt = await bcrypt.genSalt(10);
    const hashedPassword = await bcrypt.hash(password, salt);

    const superAdmin = new User({
      fullName: splitFullName(name),
      userName: name,
      email,
      password: hashedPassword,
      verified: true,
      systemRole: SYSTEM_ROLE.SUPER_ADMIN,
    });
    superAdmin._adminCreation = true; // internal flag, never persisted — see userModel.ts

    await superAdmin.save();

    return { task: "Ensure Super Admin", status: "success", message: "Super Admin created" };
  } catch (err) {
    // Never return the raw error to the caller — this result is the
    // entire HTTP response of an unauthenticated route, and a Mongo
    // duplicate-key error on `email` embeds the email's value in its own
    // message text. Full detail goes to the server log instead.
    console.error("[DEPLOYMENT SETUP] ensureSuperAdminExists failed:", err);
    return { task: "Ensure Super Admin", status: "failed", message: "Failed to ensure Super Admin exists — see server logs" };
  }
};

// @task Ensure Verification Templates (Nigeria) — every profile type
// registered in PROFILE_MODEL_REGISTRY needs an active template before
// anyone can submit verification for it at all (see
// helpers/verificationTemplateLookup.ts). These are deliberately
// placeholder content — one generic field, one generic document — not
// real per-pillar regulatory requirements. Good enough for the
// submit-verification flow to actually work end-to-end pre-launch;
// replace with real requirements (via the normal
// POST /api/verification-templates admin endpoint, which versions
// properly) before relying on this for real users. See
// docs/verification-templates-plan.md.
const NIGERIA = "NG";

const PLACEHOLDER_PROFILE_TYPES: ProfileType[] = Object.values(PROFILE_TYPE);

export const ensureVerificationTemplatesSeeded = async (): Promise<SetupTaskResult> => {
  try {
    const created: string[] = [];

    for (const profileType of PLACEHOLDER_PROFILE_TYPES) {
      const existing = await VerificationTemplate.findOne({
        profileType,
        country: NIGERIA,
        state: null,
        isActive: true,
      });

      if (existing) continue;

      await VerificationTemplate.create({
        profileType,
        country: NIGERIA,
        state: null,
        name: `Nigeria placeholder — ${profileType}`,
        fields: [
          {
            key: "fullName",
            label: "Full legal name",
            type: TEMPLATE_FIELD_TYPE.STRING,
            required: true,
          },
        ],
        documents: [
          {
            type: "identity_document",
            label: "Government-issued ID",
            required: true,
            acceptedFormats: [TEMPLATE_DOCUMENT_FORMAT.PDF, TEMPLATE_DOCUMENT_FORMAT.JPG, TEMPLATE_DOCUMENT_FORMAT.PNG],
          },
        ],
      });

      created.push(profileType);
    }

    return {
      task: "Ensure Verification Templates (Nigeria)",
      status: "success",
      message:
        created.length > 0
          ? `Placeholder templates created for: ${created.join(", ")}`
          : "All profile types already have an active Nigeria template",
    };
  } catch (err) {
    console.error("[DEPLOYMENT SETUP] ensureVerificationTemplatesSeeded failed:", err);
    return {
      task: "Ensure Verification Templates (Nigeria)",
      status: "failed",
      message: "Failed to seed verification templates — see server logs",
    };
  }
};

// @task Fix Conversation's pair-uniqueness index — conversationModel.ts
// used to enforce "one conversation per pair" with a unique index
// directly on the `participants` array, which Mongo indexes as a
// *multikey* index: unique per ELEMENT, not per full-array value. The
// real effect was "every user can only ever be in one conversation,
// ever" (see docs/jobs-and-contacts-plan.md and conversationModel.ts's
// own comment on `pairKey`, the field that now actually carries this
// constraint). Model.syncIndexes() is scoped to just this one model —
// it drops the old `participants_1` index (no longer declared in the
// schema) and creates `pairKey_1` (declared, but not yet present on an
// existing database), leaving every other model's indexes untouched.
// Safe to call repeatedly: a database already on the new schema has
// nothing to sync.
// @task Ensure SystemSettings is seeded — paymentGuardrails.ts's checks
// are deliberately closed by default (helpers/systemSettings.ts's own
// DEFAULTS: no country supported, every cap 0), so without this nothing
// payment-related works at all on a fresh deploy. All whole USD, not
// cents — same unit Payment.amount itself already uses everywhere;
// conversion to Stripe's minor units only happens inside
// providers/paymentProviders/stripeProvider.ts, right before the API
// call. One named constant below so these are easy to tweak later.
// Only ever seeds while the singleton doesn't exist yet — never
// overwrites values an admin has since changed via
// PATCH /api/system-settings; this is a one-time seed, not a sync.
const INITIAL_SYSTEM_SETTINGS = {
  supportedCountries: ["NG"],
  maxTransactionAmount: 7463, // ~10,000,000 NGN
  maxOutstandingExposure: 7463, // ~10,000,000 NGN
  fraudHoldThresholdAmount: 746, // ~1,000,000 NGN
  fraudHoldHours: 24,
  manualReviewThresholdAmount: 74627, // ~100,000,000 NGN
  // Stripe stays the global default (absent from this map); Nigeria
  // routes to Paystack instead, since Stripe can't pay out to a
  // Nigerian bank account at all — see docs/payments-plan.md.
  countryProviderOverrides: { NG: "paystack" },
  // Nigeria gets the automated BVN/NIN track via Dojah; every other
  // country has no entry here, so it falls back to the document track
  // automatically (BVN/NIN only exist for Nigeria) — see
  // payoutKycController.ts.
  countryKycProviders: { NG: "dojah" },
};

export const ensureSystemSettingsSeeded = async (): Promise<SetupTaskResult> => {
  try {
    const existing = await SystemSettings.findOne();

    if (existing) {
      return {
        task: "Ensure SystemSettings seeded",
        status: "success",
        message: "SystemSettings already configured — left untouched",
      };
    }

    await SystemSettings.create(INITIAL_SYSTEM_SETTINGS);

    return {
      task: "Ensure SystemSettings seeded",
      status: "success",
      message: "SystemSettings created with initial values",
    };
  } catch (err) {
    console.error("[DEPLOYMENT SETUP] ensureSystemSettingsSeeded failed:", err);
    return {
      task: "Ensure SystemSettings seeded",
      status: "failed",
      message: "Failed to seed SystemSettings — see server logs",
    };
  }
};

// @task Backfill User.fullName/userName onto the new {firstName, lastName}
// + userName shape — a one-time migration for any document still holding
// the old plain-string `fullName` from before that restructure. Reads via
// the raw collection (not the Mongoose model), since the model's own
// fullNameSchema cast would reject the old string shape outright before
// this ever got a chance to fix it. userName gets the old string as-is
// (not just the first name) — the most recognizable, least-lossy choice
// for a field that's purely cosmetic.
export const ensureUserNamesNormalized = async (): Promise<SetupTaskResult> => {
  try {
    const legacy = await User.collection
      .find({ "fullName.firstName": { $exists: false } })
      .project({ fullName: 1 })
      .toArray();

    if (legacy.length === 0) {
      return {
        task: "Normalize User names",
        status: "success",
        message: "Every User already has the firstName/lastName + userName shape",
      };
    }

    await User.collection.bulkWrite(
      legacy.map((doc) => {
        const oldFullName = String(doc.fullName ?? "");
        return {
          updateOne: {
            filter: { _id: doc._id },
            update: { $set: { fullName: splitFullName(oldFullName), userName: oldFullName } },
          },
        };
      }),
    );

    return {
      task: "Normalize User names",
      status: "success",
      message: `Backfilled firstName/lastName/userName for ${legacy.length} user(s)`,
    };
  } catch (err) {
    console.error("[DEPLOYMENT SETUP] ensureUserNamesNormalized failed:", err);
    return {
      task: "Normalize User names",
      status: "failed",
      message: "Failed to normalize User names — see server logs",
    };
  }
};

// @task Backfill PayoutKycHistory for every already-VERIFIED PayoutKyc
// record that predates the history collection — otherwise anyone
// verified before this feature shipped would show zero bookkeeping
// entries despite genuinely being verified. Best-effort by nature: it
// snapshots the user's *current* fullName/country, since the actual
// values at the moment they were originally verified were never
// recorded anywhere to recover — accurate for anyone who hasn't changed
// either since (the common case, and the only case possible going
// forward now that a verified identity is locked — see
// userController.ts's updateUserProfile), approximate for anyone who
// changed theirs under the old, pre-lock rules.
export const ensurePayoutKycHistoryBackfilled = async (): Promise<SetupTaskResult> => {
  try {
    const alreadyLogged = new Set(
      (await PayoutKycHistory.distinct("user")).map((id) => id.toString()),
    );

    const verifiedRecords = await PayoutKyc.find({ status: PAYOUT_KYC_STATUS.VERIFIED }).populate<{
      user: { _id: Types.ObjectId; fullName: { firstName: string; lastName: string } } | null;
    }>("user", "fullName");

    const missing = verifiedRecords.filter(
      (record) => record.user && !alreadyLogged.has(record.user._id.toString()),
    );

    if (missing.length === 0) {
      return {
        task: "Backfill PayoutKycHistory",
        status: "success",
        message: "Every verified PayoutKyc record already has a history entry",
      };
    }

    await PayoutKycHistory.insertMany(
      missing.map((record) => {
        const owner = record.user as { _id: Types.ObjectId; fullName: { firstName: string; lastName: string } };
        return {
          user: owner._id,
          fullName: { firstName: owner.fullName.firstName, lastName: owner.fullName.lastName },
          country: record.country,
          method: record.method,
          idType: record.idType,
          provider: record.provider,
          last4: record.last4,
          providerReference: record.providerReference,
          documents: record.documents,
          reviewedBy: record.reviewedBy,
          verifiedAt: record.verifiedAt ?? record.updatedAt,
        };
      }),
    );

    return {
      task: "Backfill PayoutKycHistory",
      status: "success",
      message: `Backfilled a history entry for ${missing.length} already-verified user(s)`,
    };
  } catch (err) {
    console.error("[DEPLOYMENT SETUP] ensurePayoutKycHistoryBackfilled failed:", err);
    return {
      task: "Backfill PayoutKycHistory",
      status: "failed",
      message: "Failed to backfill PayoutKycHistory — see server logs",
    };
  }
};

export const ensureConversationIndexesFixed = async (): Promise<SetupTaskResult> => {
  try {
    const dropped = await Conversation.syncIndexes();

    return {
      task: "Fix Conversation pair-uniqueness index",
      status: "success",
      message:
        dropped.length > 0
          ? `Dropped obsolete index(es): ${dropped.join(", ")}`
          : "Conversation indexes already correct",
    };
  } catch (err) {
    console.error("[DEPLOYMENT SETUP] ensureConversationIndexesFixed failed:", err);
    return {
      task: "Fix Conversation pair-uniqueness index",
      status: "failed",
      message: "Failed to sync Conversation indexes — see server logs",
    };
  }
};
