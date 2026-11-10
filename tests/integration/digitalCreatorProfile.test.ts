import request from "supertest";
import createApp from "../../src/app";
import { connectTestDB, disconnectTestDB, clearTestDB } from "../setup/db";
import {
  createUser,
  createUserWithActiveSubscription,
  createDigitalCreatorProfile,
  createDigitalProduct,
  createDigitalPurchase,
  generateToken,
  TEST_PNG_BUFFER,
} from "../setup/fixtures";
import { DigitalCreatorProfile } from "../../src/models/digitalCreatorProfileModel";
import { Subscription } from "../../src/models/subscriptionModel";
import { DigitalPurchase } from "../../src/models/digitalPurchaseModel";
import { SystemPayout } from "../../src/models/systemPayoutModel";
import { PayoutKyc } from "../../src/models/payoutKycModel";
import { IUser } from "../../src/models/userModel";

const TEST_PAYOUT_ACCOUNT = {
  accountName: "Test Recipient",
  accountNumber: "0123456789",
  bankName: "Test Bank",
  country: "NG",
};

// requestDigitalCreatorPayout refuses to approve unless the beneficiary
// has a verified PayoutKyc record on file, independent of
// payoutAccount/settlementMethod — see digitalCreatorProfileController.ts.
const verifyPayoutKyc = (user: IUser) =>
  PayoutKyc.create({ user: user._id, country: user.country ?? "NG", method: "automated", status: "verified" });

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

describe("POST /api/digital-creator-profiles", () => {
  it("requires authentication", async () => {
    const res = await request(app).post("/api/digital-creator-profiles").send({});
    expect(res.status).toBe(401);
  });

  it("creates a creator profile", async () => {
    const user = await createUser();

    const res = await request(app)
      .post("/api/digital-creator-profiles")
      .set("Authorization", `Bearer ${generateToken(user)}`)
      .send({ displayName: "Ada the Draftsman", country: "NG" });

    expect(res.status).toBe(201);
    expect(res.body.displayName).toBe("Ada the Draftsman");
    expect(res.body.slug).toBeTruthy();
  });

  it("rejects a second profile for the same user", async () => {
    const user = await createUser();
    await createDigitalCreatorProfile({ user });

    const res = await request(app)
      .post("/api/digital-creator-profiles")
      .set("Authorization", `Bearer ${generateToken(user)}`)
      .send({ displayName: "Second Profile", country: "NG" });

    expect(res.status).toBe(400);
  });
});

describe("PATCH /api/digital-creator-profiles/me", () => {
  it("updates my own profile fields", async () => {
    const user = await createUser();
    await createDigitalCreatorProfile({ user });

    const res = await request(app)
      .patch("/api/digital-creator-profiles/me")
      .set("Authorization", `Bearer ${generateToken(user)}`)
      .send({ bio: "I draw floor plans for a living" });

    expect(res.status).toBe(200);
    expect(res.body.bio).toBe("I draw floor plans for a living");
  });

  // Full status (active/inactive/banned) behavior — self-service toggle,
  // admin-only ban, search/eligibility exclusion, banned-hides-the-page —
  // is covered in depth once in consultancyProfile.test.ts (identical
  // shared logic); this just confirms the same wiring exists here too.
  it("lets me toggle my own status, but not to 'banned'; a banned profile rejects any update", async () => {
    const user = await createUser();
    await createDigitalCreatorProfile({ user });
    const token = generateToken(user);

    const toInactive = await request(app)
      .patch("/api/digital-creator-profiles/me")
      .set("Authorization", `Bearer ${token}`)
      .send({ status: "inactive" });
    expect(toInactive.status).toBe(200);
    expect(toInactive.body.status).toBe("inactive");

    const selfBan = await request(app)
      .patch("/api/digital-creator-profiles/me")
      .set("Authorization", `Bearer ${token}`)
      .send({ status: "banned" });
    expect(selfBan.status).toBe(400);

    const bannedUser = await createUser();
    await createDigitalCreatorProfile({ user: bannedUser, status: "banned" });
    const bannedUpdate = await request(app)
      .patch("/api/digital-creator-profiles/me")
      .set("Authorization", `Bearer ${generateToken(bannedUser)}`)
      .send({ bio: "Trying to sneak an edit in" });
    expect(bannedUpdate.status).toBe(403);
  });
});

