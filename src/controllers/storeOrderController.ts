import mongoose from "mongoose";
import asyncHandler from "express-async-handler";
import { Request, Response } from "express";
import { StoreOrder, IStoreOrder } from "../models/storeOrderModel";
import { StoreProfile } from "../models/storeProfileModel";
import { Product, resolveShippingPrice } from "../models/productModel";
import { Job, JOB_TYPE } from "../models/jobModel";
import { IUser } from "../models/userModel";
import { Subscription } from "../models/subscriptionModel";
import { connectUsers } from "./contactController";
import { normalizeStages, getPlatformFeePercent } from "./jobController";

const paginationParams = (req: Request) => {
  const page = Math.max(Number(req.query.page) || 1, 1);
  const limit = Math.min(Number(req.query.limit) || 20, 100);
  return { page, limit, skip: (page - 1) * limit };
};

const toPublicOrder = (order: IStoreOrder) => ({
  id: order.id,
  store: order.store,
  buyer: order.buyer,
  job: order.job,
  items: order.items,
  shippingDestination: order.shippingDestination,
  itemsTotalSnapshot: order.itemsTotalSnapshot,
  shippingTotalSnapshot: order.shippingTotalSnapshot,
  totalSnapshot: order.totalSnapshot,
  currency: order.currency,
  note: order.note,
  createdAt: order.createdAt,
});

interface OrderItemInput {
  productId?: string;
  quantity?: number;
}

interface ShippingDestinationInput {
  country?: string;
  state?: string;
}

// @desc    "Checkout" — snapshots what's being requested, resolves each
//          product's shipping price for the given destination (rejecting
//          the whole order if any item can't ship there at all — see
//          Product.resolveShippingPrice), and spins up a real `Job`
//          (jobType: 'store') for it: the shop owner as creator (so they
//          can adjust the calculated price before the buyer confirms,
//          tracked via Job.amountHistory — see jobController.updateJob),
//          the buyer as the party who confirms to accept it. Also
//          connects buyer and store owner as Contacts, same side effect
//          Job creation always has, replicated here since this Job is
//          built directly rather than through POST /api/jobs.
// @route   POST /api/store-orders
// @access  Private
export const createOrder = asyncHandler(async (req: Request, res: Response) => {
  const requester = req.user as IUser;
  const {
    storeId,
    items,
    shippingDestination,
    note,
  } = req.body as {
    storeId?: string;
    items?: OrderItemInput[];
    shippingDestination?: ShippingDestinationInput;
    note?: string;
  };

  if (!storeId || !mongoose.Types.ObjectId.isValid(storeId)) {
    res.status(400);
    throw new Error("A valid storeId is required");
  }

  if (!Array.isArray(items) || items.length === 0) {
    res.status(400);
    throw new Error("An order needs at least one item");
  }

  if (!shippingDestination?.country) {
    res.status(400);
    throw new Error("A shipping destination (at least a country) is required");
  }

  const store = await StoreProfile.findById(storeId);
  if (!store) {
    res.status(404);
    throw new Error("Store not found");
  }

  if (store.userId.toString() === requester.id) {
    res.status(400);
    throw new Error("You can't order from your own store");
  }

  // A store that isn't currently subscribed isn't discoverable/orderable
  // at all — same live check as getStore/getProduct, never a stored flag.
  const subscription = store.currentSubscription
    ? await Subscription.findById(store.currentSubscription)
    : null;
  if (!subscription?.isActive()) {
    res.status(404);
    throw new Error("Store not found");
  }

  const resolvedItems = [];
  let currency: string | undefined;
  let itemsTotal = 0;
  let shippingTotal = 0;

  for (const item of items) {
    if (!item.productId || !mongoose.Types.ObjectId.isValid(item.productId)) {
      res.status(400);
      throw new Error("Each item needs a valid productId");
    }
    const quantity = Number(item.quantity);
    if (!Number.isInteger(quantity) || quantity < 1) {
      res.status(400);
      throw new Error("Each item needs a quantity of at least 1");
    }

    const product = await Product.findOne({ _id: item.productId, storeId: store._id });
    if (!product) {
      res.status(400);
      throw new Error(`Product ${item.productId} does not belong to this store`);
    }

    // A single order draws from one store, so it can only ever be in one
    // currency — a product priced in a different currency than the rest
    // of the order is almost certainly a client-side mistake, not
    // something to silently total across currencies.
    if (currency && product.currency !== currency) {
      res.status(400);
      throw new Error("All items in one order must share the same currency");
    }
    currency = product.currency;

    // "Any location that's not there won't go through" — a product with
    // no shipping option for the requested destination can't be part of
    // this order at all, not silently skipped or defaulted to some price.
    const shippingPrice = resolveShippingPrice(product, shippingDestination as { country: string; state?: string });
    if (shippingPrice === null) {
      res.status(400);
      throw new Error(`${product.title} does not ship to the requested destination`);
    }

    itemsTotal += product.price * quantity;
    shippingTotal += shippingPrice;

    resolvedItems.push({
      product: product._id,
      titleSnapshot: product.title,
      quantity,
      unitPriceSnapshot: product.price,
    });
  }

  const totalSnapshot = itemsTotal + shippingTotal;
  const destinationLabel = [shippingDestination.state, shippingDestination.country].filter(Boolean).join(", ");
  const itemsSummary = resolvedItems.map((item) => `${item.quantity} x ${item.titleSnapshot}`).join(", ");

  // Built directly, not through POST /api/jobs — that endpoint always
  // makes whoever calls it a confirmed party, but here the *buyer* is the
  // one calling checkout while the *shop owner* needs to be the
  // confirmed, editing-capable creator (see the file-level comment).
  const job = await Job.create({
    jobTitle: `Order from ${store.storeName}`,
    jobDescription: `${itemsSummary} — shipping to ${destinationLabel}`,
    jobType: JOB_TYPE.STORE,
    createdBy: store.userId,
    client: { userId: requester._id, isConfirmed: false },
    provider: { userId: store.userId, isConfirmed: true },
    stages: normalizeStages(undefined),
    totalAmount: totalSnapshot,
    currency,
    platformFeePercent: getPlatformFeePercent(),
  });

  const order = await StoreOrder.create({
    store: store._id,
    buyer: requester._id,
    job: job._id,
    items: resolvedItems,
    shippingDestination,
    itemsTotalSnapshot: itemsTotal,
    shippingTotalSnapshot: shippingTotal,
    totalSnapshot,
    currency,
    note,
  });

  await connectUsers(requester._id, store.userId);

  res.status(201).json({ ...toPublicOrder(order), job });
});

