import request from "supertest";
import createApp from "../../src/app";
import { connectTestDB, disconnectTestDB, clearTestDB } from "../setup/db";
import {
  createUser,
  createUserWithActiveSubscription,
  createStoreProfile,
  createProduct,
  generateToken,
} from "../setup/fixtures";
import { Contact } from "../../src/models/contactModel";
import { Job } from "../../src/models/jobModel";
import { PayoutKyc, PAYOUT_KYC_METHOD, PAYOUT_KYC_STATUS } from "../../src/models/payoutKycModel";
import { SystemSettings } from "../../src/models/systemSettingsModel";
import { IUser } from "../../src/models/userModel";

const app = createApp();

beforeAll(async () => {
  await connectTestDB();
});

// clearTestDB wipes SystemSettings between tests, and its own defaults
// are deliberately restrictive (nothing supported) — placing an order
// now requires the *store owner's* own country to be supported (see
// helpers/paymentGuardrails.ts's assertEscrowEligible, called on the
// seller, not the buyer, since the seller is the one auto-confirmed on
// the new Job), so every test here needs NG permitted, same pattern as
// payment.test.ts's own beforeEach.
beforeEach(async () => {
  await SystemSettings.create({
    supportedCountries: ["NG"],
    maxOutstandingExposure: 1_000_000,
    maxTransactionAmount: 1_000_000,
  });
});

afterEach(async () => {
  await clearTestDB();
});

afterAll(async () => {
  await disconnectTestDB();
});

// createOrder auto-confirms the store owner's own side of the new Job
// immediately, so the owner must already be escrow-eligible (verified
// payout KYC, supported country) — see
// helpers/paymentGuardrails.ts's assertEscrowEligible.
const createEligibleStoreOwner = async (): Promise<IUser> => {
  const user = await createUserWithActiveSubscription({ country: "NG" });
  await PayoutKyc.create({
    user: user._id,
    country: "NG",
    method: PAYOUT_KYC_METHOD.AUTOMATED,
    status: PAYOUT_KYC_STATUS.VERIFIED,
  });
  return user;
};

