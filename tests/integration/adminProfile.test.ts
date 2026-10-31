// No real Mailgun call — same "mock the third-party integration
// entirely" boundary tests/README.md documents for helpers/emailSender.
jest.mock("../../src/helpers/emailSender", () => ({
  sendTemplatedEmail: jest.fn().mockResolvedValue({}),
  loadTemplates: jest.fn().mockResolvedValue(undefined),
}));

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
  createClientProfile,
  generateToken,
} from "../setup/fixtures";
import { PROFILE_TYPE } from "../../src/constants/profileTypes";
import { ConsultancyProfile } from "../../src/models/consultancyProfileModel";
import { sendTemplatedEmail } from "../../src/helpers/emailSender";

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

  it("records an optional reason, returns it via the review endpoint, clears it on unban, and notifies the owner both times", async () => {
    const admin = await createAdmin();
    const owner = await createUser({ fullName: "Chidi Okonkwo", email: "chidi@example.com" });
    const profile = await createConsultancyProfile({ user: owner });

    const banned = await request(app)
      .patch(`/api/admin/profiles/${PROFILE_TYPE.CONSULTANCY}/${profile.id}/status`)
      .set("Authorization", `Bearer ${generateToken(admin)}`)
      .send({ status: "banned", reason: "Repeated policy violations" });
    expect(banned.status).toBe(200);

    const review = await request(app)
      .get(`/api/admin/profiles/${PROFILE_TYPE.CONSULTANCY}/${profile.id}`)
      .set("Authorization", `Bearer ${generateToken(admin)}`);
    expect(review.body.banReason).toBe("Repeated policy violations");
    expect(review.body.bannedBy).toBe(admin.id);
    expect(review.body.bannedAt).toBeTruthy();

    expect(sendTemplatedEmail).toHaveBeenCalledWith(
      expect.objectContaining({
        to: "chidi@example.com",
        template: "profileStatusChanged",
        variables: expect.objectContaining({ banned: true, banReason: "Repeated policy violations" }),
      }),
    );

    const unbanned = await request(app)
      .patch(`/api/admin/profiles/${PROFILE_TYPE.CONSULTANCY}/${profile.id}/status`)
      .set("Authorization", `Bearer ${generateToken(admin)}`)
      .send({ status: "active" });
    expect(unbanned.status).toBe(200);

    const reviewAfterUnban = await request(app)
      .get(`/api/admin/profiles/${PROFILE_TYPE.CONSULTANCY}/${profile.id}`)
      .set("Authorization", `Bearer ${generateToken(admin)}`);
    expect(reviewAfterUnban.body.banReason).toBeUndefined();
    expect(reviewAfterUnban.body.bannedBy).toBeUndefined();
    expect(reviewAfterUnban.body.bannedAt).toBeUndefined();

    expect(sendTemplatedEmail).toHaveBeenCalledWith(
      expect.objectContaining({
        to: "chidi@example.com",
        template: "profileStatusChanged",
        variables: expect.objectContaining({ banned: false }),
      }),
    );
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

describe("GET /api/admin/profiles (search)", () => {
  it("requires a valid profileType", async () => {
    const admin = await createAdmin();

    const missing = await request(app)
      .get("/api/admin/profiles")
      .set("Authorization", `Bearer ${generateToken(admin)}`);
    expect(missing.status).toBe(400);

    const invalid = await request(app)
      .get("/api/admin/profiles?profileType=NotReal")
      .set("Authorization", `Bearer ${generateToken(admin)}`);
    expect(invalid.status).toBe(400);
  });

  it("blocks a plain user, but allows customer_care (read-only)", async () => {
    const user = await createUser();
    const customerCare = await createCustomerCare();

    const blocked = await request(app)
      .get(`/api/admin/profiles?profileType=${PROFILE_TYPE.CONSULTANCY}`)
      .set("Authorization", `Bearer ${generateToken(user)}`);
    expect(blocked.status).toBe(401);

    const allowed = await request(app)
      .get(`/api/admin/profiles?profileType=${PROFILE_TYPE.CONSULTANCY}`)
      .set("Authorization", `Bearer ${generateToken(customerCare)}`);
    expect(allowed.status).toBe(200);
  });

  it("matches the profile's own name/slug or the owner's name/email, and includes owner + rating per row", async () => {
    const admin = await createAdmin();
    const owner = await createUser({ fullName: "Chidi Okonkwo", email: "chidi@example.com" });
    const profile = await createConsultancyProfile({ user: owner, headline: "Structural Engineering Pro" });
    const otherOwner = await createUser();
    await createConsultancyProfile({ user: otherOwner, headline: "Totally unrelated" });

    const byName = await request(app)
      .get(`/api/admin/profiles?profileType=${PROFILE_TYPE.CONSULTANCY}&q=Structural`)
      .set("Authorization", `Bearer ${generateToken(admin)}`);
    expect(byName.body.data).toHaveLength(1);
    const row = byName.body.data[0];
    expect(row.id).toBe(profile.id);
    expect(row.name).toBe("Structural Engineering Pro");
    expect(row.slug).toBe(profile.slug);
    expect(row.owner).toEqual({ id: owner.id, fullName: "Chidi Okonkwo", email: "chidi@example.com" });
    expect(row.ratingAverage).toBe(profile.ratingAverage);
    expect(row.ratingCount).toBe(profile.ratingCount);

    const byOwnerName = await request(app)
      .get(`/api/admin/profiles?profileType=${PROFILE_TYPE.CONSULTANCY}&q=chidi`)
      .set("Authorization", `Bearer ${generateToken(admin)}`);
    expect(byOwnerName.body.data).toHaveLength(1);
    expect(byOwnerName.body.data[0].id).toBe(profile.id);

    const byEmail = await request(app)
      .get(`/api/admin/profiles?profileType=${PROFILE_TYPE.CONSULTANCY}&q=chidi@example.com`)
      .set("Authorization", `Bearer ${generateToken(admin)}`);
    expect(byEmail.body.data).toHaveLength(1);
    expect(byEmail.body.data[0].id).toBe(profile.id);

    const bySlug = await request(app)
      .get(`/api/admin/profiles?profileType=${PROFILE_TYPE.CONSULTANCY}&q=${profile.slug}`)
      .set("Authorization", `Bearer ${generateToken(admin)}`);
    expect(bySlug.body.data).toHaveLength(1);
    expect(bySlug.body.data[0].id).toBe(profile.id);
  });

  it("filters by status, including banned and inactive", async () => {
    const admin = await createAdmin();
    const activeOwner = await createUser();
    await createConsultancyProfile({ user: activeOwner });
    const bannedOwner = await createUser();
    await createConsultancyProfile({ user: bannedOwner, status: "banned" });

    const res = await request(app)
      .get(`/api/admin/profiles?profileType=${PROFILE_TYPE.CONSULTANCY}&status=banned`)
      .set("Authorization", `Bearer ${generateToken(admin)}`);

    expect(res.body.data).toHaveLength(1);
    expect(res.body.data[0].status).toBe("banned");
  });

  it("works for a profile type with no slug (ClientProfile)", async () => {
    const admin = await createAdmin();
    const owner = await createUser();
    const profile = await createClientProfile({ user: owner });

    const res = await request(app)
      .get(`/api/admin/profiles?profileType=${PROFILE_TYPE.CLIENT}`)
      .set("Authorization", `Bearer ${generateToken(admin)}`);

    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(1);
    expect(res.body.data[0].id).toBe(profile.id);
    expect(res.body.data[0].slug).toBeUndefined();
  });
});
