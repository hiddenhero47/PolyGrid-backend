import bcrypt from "bcryptjs";
import { User, SYSTEM_ROLE } from "../models/userModel";
import { VerificationTemplate, TEMPLATE_FIELD_TYPE, TEMPLATE_DOCUMENT_FORMAT } from "../models/verificationTemplateModel";
import { PROFILE_TYPE, ProfileType } from "../constants/profileTypes";
import { Conversation } from "../models/conversationModel";

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
      fullName: name,
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
