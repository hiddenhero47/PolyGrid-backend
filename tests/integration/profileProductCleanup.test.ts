// No real storage call — same "mock the third-party integration entirely"
// boundary tests/README.md documents for helpers/emailSender, applied at
// the provider-dispatch boundary. Only the digital side goes through
// this; Store products use real (unmocked) local-disk deleteStoredFile,
// which is always ENOENT-safe for a fixture's non-existent path.
jest.mock("../../src/providers/digitalStorageProviders", () => {
  const adapter = { deleteDigitalFile: jest.fn() };
  return { getDigitalStorageProvider: () => adapter };
});

import mongoose from "mongoose";
import { connectTestDB, disconnectTestDB, clearTestDB } from "../setup/db";
import {
  createUser,
  createUserWithActiveSubscription,
  createStoreProfile,
  createProduct,
  createDigitalCreatorProfile,
  createDigitalProduct,
} from "../setup/fixtures";
import { Product } from "../../src/models/productModel";
import { DigitalProduct } from "../../src/models/digitalProductModel";
import { Subscription, SUBSCRIPTION_STATUS } from "../../src/models/subscriptionModel";
import { StoreProfile } from "../../src/models/storeProfileModel";
import { DigitalCreatorProfile } from "../../src/models/digitalCreatorProfileModel";
import { sweepInactiveProfileProducts, BATCH_SIZE_PER_TYPE } from "../../src/helpers/profileProductCleanup";
import { getDigitalStorageProvider } from "../../src/providers/digitalStorageProviders";

const mockDeleteDigitalFile = getDigitalStorageProvider().deleteDigitalFile as jest.Mock;

const DAY_MS = 24 * 60 * 60 * 1000;

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

// Backdates a subscription's status/updatedAt the way the sweep's
// "lapsed since" aggregation expects — bypassing Mongoose's own
// timestamps middleware (which fights a query-level attempt to set
// updatedAt) by going straight to the native collection.
const lapseSubscription = async (subscriptionId: mongoose.Types.ObjectId, daysAgo: number) =>
  Subscription.collection.updateOne(
    { _id: subscriptionId },
    { $set: { status: SUBSCRIPTION_STATUS.CANCELED, updatedAt: new Date(Date.now() - daysAgo * DAY_MS) } },
  );

describe("sweepInactiveProfileProducts — Store side", () => {
  it("deletes every product (and leaves its images request issued) for a store lapsed 30+ days", async () => {
    const user = await createUserWithActiveSubscription();
    const store = await createStoreProfile({ user, currentSubscription: user.currentSubscription });
    await createProduct({ store });
    await createProduct({ store });
    await lapseSubscription(user.currentSubscription as mongoose.Types.ObjectId, 40);

    const result = await sweepInactiveProfileProducts();

    expect(result.storeProfilesProcessed).toBe(1);
    expect(await Product.find({ storeId: store._id })).toHaveLength(0);
    // Never touches the profile itself.
    expect(await StoreProfile.findById(store.id)).not.toBeNull();
  });

  it("leaves a currently-subscribed store's products alone", async () => {
    const user = await createUserWithActiveSubscription();
    const store = await createStoreProfile({ user, currentSubscription: user.currentSubscription });
    await createProduct({ store });

    const result = await sweepInactiveProfileProducts();

    expect(result.storeProfilesProcessed).toBe(0);
    expect(await Product.find({ storeId: store._id })).toHaveLength(1);
  });

  it("leaves a store alone while still inside the 30-day grace window", async () => {
    const user = await createUserWithActiveSubscription();
    const store = await createStoreProfile({ user, currentSubscription: user.currentSubscription });
    await createProduct({ store });
    await lapseSubscription(user.currentSubscription as mongoose.Types.ObjectId, 10);

    const result = await sweepInactiveProfileProducts();

    expect(result.storeProfilesProcessed).toBe(0);
    expect(await Product.find({ storeId: store._id })).toHaveLength(1);
  });

  it("never sweeps a store that simply never subscribed at all", async () => {
    const user = await createUser();
    const store = await createStoreProfile({ user, currentSubscription: null });
    await createProduct({ store });

    const result = await sweepInactiveProfileProducts();

    expect(result.storeProfilesProcessed).toBe(0);
    expect(await Product.find({ storeId: store._id })).toHaveLength(1);
  });

  it(`only processes ${BATCH_SIZE_PER_TYPE} stores per run, leaving the rest for later`, async () => {
    for (let i = 0; i < BATCH_SIZE_PER_TYPE + 1; i++) {
      const user = await createUserWithActiveSubscription();
      const store = await createStoreProfile({ user, currentSubscription: user.currentSubscription });
      await createProduct({ store });
      await lapseSubscription(user.currentSubscription as mongoose.Types.ObjectId, 40);
    }

    const result = await sweepInactiveProfileProducts();
    expect(result.storeProfilesProcessed).toBe(BATCH_SIZE_PER_TYPE);

    const remainingProductCounts = await Product.countDocuments();
    expect(remainingProductCounts).toBe(1); // exactly one store's product untouched this run

    // Running it again clears the one left over — nothing was skipped
    // forever, just spread across runs.
    const second = await sweepInactiveProfileProducts();
    expect(second.storeProfilesProcessed).toBe(1);
    expect(await Product.countDocuments()).toBe(0);
  });
});

