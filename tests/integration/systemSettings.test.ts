import request from "supertest";
import createApp from "../../src/app";
import { connectTestDB, disconnectTestDB, clearTestDB } from "../setup/db";
import { createUser, createAdmin, createSuperAdmin, createCustomerCare, generateToken } from "../setup/fixtures";
import { SystemSettings } from "../../src/models/systemSettingsModel";

const app = createApp();

beforeAll(async () => {
  await connectTestDB();
});

afterEach(async () => {
  await clearTestDB();
});

afterAll(async () => {
  await disconnectTestDB();
});

describe("GET /api/system-settings", () => {
  it("requires authentication", async () => {
    const res = await request(app).get("/api/system-settings");
    expect(res.status).toBe(401);
  });

  it("blocks a plain user", async () => {
    const user = await createUser();
    const res = await request(app)
      .get("/api/system-settings")
      .set("Authorization", `Bearer ${generateToken(user)}`);
    expect(res.status).toBe(401);
  });

  it("lets customer_care (REVIEW_ROLES) read it", async () => {
    const reviewer = await createCustomerCare();
    const res = await request(app)
      .get("/api/system-settings")
      .set("Authorization", `Bearer ${generateToken(reviewer)}`);
    expect(res.status).toBe(200);
  });

  it("creates conservative defaults on first read — nothing supported, both caps 0", async () => {
    const admin = await createAdmin();
    const res = await request(app)
      .get("/api/system-settings")
      .set("Authorization", `Bearer ${generateToken(admin)}`);

    expect(res.status).toBe(200);
    expect(res.body.maxOutstandingExposure).toBe(0);
    expect(res.body.maxTransactionAmount).toBe(0);
    expect(res.body.supportedCountries).toEqual([]);

    expect(await SystemSettings.countDocuments()).toBe(1);
  });
});

describe("PATCH /api/system-settings", () => {
  it("blocks a plain admin — super_admin only", async () => {
    const admin = await createAdmin();
    const res = await request(app)
      .patch("/api/system-settings")
      .set("Authorization", `Bearer ${generateToken(admin)}`)
      .send({ maxTransactionAmount: 5000 });

    expect(res.status).toBe(401);
  });

  it("lets super_admin raise the caps and set supported countries", async () => {
    const superAdmin = await createSuperAdmin();
    const res = await request(app)
      .patch("/api/system-settings")
      .set("Authorization", `Bearer ${generateToken(superAdmin)}`)
      .send({
        maxOutstandingExposure: 10000,
        maxTransactionAmount: 2000,
        supportedCountries: ["ng", "us"],
      });

    expect(res.status).toBe(200);
    expect(res.body.maxOutstandingExposure).toBe(10000);
    expect(res.body.maxTransactionAmount).toBe(2000);
    expect(res.body.supportedCountries).toEqual(["NG", "US"]);
    expect(res.body.updatedBy).toBe(superAdmin.id);
  });

  it("rejects a country that isn't a real ISO code", async () => {
    const superAdmin = await createSuperAdmin();
    const res = await request(app)
      .patch("/api/system-settings")
      .set("Authorization", `Bearer ${generateToken(superAdmin)}`)
      .send({ supportedCountries: ["ZZ"] });

    expect(res.status).toBe(400);
  });

  it("only updates the fields actually sent, leaving the rest untouched", async () => {
    const superAdmin = await createSuperAdmin();
    await SystemSettings.create({
      maxOutstandingExposure: 10000,
      maxTransactionAmount: 2000,
      supportedCountries: ["NG"],
    });

    const res = await request(app)
      .patch("/api/system-settings")
      .set("Authorization", `Bearer ${generateToken(superAdmin)}`)
      .send({ maxTransactionAmount: 3000 });

    expect(res.status).toBe(200);
    expect(res.body.maxTransactionAmount).toBe(3000);
    expect(res.body.maxOutstandingExposure).toBe(10000);
    expect(res.body.supportedCountries).toEqual(["NG"]);
  });

  // Regression: countryProviderOverrides/countryKycProviders were
  // originally yup.object().test(...) — validateBody's stripUnknown
  // silently collapsed them to {} on every PATCH, even though the
  // request itself came back 200 (the .test() ran against the
  // pre-strip value, so validation passed; only the cast/returned value
  // was empty). Caught live by the frontend session, not by a test —
  // round-tripping a non-empty map here so it can't regress silently
  // again. See validators/admin/systemSettingsValidator.ts and
  // validate.ts's own comment on this exact gotcha.
  it("round-trips a non-empty countryProviderOverrides and countryKycProviders", async () => {
    const superAdmin = await createSuperAdmin();
    const res = await request(app)
      .patch("/api/system-settings")
      .set("Authorization", `Bearer ${generateToken(superAdmin)}`)
      .send({
        countryProviderOverrides: { NG: "paystack" },
        countryKycProviders: { NG: "dojah" },
      });

    expect(res.status).toBe(200);
    expect(res.body.countryProviderOverrides).toEqual({ NG: "paystack" });
    expect(res.body.countryKycProviders).toEqual({ NG: "dojah" });

    const fetched = await request(app)
      .get("/api/system-settings")
      .set("Authorization", `Bearer ${generateToken(superAdmin)}`);
    expect(fetched.body.countryProviderOverrides).toEqual({ NG: "paystack" });
    expect(fetched.body.countryKycProviders).toEqual({ NG: "dojah" });
  });

  it("rejects a countryProviderOverrides entry pointing at an unroutable provider", async () => {
    const superAdmin = await createSuperAdmin();
    const res = await request(app)
      .patch("/api/system-settings")
      .set("Authorization", `Bearer ${generateToken(superAdmin)}`)
      .send({ countryProviderOverrides: { NG: "manual" } });

    expect(res.status).toBe(400);
  });

  it("rejects a countryKycProviders entry with an unregistered vendor", async () => {
    const superAdmin = await createSuperAdmin();
    const res = await request(app)
      .patch("/api/system-settings")
      .set("Authorization", `Bearer ${generateToken(superAdmin)}`)
      .send({ countryKycProviders: { NG: "some-unregistered-vendor" } });

    expect(res.status).toBe(400);
  });
});
