import { connectTestDB, disconnectTestDB, clearTestDB } from "../setup/db";
import { createSuperAdmin } from "../setup/fixtures";
import { User, SYSTEM_ROLE } from "../../src/models/userModel";
import { VerificationTemplate } from "../../src/models/verificationTemplateModel";
import { PROFILE_TYPE } from "../../src/constants/profileTypes";
import { ensureSuperAdminExists, ensureVerificationTemplatesSeeded } from "../../src/helpers/deploymentSetup";

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
