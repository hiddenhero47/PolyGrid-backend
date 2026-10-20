import request from "supertest";
import createApp from "../../src/app";
import { connectTestDB, disconnectTestDB, clearTestDB } from "../setup/db";
import {
  createUser,
  createAdmin,
  createCustomerCare,
  createUserWithActiveSubscription,
  createConsultancyProfile,
  createStoreProfile,
  generateToken,
} from "../setup/fixtures";
import { PROFILE_TYPE } from "../../src/constants/profileTypes";
import { ConsultancyProfile } from "../../src/models/consultancyProfileModel";

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

// Deliberately exercised against two different profile types
// (ConsultancyProfile, StoreProfile) with no profile-type-specific code
// of its own — that genericity (reusing PROFILE_MODEL_REGISTRY) is the
// entire point of this endpoint.
describe("PATCH /api/admin/profiles/:profileType/:id/status", () => {
  it("lets an admin ban a ConsultancyProfile, and unban it again", async () => {
    const admin = await createAdmin();
    const user = await createUser();
    const profile = await createConsultancyProfile({ user });

    const banned = await request(app)
      .patch(`/api/admin/profiles/${PROFILE_TYPE.CONSULTANCY}/${profile.id}/status`)
      .set("Authorization", `Bearer ${generateToken(admin)}`)
      .send({ status: "banned" });

    expect(banned.status).toBe(200);
    expect(banned.body.status).toBe("banned");

    const stored = await ConsultancyProfile.findById(profile.id);
    expect(stored?.status).toBe("banned");

    const unbanned = await request(app)
      .patch(`/api/admin/profiles/${PROFILE_TYPE.CONSULTANCY}/${profile.id}/status`)
      .set("Authorization", `Bearer ${generateToken(admin)}`)
      .send({ status: "active" });

    expect(unbanned.status).toBe(200);
    expect(unbanned.body.status).toBe("active");
  });

  it("works the same way against a StoreProfile — no per-type code needed", async () => {
    const admin = await createAdmin();
    const user = await createUser();
    const store = await createStoreProfile({ user });

    const res = await request(app)
      .patch(`/api/admin/profiles/${PROFILE_TYPE.STORE}/${store.id}/status`)
      .set("Authorization", `Bearer ${generateToken(admin)}`)
      .send({ status: "banned" });

    expect(res.status).toBe(200);
    expect(res.body.status).toBe("banned");
  });

  it("rejects 'inactive' — that's self-service only, never set through the admin endpoint", async () => {
    const admin = await createAdmin();
    const user = await createUser();
    const profile = await createConsultancyProfile({ user });

    const res = await request(app)
      .patch(`/api/admin/profiles/${PROFILE_TYPE.CONSULTANCY}/${profile.id}/status`)
      .set("Authorization", `Bearer ${generateToken(admin)}`)
      .send({ status: "inactive" });

    expect(res.status).toBe(400);
  });

  it("rejects an invalid profileType", async () => {
    const admin = await createAdmin();

    const res = await request(app)
      .patch(`/api/admin/profiles/NotARealProfile/507f1f77bcf86cd799439011/status`)
      .set("Authorization", `Bearer ${generateToken(admin)}`)
      .send({ status: "banned" });

    expect(res.status).toBe(400);
  });

  it("404s for an unknown profile id", async () => {
    const admin = await createAdmin();

    const res = await request(app)
      .patch(`/api/admin/profiles/${PROFILE_TYPE.CONSULTANCY}/507f1f77bcf86cd799439011/status`)
      .set("Authorization", `Bearer ${generateToken(admin)}`)
      .send({ status: "banned" });

    expect(res.status).toBe(404);
  });

  it("blocks a non-admin", async () => {
    const user = await createUser();
    const profile = await createConsultancyProfile({ user });

    const res = await request(app)
      .patch(`/api/admin/profiles/${PROFILE_TYPE.CONSULTANCY}/${profile.id}/status`)
      .set("Authorization", `Bearer ${generateToken(user)}`)
      .send({ status: "banned" });

    expect(res.status).toBe(401);
  });
});

