import mongoose from "mongoose";
import asyncHandler from "express-async-handler";
import { Request, Response } from "express";
import {
  LaborProfile,
  ILaborProfile,
  IPortfolioItem,
  IProfileLink,
  LABOR_SKILL,
  LaborSkill,
  MAX_PORTFOLIO_ITEMS,
  MAX_MEDIA_PER_ITEM,
  MAX_PROFILE_LINKS,
} from "../models/laborProfileModel";
import { IPortfolioMedia } from "../models/portfolioItem";
import { IUser } from "../models/userModel";
import { Subscription } from "../models/subscriptionModel";
import { uploadHandler, deleteStoredFile, FILE_VISIBILITY } from "../helpers/fileStorage";
import { parseMultipartData } from "../helpers/parseMultipartData";

const slugify = (value: string): string =>
  value
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/(^-|-$)/g, "");

const generateUniqueSlug = async (base: string): Promise<string> => {
  const root = slugify(base) || "worker";
  let slug = root;

  while (await LaborProfile.exists({ slug })) {
    slug = `${root}-${Math.random().toString(36).slice(2, 6)}`;
  }

  return slug;
};

const toPublicMedia = (media: IPortfolioMedia) => ({
  fileName: media.fileName,
  mime: media.mime,
  size: media.size,
  url: media.url,
});

const toPublicPortfolioItem = (item: IPortfolioItem) => ({
  _id: item._id,
  title: item.title,
  description: item.description,
  media: item.media.map(toPublicMedia),
  tags: item.tags,
  startedAt: item.startedAt,
  completedAt: item.completedAt,
});

export const toPublicLaborProfile = (profile: ILaborProfile) => ({
  id: profile.id,
  userId: profile.userId,
  isVerified: profile.isVerified,
  slug: profile.slug,
  headline: profile.headline,
  bio: profile.bio,
  skills: profile.skills,
  country: profile.country,
  city: profile.city,
  yearsOfExperience: profile.yearsOfExperience,
  links: profile.links,
  portfolio: profile.portfolio.map(toPublicPortfolioItem),
  ratingAverage: profile.ratingAverage,
  ratingCount: profile.ratingCount,
  createdAt: profile.createdAt,
});

const filterValidLinks = (input: unknown): IProfileLink[] => {
  if (!Array.isArray(input)) return [];

  return input
    .filter(
      (link): link is Record<string, unknown> =>
        !!link && typeof link === "object" && !Array.isArray(link),
    )
    .filter(
      (link) =>
        typeof link.label === "string" &&
        link.label.trim().length > 0 &&
        typeof link.url === "string" &&
        /^https?:\/\//i.test(link.url),
    )
    .map((link) => ({ label: (link.label as string).trim(), url: (link.url as string).trim() }));
};

// Shared with jobOpeningController — a worker is eligible to apply (or be
// found via Direct Hire's full detail) only while verified AND currently
// subscribed, checked live. This is the actual safety mechanism behind
// SiteForce's job board, not a nice-to-have — see laborProfileModel.ts.
export const loadEligibleLaborProfile = async (
  userId: mongoose.Types.ObjectId | string,
): Promise<ILaborProfile | null> => {
  const profile = await LaborProfile.findOne({ userId });
  if (!profile?.isVerified) return null;

  const subscription = profile.currentSubscription
    ? await Subscription.findById(profile.currentSubscription)
    : null;

  return subscription?.isActive() ? profile : null;
};

// @desc    Create my PolyGrid SiteForce worker profile
// @route   POST /api/labor-profiles
// @access  Private — one per user
export const createLaborProfile = asyncHandler(async (req: Request, res: Response) => {
  const requester = req.user as IUser;

  const existing = await LaborProfile.findOne({ userId: requester._id });
  if (existing) {
    res.status(400);
    throw new Error("You already have a labor profile");
  }

  const { headline, bio, skills, country, city, yearsOfExperience, links } = req.body;

  if (!headline || !country) {
    res.status(400);
    throw new Error("Please add a headline and country");
  }

  const resolvedSkills = Array.isArray(skills)
    ? skills.filter((s): s is LaborSkill => Object.values(LABOR_SKILL).includes(s))
    : [];

  const resolvedLinks = filterValidLinks(links);
  if (resolvedLinks.length > MAX_PROFILE_LINKS) {
    res.status(400);
    throw new Error(`You can have at most ${MAX_PROFILE_LINKS} links`);
  }

  const profile = await LaborProfile.create({
    userId: requester._id,
    currentSubscription: requester.currentSubscription,
    slug: await generateUniqueSlug(requester.fullName),
    headline,
    bio,
    skills: resolvedSkills,
    country,
    city,
    yearsOfExperience,
    links: resolvedLinks,
  });

  res.status(201).json(toPublicLaborProfile(profile));
});