describe("POST /api/digital-creator-profiles/me/avatar", () => {
  it("uploads an avatar and replaces the old one", async () => {
    const user = await createUser();
    await createDigitalCreatorProfile({ user });
    const token = generateToken(user);

    const res = await request(app)
      .post("/api/digital-creator-profiles/me/avatar")
      .set("Authorization", `Bearer ${token}`)
      .attach("file", TEST_PNG_BUFFER, "avatar.png");

    expect(res.status).toBe(200);
    expect(res.body.avatar.mime).toBe("image/png");
  });
});

describe("GET /api/digital-creator-profiles/:idOrSlug", () => {
  it("resolves the URL but withholds products when not currently subscribed", async () => {
    const user = await createUser();
    const creator = await createDigitalCreatorProfile({ user, slug: "unsub-creator" });
    await createDigitalProduct({ creator });

    const res = await request(app).get("/api/digital-creator-profiles/unsub-creator");

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ available: false, message: expect.any(String) });
  });

  it("returns only the creator's active AND verified products once subscribed", async () => {
    const user = await createUserWithActiveSubscription();
    const creator = await createDigitalCreatorProfile({
      user,
      currentSubscription: user.currentSubscription,
      slug: "sub-creator",
    });
    await createDigitalProduct({ creator, isVerified: true });
    await createDigitalProduct({ creator, isActive: false, isVerified: true });
    // Still awaiting review — GET /api/digital-products/:id already
    // answers {available:false} for this one, so the creator's own page
    // listing it (and counting it toward pagination.total) would be
    // inconsistent with that.
    await createDigitalProduct({ creator, isVerified: false });

    const res = await request(app).get("/api/digital-creator-profiles/sub-creator");

    expect(res.status).toBe(200);
    expect(res.body.displayName).toBeTruthy();
    expect(res.body.products).toHaveLength(1);
    expect(res.body.pagination.total).toBe(1);
  });

  it("goes back to unavailable the moment the subscription expires, with no write needed", async () => {
    const user = await createUserWithActiveSubscription();
    await createDigitalCreatorProfile({
      user,
      currentSubscription: user.currentSubscription,
      slug: "expiring-creator",
    });

    await Subscription.updateOne(
      { _id: user.currentSubscription },
      { expiresAt: new Date(Date.now() - 1000) },
    );

    const res = await request(app).get("/api/digital-creator-profiles/expiring-creator");
    expect(res.body.available).toBe(false);
  });

  it("404s for an unknown slug", async () => {
    const res = await request(app).get("/api/digital-creator-profiles/no-such-creator");
    expect(res.status).toBe(404);
  });
});

describe("model", () => {
  it("requires a userId, slug, displayName, and country", async () => {
    await expect(DigitalCreatorProfile.create({})).rejects.toThrow();
  });
});

