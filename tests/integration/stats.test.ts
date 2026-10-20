import request from "supertest";
import createApp from "../../src/app";
import { connectTestDB, disconnectTestDB, clearTestDB } from "../setup/db";
import {
  createUser,
  createAdmin,
  createCustomerCare,
  createUserWithActiveSubscription,
  createConsultancyProfile,
  createActiveJob,
  generateToken,
} from "../setup/fixtures";
import { PROFILE_TYPE } from "../../src/constants/profileTypes";
import { JOB_STATUS } from "../../src/models/jobModel";

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

describe("GET /api/stats/top-profiles", () => {
  it("requires a valid profileType", async () => {
    const res = await request(app).get("/api/stats/top-profiles");
    expect(res.status).toBe(400);
  });

  it("ranks eligible profiles by rating, highest first", async () => {
    const low = await createUserWithActiveSubscription();
    await createConsultancyProfile({
      user: low,
      currentSubscription: low.currentSubscription,
      isVerified: true,
      ratingAverage: 3.5,
      ratingCount: 10,
    });

    const high = await createUserWithActiveSubscription();
    await createConsultancyProfile({
      user: high,
      currentSubscription: high.currentSubscription,
      isVerified: true,
      ratingAverage: 4.9,
      ratingCount: 50,
    });

    const unverified = await createUserWithActiveSubscription();
    await createConsultancyProfile({
      user: unverified,
      currentSubscription: unverified.currentSubscription,
      isVerified: false,
      ratingAverage: 5,
      ratingCount: 100,
    });

    const res = await request(app).get(`/api/stats/top-profiles?profileType=${PROFILE_TYPE.CONSULTANCY}`);

    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(2); // the unverified one is excluded
    expect(res.body.data[0].ratingAverage).toBe(4.9);
    expect(res.body.data[1].ratingAverage).toBe(3.5);
  });

  it("respects the limit query param, capped at the max", async () => {
    for (let i = 0; i < 3; i++) {
      const user = await createUserWithActiveSubscription();
      await createConsultancyProfile({ user, currentSubscription: user.currentSubscription, isVerified: true });
    }

    const res = await request(app).get(`/api/stats/top-profiles?profileType=${PROFILE_TYPE.CONSULTANCY}&limit=2`);
    expect(res.body.data).toHaveLength(2);
  });
});

describe("GET /api/stats/overview", () => {
  it("blocks a regular user", async () => {
    const user = await createUser();
    const res = await request(app).get("/api/stats/overview").set("Authorization", `Bearer ${generateToken(user)}`);
    expect(res.status).toBe(401);
  });

  it("lets customer_care view it, and lets admin view it, with the expected shape", async () => {
    await createUser();
    await createUser({ accountStatus: "suspended" });

    for (const role of [await createAdmin(), await createCustomerCare()]) {
      const res = await request(app).get("/api/stats/overview").set("Authorization", `Bearer ${generateToken(role)}`);

      expect(res.status).toBe(200);
      expect(res.body.suspendedUsers).toBeGreaterThanOrEqual(1);
      expect(res.body.profileCounts).toHaveLength(Object.values(PROFILE_TYPE).length);
    }
  });

  it("returns completedJobsGrossAmount grouped by currency (array shape, not a single cross-currency sum)", async () => {
    // Job.currency is hard-locked to PLATFORM_CURRENCY (USD) — see
    // currencyReference.ts — so only one group is actually reachable in
    // practice today. The grouping logic itself stays (a $group by
    // currency, not one blind $sum) so this is still correct if that
    // lock is ever deliberately lifted for a second currency later.
    const client = await createUser();
    const provider = await createUser();
    await createActiveJob({
      client,
      provider,
      status: JOB_STATUS.COMPLETED,
      totalAmount: 1000,
    });
    await createActiveJob({
      client,
      provider,
      status: JOB_STATUS.COMPLETED,
      totalAmount: 500,
    });

    const admin = await createAdmin();
    const res = await request(app)
      .get("/api/stats/overview")
      .set("Authorization", `Bearer ${generateToken(admin)}`);

    expect(res.status).toBe(200);
    expect(res.body.completedJobsGrossAmount).toEqual([{ currency: "USD", total: 1500 }]);
  });
});
