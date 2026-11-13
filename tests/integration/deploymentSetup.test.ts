import { connectTestDB, disconnectTestDB, clearTestDB } from "../setup/db";
import { createSuperAdmin } from "../setup/fixtures";
import { User, SYSTEM_ROLE } from "../../src/models/userModel";
import { VerificationTemplate } from "../../src/models/verificationTemplateModel";
import { PROFILE_TYPE } from "../../src/constants/profileTypes";
import {
  ensureSuperAdminExists,
  ensureVerificationTemplatesSeeded,
  ensureUserNamesNormalized,
  ensurePayoutKycHistoryBackfilled,
  ensureConversationIndexesFixed,
} from "../../src/helpers/deploymentSetup";
import { Conversation } from "../../src/models/conversationModel";
import { createUser } from "../setup/fixtures";
import { PayoutKyc, PAYOUT_KYC_STATUS, PAYOUT_KYC_METHOD } from "../../src/models/payoutKycModel";
import { PayoutKycHistory } from "../../src/models/payoutKycHistoryModel";

const SUPER_ADMIN_ENV_KEYS = ["SUPER_ADMIN_NAME", "SUPER_ADMIN_EMAIL", "SUPER_ADMIN_PASSWORD"] as const;
const savedEnv: Record<string, string | undefined> = {};

beforeAll(async () => {
  await connectTestDB();
});

beforeEach(() => {
  for (const key of SUPER_ADMIN_ENV_KEYS) savedEnv[key] = process.env[key];
});

