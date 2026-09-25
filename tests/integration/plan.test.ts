import request from "supertest";
import createApp from "../../src/app";
import { connectTestDB, disconnectTestDB, clearTestDB } from "../setup/db";
import { createUser, createSuperAdmin, createPlan, generateToken } from "../setup/fixtures";
import { PLAN_TIER } from "../../src/models/planModel";

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

describe("GET /api/plans", () => {
  it("lists only active plans, cheapest first", async () => {
    await createPlan({ planTier: PLAN_TIER.PRO, price: 20 });
    await createPlan({ planTier: PLAN_TIER.ENTERPRISE, price: 50 });
    await createPlan({ planTier: PLAN_TIER.FREE, price: 0, isActive: false });

    const res = await request(app).get("/api/plans");

    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(2);
    expect(res.body[0].planTier).toBe(PLAN_TIER.PRO);
    expect(res.body[1].planTier).toBe(PLAN_TIER.ENTERPRISE);
  });

  it("includes inactive plans when includeInactive=true", async () => {
    await createPlan({ planTier: PLAN_TIER.FREE, price: 0, isActive: false });

    const res = await request(app).get("/api/plans?includeInactive=true");

    expect(res.body).toHaveLength(1);
  });
});

describe("GET /api/plans/:id", () => {
  it("returns a single plan", async () => {
    const plan = await createPlan();

    const res = await request(app).get(`/api/plans/${plan.id}`);

    expect(res.status).toBe(200);
    expect(res.body.planTier).toBe(plan.planTier);
  });

  it("404s for an unknown id", async () => {
    const res = await request(app).get("/api/plans/507f1f77bcf86cd799439011");
    expect(res.status).toBe(404);
  });
});

describe("POST /api/plans", () => {
  it("lets a super admin create a plan", async () => {
    const superAdmin = await createSuperAdmin();
    const token = generateToken(superAdmin);

    const res = await request(app)
      .post("/api/plans")
      .set("Authorization", `Bearer ${token}`)
      .send({
        planTier: PLAN_TIER.PRO,
        name: "Pro",
        privileges: ["engineering.consultant.access"],
        duration: 30,
        price: 20,
      });

    expect(res.status).toBe(201);
    expect(res.body.planTier).toBe(PLAN_TIER.PRO);
  });

  it("rejects a currency that isn't a real ISO 4217 code, as a clean 400 not a 500", async () => {
    const superAdmin = await createSuperAdmin();
    const token = generateToken(superAdmin);

    const res = await request(app)
      .post("/api/plans")
      .set("Authorization", `Bearer ${token}`)
      .send({
        planTier: PLAN_TIER.PRO,
        name: "Pro",
        duration: 30,
        price: 20,
        currency: "NOT_REAL",
      });

    // Nothing in planController pre-checks currency — this exercises the
    // Mongoose ValidationError -> 400 conversion in errorMiddleware.ts,
    // which every schema `validate` across the app relies on to avoid
    // surfacing a client-input problem as a 500.
    expect(res.status).toBe(400);
  });

  it("blocks a non-super-admin", async () => {
    const user = await createUser();
    const token = generateToken(user);

    const res = await request(app)
      .post("/api/plans")
      .set("Authorization", `Bearer ${token}`)
      .send({ planTier: PLAN_TIER.PRO, name: "Pro", duration: 30, price: 20 });

    expect(res.status).toBe(401);
  });

  it("rejects a duplicate planTier", async () => {
    const superAdmin = await createSuperAdmin();
    const token = generateToken(superAdmin);
    await createPlan({ planTier: PLAN_TIER.PRO });

    const res = await request(app)
      .post("/api/plans")
      .set("Authorization", `Bearer ${token}`)
      .send({ planTier: PLAN_TIER.PRO, name: "Pro again", duration: 30, price: 20 });

    expect(res.status).toBe(400);
  });
});

describe("PUT /api/plans/:id", () => {
  it("lets a super admin update a plan", async () => {
    const superAdmin = await createSuperAdmin();
    const token = generateToken(superAdmin);
    const plan = await createPlan({ price: 20 });

    const res = await request(app)
      .put(`/api/plans/${plan.id}`)
      .set("Authorization", `Bearer ${token}`)
      .send({ price: 25, isActive: false });

    expect(res.status).toBe(200);
    expect(res.body.price).toBe(25);
    expect(res.body.isActive).toBe(false);
  });
});