// @desc    Get my own profile (full detail regardless of verified/subscribed)
// @route   GET /api/labor-profiles/me
// @access  Private
export const getMyLaborProfile = asyncHandler(async (req: Request, res: Response) => {
  const profile = await LaborProfile.findOne({ userId: (req.user as IUser)._id });

  if (!profile) {
    res.status(404);
    throw new Error("You don't have a labor profile yet");
  }

  res.status(200).json(toPublicLaborProfile(profile));
});

// @desc    Update my profile
// @route   PATCH /api/labor-profiles/me
// @access  Private
export const updateMyLaborProfile = asyncHandler(async (req: Request, res: Response) => {
  const profile = await LaborProfile.findOne({ userId: (req.user as IUser)._id });

  if (!profile) {
    res.status(404);
    throw new Error("You don't have a labor profile yet");
  }

  const { headline, bio, skills, country, city, yearsOfExperience, links } = req.body;

  if (headline) profile.headline = headline;
  if (bio !== undefined) profile.bio = bio;
  if (country) profile.country = country;
  if (city !== undefined) profile.city = city;
  if (yearsOfExperience !== undefined) profile.yearsOfExperience = yearsOfExperience;

  if (Array.isArray(skills)) {
    profile.skills = skills.filter((s): s is LaborSkill => Object.values(LABOR_SKILL).includes(s));
  }

  if (links !== undefined) {
    const resolvedLinks = filterValidLinks(links);
    if (resolvedLinks.length > MAX_PROFILE_LINKS) {
      res.status(400);
      throw new Error(`You can have at most ${MAX_PROFILE_LINKS} links`);
    }
    profile.links = resolvedLinks;
  }

  await profile.save();

  res.status(200).json(toPublicLaborProfile(profile));
});

// @desc    Search/list workers — only those verified AND currently
//          subscribed show up here. Same rule as searchContractors.
// @route   GET /api/labor-profiles
// @access  Public
export const searchWorkers = asyncHandler(async (req: Request, res: Response) => {
  const page = Math.max(Number(req.query.page) || 1, 1);
  const limit = Math.min(Number(req.query.limit) || 20, 100);
  const skip = (page - 1) * limit;

  const { skill, country } = req.query as { skill?: string; country?: string };

  const match: Record<string, unknown> = { isVerified: true, currentSubscription: { $ne: null } };

  if (skill && Object.values(LABOR_SKILL).includes(skill as LaborSkill)) {
    match.skills = skill;
  }

  if (country) {
    match.country = String(country).toUpperCase();
  }

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
    {
      $match: {
        "subscription.status": "active",
        "subscription.expiresAt": { $gt: new Date() },
      },
    },
    { $sort: { createdAt: -1 as const } },
  ];

  const [data, totalResult] = await Promise.all([
    LaborProfile.aggregate([...pipeline, { $skip: skip }, { $limit: limit }]),
    LaborProfile.aggregate([...pipeline, { $count: "total" }]),
  ]);

  const total = totalResult[0]?.total ?? 0;

  res.status(200).json({
    data: data.map((doc) => toPublicLaborProfile(doc as ILaborProfile)),
    pagination: { total, page, limit, totalPages: Math.ceil(total / limit) },
  });
});

// @desc    View a single worker's profile — the URL always resolves, but
//          content is only served while they're currently subscribed,
//          checked live. Same reasoning as getContractor.
// @route   GET /api/labor-profiles/:idOrSlug
// @access  Public
export const getWorker = asyncHandler(async (req: Request, res: Response) => {
  const idOrSlug = req.params.idOrSlug as string;

  const profile = mongoose.Types.ObjectId.isValid(idOrSlug)
    ? await LaborProfile.findById(idOrSlug)
    : await LaborProfile.findOne({ slug: idOrSlug });

  if (!profile) {
    res.status(404);
    throw new Error("Profile not found");
  }

  const subscription = profile.currentSubscription
    ? await Subscription.findById(profile.currentSubscription)
    : null;

  if (!subscription?.isActive()) {
    res.status(200).json({ available: false, message: "This profile is not currently available." });
    return;
  }

  res.status(200).json(toPublicLaborProfile(profile));
});

interface PortfolioItemPayload {
  title?: string;
  description?: string;
  tags?: string[];
  startedAt?: string;
  completedAt?: string;
}

const saveMediaFiles = async (
  req: Request,
): Promise<{ media: IPortfolioMedia[]; warnings: string[] }> => {
  const { results, errorLogs } = await uploadHandler({ req, visibility: FILE_VISIBILITY.PUBLIC });

  return {
    media: results.map((r) => ({
      fileName: r.fileName,
      storagePath: r.storagePath,
      mime: r.mime,
      size: r.size,
      url: r.url,
    })),
    warnings: errorLogs,
  };
};