describe("sweepInactiveProfileProducts — Digital side", () => {
  it("deactivates and clears every file for a creator lapsed 30+ days, keeping the record", async () => {
    const user = await createUserWithActiveSubscription();
    const profile = await createDigitalCreatorProfile({ user, currentSubscription: user.currentSubscription });
    const product = await createDigitalProduct({ creator: profile });
    await lapseSubscription(user.currentSubscription as mongoose.Types.ObjectId, 40);

    const result = await sweepInactiveProfileProducts();

    expect(result.digitalCreatorProfilesProcessed).toBe(1);
    expect(mockDeleteDigitalFile).toHaveBeenCalledTimes(1);
    expect(mockDeleteDigitalFile).toHaveBeenCalledWith(product.files[0].key);

    const updated = await DigitalProduct.findById(product.id);
    expect(updated?.isActive).toBe(false);
    expect(updated?.files).toHaveLength(0);
    expect(updated?.previewImages).toHaveLength(0);
    // Never touches the profile itself.
    expect(await DigitalCreatorProfile.findById(profile.id)).not.toBeNull();
  });

  it("also clears a product's bin entries, not just its live files", async () => {
    const user = await createUserWithActiveSubscription();
    const profile = await createDigitalCreatorProfile({ user, currentSubscription: user.currentSubscription });
    const product = await createDigitalProduct({ creator: profile });
    product.bin.push({
      file: { fileName: "removed.pdf", key: "digital-products/x/removed.pdf", mime: "application/pdf", size: 10 },
      deleteAt: new Date(Date.now() + DAY_MS), // not yet due on its own — cleanup forces it anyway
    });
    await product.save();
    await lapseSubscription(user.currentSubscription as mongoose.Types.ObjectId, 40);

    await sweepInactiveProfileProducts();

    expect(mockDeleteDigitalFile).toHaveBeenCalledWith("digital-products/x/removed.pdf");
    const updated = await DigitalProduct.findById(product.id);
    expect(updated?.bin).toHaveLength(0);
  });

  it("leaves a currently-subscribed creator's products alone", async () => {
    const user = await createUserWithActiveSubscription();
    const profile = await createDigitalCreatorProfile({ user, currentSubscription: user.currentSubscription });
    const product = await createDigitalProduct({ creator: profile });

    const result = await sweepInactiveProfileProducts();

    expect(result.digitalCreatorProfilesProcessed).toBe(0);
    const unchanged = await DigitalProduct.findById(product.id);
    expect(unchanged?.isActive).toBe(true);
    expect(unchanged?.files).toHaveLength(1);
  });

  it("never re-processes a creator once every one of their products is already deactivated", async () => {
    const user = await createUserWithActiveSubscription();
    const profile = await createDigitalCreatorProfile({ user, currentSubscription: user.currentSubscription });
    await createDigitalProduct({ creator: profile });
    await lapseSubscription(user.currentSubscription as mongoose.Types.ObjectId, 40);

    const first = await sweepInactiveProfileProducts();
    expect(first.digitalCreatorProfilesProcessed).toBe(1);

    const second = await sweepInactiveProfileProducts();
    expect(second.digitalCreatorProfilesProcessed).toBe(0);
    expect(mockDeleteDigitalFile).toHaveBeenCalledTimes(1); // only from the first run
  });
});