describe("POST /api/store-orders", () => {
  it("requires authentication", async () => {
    const res = await request(app).post("/api/store-orders").send({});
    expect(res.status).toBe(401);
  });

  it("404s for a store that isn't currently subscribed", async () => {
    const buyer = await createUser();
    const owner = await createUser();
    const store = await createStoreProfile({ user: owner });
    const product = await createProduct({ store });

    const res = await request(app)
      .post("/api/store-orders")
      .set("Authorization", `Bearer ${generateToken(buyer)}`)
      .send({
        storeId: store.id,
        items: [{ productId: product.id, quantity: 2 }],
        shippingDestination: { country: "NG" },
      });

    expect(res.status).toBe(404);
  });

  it("404s (not a KYC-specific error) when the shop owner isn't escrow-eligible", async () => {
    // An active subscription, but no verified payout KYC — same masking
    // instinct as the inactive-subscription case above: a buyer is never
    // told the real reason is the seller's own KYC/country status.
    const buyer = await createUser();
    const owner = await createUserWithActiveSubscription();
    const store = await createStoreProfile({ user: owner, currentSubscription: owner.currentSubscription });
    const product = await createProduct({ store });

    const res = await request(app)
      .post("/api/store-orders")
      .set("Authorization", `Bearer ${generateToken(buyer)}`)
      .send({
        storeId: store.id,
        items: [{ productId: product.id, quantity: 2 }],
        shippingDestination: { country: "NG" },
      });

    expect(res.status).toBe(404);
    expect(res.body.code).toBeUndefined();
  });

  it("blocks ordering from your own store", async () => {
    const owner = await createEligibleStoreOwner();
    const store = await createStoreProfile({ user: owner, currentSubscription: owner.currentSubscription });
    const product = await createProduct({ store });

    const res = await request(app)
      .post("/api/store-orders")
      .set("Authorization", `Bearer ${generateToken(owner)}`)
      .send({
        storeId: store.id,
        items: [{ productId: product.id, quantity: 1 }],
        shippingDestination: { country: "NG" },
      });

    expect(res.status).toBe(400);
  });

  it("requires a shipping destination", async () => {
    const buyer = await createUser();
    const owner = await createEligibleStoreOwner();
    const store = await createStoreProfile({ user: owner, currentSubscription: owner.currentSubscription });
    const product = await createProduct({ store });

    const res = await request(app)
      .post("/api/store-orders")
      .set("Authorization", `Bearer ${generateToken(buyer)}`)
      .send({ storeId: store.id, items: [{ productId: product.id, quantity: 1 }] });

    expect(res.status).toBe(400);
  });

  it("rejects a product that doesn't belong to the given store", async () => {
    const buyer = await createUser();
    const owner = await createEligibleStoreOwner();
    const store = await createStoreProfile({ user: owner, currentSubscription: owner.currentSubscription });
    const otherOwner = await createEligibleStoreOwner();
    const otherStore = await createStoreProfile({
      user: otherOwner,
      currentSubscription: otherOwner.currentSubscription,
    });
    const foreignProduct = await createProduct({ store: otherStore });

    const res = await request(app)
      .post("/api/store-orders")
      .set("Authorization", `Bearer ${generateToken(buyer)}`)
      .send({
        storeId: store.id,
        items: [{ productId: foreignProduct.id, quantity: 1 }],
        shippingDestination: { country: "NG" },
      });

    expect(res.status).toBe(400);
  });

  it("rejects a destination none of the order's products ship to", async () => {
    const buyer = await createUser();
    const owner = await createEligibleStoreOwner();
    const store = await createStoreProfile({ user: owner, currentSubscription: owner.currentSubscription });
    // Fixture default only ships to NG.
    const product = await createProduct({ store });

    const res = await request(app)
      .post("/api/store-orders")
      .set("Authorization", `Bearer ${generateToken(buyer)}`)
      .send({
        storeId: store.id,
        items: [{ productId: product.id, quantity: 1 }],
        shippingDestination: { country: "US" },
      });

    expect(res.status).toBe(400);
  });

  it("resolves a state-specific shipping price over the nationwide default", async () => {
    const buyer = await createUser();
    const owner = await createEligibleStoreOwner();
    const store = await createStoreProfile({ user: owner, currentSubscription: owner.currentSubscription });
    const product = await createProduct({
      store,
      price: 100,
      shippingLocations: [
        { country: "NG", price: 20 }, // nationwide default
        { country: "NG", state: "LA", price: 5 }, // Lagos-specific, cheaper
      ],
    });

    const res = await request(app)
      .post("/api/store-orders")
      .set("Authorization", `Bearer ${generateToken(buyer)}`)
      .send({
        storeId: store.id,
        items: [{ productId: product.id, quantity: 2 }],
        shippingDestination: { country: "ng", state: "la" },
      });

    expect(res.status).toBe(201);
    expect(res.body.itemsTotalSnapshot).toBe(200);
    expect(res.body.shippingTotalSnapshot).toBe(5); // Lagos rate, not the NGN20 nationwide one
    expect(res.body.totalSnapshot).toBe(205);
  });

  it("places an order, spins up a Job the shop owner created, and connects buyer and owner as contacts", async () => {
    const buyer = await createUser();
    const owner = await createEligibleStoreOwner();
    const store = await createStoreProfile({ user: owner, currentSubscription: owner.currentSubscription });
    const product = await createProduct({ store, title: "Dangote Cement", price: 12.5 });

    const res = await request(app)
      .post("/api/store-orders")
      .set("Authorization", `Bearer ${generateToken(buyer)}`)
      .send({
        storeId: store.id,
        items: [{ productId: product.id, quantity: 3 }],
        shippingDestination: { country: "NG" },
        note: "Deliver to site B, Lekki",
      });

    expect(res.status).toBe(201);
    expect(res.body.items).toHaveLength(1);
    expect(res.body.items[0].titleSnapshot).toBe("Dangote Cement");
    expect(res.body.items[0].quantity).toBe(3);
    expect(res.body.note).toBe("Deliver to site B, Lekki");

    // The Job: shop owner is creator + already-confirmed provider, buyer
    // is the not-yet-confirmed client, total matches the order.
    expect(res.body.job).toBeTruthy();
    const job = await Job.findById(res.body.job._id);
    expect(job?.createdBy.toString()).toBe(owner.id);
    expect(job?.provider.userId.toString()).toBe(owner.id);
    expect(job?.provider.isConfirmed).toBe(true);
    expect(job?.client.userId.toString()).toBe(buyer.id);
    expect(job?.client.isConfirmed).toBe(false);
    expect(job?.jobType).toBe("store");
    expect(job?.totalAmount).toBe(res.body.totalSnapshot);
    expect(job?.status).toBe("pending_confirmation");

    const buyerContacts = await Contact.findOne({ userId: buyer._id });
    expect(buyerContacts?.list.map((e) => e.user.toString())).toContain(owner.id);
  });

  it("lets the shop owner (job creator) adjust the price before the buyer confirms", async () => {
    // The buyer is the one confirming the job below, which now requires
    // them to be escrow-eligible too (see jobController.ts's confirmJob).
    const buyer = await createEligibleStoreOwner();
    const owner = await createEligibleStoreOwner();
    const store = await createStoreProfile({ user: owner, currentSubscription: owner.currentSubscription });
    const product = await createProduct({ store, price: 100 });

    const order = await request(app)
      .post("/api/store-orders")
      .set("Authorization", `Bearer ${generateToken(buyer)}`)
      .send({
        storeId: store.id,
        items: [{ productId: product.id, quantity: 1 }],
        shippingDestination: { country: "NG" },
      });
    const jobId = order.body.job._id;

    const adjusted = await request(app)
      .patch(`/api/jobs/${jobId}`)
      .set("Authorization", `Bearer ${generateToken(owner)}`)
      .send({ totalAmount: 150 });

    expect(adjusted.status).toBe(200);
    expect(adjusted.body.totalAmount).toBe(150);
    expect(adjusted.body.amountHistory).toHaveLength(1);

    const confirmed = await request(app)
      .patch(`/api/jobs/${jobId}/confirm`)
      .set("Authorization", `Bearer ${generateToken(buyer)}`);
    expect(confirmed.status).toBe(200);
    expect(confirmed.body.status).toBe("active");
  });

  it("rejects a quantity less than 1", async () => {
    const buyer = await createUser();
    const owner = await createEligibleStoreOwner();
    const store = await createStoreProfile({ user: owner, currentSubscription: owner.currentSubscription });
    const product = await createProduct({ store });

    const res = await request(app)
      .post("/api/store-orders")
      .set("Authorization", `Bearer ${generateToken(buyer)}`)
      .send({
        storeId: store.id,
        items: [{ productId: product.id, quantity: 0 }],
        shippingDestination: { country: "NG" },
      });

    expect(res.status).toBe(400);
  });
});

