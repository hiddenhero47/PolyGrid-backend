import request from "supertest";
import createApp from "../../src/app";
import { connectTestDB, disconnectTestDB, clearTestDB } from "../setup/db";
import {
  createUser,
  createAdmin,
  createConsultancyProfile,
  createVerificationTemplate,
  generateToken,
  TEST_PNG_BUFFER,
} from "../setup/fixtures";
import { ConsultancyProfile } from "../../src/models/consultancyProfileModel";
import { Verification } from "../../src/models/verificationModel";
import fs from "fs";
import path from "path";

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

// A template whose one document type accepts png, matching TEST_PNG_BUFFER
// — every test in this file that needs "a template that will actually
// accept the file we attach" uses this, unless it's specifically testing
// the format-mismatch case.
const createPngTemplate = (overrides: Parameters<typeof createVerificationTemplate>[0] = {}) =>
  createVerificationTemplate({
    country: "NG",
    documents: [
      { type: "business_certificate", label: "Business certificate", required: true, acceptedFormats: ["png"] },
    ],
    ...overrides,
  });

interface Payload {
  profileType?: string;
  profileId?: string;
  country?: string;
  state?: string;
  form?: Record<string, unknown>;
}

// Every non-file field travels as one JSON-stringified `data` field
// alongside the real file attachments — see src/helpers/parseMultipartData.ts
// (mirrors house-maduekwe-backend's shopItems create/update pattern).
const post = (token: string, payload: Payload) =>
  request(app)
    .post("/api/verifications")
    .set("Authorization", `Bearer ${token}`)
    .field("data", JSON.stringify(payload));

// Files are attached directly on the submission request itself — never
// pre-uploaded through a separate route and referenced by fileName
// afterward (see verificationController.resolveAndSaveDocuments). The
// field name for a document attachment must equal the template's declared
// document `type`.
const submitValid = (token: string, profileId: string) =>
  post(token, {
    profileType: "ConsultancyProfile",
    profileId,
    country: "ng",
    form: { businessName: "Acme Engineering" },
  }).attach("business_certificate", TEST_PNG_BUFFER, "cert.png");

