import request from "supertest";
import createApp from "../../src/app";
import { connectTestDB, disconnectTestDB, clearTestDB } from "../setup/db";
import {
  createUser,
  createActiveJob,
  createContractorProfile,
  createDigitalCreatorProfile,
  createDigitalProduct,
  createDigitalPurchase,
  generateToken,
} from "../setup/fixtures";
import { JOB_STATUS } from "../../src/models/jobModel";
import { ContractorProfile } from "../../src/models/contractorProfileModel";
import { DigitalCreatorProfile } from "../../src/models/digitalCreatorProfileModel";

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

describe("POST /api/reviews — sourced from a completed Job", () => {
  it("requires authentication", async () => {
    const res = await request(app).post("/api/reviews").send({});
    expect(res.status).toBe(401);
  });

  it("requires a valid sourceType, sourceId, and a 1-5 rating", async () => {
    const user = await createUser();

    const res = await request(app)
      .post("/api/reviews")
      .set("Authorization", `Bearer ${generateToken(user)}`)
      .send({ sourceType: "NotReal", sourceId: "507f1f77bcf86cd799439011", rating: 5 });

    expect(res.status).toBe(400);
  });

  it("blocks reviewing a job that isn't completed yet", async () => {
    const clientUser = await createUser();
    const providerUser = await createUser();
    await createContractorProfile({ user: providerUser });
    const job = await createActiveJob({ client: clientUser, provider: providerUser });

    const res = await request(app)
      .post("/api/reviews")
      .set("Authorization", `Bearer ${generateToken(clientUser)}`)
      .send({ sourceType: "Job", sourceId: job.id, rating: 5 });

    expect(res.status).toBe(400);
  });

  it("blocks anyone other than the job's own client", async () => {
    const clientUser = await createUser();
    const providerUser = await createUser();
    const stranger = await createUser();
    await createContractorProfile({ user: providerUser });
    const job = await createActiveJob({
      client: clientUser,
      provider: providerUser,
      status: JOB_STATUS.COMPLETED,
    });

    const res = await request(app)
      .post("/api/reviews")
      .set("Authorization", `Bearer ${generateToken(stranger)}`)
      .send({ sourceType: "Job", sourceId: job.id, rating: 5 });

    expect(res.status).toBe(403);
  });

  it("creates a review, resolves the contractor profile from the job's provider, and updates its running rating", async () => {
    const clientUser = await createUser();
    const providerUser = await createUser();
    const contractorProfile = await createContractorProfile({ user: providerUser });
    const job = await createActiveJob({
      client: clientUser,
      provider: providerUser,
      status: JOB_STATUS.COMPLETED,
    });

    const res = await request(app)
      .post("/api/reviews")
      .set("Authorization", `Bearer ${generateToken(clientUser)}`)
      .send({ sourceType: "Job", sourceId: job.id, rating: 4, comment: "Solid work, on time" });

    expect(res.status).toBe(201);
    expect(res.body.profileType).toBe("ContractorProfile");
    expect(res.body.profileId).toBe(contractorProfile.id);
    expect(res.body.rating).toBe(4);

    const updatedProfile = await ContractorProfile.findById(contractorProfile.id);
    expect(updatedProfile?.ratingAverage).toBe(4);
    expect(updatedProfile?.ratingCount).toBe(1);
  });

  it("averages correctly across multiple reviews from different completed jobs", async () => {
    const providerUser = await createUser();
    const contractorProfile = await createContractorProfile({ user: providerUser });

    const clientA = await createUser();
    const jobA = await createActiveJob({
      client: clientA,
      provider: providerUser,
      status: JOB_STATUS.COMPLETED,
    });
    await request(app)
      .post("/api/reviews")
      .set("Authorization", `Bearer ${generateToken(clientA)}`)
      .send({ sourceType: "Job", sourceId: jobA.id, rating: 4 });

    const clientB = await createUser();
    const jobB = await createActiveJob({
      client: clientB,
      provider: providerUser,
      status: JOB_STATUS.COMPLETED,
    });
    await request(app)
      .post("/api/reviews")
      .set("Authorization", `Bearer ${generateToken(clientB)}`)
      .send({ sourceType: "Job", sourceId: jobB.id, rating: 2 });

    const updatedProfile = await ContractorProfile.findById(contractorProfile.id);
    expect(updatedProfile?.ratingAverage).toBe(3);
    expect(updatedProfile?.ratingCount).toBe(2);
  });

  it("blocks a second review of the same completed job", async () => {
    const clientUser = await createUser();
    const providerUser = await createUser();
    await createContractorProfile({ user: providerUser });
    const job = await createActiveJob({
      client: clientUser,
      provider: providerUser,
      status: JOB_STATUS.COMPLETED,
    });

    await request(app)
      .post("/api/reviews")
      .set("Authorization", `Bearer ${generateToken(clientUser)}`)
      .send({ sourceType: "Job", sourceId: job.id, rating: 5 });

    const res = await request(app)
      .post("/api/reviews")
      .set("Authorization", `Bearer ${generateToken(clientUser)}`)
      .send({ sourceType: "Job", sourceId: job.id, rating: 1 });

    expect(res.status).toBe(400);
  });
});