// @desc    Add a new portfolio item (with its initial media, if any)
// @route   POST /api/labor-profiles/me/portfolio
// @access  Private
export const addPortfolioItem = asyncHandler(async (req: Request, res: Response) => {
  const profile = await LaborProfile.findOne({ userId: (req.user as IUser)._id });

  if (!profile) {
    res.status(404);
    throw new Error("You don't have a labor profile yet");
  }

  if (profile.portfolio.length >= MAX_PORTFOLIO_ITEMS) {
    res.status(400);
    throw new Error(`You can have at most ${MAX_PORTFOLIO_ITEMS} portfolio items`);
  }

  const { title, description, tags, startedAt, completedAt } =
    parseMultipartData<PortfolioItemPayload>(req);

  if (!title) {
    res.status(400);
    throw new Error("Please add a title");
  }

  const attachedCount = (req.files as Express.Multer.File[] | undefined)?.length ?? 0;
  if (attachedCount > MAX_MEDIA_PER_ITEM) {
    res.status(400);
    throw new Error(`You can attach at most ${MAX_MEDIA_PER_ITEM} images to a single portfolio item`);
  }

  if (startedAt && completedAt && new Date(startedAt) > new Date(completedAt)) {
    res.status(400);
    throw new Error("completedAt must be on or after startedAt");
  }

  const { media, warnings: mediaWarnings } = await saveMediaFiles(req);

  profile.portfolio.push({
    title,
    description,
    media,
    tags: Array.isArray(tags) ? tags : [],
    startedAt: startedAt ? new Date(startedAt) : undefined,
    completedAt: completedAt ? new Date(completedAt) : undefined,
  });

  await profile.save();

  res.status(201).json({
    ...toPublicLaborProfile(profile),
    ...(mediaWarnings.length > 0 ? { mediaWarnings } : {}),
  });
});

// @desc    Add more media to an existing portfolio item
// @route   POST /api/labor-profiles/me/portfolio/:itemId/media
// @access  Private
export const addPortfolioMedia = asyncHandler(async (req: Request, res: Response) => {
  const profile = await LaborProfile.findOne({ userId: (req.user as IUser)._id });

  if (!profile) {
    res.status(404);
    throw new Error("You don't have a labor profile yet");
  }

  const item = profile.portfolio.id(req.params.itemId as string);

  if (!item) {
    res.status(404);
    throw new Error("Portfolio item not found");
  }

  const attachedCount = (req.files as Express.Multer.File[] | undefined)?.length ?? 0;
  if (attachedCount === 0) {
    res.status(400);
    throw new Error("Attach at least one image");
  }

  if (item.media.length + attachedCount > MAX_MEDIA_PER_ITEM) {
    res.status(400);
    throw new Error(
      `This item already has ${item.media.length} of ${MAX_MEDIA_PER_ITEM} images allowed — attach fewer`,
    );
  }

  const { media, warnings: mediaWarnings } = await saveMediaFiles(req);
  item.media.push(...media);
  await profile.save();

  res.status(201).json({
    ...toPublicLaborProfile(profile),
    ...(mediaWarnings.length > 0 ? { mediaWarnings } : {}),
  });
});

// @desc    Remove one media file from a portfolio item
// @route   DELETE /api/labor-profiles/me/portfolio/:itemId/media/:fileName
// @access  Private
export const removePortfolioMedia = asyncHandler(async (req: Request, res: Response) => {
  const profile = await LaborProfile.findOne({ userId: (req.user as IUser)._id });

  if (!profile) {
    res.status(404);
    throw new Error("You don't have a labor profile yet");
  }

  const item = profile.portfolio.id(req.params.itemId as string);

  if (!item) {
    res.status(404);
    throw new Error("Portfolio item not found");
  }

  const fileName = req.params.fileName as string;
  const media = item.media.find((m) => m.fileName === fileName);

  if (!media) {
    res.status(404);
    throw new Error("Media not found on this item");
  }

  await deleteStoredFile(media.storagePath);
  item.media = item.media.filter((m) => m.fileName !== fileName) as typeof item.media;
  await profile.save();

  res.status(200).json(toPublicLaborProfile(profile));
});

// @desc    Remove a portfolio item and every media file it owns
// @route   DELETE /api/labor-profiles/me/portfolio/:itemId
// @access  Private
export const removePortfolioItem = asyncHandler(async (req: Request, res: Response) => {
  const profile = await LaborProfile.findOne({ userId: (req.user as IUser)._id });

  if (!profile) {
    res.status(404);
    throw new Error("You don't have a labor profile yet");
  }

  const item = profile.portfolio.id(req.params.itemId as string);

  if (!item) {
    res.status(404);
    throw new Error("Portfolio item not found");
  }

  await Promise.all(item.media.map((media) => deleteStoredFile(media.storagePath)));

  item.deleteOne();
  await profile.save();

  res.status(200).json(toPublicLaborProfile(profile));
});
