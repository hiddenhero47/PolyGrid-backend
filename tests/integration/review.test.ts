import request from "supertest";
import createApp from "../../src/app";
import { connectTestDB, disconnectTestDB, clearTestDB } from "../setup/db";
import {
  createUser,
  createAdmin,
  createCustomerCare,
  createActiveJob,
  createContractorProfile,
  createDigitalCreatorProfile,
  createDigitalProduct,
  createDigitalPurchase,
  createClientProfile,
  generateToken,
} from "../setup/fixtures";
import { JOB_STATUS } from "../../src/models/jobModel";
import { ContractorProfile } from "../../src/models/contractorProfileModel";
import { DigitalCreatorProfile } from "../../src/models/digitalCreatorProfileModel";
import { ClientProfile } from "../../src/models/clientProfileModel";

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

describe("POST /api/reviews — two-way on a Job (PolyGrid Tenders/SiteForce safety motivation)", () => {
  it("lets the provider review the client's ClientProfile too, not just the other direction", async () => {
    const clientUser = await createUser();
    const clientProfile = await createClientProfile({ user: clientUser });
    const providerUser = await createUser();
    const job = await createActiveJob({
      client: clientUser,
      provider: providerUser,
      status: JOB_STATUS.COMPLETED,
    });

    // The client reviews the provider — but the provider has no
    // business profile here, so this direction 404s cleanly rather than
    // erroring.
    const clientReviewing = await request(app)
      .post("/api/reviews")
      .set("Authorization", `Bearer ${generateToken(clientUser)}`)
      .send({ sourceType: "Job", sourceId: job.id, rating: 4 });
    expect(clientReviewing.status).toBe(404);

    // The provider (e.g. a worker/contractor) reviews the client's
    // ClientProfile — the actual safety-motivated direction.
    const providerReviewing = await request(app)
      .post("/api/reviews")
      .set("Authorization", `Bearer ${generateToken(providerUser)}`)
      .send({ sourceType: "Job", sourceId: job.id, rating: 2, comment: "Site was unsafe" });

    expect(providerReviewing.status).toBe(201);
    expect(providerReviewing.body.profileType).toBe("ClientProfile");
    expect(providerReviewing.body.profileId).toBe(clientProfile.id);

    const updatedClientProfile = await ClientProfile.findById(clientProfile.id);
    expect(updatedClientProfile?.ratingAverage).toBe(2);
    expect(updatedClientProfile?.ratingCount).toBe(1);
  });

  it("lets both parties each leave their own review on the same job when both have profiles", async () => {
    const clientUser = await createUser();
    await createClientProfile({ user: clientUser });
    const providerUser = await createUser();
    await createContractorProfile({ user: providerUser });
    const job = await createActiveJob({
      client: clientUser,
      provider: providerUser,
      status: JOB_STATUS.COMPLETED,
    });

    const fromClient = await request(app)
      .post("/api/reviews")
      .set("Authorization", `Bearer ${generateToken(clientUser)}`)
      .send({ sourceType: "Job", sourceId: job.id, rating: 5 });
    expect(fromClient.status).toBe(201);

    const fromProvider = await request(app)
      .post("/api/reviews")
      .set("Authorization", `Bearer ${generateToken(providerUser)}`)
      .send({ sourceType: "Job", sourceId: job.id, rating: 4 });
    expect(fromProvider.status).toBe(201);

    // Still blocks the SAME party reviewing the SAME job twice.
    const duplicate = await request(app)
      .post("/api/reviews")
      .set("Authorization", `Bearer ${generateToken(clientUser)}`)
      .send({ sourceType: "Job", sourceId: job.id, rating: 1 });
    expect(duplicate.status).toBe(400);
  });

  it("blocks anyone who wasn't a party to the job at all", async () => {
    const clientUser = await createUser();
    await createClientProfile({ user: clientUser });
    const providerUser = await createUser();
    const stranger = await createUser();
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

describe("Review moderation — hide, unhide, delete", () => {
  const leaveReview = async (clientUser: Awaited<ReturnType<typeof createUser>>, providerUser: Awaited<ReturnType<typeof createUser>>, rating: number) => {
    const job = await createActiveJob({ client: clientUser, provider: providerUser, status: JOB_STATUS.COMPLETED });
    const res = await request(app)
      .post("/api/reviews")
      .set("Authorization", `Bearer ${generateToken(clientUser)}`)
      .send({ sourceType: "Job", sourceId: job.id, rating });
    return res.body;
  };

  it("hides a review, backing its rating out of the profile and out of the public listing", async () => {
    const providerUser = await createUser();
    const contractorProfile = await createContractorProfile({ user: providerUser });
    const clientA = await createUser();
    const reviewA = await leaveReview(clientA, providerUser, 5);
    const clientB = await createUser();
    await leaveReview(clientB, providerUser, 3);

    const admin = await createAdmin();
    const hidden = await request(app)
      .patch(`/api/reviews/${reviewA.id}/hide`)
      .set("Authorization", `Bearer ${generateToken(admin)}`)
      .send({ reason: "Suspected fake review" });

    expect(hidden.status).toBe(200);
    expect(hidden.body.isHidden).toBe(true);
    expect(hidden.body.hiddenReason).toBe("Suspected fake review");

    const updatedProfile = await ContractorProfile.findById(contractorProfile.id);
    expect(updatedProfile?.ratingAverage).toBe(3);
    expect(updatedProfile?.ratingCount).toBe(1);

    const publicList = await request(app).get(
      `/api/reviews?profileType=ContractorProfile&profileId=${contractorProfile.id}`,
    );
    expect(publicList.body.data).toHaveLength(1);
    expect(publicList.body.data[0].rating).toBe(3);
  });

  it("unhides a review, reapplying its rating", async () => {
    const providerUser = await createUser();
    const contractorProfile = await createContractorProfile({ user: providerUser });
    const clientA = await createUser();
    const review = await leaveReview(clientA, providerUser, 5);

    const admin = await createAdmin();
    const token = generateToken(admin);

    await request(app).patch(`/api/reviews/${review.id}/hide`).set("Authorization", `Bearer ${token}`);

    const unhidden = await request(app)
      .patch(`/api/reviews/${review.id}/unhide`)
      .set("Authorization", `Bearer ${token}`);

    expect(unhidden.status).toBe(200);
    expect(unhidden.body.isHidden).toBe(false);

    const updatedProfile = await ContractorProfile.findById(contractorProfile.id);
    expect(updatedProfile?.ratingAverage).toBe(5);
    expect(updatedProfile?.ratingCount).toBe(1);

    const publicList = await request(app).get(
      `/api/reviews?profileType=ContractorProfile&profileId=${contractorProfile.id}`,
    );
    expect(publicList.body.data).toHaveLength(1);
  });

  it("rejects hiding an already-hidden review and unhiding one that isn't hidden", async () => {
    const providerUser = await createUser();
    await createContractorProfile({ user: providerUser });
    const clientA = await createUser();
    const review = await leaveReview(clientA, providerUser, 5);

    const admin = await createAdmin();
    const token = generateToken(admin);

    const alreadyUnhidden = await request(app)
      .patch(`/api/reviews/${review.id}/unhide`)
      .set("Authorization", `Bearer ${token}`);
    expect(alreadyUnhidden.status).toBe(400);

    await request(app).patch(`/api/reviews/${review.id}/hide`).set("Authorization", `Bearer ${token}`);

    const alreadyHidden = await request(app)
      .patch(`/api/reviews/${review.id}/hide`)
      .set("Authorization", `Bearer ${token}`);
    expect(alreadyHidden.status).toBe(400);
  });

  it("permanently deletes a review, backing its rating out exactly once", async () => {
    const providerUser = await createUser();
    const contractorProfile = await createContractorProfile({ user: providerUser });
    const clientA = await createUser();
    const review = await leaveReview(clientA, providerUser, 4);

    const admin = await createAdmin();
    const token = generateToken(admin);

    const deleted = await request(app)
      .delete(`/api/reviews/${review.id}`)
      .set("Authorization", `Bearer ${token}`);
    expect(deleted.status).toBe(200);

    const updatedProfile = await ContractorProfile.findById(contractorProfile.id);
    expect(updatedProfile?.ratingAverage).toBe(0);
    expect(updatedProfile?.ratingCount).toBe(0);

    const publicList = await request(app).get(
      `/api/reviews?profileType=ContractorProfile&profileId=${contractorProfile.id}`,
    );
    expect(publicList.body.data).toHaveLength(0);
  });

  it("deleting an already-hidden review doesn't double-reverse its rating", async () => {
    const providerUser = await createUser();
    const contractorProfile = await createContractorProfile({ user: providerUser });
    const clientA = await createUser();
    const reviewA = await leaveReview(clientA, providerUser, 5);
    const clientB = await createUser();
    await leaveReview(clientB, providerUser, 1);

    const admin = await createAdmin();
    const token = generateToken(admin);

    await request(app).patch(`/api/reviews/${reviewA.id}/hide`).set("Authorization", `Bearer ${token}`);
    // Rating is now just clientB's 1, count 1.

    await request(app).delete(`/api/reviews/${reviewA.id}`).set("Authorization", `Bearer ${token}`);

    const updatedProfile = await ContractorProfile.findById(contractorProfile.id);
    expect(updatedProfile?.ratingAverage).toBe(1);
    expect(updatedProfile?.ratingCount).toBe(1);
  });

  it("GET /api/reviews/moderation includes hidden reviews with their moderation detail; blocks customer_care from mutating", async () => {
    const providerUser = await createUser();
    const contractorProfile = await createContractorProfile({ user: providerUser });
    const clientA = await createUser();
    const review = await leaveReview(clientA, providerUser, 5);

    const admin = await createAdmin();
    await request(app)
      .patch(`/api/reviews/${review.id}/hide`)
      .set("Authorization", `Bearer ${generateToken(admin)}`)
      .send({ reason: "Testing moderation queue" });

    const customerCare = await createCustomerCare();
    const queue = await request(app)
      .get(`/api/reviews/moderation?profileType=ContractorProfile&profileId=${contractorProfile.id}`)
      .set("Authorization", `Bearer ${generateToken(customerCare)}`);

    expect(queue.status).toBe(200);
    expect(queue.body.data).toHaveLength(1);
    expect(queue.body.data[0].isHidden).toBe(true);
    expect(queue.body.data[0].hiddenReason).toBe("Testing moderation queue");

    const blocked = await request(app)
      .patch(`/api/reviews/${review.id}/unhide`)
      .set("Authorization", `Bearer ${generateToken(customerCare)}`);
    expect(blocked.status).toBe(401);
  });
});