describe("GET /api/store-orders/mine and /store", () => {
  it("shows the buyer their own orders and the owner their store's orders", async () => {
    const buyer = await createUser();
    const owner = await createEligibleStoreOwner();
    const store = await createStoreProfile({
      user: owner,
      currentSubscription: owner.currentSubscription,
      storeName: "Lagos Building Supplies",
    });
    const product = await createProduct({ store });

    const created = await request(app)
      .post("/api/store-orders")
      .set("Authorization", `Bearer ${generateToken(buyer)}`)
      .send({
        storeId: store.id,
        items: [{ productId: product.id, quantity: 1 }],
        shippingDestination: { country: "NG" },
      });

    const mine = await request(app)
      .get("/api/store-orders/mine")
      .set("Authorization", `Bearer ${generateToken(buyer)}`);
    expect(mine.body.data).toHaveLength(1);
    // A small store summary — not just its id — so the buyer's order
    // list can name the store without a separate GET per row.
    expect(mine.body.data[0].store).toEqual({
      id: store.id,
      storeName: "Lagos Building Supplies",
      slug: store.slug,
      logo: undefined,
    });
    // Same for the linked job — just enough ({status, amountPaid}) to
    // show "Awaiting your confirmation" / "Paid" inline.
    expect(mine.body.data[0].job).toEqual({
      id: created.body.job._id,
      status: created.body.job.status,
      amountPaid: created.body.job.amountPaid,
    });

    const storeOrders = await request(app)
      .get("/api/store-orders/store")
      .set("Authorization", `Bearer ${generateToken(owner)}`);
    expect(storeOrders.body.data).toHaveLength(1);
    expect(storeOrders.body.data[0].buyer.userName).toBeTruthy();
    expect(storeOrders.body.data[0].store.storeName).toBe("Lagos Building Supplies");
    expect(storeOrders.body.data[0].job.status).toBe(created.body.job.status);
  });

  it("404s for /store when the caller has no store profile", async () => {
    const user = await createUser();

    const res = await request(app)
      .get("/api/store-orders/store")
      .set("Authorization", `Bearer ${generateToken(user)}`);

    expect(res.status).toBe(404);
  });
});
