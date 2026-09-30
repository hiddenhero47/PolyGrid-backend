import mongoose from "mongoose";
import asyncHandler from "express-async-handler";
import { Request, Response } from "express";
import {
  StoreProfile,
  IStoreProfile,
  MATERIAL_CATEGORY,
  MaterialCategory,
  IProfileLink,
  MAX_PROFILE_LINKS,
} from "../models/storeProfileModel";
import { Product, IProduct } from "../models/productModel";
import { IUser } from "../models/userModel";
import { Subscription } from "../models/subscriptionModel";
import { toPublicMediaFile } from "../models/mediaFile";
import { uploadHandler, deleteStoredFile, FILE_VISIBILITY } from "../helpers/fileStorage";
import { toPublicProduct } from "./productController";

const slugify = (value: string): string =>
  value
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/(^-|-$)/g, "");

const generateUniqueSlug = async (base: string): Promise<string> => {
  const root = slugify(base) || "store";
  let slug = root;

  while (await StoreProfile.exists({ slug })) {
    slug = `${root}-${Math.random().toString(36).slice(2, 6)}`;
  }

  return slug;
};

export const toPublicStoreProfile = (profile: IStoreProfile) => ({
  id: profile.id,
  userId: profile.userId,
  isVerified: profile.isVerified,
  slug: profile.slug,
  storeName: profile.storeName,
  description: profile.description,
  categories: profile.categories,
  country: profile.country,
  city: profile.city,
  links: profile.links,
  logo: profile.logo ? toPublicMediaFile(profile.logo) : undefined,
  createdAt: profile.createdAt,
});

const filterValidCategories = (input: unknown): MaterialCategory[] => {
  if (!Array.isArray(input)) return [];
  return [
    ...new Set(input.filter((c): c is MaterialCategory => Object.values(MATERIAL_CATEGORY).includes(c))),
  ];
};

const filterValidLinks = (input: unknown): IProfileLink[] => {
  if (!Array.isArray(input)) return [];

  return input
    .filter((link): link is Record<string, unknown> => !!link && typeof link === "object" && !Array.isArray(link))
    .filter(
      (link) =>
        typeof link.label === "string" &&
        link.label.trim().length > 0 &&
        typeof link.url === "string" &&
        /^https?:\/\//i.test(link.url),
    )
    .map((link) => ({ label: (link.label as string).trim(), url: (link.url as string).trim() }));
};

// @desc    Create my PolyGrid Store profile
// @route   POST /api/store-profiles
// @access  Private — one per user
export const createStoreProfile = asyncHandler(async (req: Request, res: Response) => {
  const requester = req.user as IUser;

  const existing = await StoreProfile.findOne({ userId: requester._id });
  if (existing) {
    res.status(400);
    throw new Error("You already have a store profile");
  }

  const { storeName, description, categories, country, city, links } = req.body;

  if (!storeName || !country) {
    res.status(400);
    throw new Error("Please add a store name and country");
  }

  const resolvedCategories = filterValidCategories(categories);
  if (resolvedCategories.length === 0) {
    res.status(400);
    throw new Error("Select at least one category this store sells");
  }

  const resolvedLinks = filterValidLinks(links);
  if (resolvedLinks.length > MAX_PROFILE_LINKS) {
    res.status(400);
    throw new Error(`You can have at most ${MAX_PROFILE_LINKS} links`);
  }

  const profile = await StoreProfile.create({
    userId: requester._id,
    currentSubscription: requester.currentSubscription,
    slug: await generateUniqueSlug(storeName),
    storeName,
    description,
    categories: resolvedCategories,
    country,
    city,
    links: resolvedLinks,
  });

  res.status(201).json(toPublicStoreProfile(profile));
});

// @desc    Get my own store profile
// @route   GET /api/store-profiles/me
// @access  Private
export const getMyStoreProfile = asyncHandler(async (req: Request, res: Response) => {
  const profile = await StoreProfile.findOne({ userId: (req.user as IUser)._id });

  if (!profile) {
    res.status(404);
    throw new Error("You don't have a store profile yet");
  }

  res.status(200).json(toPublicStoreProfile(profile));
});