describe("POST /api/reviews — sourced from a successful DigitalPurchase", () => {
  it("creates a review against the DigitalCreatorProfile directly, no userId lookup needed", async () => {
    const creatorUser = await createUser();
    const creatorProfile = await createDigitalCreatorProfile({ user: creatorUser });
    const product = await createDigitalProduct({ creator: creatorProfile });
    const buyer = await createUser();
    const purchase = await createDigitalPurchase({ product, buyer, creator: creatorProfile });

    const res = await request(app)
      .post("/api/reviews")
      .set("Authorization", `Bearer ${generateToken(buyer)}`)
      .send({ sourceType: "DigitalPurchase", sourceId: purchase.id, rating: 5, comment: "Great plan" });

    expect(res.status).toBe(201);
    expect(res.body.profileType).toBe("DigitalCreatorProfile");
    expect(res.body.profileId).toBe(creatorProfile.id);

    const updatedProfile = await DigitalCreatorProfile.findById(creatorProfile.id);
    expect(updatedProfile?.ratingAverage).toBe(5);
    expect(updatedProfile?.ratingCount).toBe(1);
  });

  it("blocks anyone other than the purchase's own buyer", async () => {
    const creatorUser = await createUser();
    const creatorProfile = await createDigitalCreatorProfile({ user: creatorUser });
    const product = await createDigitalProduct({ creator: creatorProfile });
    const buyer = await createUser();
    const purchase = await createDigitalPurchase({ product, buyer, creator: creatorProfile });
    const stranger = await createUser();

    const res = await request(app)
      .post("/api/reviews")
      .set("Authorization", `Bearer ${generateToken(stranger)}`)
      .send({ sourceType: "DigitalPurchase", sourceId: purchase.id, rating: 5 });

    expect(res.status).toBe(403);
  });
});

describe("GET /api/reviews", () => {
  it("lists a profile's reviews, newest first", async () => {
    const providerUser = await createUser();
    const contractorProfile = await createContractorProfile({ user: providerUser });

    const clientA = await createUser();
    const jobA = await createActiveJob({
      client: clientA,
      provider: providerUser,
      status: JOB_STATUS.COMPLETED,
    });
    await request(app)
      .post("/api/reviews")
      .set("Authorization", `Bearer ${generateToken(clientA)}`)
      .send({ sourceType: "Job", sourceId: jobA.id, rating: 5, comment: "Excellent" });

    const res = await request(app).get(
      `/api/reviews?profileType=ContractorProfile&profileId=${contractorProfile.id}`,
    );

    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(1);
    expect(res.body.data[0].comment).toBe("Excellent");
  });

  it("requires a valid profileType and profileId", async () => {
    const res = await request(app).get("/api/reviews?profileType=NotReal&profileId=507f1f77bcf86cd799439011");
    expect(res.status).toBe(400);
  });
});
