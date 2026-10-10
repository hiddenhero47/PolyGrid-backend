// No real storage call — same "mock the third-party integration entirely"
// boundary tests/README.md documents for helpers/emailSender, applied at
// the provider-dispatch boundary.
jest.mock("../../src/providers/digitalStorageProviders", () => {
  const adapter = { deleteDigitalFile: jest.fn() };
  return { getDigitalStorageProvider: () => adapter };
});

import mongoose from "mongoose";
import { connectTestDB, disconnectTestDB, clearTestDB } from "../setup/db";
import {
  createUser,
  createUserWithActiveSubscription,
  createDigitalCreatorProfile,
  createDigitalProduct,
  createDigitalPurchase,
} from "../setup/fixtures";
import { DigitalPurchase, DIGITAL_PURCHASE_STATUS } from "../../src/models/digitalPurchaseModel";
import { Subscription, SUBSCRIPTION_STATUS } from "../../src/models/subscriptionModel";
import { sweepExpiredPurchaseFiles } from "../../src/helpers/digitalPurchaseRetention";
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

describe("sweepExpiredPurchaseFiles", () => {
  it("leaves a purchase alone while the buyer's subscription is active", async () => {
    const creatorUser = await createUser();
    const profile = await createDigitalCreatorProfile({ user: creatorUser });
    const product = await createDigitalProduct({ creator: profile });
    const buyer = await createUserWithActiveSubscription();
    const purchase = await createDigitalPurchase({
      product,
      buyer,
      creator: profile,
      status: DIGITAL_PURCHASE_STATUS.SUCCESS,
    });

    const result = await sweepExpiredPurchaseFiles();

    expect(result.wiped).toBe(0);
    expect(mockDeleteDigitalFile).not.toHaveBeenCalled();

    const updated = await DigitalPurchase.findById(purchase.id);
    expect(updated?.files).toHaveLength(1);
    expect(updated?.filesDeletedAt).toBeNull();
  });

  it("wipes a never-subscribed buyer's copy once 7 days have passed since the purchase", async () => {
    const creatorUser = await createUser();
    const profile = await createDigitalCreatorProfile({ user: creatorUser });
    const product = await createDigitalProduct({ creator: profile });
    const buyer = await createUser(); // never subscribed — buyer.currentSubscription stays null
    const purchase = await createDigitalPurchase({
      product,
      buyer,
      creator: profile,
      status: DIGITAL_PURCHASE_STATUS.SUCCESS,
    });
    // Mongoose's own timestamps middleware fights a query-level
    // updateOne's attempt to set createdAt — the native collection
    // bypasses it entirely.
    await DigitalPurchase.collection.updateOne(
      { _id: purchase._id },
      { $set: { createdAt: new Date(Date.now() - 8 * DAY_MS) } },
    );

    const result = await sweepExpiredPurchaseFiles();

    expect(result.wiped).toBe(1);
    expect(mockDeleteDigitalFile).toHaveBeenCalledTimes(1);

    const updated = await DigitalPurchase.findById(purchase.id);
    expect(updated?.files).toHaveLength(0);
    expect(updated?.filesDeletedAt).toBeTruthy();
  });

  it("keeps a never-subscribed buyer's copy inside the 7-day grace window", async () => {
    const creatorUser = await createUser();
    const profile = await createDigitalCreatorProfile({ user: creatorUser });
    const product = await createDigitalProduct({ creator: profile });
    const buyer = await createUser();
    const purchase = await createDigitalPurchase({
      product,
      buyer,
      creator: profile,
      status: DIGITAL_PURCHASE_STATUS.SUCCESS,
    });
    await DigitalPurchase.collection.updateOne(
      { _id: purchase._id },
      { $set: { createdAt: new Date(Date.now() - 2 * DAY_MS) } },
    );

    const result = await sweepExpiredPurchaseFiles();

    expect(result.wiped).toBe(0);
    const updated = await DigitalPurchase.findById(purchase.id);
    expect(updated?.files).toHaveLength(1);
  });

  it("wipes a buyer's copy 7+ days after their subscription was canceled", async () => {
    const creatorUser = await createUser();
    const profile = await createDigitalCreatorProfile({ user: creatorUser });
    const product = await createDigitalProduct({ creator: profile });
    const buyer = await createUserWithActiveSubscription();
    const purchase = await createDigitalPurchase({
      product,
      buyer,
      creator: profile,
      status: DIGITAL_PURCHASE_STATUS.SUCCESS,
    });

    await Subscription.collection.updateOne(
      { _id: buyer.currentSubscription as mongoose.Types.ObjectId },
      { $set: { status: SUBSCRIPTION_STATUS.CANCELED, updatedAt: new Date(Date.now() - 10 * DAY_MS) } },
    );

    const result = await sweepExpiredPurchaseFiles();

    expect(result.wiped).toBe(1);
    const updated = await DigitalPurchase.findById(purchase.id);
    expect(updated?.files).toHaveLength(0);
    expect(updated?.filesDeletedAt).toBeTruthy();
  });

  it("keeps a buyer's copy inside the 7-day grace window after cancellation", async () => {
    const creatorUser = await createUser();
    const profile = await createDigitalCreatorProfile({ user: creatorUser });
    const product = await createDigitalProduct({ creator: profile });
    const buyer = await createUserWithActiveSubscription();
    const purchase = await createDigitalPurchase({
      product,
      buyer,
      creator: profile,
      status: DIGITAL_PURCHASE_STATUS.SUCCESS,
    });

    await Subscription.collection.updateOne(
      { _id: buyer.currentSubscription as mongoose.Types.ObjectId },
      { $set: { status: SUBSCRIPTION_STATUS.CANCELED, updatedAt: new Date(Date.now() - 2 * DAY_MS) } },
    );

    const result = await sweepExpiredPurchaseFiles();

    expect(result.wiped).toBe(0);
    const updated = await DigitalPurchase.findById(purchase.id);
    expect(updated?.files).toHaveLength(1);
  });

  it("never reprocesses a purchase whose files are already wiped", async () => {
    const creatorUser = await createUser();
    const profile = await createDigitalCreatorProfile({ user: creatorUser });
    const product = await createDigitalProduct({ creator: profile });
    const buyer = await createUser();
    await createDigitalPurchase({
      product,
      buyer,
      creator: profile,
      status: DIGITAL_PURCHASE_STATUS.SUCCESS,
      files: [],
      filesDeletedAt: new Date(Date.now() - 30 * DAY_MS),
    });

    const result = await sweepExpiredPurchaseFiles();

    expect(result.checked).toBe(0);
    expect(result.wiped).toBe(0);
    expect(mockDeleteDigitalFile).not.toHaveBeenCalled();
  });
});