// Deletes every product under any category this update just removed, and
// their image files — a store can't keep selling something it just said
// it doesn't sell anymore. Runs before the profile itself saves its new
// category list, so a failure here never leaves the store claiming a
// category it silently still has orphaned products under.
const cascadeDeleteRemovedCategories = async (
  storeId: mongoose.Types.ObjectId,
  oldCategories: MaterialCategory[],
  newCategories: MaterialCategory[],
): Promise<void> => {
  const removed = oldCategories.filter((c) => !newCategories.includes(c));
  if (removed.length === 0) return;

  const doomedProducts = await Product.find({ storeId, category: { $in: removed } });
  if (doomedProducts.length === 0) return;

  await Promise.all(
    doomedProducts.flatMap((product) => product.images.map((image) => deleteStoredFile(image.storagePath))),
  );
  await Product.deleteMany({ _id: { $in: doomedProducts.map((p) => p._id) } });
};

// @desc    Update my store profile
// @route   PATCH /api/store-profiles/me
// @access  Private
export const updateMyStoreProfile = asyncHandler(async (req: Request, res: Response) => {
  const profile = await StoreProfile.findOne({ userId: (req.user as IUser)._id });

  if (!profile) {
    res.status(404);
    throw new Error("You don't have a store profile yet");
  }

  const { storeName, description, categories, country, city, links } = req.body;

  if (storeName) profile.storeName = storeName;
  if (description !== undefined) profile.description = description;
  if (country) profile.country = country;
  if (city !== undefined) profile.city = city;

  if (links !== undefined) {
    const resolvedLinks = filterValidLinks(links);
    if (resolvedLinks.length > MAX_PROFILE_LINKS) {
      res.status(400);
      throw new Error(`You can have at most ${MAX_PROFILE_LINKS} links`);
    }
    profile.links = resolvedLinks;
  }

  if (categories !== undefined) {
    const resolvedCategories = filterValidCategories(categories);
    if (resolvedCategories.length === 0) {
      res.status(400);
      throw new Error("Select at least one category this store sells");
    }

    await cascadeDeleteRemovedCategories(
      profile._id as mongoose.Types.ObjectId,
      profile.categories,
      resolvedCategories,
    );
    profile.categories = resolvedCategories;
  }

  await profile.save();

  res.status(200).json(toPublicStoreProfile(profile));
});

// @desc    Replace my store's logo (a single public image)
// @route   POST /api/store-profiles/me/logo
// @access  Private
export const uploadStoreLogo = asyncHandler(async (req: Request, res: Response) => {
  const profile = await StoreProfile.findOne({ userId: (req.user as IUser)._id });

  if (!profile) {
    res.status(404);
    throw new Error("You don't have a store profile yet");
  }

  const { results, errorLogs } = await uploadHandler({ req, visibility: FILE_VISIBILITY.PUBLIC });
  const saved = results[0];

  if (!saved) {
    res.status(400);
    throw new Error(errorLogs[0] || "No valid image provided");
  }

  const oldLogo = profile.logo;

  profile.logo = {
    fileName: saved.fileName,
    storagePath: saved.storagePath,
    mime: saved.mime,
    size: saved.size,
    url: saved.url,
  };
  await profile.save();

  // Only after the new logo is safely saved — never delete the old file
  // first and risk a profile with no logo at all if the new upload
  // somehow fails partway through.
  if (oldLogo) {
    await deleteStoredFile(oldLogo.storagePath);
  }

  res.status(200).json(toPublicStoreProfile(profile));
});

const paginationParams = (req: Request) => {
  const page = Math.max(Number(req.query.page) || 1, 1);
  const limit = Math.min(Number(req.query.limit) || 20, 100);
  return { page, limit, skip: (page - 1) * limit };
};

const PRODUCT_PREVIEW_COUNT = 4;