// @desc    My own orders (as a buyer), newest first
// @route   GET /api/store-orders/mine
// @access  Private
export const getMyOrders = asyncHandler(async (req: Request, res: Response) => {
  const requester = req.user as IUser;
  const { page, limit, skip } = paginationParams(req);
  const filter = { buyer: requester._id };

  const [data, total] = await Promise.all([
    StoreOrder.find(filter).sort({ createdAt: -1 }).skip(skip).limit(limit),
    StoreOrder.countDocuments(filter),
  ]);

  res.status(200).json({
    data: data.map(toPublicOrder),
    pagination: { total, page, limit, totalPages: Math.ceil(total / limit) },
  });
});

// @desc    Orders received by my store, newest first
// @route   GET /api/store-orders/store
// @access  Private — must own a store profile
export const getStoreOrders = asyncHandler(async (req: Request, res: Response) => {
  const requester = req.user as IUser;
  const store = await StoreProfile.findOne({ userId: requester._id });

  if (!store) {
    res.status(404);
    throw new Error("You don't have a store profile yet");
  }

  const { page, limit, skip } = paginationParams(req);
  const filter = { store: store._id };

  const [data, total] = await Promise.all([
    StoreOrder.find(filter).sort({ createdAt: -1 }).skip(skip).limit(limit).populate("buyer", "fullName email"),
    StoreOrder.countDocuments(filter),
  ]);

  res.status(200).json({
    data: data.map(toPublicOrder),
    pagination: { total, page, limit, totalPages: Math.ceil(total / limit) },
  });
});