describe("POST /api/verifications", () => {
  it("requires authentication", async () => {
    const res = await request(app).post("/api/verifications").send({});
    expect(res.status).toBe(401);
  });

  it("rejects a malformed 'data' field", async () => {
    const user = await createUser();

    const res = await request(app)
      .post("/api/verifications")
      .set("Authorization", `Bearer ${generateToken(user)}`)
      .field("data", "{not valid json");

    expect(res.status).toBe(400);
  });

  it("rejects a request missing profileType/profileId/country", async () => {
    const user = await createUser();

    const res = await post(generateToken(user), { profileType: "ConsultancyProfile" });

    expect(res.status).toBe(400);
  });

  it("rejects an unknown profileType", async () => {
    const user = await createUser();

    const res = await post(generateToken(user), {
      profileType: "NotAProfile",
      profileId: "507f1f77bcf86cd799439011",
      country: "NG",
    });

    expect(res.status).toBe(400);
  });

  it("404s for an unknown profile", async () => {
    const user = await createUser();

    const res = await post(generateToken(user), {
      profileType: "ConsultancyProfile",
      profileId: "507f1f77bcf86cd799439011",
      country: "NG",
    });

    expect(res.status).toBe(404);
  });

  it("blocks submitting verification for someone else's profile", async () => {
    const owner = await createUser();
    const stranger = await createUser();
    const profile = await createConsultancyProfile({ user: owner });

    const res = await submitValid(generateToken(stranger), profile.id);

    expect(res.status).toBe(403);
  });

  it("404s when no template is configured for this profileType/location yet", async () => {
    const user = await createUser();
    const profile = await createConsultancyProfile({ user });

    const res = await submitValid(generateToken(user), profile.id);

    expect(res.status).toBe(404);
  });

  it("validates form against the resolved template's fields", async () => {
    const user = await createUser();
    const profile = await createConsultancyProfile({ user });
    await createPngTemplate();

    const res = await post(generateToken(user), {
      profileType: "ConsultancyProfile",
      profileId: profile.id,
      country: "NG",
      form: {}, // businessName omitted — required by the default template fields
    }).attach("business_certificate", TEST_PNG_BUFFER, "cert.png");

    expect(res.status).toBe(400);
  });

  it("rejects a request that doesn't attach a required document at all", async () => {
    const user = await createUser();
    const profile = await createConsultancyProfile({ user });
    await createPngTemplate();

    const res = await post(generateToken(user), {
      profileType: "ConsultancyProfile",
      profileId: profile.id,
      country: "NG",
      form: { businessName: "Acme Engineering" },
    });
    // no business_certificate attached

    expect(res.status).toBe(400);
  });

  it("rejects an attachment under a field name the template doesn't recognize", async () => {
    const user = await createUser();
    const profile = await createConsultancyProfile({ user });
    await createPngTemplate();

    const res = await post(generateToken(user), {
      profileType: "ConsultancyProfile",
      profileId: profile.id,
      country: "NG",
      form: { businessName: "Acme Engineering" },
    })
      .attach("business_certificate", TEST_PNG_BUFFER, "cert.png")
      .attach("some_unexpected_document", TEST_PNG_BUFFER, "extra.png");

    expect(res.status).toBe(400);
  });

  it("rejects a document whose real bytes don't match the template's accepted formats", async () => {
    const user = await createUser();
    const profile = await createConsultancyProfile({ user });
    // Default fixture template only accepts pdf for business_certificate.
    await createVerificationTemplate({ country: "NG" });

    const res = await submitValid(generateToken(user), profile.id); // attaches a PNG

    expect(res.status).toBe(400);
  });

  it("does not leave an orphaned file on disk when a required document is rejected", async () => {
    const user = await createUser();
    const profile = await createConsultancyProfile({ user });
    await createVerificationTemplate({
      country: "NG",
      documents: [
        { type: "business_certificate", label: "Business certificate", required: true, acceptedFormats: ["png"] },
        { type: "proof_of_address", label: "Proof of address", required: true, acceptedFormats: ["pdf"] },
      ],
    });

    // business_certificate (png, valid) saves fine; proof_of_address is a
    // png attached where only pdf is accepted, so the whole submission is
    // rejected — the business_certificate file must not be left behind.
    const res = await post(generateToken(user), {
      profileType: "ConsultancyProfile",
      profileId: profile.id,
      country: "NG",
      form: { businessName: "Acme Engineering" },
    })
      .attach("business_certificate", TEST_PNG_BUFFER, "cert.png")
      .attach("proof_of_address", TEST_PNG_BUFFER, "address.png");

    expect(res.status).toBe(400);

    const ownerDir = path.join(process.env.STORAGE_ROOT as string, "private", user.id);
    const filesLeftBehind = fs.existsSync(ownerDir) ? fs.readdirSync(ownerDir) : [];
    expect(filesLeftBehind).toHaveLength(0);
  });

  it("saves an optional document's failure as a warning without blocking the submission", async () => {
    const user = await createUser();
    const profile = await createConsultancyProfile({ user });
    await createVerificationTemplate({
      country: "NG",
      documents: [
        { type: "business_certificate", label: "Business certificate", required: true, acceptedFormats: ["png"] },
        { type: "extra_reference", label: "Extra reference letter", required: false, acceptedFormats: ["pdf"] },
      ],
    });

    const res = await post(generateToken(user), {
      profileType: "ConsultancyProfile",
      profileId: profile.id,
      country: "NG",
      form: { businessName: "Acme Engineering" },
    })
      .attach("business_certificate", TEST_PNG_BUFFER, "cert.png")
      .attach("extra_reference", TEST_PNG_BUFFER, "ref.png"); // wrong format, but optional

    expect(res.status).toBe(201);
    expect(res.body.documents).toHaveLength(1);
    expect(res.body.documentWarnings).toBeDefined();
    expect(res.body.documentWarnings[0]).toContain("Extra reference letter");
  });

  it("accepts a valid submission, saves the file, and snapshots real metadata", async () => {
    const user = await createUser();
    const profile = await createConsultancyProfile({ user });
    const template = await createPngTemplate();

    const res = await submitValid(generateToken(user), profile.id);

    expect(res.status).toBe(201);
    expect(res.body.location.country).toBe("NG");
    expect(res.body.templateId).toBe(template.id);
    expect(res.body.form.businessName).toBe("Acme Engineering");
    expect(res.body.status).toBe("pending");
    expect(res.body.documents).toHaveLength(1);
    expect(res.body.documents[0].type).toBe("business_certificate");
    expect(res.body.documents[0].mime).toBe("image/png");
    expect(res.body.documents[0].size).toBeGreaterThan(0);
    expect(res.body.documents[0].uploadedAt).toBeTruthy();

    const updatedProfile = await ConsultancyProfile.findById(profile.id);
    expect(updatedProfile?.verification?.toString()).toBe(res.body._id);
    expect(updatedProfile?.isVerified).toBe(false); // submitting alone never verifies

    // The file really is on disk under the submitter's own private folder.
    const ownerDir = path.join(process.env.STORAGE_ROOT as string, "private", user.id);
    expect(fs.readdirSync(ownerDir)).toContain(res.body.documents[0].fileName);
  });

  it("falls back to the nationwide template when no state-specific one exists", async () => {
    const user = await createUser();
    const profile = await createConsultancyProfile({ user });
    await createPngTemplate({ state: null });

    const res = await post(generateToken(user), {
      profileType: "ConsultancyProfile",
      profileId: profile.id,
      country: "NG",
      state: "Lagos",
      form: { businessName: "Acme Engineering" },
    }).attach("business_certificate", TEST_PNG_BUFFER, "cert.png");

    expect(res.status).toBe(201);
  });

  it("prefers a state-specific template over the nationwide default", async () => {
    const user = await createUser();
    const profile = await createConsultancyProfile({ user });
    await createVerificationTemplate({ country: "NG", state: null, documents: [] });
    const stateTemplate = await createVerificationTemplate({
      country: "NG",
      state: "LAGOS",
      fields: [{ key: "businessName", label: "Business name", type: "string", required: true }],
      documents: [],
    });

    const res = await post(generateToken(user), {
      profileType: "ConsultancyProfile",
      profileId: profile.id,
      country: "NG",
      state: "lagos",
      form: { businessName: "Acme Engineering" },
    });

    expect(res.status).toBe(201);
    expect(res.body.templateId).toBe(stateTemplate.id);
  });

  it("creates a new record on resubmission rather than overwriting the old one", async () => {
    const user = await createUser();
    const profile = await createConsultancyProfile({ user });
    await createPngTemplate();
    const token = generateToken(user);

    const first = await submitValid(token, profile.id);
    const second = await submitValid(token, profile.id);

    expect(await Verification.countDocuments({ profileId: profile.id })).toBe(2);

    const updatedProfile = await ConsultancyProfile.findById(profile.id);
    expect(updatedProfile?.verification?.toString()).toBe(second.body._id);
    expect(updatedProfile?.verification?.toString()).not.toBe(first.body._id);
  });
});

