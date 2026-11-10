// Same boundary as every other third-party integration this test suite
// mocks — no real call to Dojah ever happens in CI.
const mockVerifyMatch = jest.fn();
jest.mock("../../src/providers/identityVerificationProviders", () => ({
  getIdentityVerificationProvider: () => ({ verifyMatch: mockVerifyMatch }),
}));

import request from "supertest";
import createApp from "../../src/app";
import { connectTestDB, disconnectTestDB, clearTestDB } from "../setup/db";
import { createUser, createAdmin, createCustomerCare, generateToken, TEST_PNG_BUFFER } from "../setup/fixtures";
import { SystemSettings } from "../../src/models/systemSettingsModel";
import { PayoutKyc } from "../../src/models/payoutKycModel";

const app = createApp();

beforeAll(async () => {
  await connectTestDB();
});

afterEach(async () => {
  await clearTestDB();
  jest.clearAllMocks();
});

afterAll(async () => {
  await disconnectTestDB();
});

describe("POST /api/users/me/payout-kyc — automated track (country in countryKycProviders)", () => {
  it("requires authentication", async () => {
    const res = await request(app).post("/api/users/me/payout-kyc").send({});
    expect(res.status).toBe(401);
  });

  it("requires the current password, same sensitivity tier as /payout-account", async () => {
    await SystemSettings.create({
      maxOutstandingExposure: 0,
      maxTransactionAmount: 0,
      supportedCountries: [],
      countryKycProviders: { NG: "dojah" },
    });
    const user = await createUser({ country: "NG", fullName: "Ada Okafor" });

    const res = await request(app)
      .post("/api/users/me/payout-kyc")
      .set("Authorization", `Bearer ${generateToken(user)}`)
      .send({ idType: "bvn", idNumber: "12345678901" });

    expect(res.status).toBe(400);
    expect(res.body.code).toBe("IDENTITY_REQUIRED");
  });

  it("verifies on a name match, never storing the raw idNumber", async () => {
    await SystemSettings.create({
      maxOutstandingExposure: 0,
      maxTransactionAmount: 0,
      supportedCountries: [],
      countryKycProviders: { NG: "dojah" },
    });
    const user = await createUser({ country: "NG", fullName: "Ada Okafor" });
    mockVerifyMatch.mockResolvedValue({ matched: true, reference: "dojah_ref_1", raw: {} });

    const res = await request(app)
      .post("/api/users/me/payout-kyc")
      .set("Authorization", `Bearer ${generateToken(user)}`)
      .send({ idType: "bvn", idNumber: "12345678901", currentPassword: "password123" });

    expect(res.status).toBe(201);
    expect(res.body.status).toBe("verified");
    expect(res.body.last4).toBe("8901");
    expect(res.body.idNumber).toBeUndefined();

    const record = await PayoutKyc.findOne({ user: user._id });
    expect(JSON.stringify(record)).not.toContain("12345678901");
    expect(mockVerifyMatch).toHaveBeenCalledWith({
      idType: "bvn",
      idNumber: "12345678901",
      firstName: "Ada",
      lastName: "Okafor",
    });
  });

  it("fails on a name mismatch, with a failureReason", async () => {
    await SystemSettings.create({
      maxOutstandingExposure: 0,
      maxTransactionAmount: 0,
      supportedCountries: [],
      countryKycProviders: { NG: "dojah" },
    });
    const user = await createUser({ country: "NG", fullName: "Ada Okafor" });
    mockVerifyMatch.mockResolvedValue({ matched: false, reference: "dojah_ref_2", raw: {} });

    const res = await request(app)
      .post("/api/users/me/payout-kyc")
      .set("Authorization", `Bearer ${generateToken(user)}`)
      .send({ idType: "nin", idNumber: "10987654321", currentPassword: "password123" });

    expect(res.status).toBe(201);
    expect(res.body.status).toBe("failed");
    expect(res.body.failureReason).toBeTruthy();
  });

  it("rejects an idNumber that isn't 11 digits", async () => {
    await SystemSettings.create({
      maxOutstandingExposure: 0,
      maxTransactionAmount: 0,
      supportedCountries: [],
      countryKycProviders: { NG: "dojah" },
    });
    const user = await createUser({ country: "NG" });

    const res = await request(app)
      .post("/api/users/me/payout-kyc")
      .set("Authorization", `Bearer ${generateToken(user)}`)
      .send({ idType: "bvn", idNumber: "123", currentPassword: "password123" });

    expect(res.status).toBe(400);
    expect(mockVerifyMatch).not.toHaveBeenCalled();
  });

  it("resubmitting replaces the prior record rather than creating a second one", async () => {
    await SystemSettings.create({
      maxOutstandingExposure: 0,
      maxTransactionAmount: 0,
      supportedCountries: [],
      countryKycProviders: { NG: "dojah" },
    });
    const user = await createUser({ country: "NG", fullName: "Ada Okafor" });
    mockVerifyMatch.mockResolvedValueOnce({ matched: false, reference: "dojah_ref_3", raw: {} });
    mockVerifyMatch.mockResolvedValueOnce({ matched: true, reference: "dojah_ref_4", raw: {} });

    await request(app)
      .post("/api/users/me/payout-kyc")
      .set("Authorization", `Bearer ${generateToken(user)}`)
      .send({ idType: "bvn", idNumber: "12345678901", currentPassword: "password123" });

    const second = await request(app)
      .post("/api/users/me/payout-kyc")
      .set("Authorization", `Bearer ${generateToken(user)}`)
      .send({ idType: "bvn", idNumber: "12345678901", currentPassword: "password123" });

    expect(second.body.status).toBe("verified");
    expect(await PayoutKyc.countDocuments({ user: user._id })).toBe(1);
  });
});