describe("POST /api/digital-creator-profiles/me/request-payout", () => {
  it("requires authentication", async () => {
    const res = await request(app).post("/api/digital-creator-profiles/me/request-payout");
    expect(res.status).toBe(401);
  });

  it("404s when the caller has no digital creator profile", async () => {
    const user = await createUser();

    const res = await request(app)
      .post("/api/digital-creator-profiles/me/request-payout")
      .set("Authorization", `Bearer ${generateToken(user)}`);

    expect(res.status).toBe(404);
  });

  it("400s when nothing is unpaid yet", async () => {
    const creatorUser = await createUser({ payoutAccount: TEST_PAYOUT_ACCOUNT });
    await createDigitalCreatorProfile({ user: creatorUser });

    const res = await request(app)
      .post("/api/digital-creator-profiles/me/request-payout")
      .set("Authorization", `Bearer ${generateToken(creatorUser)}`);

    expect(res.status).toBe(400);
  });

  it("400s when the creator hasn't set up a payout account yet", async () => {
    const creatorUser = await createUser();
    const profile = await createDigitalCreatorProfile({ user: creatorUser });
    const product = await createDigitalProduct({ creator: profile, price: 100 });
    const buyer = await createUser();
    await createDigitalPurchase({ product, buyer, creator: profile });

    const res = await request(app)
      .post("/api/digital-creator-profiles/me/request-payout")
      .set("Authorization", `Bearer ${generateToken(creatorUser)}`);

    expect(res.status).toBe(400);
  });

  it("400s with a stable PAYOUT_KYC_REQUIRED code when the creator hasn't completed payout KYC", async () => {
    const creatorUser = await createUser({ payoutAccount: TEST_PAYOUT_ACCOUNT });
    const profile = await createDigitalCreatorProfile({ user: creatorUser });
    const product = await createDigitalProduct({ creator: profile, price: 100 });
    const buyer = await createUser();
    await createDigitalPurchase({ product, buyer, creator: profile });

    const res = await request(app)
      .post("/api/digital-creator-profiles/me/request-payout")
      .set("Authorization", `Bearer ${generateToken(creatorUser)}`);

    expect(res.status).toBe(400);
    expect(res.body.code).toBe("PAYOUT_KYC_REQUIRED");
  });

  // Same reasoning as jobController.ts's createSystemPayout fix (dde4cfd):
  // a payout account is only actually needed when settlement will fall
  // back to "manual" — a Stripe-Connect-ready creator's payout goes to
  // their own connected account and never reads payoutAccount at all.
  it("succeeds without a payout account on file when the creator is Stripe Connect ready", async () => {
    const creatorUser = await createUser({ stripeConnectedAccountId: "acct_123", stripeConnectPayoutsEnabled: true });
    await verifyPayoutKyc(creatorUser);
    const profile = await createDigitalCreatorProfile({ user: creatorUser });
    const product = await createDigitalProduct({ creator: profile, price: 100 });
    const buyer = await createUser();
    await createDigitalPurchase({ product, buyer, creator: profile });

    const res = await request(app)
      .post("/api/digital-creator-profiles/me/request-payout")
      .set("Authorization", `Bearer ${generateToken(creatorUser)}`);

    expect(res.status).toBe(201);
    expect(res.body.systemPayout.settlementMethod).toBe("stripe");
  });

  it("bundles every unpaid purchase into one SystemPayout, net of the platform fee, and marks them requested", async () => {
    const creatorUser = await createUser({ payoutAccount: TEST_PAYOUT_ACCOUNT });
    await verifyPayoutKyc(creatorUser);
    const profile = await createDigitalCreatorProfile({ user: creatorUser });
    const product = await createDigitalProduct({ creator: profile, price: 100 });
    const buyerA = await createUser();
    const buyerB = await createUser();

    const purchaseA = await createDigitalPurchase({
      product,
      buyer: buyerA,
      creator: profile,
      platformFeePercent: 10,
    });
    const purchaseB = await createDigitalPurchase({
      product,
      buyer: buyerB,
      creator: profile,
      platformFeePercent: 10,
    });

    const res = await request(app)
      .post("/api/digital-creator-profiles/me/request-payout")
      .set("Authorization", `Bearer ${generateToken(creatorUser)}`);

    expect(res.status).toBe(201);
    expect(res.body.purchasesBundled).toBe(2);
    // Each purchase: 100 * (1 - 10/100) = 90, so 180 total across both.
    expect(res.body.systemPayout.amount).toBeCloseTo(180);
    expect(res.body.systemPayout.settlementMethod).toBe("manual");
    expect(res.body.systemPayout.user).toBe(creatorUser.id);

    const updatedA = await DigitalPurchase.findById(purchaseA.id);
    const updatedB = await DigitalPurchase.findById(purchaseB.id);
    expect(updatedA?.payoutStatus).toBe("requested");
    expect(updatedB?.payoutStatus).toBe("requested");
    expect(updatedA?.payoutRequestId?.toString()).toBe(res.body.systemPayout._id);

    // A second request right away has nothing new to bundle.
    const again = await request(app)
      .post("/api/digital-creator-profiles/me/request-payout")
      .set("Authorization", `Bearer ${generateToken(creatorUser)}`);
    expect(again.status).toBe(400);
  });

  it("uses settlementMethod 'stripe' once the creator has a usable Connect account", async () => {
    const creatorUser = await createUser({
      payoutAccount: TEST_PAYOUT_ACCOUNT,
      stripeConnectedAccountId: "acct_123",
      stripeConnectPayoutsEnabled: true,
    });
    await verifyPayoutKyc(creatorUser);
    const profile = await createDigitalCreatorProfile({ user: creatorUser });
    const product = await createDigitalProduct({ creator: profile, price: 50 });
    const buyer = await createUser();
    await createDigitalPurchase({ product, buyer, creator: profile, platformFeePercent: 0 });

    const res = await request(app)
      .post("/api/digital-creator-profiles/me/request-payout")
      .set("Authorization", `Bearer ${generateToken(creatorUser)}`);

    expect(res.status).toBe(201);
    expect(res.body.systemPayout.settlementMethod).toBe("stripe");

    const payout = await SystemPayout.findById(res.body.systemPayout._id);
    expect(payout?.targetType).toBe("DigitalCreatorProfile");
    expect(payout?.targetId.toString()).toBe(profile.id);
  });
});
