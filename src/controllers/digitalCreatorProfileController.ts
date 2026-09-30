import mongoose from "mongoose";
import asyncHandler from "express-async-handler";
import { Request, Response } from "express";
import {
  DigitalCreatorProfile,
  IDigitalCreatorProfile,
  IProfileLink,
  MAX_PROFILE_LINKS,
} from "../models/digitalCreatorProfileModel";
import { DigitalProduct } from "../models/digitalProductModel";
import { IUser } from "../models/userModel";
import { Subscription } from "../models/subscriptionModel";
import { toPublicMediaFile } from "../models/mediaFile";
import { uploadHandler, deleteStoredFile, FILE_VISIBILITY } from "../helpers/fileStorage";
import { toPublicDigitalProduct } from "./digitalProductController";

const slugify = (value: string): string =>
  value
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/(^-|-$)/g, "");

const generateUniqueSlug = async (base: string): Promise<string> => {
  const root = slugify(base) || "creator";
  let slug = root;

  while (await DigitalCreatorProfile.exists({ slug })) {
    slug = `${root}-${Math.random().toString(36).slice(2, 6)}`;
  }

  return slug;
};

export const toPublicDigitalCreatorProfile = (profile: IDigitalCreatorProfile) => ({
  id: profile.id,
  userId: profile.userId,
  isVerified: profile.isVerified,
  slug: profile.slug,
  displayName: profile.displayName,
  bio: profile.bio,
  country: profile.country,
  city: profile.city,
  links: profile.links,
  avatar: profile.avatar ? toPublicMediaFile(profile.avatar) : undefined,
  createdAt: profile.createdAt,
});

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

// @desc    Create my Digital Storefront creator profile
// @route   POST /api/digital-creator-profiles
// @access  Private — one per user
export const createDigitalCreatorProfile = asyncHandler(async (req: Request, res: Response) => {
  const requester = req.user as IUser;

  const existing = await DigitalCreatorProfile.findOne({ userId: requester._id });
  if (existing) {
    res.status(400);
    throw new Error("You already have a digital creator profile");
  }

  const { displayName, bio, country, city, links } = req.body;

  if (!displayName || !country) {
    res.status(400);
    throw new Error("Please add a displayName and country");
  }

  const resolvedLinks = filterValidLinks(links);
  if (resolvedLinks.length > MAX_PROFILE_LINKS) {
    res.status(400);
    throw new Error(`You can have at most ${MAX_PROFILE_LINKS} links`);
  }

  const profile = await DigitalCreatorProfile.create({
    userId: requester._id,
    currentSubscription: requester.currentSubscription,
    slug: await generateUniqueSlug(displayName),
    displayName,
    bio,
    country,
    city,
    links: resolvedLinks,
  });

  res.status(201).json(toPublicDigitalCreatorProfile(profile));
});

// @desc    Get my own digital creator profile
// @route   GET /api/digital-creator-profiles/me
// @access  Private
export const getMyDigitalCreatorProfile = asyncHandler(async (req: Request, res: Response) => {
  const profile = await DigitalCreatorProfile.findOne({ userId: (req.user as IUser)._id });

  if (!profile) {
    res.status(404);
    throw new Error("You don't have a digital creator profile yet");
  }

  res.status(200).json(toPublicDigitalCreatorProfile(profile));
});

// @desc    Update my digital creator profile
// @route   PATCH /api/digital-creator-profiles/me
// @access  Private
export const updateMyDigitalCreatorProfile = asyncHandler(async (req: Request, res: Response) => {
  const profile = await DigitalCreatorProfile.findOne({ userId: (req.user as IUser)._id });

  if (!profile) {
    res.status(404);
    throw new Error("You don't have a digital creator profile yet");
  }

  const { displayName, bio, country, city, links } = req.body;

  if (displayName) profile.displayName = displayName;
  if (bio !== undefined) profile.bio = bio;
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

  await profile.save();

  res.status(200).json(toPublicDigitalCreatorProfile(profile));
});

// @desc    Replace my avatar (a single public image)
// @route   POST /api/digital-creator-profiles/me/avatar
// @access  Private
export const uploadDigitalCreatorAvatar = asyncHandler(async (req: Request, res: Response) => {
  const profile = await DigitalCreatorProfile.findOne({ userId: (req.user as IUser)._id });

  if (!profile) {
    res.status(404);
    throw new Error("You don't have a digital creator profile yet");
  }

  const { results, errorLogs } = await uploadHandler({ req, visibility: FILE_VISIBILITY.PUBLIC });
  const saved = results[0];

  if (!saved) {
    res.status(400);
    throw new Error(errorLogs[0] || "No valid image provided");
  }

  const oldAvatar = profile.avatar;

  profile.avatar = {
    fileName: saved.fileName,
    storagePath: saved.storagePath,
    mime: saved.mime,
    size: saved.size,
    url: saved.url,
  };
  await profile.save();

  if (oldAvatar) {
    await deleteStoredFile(oldAvatar.storagePath);
  }

  res.status(200).json(toPublicDigitalCreatorProfile(profile));
});

const paginationParams = (req: Request) => {
  const page = Math.max(Number(req.query.page) || 1, 1);
  const limit = Math.min(Number(req.query.limit) || 20, 100);
  return { page, limit, skip: (page - 1) * limit };
};

// @desc    View a creator's page — the URL always resolves, but their
//          products are only listed while currently subscribed, checked
//          live, same reasoning as StoreProfile/ConsultancyProfile. This
//          is the "go into all of this creator's work" step from the
//          brief's YouTube/TikTok-style browsing — reached from a
//          product in the feed, not searched for directly (there's no
//          separate creator-search endpoint; the feed is the primary
//          discovery surface for Digital).
// @route   GET /api/digital-creator-profiles/:idOrSlug
// @access  Public
export const getDigitalCreatorProfile = asyncHandler(async (req: Request, res: Response) => {
  const idOrSlug = req.params.idOrSlug as string;

  const profile = mongoose.Types.ObjectId.isValid(idOrSlug)
    ? await DigitalCreatorProfile.findById(idOrSlug)
    : await DigitalCreatorProfile.findOne({ slug: idOrSlug });

  if (!profile) {
    res.status(404);
    throw new Error("Creator not found");
  }

  const subscription = profile.currentSubscription
    ? await Subscription.findById(profile.currentSubscription)
    : null;

  if (!subscription?.isActive()) {
    res.status(200).json({ available: false, message: "This creator's storefront is not currently available." });
    return;
  }

  const { page, limit, skip } = paginationParams(req);
  const filter = { creatorId: profile._id, isActive: true };

  const [products, total] = await Promise.all([
    DigitalProduct.find(filter).sort({ createdAt: -1 }).skip(skip).limit(limit),
    DigitalProduct.countDocuments(filter),
  ]);

  res.status(200).json({
    ...toPublicDigitalCreatorProfile(profile),
    products: products.map(toPublicDigitalProduct),
    pagination: { total, page, limit, totalPages: Math.ceil(total / limit) },
  });
});