describe("POST /api/users/me/payout-kyc — document track (country not in countryKycProviders)", () => {
  it("saves the 3 images and leaves status pending for admin review", async () => {
    await SystemSettings.create({
      maxOutstandingExposure: 0,
      maxTransactionAmount: 0,
      supportedCountries: [],
      countryKycProviders: { NG: "dojah" },
    });
    const user = await createUser({ country: "US" });

    const res = await request(app)
      .post("/api/users/me/payout-kyc")
      .set("Authorization", `Bearer ${generateToken(user)}`)
      .field("currentPassword", "password123")
      .attach("idFront", TEST_PNG_BUFFER, "front.png")
      .attach("idBack", TEST_PNG_BUFFER, "back.png")
      .attach("face", TEST_PNG_BUFFER, "face.png");

    expect(res.status).toBe(201);
    expect(res.body.method).toBe("document");
    expect(res.body.status).toBe("pending");
    expect(mockVerifyMatch).not.toHaveBeenCalled();

    const record = await PayoutKyc.findOne({ user: user._id });
    expect(record?.documents?.idFront?.fileName).toBeTruthy();
    expect(record?.documents?.face?.fileName).toBeTruthy();
  });

  it("rejects when a required image is missing", async () => {
    await SystemSettings.create({
      maxOutstandingExposure: 0,
      maxTransactionAmount: 0,
      supportedCountries: [],
    });
    const user = await createUser({ country: "US" });

    const res = await request(app)
      .post("/api/users/me/payout-kyc")
      .set("Authorization", `Bearer ${generateToken(user)}`)
      .field("currentPassword", "password123")
      .attach("idFront", TEST_PNG_BUFFER, "front.png");

    expect(res.status).toBe(400);
  });
});

describe("GET /api/users/me/payout-kyc", () => {
  it("tells the caller which track they'd get before they've ever submitted anything", async () => {
    await SystemSettings.create({
      maxOutstandingExposure: 0,
      maxTransactionAmount: 0,
      supportedCountries: [],
      countryKycProviders: { NG: "dojah" },
    });
    const ngUser = await createUser({ country: "NG" });
    const usUser = await createUser({ country: "US" });

    const ngRes = await request(app)
      .get("/api/users/me/payout-kyc")
      .set("Authorization", `Bearer ${generateToken(ngUser)}`);
    expect(ngRes.status).toBe(200);
    expect(ngRes.body.track).toBe("automated");
    expect(ngRes.body.record).toBeNull();

    const usRes = await request(app)
      .get("/api/users/me/payout-kyc")
      .set("Authorization", `Bearer ${generateToken(usUser)}`);
    expect(usRes.body.track).toBe("document");
    expect(usRes.body.record).toBeNull();
  });

  it("includes the existing record once one has been submitted", async () => {
    await SystemSettings.create({
      maxOutstandingExposure: 0,
      maxTransactionAmount: 0,
      supportedCountries: [],
      countryKycProviders: { NG: "dojah" },
    });
    const user = await createUser({ country: "NG", fullName: "Ada Okafor" });
    mockVerifyMatch.mockResolvedValue({ matched: true, reference: "dojah_ref_1", raw: {} });

    await request(app)
      .post("/api/users/me/payout-kyc")
      .set("Authorization", `Bearer ${generateToken(user)}`)
      .send({ idType: "bvn", idNumber: "12345678901", currentPassword: "password123" });

    const res = await request(app)
      .get("/api/users/me/payout-kyc")
      .set("Authorization", `Bearer ${generateToken(user)}`);

    expect(res.body.track).toBe("automated");
    expect(res.body.record.status).toBe("verified");
  });
});