// @desc    Search/list stores — verified AND currently subscribed only
//          (same rule as ConsultancyProfile), optionally filtered by
//          category. Discovery always happens at the store level: this is
//          how a search for "aggregates" surfaces the stores that sell
//          aggregates, each with a small preview of matching products —
//          never a flat product search, which is exactly what would force
//          checking subscription status on every individual product (see
//          docs/store-plan.md).
// @route   GET /api/store-profiles
// @access  Public
export const searchStores = asyncHandler(async (req: Request, res: Response) => {
  const { page, limit, skip } = paginationParams(req);
  const { category, country } = req.query as { category?: string; country?: string };

  const match: Record<string, unknown> = { isVerified: true, currentSubscription: { $ne: null } };

  if (category && Object.values(MATERIAL_CATEGORY).includes(category as MaterialCategory)) {
    match.categories = category;
  }
  if (country) {
    match.country = String(country).toUpperCase();
  }

  const productMatchStage = category ? [{ $match: { category } }] : [];

  const pipeline = [
    { $match: match },
    {
      $lookup: {
        from: "subscriptions",
        localField: "currentSubscription",
        foreignField: "_id",
        as: "subscription",
      },
    },
    { $unwind: "$subscription" },
    { $match: { "subscription.status": "active", "subscription.expiresAt": { $gt: new Date() } } },
    {
      $lookup: {
        from: "products",
        let: { storeId: "$_id" },
        pipeline: [
          { $match: { $expr: { $eq: ["$storeId", "$$storeId"] } } },
          ...productMatchStage,
          { $sort: { createdAt: -1 as const } },
          { $limit: PRODUCT_PREVIEW_COUNT },
        ],
        as: "previewProducts",
      },
    },
    { $sort: { createdAt: -1 as const } },
  ];

  const [stores, totalResult] = await Promise.all([
    StoreProfile.aggregate([...pipeline, { $skip: skip }, { $limit: limit }]),
    StoreProfile.aggregate([...pipeline, { $count: "total" }]),
  ]);

  const total = totalResult[0]?.total ?? 0;

  res.status(200).json({
    data: stores.map((store) => ({
      ...toPublicStoreProfile(store as IStoreProfile),
      previewProducts: (store.previewProducts as IProduct[]).map(toPublicProduct),
    })),
    pagination: { total, page, limit, totalPages: Math.ceil(total / limit) },
  });
});

// @desc    View a store (its full catalog) — the URL always resolves, but
//          content (including products) is withheld unless the store is
//          currently subscribed, checked live, same reasoning and same
//          shape of response as ConsultancyProfile.getProfile.
// @route   GET /api/store-profiles/:idOrSlug
// @access  Public
export const getStore = asyncHandler(async (req: Request, res: Response) => {
  const idOrSlug = req.params.idOrSlug as string;

  const profile = mongoose.Types.ObjectId.isValid(idOrSlug)
    ? await StoreProfile.findById(idOrSlug)
    : await StoreProfile.findOne({ slug: idOrSlug });

  if (!profile) {
    res.status(404);
    throw new Error("Store not found");
  }

  const subscription = profile.currentSubscription
    ? await Subscription.findById(profile.currentSubscription)
    : null;

  if (!subscription?.isActive()) {
    res.status(200).json({ available: false, message: "This store is not currently available." });
    return;
  }

  const { page, limit, skip } = paginationParams(req);
  const { category, subCategory } = req.query as { category?: string; subCategory?: string };

  const filter: Record<string, unknown> = { storeId: profile._id };
  if (category && Object.values(MATERIAL_CATEGORY).includes(category as MaterialCategory)) {
    filter.category = category;
  }
  if (subCategory) {
    filter.subCategory = subCategory;
  }

  const [products, total] = await Promise.all([
    Product.find(filter).sort({ createdAt: -1 }).skip(skip).limit(limit),
    Product.countDocuments(filter),
  ]);

  res.status(200).json({
    ...toPublicStoreProfile(profile),
    products: products.map(toPublicProduct),
    pagination: { total, page, limit, totalPages: Math.ceil(total / limit) },
  });
});