afterEach(async () => {
  await clearTestDB();
  for (const key of SUPER_ADMIN_ENV_KEYS) {
    if (savedEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedEnv[key];
  }
});

afterAll(async () => {
  await disconnectTestDB();
});

describe("ensureSuperAdminExists", () => {
  it("creates the Super Admin from env vars when none exists", async () => {
    process.env.SUPER_ADMIN_NAME = "Test Admin";
    process.env.SUPER_ADMIN_EMAIL = "test-super-admin@example.com";
    process.env.SUPER_ADMIN_PASSWORD = "a-strong-password";

    const result = await ensureSuperAdminExists();

    expect(result.status).toBe("success");
    expect(result.message).toContain("created");

    const created = await User.findOne({ systemRole: SYSTEM_ROLE.SUPER_ADMIN });
    expect(created).not.toBeNull();
    expect(created?.email).toBe("test-super-admin@example.com");
    expect(created?.password).not.toBe("a-strong-password"); // hashed, not plaintext
  });

  it("is a no-op when a Super Admin already exists", async () => {
    const existing = await createSuperAdmin({ email: "already-here@example.com" });

    const result = await ensureSuperAdminExists();

    expect(result.status).toBe("success");
    expect(result.message).toContain("already exists");
    expect(await User.countDocuments({ systemRole: SYSTEM_ROLE.SUPER_ADMIN })).toBe(1);
    expect((await User.findOne({ systemRole: SYSTEM_ROLE.SUPER_ADMIN }))?.id).toBe(existing.id);
  });

  it("fails clearly when the env vars aren't set", async () => {
    delete process.env.SUPER_ADMIN_NAME;
    delete process.env.SUPER_ADMIN_EMAIL;
    delete process.env.SUPER_ADMIN_PASSWORD;

    const result = await ensureSuperAdminExists();

    expect(result.status).toBe("failed");
    expect(await User.countDocuments({ systemRole: SYSTEM_ROLE.SUPER_ADMIN })).toBe(0);
  });
});

describe("ensureVerificationTemplatesSeeded", () => {
  it("creates one placeholder Nigeria template per registered profile type", async () => {
    const result = await ensureVerificationTemplatesSeeded();

    expect(result.status).toBe("success");

    const templates = await VerificationTemplate.find({ country: "NG", isActive: true });
    expect(templates).toHaveLength(Object.values(PROFILE_TYPE).length);

    for (const profileType of Object.values(PROFILE_TYPE)) {
      const template = templates.find((t) => t.profileType === profileType);
      expect(template).toBeDefined();
      expect(template?.fields.length).toBeGreaterThan(0);
      expect(template?.documents.length).toBeGreaterThan(0);
    }
  });

  it("is a no-op for a profile type that already has an active Nigeria template", async () => {
    await VerificationTemplate.create({
      profileType: PROFILE_TYPE.CONSULTANCY,
      country: "NG",
      state: null,
      name: "Already seeded",
      fields: [{ key: "x", label: "X", type: "string", required: true }],
      documents: [{ type: "doc", label: "Doc", required: true, acceptedFormats: ["pdf"] }],
    });

    const result = await ensureVerificationTemplatesSeeded();

    expect(result.status).toBe("success");
    expect(await VerificationTemplate.countDocuments({ profileType: PROFILE_TYPE.CONSULTANCY, country: "NG" })).toBe(
      1,
    );
    // Every other profile type still got seeded.
    expect(await VerificationTemplate.countDocuments({ country: "NG", isActive: true })).toBe(
      Object.values(PROFILE_TYPE).length,
    );
  });

  it("running it twice never creates duplicates", async () => {
    await ensureVerificationTemplatesSeeded();
    await ensureVerificationTemplatesSeeded();

    expect(await VerificationTemplate.countDocuments({ country: "NG" })).toBe(Object.values(PROFILE_TYPE).length);
  });
});

describe("ensureUserNamesNormalized", () => {
  it("backfills firstName/lastName/userName for a User still on the old plain-string fullName", async () => {
    // Inserted via the raw collection, bypassing Mongoose's own
    // fullNameSchema cast — simulates a pre-restructure document, the
    // same reason ensureConversationIndexesFixed's own test creates its
    // old index by hand rather than via the current schema.
    const { insertedId } = await User.collection.insertOne({
      fullName: "Legacy Name Here",
      email: "legacy-user@example.com",
      password: "hashed",
      systemRole: SYSTEM_ROLE.USER,
      activeAccountType: "normal",
      accountStatus: "active",
      authProviders: [],
      verified: false,
      user2fa: { enable: false },
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    const result = await ensureUserNamesNormalized();

    expect(result.status).toBe("success");
    expect(result.message).toContain("1");

    // .lean() — comparing a hydrated Mongoose subdocument directly with
    // toEqual trips jest's equality checker over internal getters it
    // doesn't expect; a plain object sidesteps that entirely.
    const migrated = await User.findById(insertedId).lean();
    expect(migrated?.fullName).toEqual({ firstName: "Legacy", lastName: "Name Here" });
    expect(migrated?.userName).toBe("Legacy Name Here");
  });

  it("is a no-op once every User already has the new shape", async () => {
    await createSuperAdmin();

    const result = await ensureUserNamesNormalized();

    expect(result.status).toBe("success");
    expect(result.message).toContain("already");
  });

  it("running it twice never double-processes an already-migrated document", async () => {
    await User.collection.insertOne({
      fullName: "Run Twice",
      email: "run-twice@example.com",
      password: "hashed",
      systemRole: SYSTEM_ROLE.USER,
      activeAccountType: "normal",
      accountStatus: "active",
      authProviders: [],
      verified: false,
      user2fa: { enable: false },
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    await ensureUserNamesNormalized();
    const second = await ensureUserNamesNormalized();

    expect(second.status).toBe("success");
    expect(second.message).toContain("already");

    const migrated = await User.findOne({ email: "run-twice@example.com" }).lean();
    expect(migrated?.fullName).toEqual({ firstName: "Run", lastName: "Twice" });
  });
});

describe("ensurePayoutKycHistoryBackfilled", () => {
  it("backfills a history entry for an already-verified PayoutKyc record with none yet", async () => {
    const user = await createUser({ country: "NG", fullName: { firstName: "Ada", lastName: "Okafor" } });
    await PayoutKyc.create({
      user: user._id,
      country: "NG",
      method: PAYOUT_KYC_METHOD.AUTOMATED,
      idType: "bvn",
      last4: "1234",
      providerReference: "ref-legacy",
      status: PAYOUT_KYC_STATUS.VERIFIED,
      verifiedAt: new Date("2026-01-01T00:00:00Z"),
    });

    const result = await ensurePayoutKycHistoryBackfilled();

    expect(result.status).toBe("success");
    expect(result.message).toContain("1");

    const history = await PayoutKycHistory.findOne({ user: user._id });
    expect(history).toBeTruthy();
    expect(history?.fullName).toEqual({ firstName: "Ada", lastName: "Okafor" });
    expect(history?.providerReference).toBe("ref-legacy");
  });

  it("is a no-op once every verified record already has a history entry", async () => {
    const user = await createUser({ country: "NG" });
    const record = await PayoutKyc.create({
      user: user._id,
      country: "NG",
      method: PAYOUT_KYC_METHOD.AUTOMATED,
      status: PAYOUT_KYC_STATUS.VERIFIED,
      verifiedAt: new Date(),
    });
    await ensurePayoutKycHistoryBackfilled();

    const second = await ensurePayoutKycHistoryBackfilled();

    expect(second.status).toBe("success");
    expect(second.message).toContain("already");
    expect(await PayoutKycHistory.countDocuments({ user: user._id })).toBe(1);
    expect(record.status).toBe(PAYOUT_KYC_STATUS.VERIFIED); // sanity: untouched by the backfill
  });

  it("never touches a PENDING or FAILED record", async () => {
    const user = await createUser({ country: "NG" });
    await PayoutKyc.create({
      user: user._id,
      country: "NG",
      method: PAYOUT_KYC_METHOD.DOCUMENT,
      status: PAYOUT_KYC_STATUS.PENDING,
    });

    const result = await ensurePayoutKycHistoryBackfilled();

    expect(result.status).toBe("success");
    expect(await PayoutKycHistory.countDocuments({ user: user._id })).toBe(0);
  });
});

describe("ensureConversationIndexesFixed", () => {
  it("drops the old broken multikey-unique index and leaves the new pairKey index in place", async () => {
    // Simulates an existing (dev/staging) database still on the old
    // schema — Conversation.init() in connectTestDB only ever creates
    // indexes the *current* schema declares, so the old one has to be
    // added by hand here to have anything to migrate away from.
    await Conversation.collection.dropIndex("pairKey_1").catch(() => {});
    await Conversation.collection.createIndex({ participants: 1 }, { unique: true, name: "participants_1" });

    const result = await ensureConversationIndexesFixed();
    expect(result.status).toBe("success");
    expect(result.message).toContain("participants_1");

    const indexes = await Conversation.collection.indexes();
    const indexNames = indexes.map((index) => index.name);
    expect(indexNames).not.toContain("participants_1");
    expect(indexNames).toContain("pairKey_1");
  });

  it("is a no-op once the database is already on the new schema", async () => {
    const result = await ensureConversationIndexesFixed();
    expect(result.status).toBe("success");
    expect(result.message).toBe("Conversation indexes already correct");
  });
});