describe("payout-kyc admin review (document track)", () => {
  const submitDocumentKyc = async (user: Awaited<ReturnType<typeof createUser>>) =>
    request(app)
      .post("/api/users/me/payout-kyc")
      .set("Authorization", `Bearer ${generateToken(user)}`)
      .field("currentPassword", "password123")
      .attach("idFront", TEST_PNG_BUFFER, "front.png")
      .attach("idBack", TEST_PNG_BUFFER, "back.png")
      .attach("face", TEST_PNG_BUFFER, "face.png");

  it("requires authentication on the queue and on approve/reject", async () => {
    const listRes = await request(app).get("/api/payout-kyc");
    expect(listRes.status).toBe(401);

    const approveRes = await request(app).patch("/api/payout-kyc/507f1f77bcf86cd799439011/approve");
    expect(approveRes.status).toBe(401);
  });

  it("lists a pending document-track submission for REVIEW_ROLES, and approves it", async () => {
    await SystemSettings.create({ maxOutstandingExposure: 0, maxTransactionAmount: 0, supportedCountries: [] });
    const user = await createUser({ country: "US", fullName: "Jamie Rivera" });
    const submitted = await submitDocumentKyc(user);
    const recordId = submitted.body._id;

    const customerCare = await createCustomerCare();
    const listRes = await request(app)
      .get("/api/payout-kyc?status=pending")
      .set("Authorization", `Bearer ${generateToken(customerCare)}`);
    expect(listRes.status).toBe(200);
    expect(listRes.body.data).toHaveLength(1);
    // Populated, not a bare ObjectId — the admin queue needs this to show
    // who it's actually reviewing without a second round trip.
    expect(listRes.body.data[0].user.fullName).toBe("Jamie Rivera");
    expect(listRes.body.data[0].user.email).toBe(user.email);
    expect(listRes.body.data[0].user.country).toBe("US");

    const admin = await createAdmin();
    const approveRes = await request(app)
      .patch(`/api/payout-kyc/${recordId}/approve`)
      .set("Authorization", `Bearer ${generateToken(admin)}`);

    expect(approveRes.status).toBe(200);
    expect(approveRes.body.status).toBe("verified");
    expect(approveRes.body.verifiedAt).toBeTruthy();
  });

  it("rejects with a reason, and refuses an approve/reject on an already-decided record", async () => {
    await SystemSettings.create({ maxOutstandingExposure: 0, maxTransactionAmount: 0, supportedCountries: [] });
    const user = await createUser({ country: "US" });
    const submitted = await submitDocumentKyc(user);
    const recordId = submitted.body._id;
    const admin = await createAdmin();

    const missingReason = await request(app)
      .patch(`/api/payout-kyc/${recordId}/reject`)
      .set("Authorization", `Bearer ${generateToken(admin)}`)
      .send({});
    expect(missingReason.status).toBe(400);

    const rejectRes = await request(app)
      .patch(`/api/payout-kyc/${recordId}/reject`)
      .set("Authorization", `Bearer ${generateToken(admin)}`)
      .send({ rejectionReason: "Face photo doesn't match the ID" });
    expect(rejectRes.status).toBe(200);
    expect(rejectRes.body.status).toBe("failed");

    const againRes = await request(app)
      .patch(`/api/payout-kyc/${recordId}/approve`)
      .set("Authorization", `Bearer ${generateToken(admin)}`);
    expect(againRes.status).toBe(400);
  });

  it("refuses to review an automated-track record by hand", async () => {
    await SystemSettings.create({
      maxOutstandingExposure: 0,
      maxTransactionAmount: 0,
      supportedCountries: [],
      countryKycProviders: { NG: "dojah" },
    });
    const user = await createUser({ country: "NG", fullName: "Ada Okafor" });
    mockVerifyMatch.mockResolvedValue({ matched: true, reference: "dojah_ref_5", raw: {} });

    const submitted = await request(app)
      .post("/api/users/me/payout-kyc")
      .set("Authorization", `Bearer ${generateToken(user)}`)
      .send({ idType: "bvn", idNumber: "12345678901", currentPassword: "password123" });

    const admin = await createAdmin();
    const res = await request(app)
      .patch(`/api/payout-kyc/${submitted.body._id}/approve`)
      .set("Authorization", `Bearer ${generateToken(admin)}`);

    expect(res.status).toBe(400);
  });
});
