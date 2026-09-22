import request from "supertest";
import createApp from "../../src/app";
import { connectTestDB, disconnectTestDB, clearTestDB } from "../setup/db";
import {
  createUser,
  createAdmin,
  createPlan,
  createSubscription,
  generateToken,
} from "../setup/fixtures";
import { PLAN_TIER } from "../../src/models/planModel";
import { Payment } from "../../src/models/paymentModel";
import { User } from "../../src/models/userModel";

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

describe("POST /api/subscriptions", () => {
  it("lets an admin grant a user a subscription and points currentSubscription at it", async () => {
    const admin = await createAdmin();
    const adminToken = generateToken(admin);
    const user = await createUser();
    const plan = await createPlan({ planTier: PLAN_TIER.PRO, duration: 30 });

    const res = await request(app)
      .post("/api/subscriptions")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ userId: user.id, planTier: plan.planTier, autoRenew: true });

    expect(res.status).toBe(201);
    expect(res.body.planTier).toBe(PLAN_TIER.PRO);
    expect(res.body.privileges).toEqual(plan.privileges);
    expect(res.body.status).toBe("active");

    const updatedUser = await User.findById(user.id);
    expect(updatedUser?.currentSubscription?.toString()).toBe(res.body._id);

    const payment = await Payment.findOne({
      targetType: "Subscription",
      targetId: res.body._id,
    });
    expect(payment?.amount).toBe(plan.price);
    expect(payment?.user.toString()).toBe(user.id);
    expect(payment?.provider).toBe("manual");
    expect(payment?.recordedBy?.toString()).toBe(admin.id);
  });

  it("rejects an unknown or inactive plan tier", async () => {
    const admin = await createAdmin();
    const adminToken = generateToken(admin);
    const user = await createUser();

    const res = await request(app)
      .post("/api/subscriptions")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ userId: user.id, planTier: PLAN_TIER.ENTERPRISE });

    expect(res.status).toBe(400);
  });

  it("blocks a non-admin from granting subscriptions", async () => {
    const user = await createUser();
    const token = generateToken(user);
    const other = await createUser();

    const res = await request(app)
      .post("/api/subscriptions")
      .set("Authorization", `Bearer ${token}`)
      .send({ userId: other.id, planTier: PLAN_TIER.PRO });

    expect(res.status).toBe(401);
  });

  it("replaces the previous currentSubscription pointer while keeping history", async () => {
    const admin = await createAdmin();
    const adminToken = generateToken(admin);
    const user = await createUser();
    const proPlan = await createPlan({ planTier: PLAN_TIER.PRO });
    const enterprisePlan = await createPlan({ planTier: PLAN_TIER.ENTERPRISE });

    const first = await request(app)
      .post("/api/subscriptions")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ userId: user.id, planTier: proPlan.planTier });

    const second = await request(app)
      .post("/api/subscriptions")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ userId: user.id, planTier: enterprisePlan.planTier });

    const updatedUser = await User.findById(user.id);
    expect(updatedUser?.currentSubscription?.toString()).toBe(second.body._id);
    expect(updatedUser?.currentSubscription?.toString()).not.toBe(first.body._id);

    const history = await request(app)
      .get("/api/subscriptions/me")
      .set("Authorization", `Bearer ${generateToken(user)}`);
    expect(history.body.pagination.total).toBe(2);
  });
});

describe("GET /api/subscriptions/me", () => {
  it("returns the caller's own history, newest first", async () => {
    const user = await createUser();
    await createSubscription({ user, expiresAt: new Date(Date.now() - 1000) });
    await createSubscription({ user });

    const res = await request(app)
      .get("/api/subscriptions/me")
      .set("Authorization", `Bearer ${generateToken(user)}`);

    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(2);
  });
});

describe("GET /api/subscriptions/users/:userId", () => {
  it("lets an admin view another user's history", async () => {
    const admin = await createAdmin();
    const user = await createUser();
    await createSubscription({ user });

    const res = await request(app)
      .get(`/api/subscriptions/users/${user.id}`)
      .set("Authorization", `Bearer ${generateToken(admin)}`);

    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(1);
  });

  it("blocks a non-admin", async () => {
    const user = await createUser();
    const other = await createUser();

    const res = await request(app)
      .get(`/api/subscriptions/users/${other.id}`)
      .set("Authorization", `Bearer ${generateToken(user)}`);

    expect(res.status).toBe(401);
  });
});

describe("GET /api/subscriptions/current", () => {
  it("returns the active subscription", async () => {
    const user = await createUser();
    await createSubscription({ user });

    const res = await request(app)
      .get("/api/subscriptions/current")
      .set("Authorization", `Bearer ${generateToken(user)}`);

    expect(res.status).toBe(200);
    expect(res.body.currentPlan).toBeTruthy();
  });

  it("returns null for a user who has never subscribed", async () => {
    const user = await createUser();

    const res = await request(app)
      .get("/api/subscriptions/current")
      .set("Authorization", `Bearer ${generateToken(user)}`);

    expect(res.status).toBe(200);
    expect(res.body.currentPlan).toBeNull();
  });
});