// For the verification-review workflow: an admin/customer_care reviewer
// needs to see a profile's actual content regardless of whether its
// owner happens to be currently subscribed — the public single-view
// endpoint's {available:false} gating is a discoverability paywall, not
// something that should block internal review.
describe("GET /api/admin/profiles/:profileType/:id", () => {
  it("shows full profile content even when the owner isn't subscribed (unlike the public view)", async () => {
    const admin = await createAdmin();
    const user = await createUser(); // no subscription
    const profile = await createConsultancyProfile({ user, headline: "Structural Engineer" });

    const publicView = await request(app).get(`/api/consultancy-profiles/${profile.id}`);
    expect(publicView.body.available).toBe(false);

    const adminView = await request(app)
      .get(`/api/admin/profiles/${PROFILE_TYPE.CONSULTANCY}/${profile.id}`)
      .set("Authorization", `Bearer ${generateToken(admin)}`);

    expect(adminView.status).toBe(200);
    expect(adminView.body.headline).toBe("Structural Engineer");
  });

  it("works the same way against a StoreProfile — no per-type code needed", async () => {
    const admin = await createAdmin();
    const user = await createUser();
    const store = await createStoreProfile({ user, storeName: "Lagos Building Supplies" });

    const res = await request(app)
      .get(`/api/admin/profiles/${PROFILE_TYPE.STORE}/${store.id}`)
      .set("Authorization", `Bearer ${generateToken(admin)}`);

    expect(res.status).toBe(200);
    expect(res.body.storeName).toBe("Lagos Building Supplies");
  });

  it("also shows a banned profile — a moderation action, not something that should hide it from a reviewer", async () => {
    const admin = await createAdmin();
    const user = await createUserWithActiveSubscription();
    const profile = await createConsultancyProfile({
      user,
      currentSubscription: user.currentSubscription,
      status: "banned",
    });

    const res = await request(app)
      .get(`/api/admin/profiles/${PROFILE_TYPE.CONSULTANCY}/${profile.id}`)
      .set("Authorization", `Bearer ${generateToken(admin)}`);

    expect(res.status).toBe(200);
    expect(res.body.status).toBe("banned");
  });

  it("lets customer_care view it too (read-only queue access, same as the verification queue itself)", async () => {
    const customerCare = await createCustomerCare();
    const user = await createUser();
    const profile = await createConsultancyProfile({ user });

    const res = await request(app)
      .get(`/api/admin/profiles/${PROFILE_TYPE.CONSULTANCY}/${profile.id}`)
      .set("Authorization", `Bearer ${generateToken(customerCare)}`);

    expect(res.status).toBe(200);
  });

  it("rejects an invalid profileType", async () => {
    const admin = await createAdmin();

    const res = await request(app)
      .get(`/api/admin/profiles/NotARealProfile/507f1f77bcf86cd799439011`)
      .set("Authorization", `Bearer ${generateToken(admin)}`);

    expect(res.status).toBe(400);
  });

  it("404s for an unknown profile id", async () => {
    const admin = await createAdmin();

    const res = await request(app)
      .get(`/api/admin/profiles/${PROFILE_TYPE.CONSULTANCY}/507f1f77bcf86cd799439011`)
      .set("Authorization", `Bearer ${generateToken(admin)}`);

    expect(res.status).toBe(404);
  });

  it("blocks a plain user", async () => {
    const user = await createUser();
    const profile = await createConsultancyProfile({ user });

    const res = await request(app)
      .get(`/api/admin/profiles/${PROFILE_TYPE.CONSULTANCY}/${profile.id}`)
      .set("Authorization", `Bearer ${generateToken(user)}`);

    expect(res.status).toBe(401);
  });
});
