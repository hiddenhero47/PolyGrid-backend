import request from "supertest";
import createApp from "../../src/app";
import { connectTestDB, disconnectTestDB, clearTestDB } from "../setup/db";
import { createUser, createAdmin, createVerificationTemplate, generateToken } from "../setup/fixtures";
import { VerificationTemplate } from "../../src/models/verificationTemplateModel";

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

const validTemplate = {
  profileType: "ConsultancyProfile",
  country: "ng",
  name: "Nigeria Engineering Consultant Verification",
  fields: [
    { key: "businessName", label: "Business name", type: "string", required: true },
    {
      key: "registrationNumber",
      label: "COREN registration number",
      type: "string",
      required: false,
      pattern: "^R\\d+[A-Za-z]{0,3}$",
    },
  ],
  documents: [
    {
      type: "business_certificate",
      label: "Business registration certificate",
      required: true,
      acceptedFormats: ["pdf"],
    },
  ],
};

describe("POST /api/verification-templates", () => {
  it("blocks non-admins", async () => {
    const user = await createUser();

    const res = await request(app)
      .post("/api/verification-templates")
      .set("Authorization", `Bearer ${generateToken(user)}`)
      .send(validTemplate);

    expect(res.status).toBe(401);
  });

  it("rejects an invalid shape (bad field type)", async () => {
    const admin = await createAdmin();

    const res = await request(app)
      .post("/api/verification-templates")
      .set("Authorization", `Bearer ${generateToken(admin)}`)
      .send({ ...validTemplate, fields: [{ key: "x", label: "X", type: "not-a-type", required: true }] });

    expect(res.status).toBe(400);
  });

  it("creates a template, normalizing country to uppercase", async () => {
    const admin = await createAdmin();

    const res = await request(app)
      .post("/api/verification-templates")
      .set("Authorization", `Bearer ${generateToken(admin)}`)
      .send(validTemplate);

    expect(res.status).toBe(201);
    expect(res.body.country).toBe("NG");
    expect(res.body.version).toBe(1);
    expect(res.body.isActive).toBe(true);
  });

  it("superseding an existing active template deactivates the old one and bumps the version", async () => {
    const admin = await createAdmin();
    const token = generateToken(admin);

    const first = await request(app)
      .post("/api/verification-templates")
      .set("Authorization", `Bearer ${token}`)
      .send(validTemplate);

    const second = await request(app)
      .post("/api/verification-templates")
      .set("Authorization", `Bearer ${token}`)
      .send(validTemplate);

    expect(second.body.version).toBe(2);

    const oldOne = await VerificationTemplate.findById(first.body._id);
    expect(oldOne?.isActive).toBe(false);
  });
});

describe("GET /api/verification-templates", () => {
  it("blocks non-admins and lists/filters for admins", async () => {
    const admin = await createAdmin();
    await createVerificationTemplate({ country: "NG" });
    await createVerificationTemplate({ country: "US" });

    const user = await createUser();
    const blocked = await request(app)
      .get("/api/verification-templates")
      .set("Authorization", `Bearer ${generateToken(user)}`);
    expect(blocked.status).toBe(401);

    const filtered = await request(app)
      .get("/api/verification-templates?country=NG")
      .set("Authorization", `Bearer ${generateToken(admin)}`);
    expect(filtered.body.data).toHaveLength(1);
    expect(filtered.body.data[0].country).toBe("NG");
  });
});

describe("GET /api/verification-templates/lookup", () => {
  it("requires authentication", async () => {
    const res = await request(app).get(
      "/api/verification-templates/lookup?profileType=ConsultancyProfile&country=NG",
    );
    expect(res.status).toBe(401);
  });

  it("404s when nothing is configured for that profileType/location", async () => {
    const user = await createUser();

    const res = await request(app)
      .get("/api/verification-templates/lookup?profileType=ConsultancyProfile&country=ZZ")
      .set("Authorization", `Bearer ${generateToken(user)}`);

    expect(res.status).toBe(404);
  });

  it("resolves the nationwide template", async () => {
    const user = await createUser();
    const template = await createVerificationTemplate({ country: "NG" });

    const res = await request(app)
      .get("/api/verification-templates/lookup?profileType=ConsultancyProfile&country=ng")
      .set("Authorization", `Bearer ${generateToken(user)}`);

    expect(res.status).toBe(200);
    expect(res.body._id).toBe(template.id);
  });

  it("prefers a state-specific template over the nationwide default", async () => {
    const user = await createUser();
    await createVerificationTemplate({ country: "NG", state: null });
    const stateTemplate = await createVerificationTemplate({ country: "NG", state: "LAGOS" });

    const res = await request(app)
      .get("/api/verification-templates/lookup?profileType=ConsultancyProfile&country=NG&state=lagos")
      .set("Authorization", `Bearer ${generateToken(user)}`);

    expect(res.status).toBe(200);
    expect(res.body._id).toBe(stateTemplate.id);
  });
});