describe("GET /api/verifications/me", () => {
  it("returns only my own submissions", async () => {
    const me = await createUser();
    const other = await createUser();
    const myProfile = await createConsultancyProfile({ user: me });
    const otherProfile = await createConsultancyProfile({ user: other });
    await createPngTemplate();

    await submitValid(generateToken(me), myProfile.id);
    await submitValid(generateToken(other), otherProfile.id);

    const res = await request(app)
      .get("/api/verifications/me")
      .set("Authorization", `Bearer ${generateToken(me)}`);

    expect(res.body.data).toHaveLength(1);
  });
});

describe("admin review", () => {
  const setupSubmission = async () => {
    const user = await createUser();
    const profile = await createConsultancyProfile({ user });
    await createPngTemplate();
    const submitted = await submitValid(generateToken(user), profile.id);
    return { user, profile, submitted };
  };

  it("blocks a non-admin from listing, approving, or rejecting", async () => {
    const { user, submitted } = await setupSubmission();

    const list = await request(app)
      .get("/api/verifications")
      .set("Authorization", `Bearer ${generateToken(user)}`);
    expect(list.status).toBe(401);

    const approve = await request(app)
      .patch(`/api/verifications/${submitted.body._id}/approve`)
      .set("Authorization", `Bearer ${generateToken(user)}`);
    expect(approve.status).toBe(401);
  });

  it("approving flips the profile's isVerified and points it at that record", async () => {
    const { profile, submitted } = await setupSubmission();
    const admin = await createAdmin();

    const queue = await request(app)
      .get("/api/verifications?status=pending")
      .set("Authorization", `Bearer ${generateToken(admin)}`);
    expect(queue.body.data).toHaveLength(1);

    const res = await request(app)
      .patch(`/api/verifications/${submitted.body._id}/approve`)
      .set("Authorization", `Bearer ${generateToken(admin)}`);

    expect(res.status).toBe(200);
    expect(res.body.status).toBe("approved");

    const updatedProfile = await ConsultancyProfile.findById(profile.id);
    expect(updatedProfile?.isVerified).toBe(true);
    expect(updatedProfile?.verification?.toString()).toBe(submitted.body._id);
  });

  it("rejecting requires a reason and does not verify the profile", async () => {
    const { profile, submitted } = await setupSubmission();
    const admin = await createAdmin();

    const noReason = await request(app)
      .patch(`/api/verifications/${submitted.body._id}/reject`)
      .set("Authorization", `Bearer ${generateToken(admin)}`)
      .send({});
    expect(noReason.status).toBe(400);

    const res = await request(app)
      .patch(`/api/verifications/${submitted.body._id}/reject`)
      .set("Authorization", `Bearer ${generateToken(admin)}`)
      .send({ reason: "Certificate photo unreadable" });

    expect(res.status).toBe(200);
    expect(res.body.status).toBe("rejected");
    expect(res.body.rejectionReason).toBe("Certificate photo unreadable");

    const updatedProfile = await ConsultancyProfile.findById(profile.id);
    expect(updatedProfile?.isVerified).toBe(false);
  });

  it("blocks re-reviewing an already-decided verification", async () => {
    const { submitted } = await setupSubmission();
    const admin = await createAdmin();

    await request(app)
      .patch(`/api/verifications/${submitted.body._id}/approve`)
      .set("Authorization", `Bearer ${generateToken(admin)}`);

    const res = await request(app)
      .patch(`/api/verifications/${submitted.body._id}/approve`)
      .set("Authorization", `Bearer ${generateToken(admin)}`);

    expect(res.status).toBe(400);
  });
});
