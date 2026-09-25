import mongoose from "mongoose";
import asyncHandler from "express-async-handler";
import { Request, Response } from "express";
import {
  ConsultancyProfile,
  IConsultancyProfile,
  IPortfolioItem,
  IPortfolioMedia,
  IProfileLink,
  SPECIALIZATION,
  Specialization,
  MAX_PORTFOLIO_ITEMS,
  MAX_MEDIA_PER_ITEM,
  MAX_PROFILE_LINKS,
} from "../models/consultancyProfileModel";
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

// Appends a short random suffix on collision rather than failing the
// request outright — two "John Smith"s are a certainty at any real scale.
const generateUniqueSlug = async (base: string): Promise<string> => {
  const root = slugify(base) || "consultant";
  let slug = root;

  while (await ConsultancyProfile.exists({ slug })) {
    slug = `${root}-${Math.random().toString(36).slice(2, 6)}`;
  }

  return slug;
};

// storagePath is a server filesystem detail (needed internally to delete a
// file later — see deleteStoredFile calls below) with no business leaving
// the server, same reasoning toPublicUser already applies to User.avatar.
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

const toPublicProfile = (profile: IConsultancyProfile) => ({
  id: profile.id,
  userId: profile.userId,
  isVerified: profile.isVerified,
  slug: profile.slug,
  headline: profile.headline,
  bio: profile.bio,
  specializations: profile.specializations,
  country: profile.country,
  city: profile.city,
  yearsOfExperience: profile.yearsOfExperience,
  links: profile.links,
  portfolio: profile.portfolio.map(toPublicPortfolioItem),
  services: profile.services,
  mentorship: profile.mentorship,
  createdAt: profile.createdAt,
});

// External links only — see IProfileLink's own comment in the model for
// why raw contact details are deliberately never a field here at all.
// Malformed entries (missing label, or a url that doesn't look like one)
// are silently dropped rather than failing the whole request, same
// "filter, don't hard-reject" instinct already used for `specializations`
// in this same controller.
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

// @desc    Create my PolyGrid Engineering profile
// @route   POST /api/consultancy-profiles
// @access  Private — one per user
export const createProfile = asyncHandler(async (req: Request, res: Response) => {
  const requester = req.user as IUser;

  const existing = await ConsultancyProfile.findOne({ userId: requester._id });
  if (existing) {
    res.status(400);
    throw new Error("You already have a consultancy profile");
  }

  const { headline, bio, specializations, country, city, yearsOfExperience, links } = req.body;

  if (!headline || !country) {
    res.status(400);
    throw new Error("Please add a headline and country");
  }

  const resolvedSpecializations = Array.isArray(specializations)
    ? specializations.filter((s): s is Specialization =>
        Object.values(SPECIALIZATION).includes(s),
      )
    : [];

  const resolvedLinks = filterValidLinks(links);
  if (resolvedLinks.length > MAX_PROFILE_LINKS) {
    res.status(400);
    throw new Error(`You can have at most ${MAX_PROFILE_LINKS} links`);
  }

  const profile = await ConsultancyProfile.create({
    userId: requester._id,
    currentSubscription: requester.currentSubscription,
    slug: await generateUniqueSlug(requester.fullName),
    headline,
    bio,
    specializations: resolvedSpecializations,
    country,
    city,
    yearsOfExperience,
    links: resolvedLinks,
  });

  res.status(201).json(toPublicProfile(profile));
});

// @desc    Get my own profile (full detail regardless of verified/subscribed)
// @route   GET /api/consultancy-profiles/me
// @access  Private
export const getMyProfile = asyncHandler(async (req: Request, res: Response) => {
  const profile = await ConsultancyProfile.findOne({ userId: (req.user as IUser)._id });

  if (!profile) {
    res.status(404);
    throw new Error("You don't have a consultancy profile yet");
  }

  res.status(200).json(toPublicProfile(profile));
});

// @desc    Update my profile
// @route   PATCH /api/consultancy-profiles/me
// @access  Private
export const updateMyProfile = asyncHandler(async (req: Request, res: Response) => {
  const profile = await ConsultancyProfile.findOne({ userId: (req.user as IUser)._id });

  if (!profile) {
    res.status(404);
    throw new Error("You don't have a consultancy profile yet");
  }

  const {
    headline,
    bio,
    specializations,
    country,
    city,
    yearsOfExperience,
    links,
    services,
    mentorship,
  } = req.body;

  if (headline) profile.headline = headline;
  if (bio !== undefined) profile.bio = bio;
  if (country) profile.country = country;
  if (city !== undefined) profile.city = city;
  if (yearsOfExperience !== undefined) profile.yearsOfExperience = yearsOfExperience;

  if (Array.isArray(specializations)) {
    profile.specializations = specializations.filter((s): s is Specialization =>
      Object.values(SPECIALIZATION).includes(s),
    );
  }

  if (links !== undefined) {
    const resolvedLinks = filterValidLinks(links);
    if (resolvedLinks.length > MAX_PROFILE_LINKS) {
      res.status(400);
      throw new Error(`You can have at most ${MAX_PROFILE_LINKS} links`);
    }
    profile.links = resolvedLinks;
  }

  if (Array.isArray(services)) {
    profile.services = services as unknown as typeof profile.services;
  }

  if (mentorship && typeof mentorship === "object") {
    profile.mentorship = { ...profile.mentorship, ...mentorship };
  }

  await profile.save();

  res.status(200).json(toPublicProfile(profile));
});

// @desc    Search/list consultants — only those verified AND currently
//          subscribed show up here (product-overview.md's global
//          subscription rule), even though a profile page itself is always
//          directly reachable by id/slug once created.
// @route   GET /api/consultancy-profiles
// @access  Public
export const searchConsultants = asyncHandler(async (req: Request, res: Response) => {
  const page = Math.max(Number(req.query.page) || 1, 1);
  const limit = Math.min(Number(req.query.limit) || 20, 100);
  const skip = (page - 1) * limit;

  const { specialization, country } = req.query as { specialization?: string; country?: string };

  const match: Record<string, unknown> = { isVerified: true, currentSubscription: { $ne: null } };

  if (specialization && Object.values(SPECIALIZATION).includes(specialization as Specialization)) {
    match.specializations = specialization;
  }

  if (country) {
    match.country = String(country).toUpperCase();
  }

  // A single $lookup against Subscription directly (currentSubscription is
  // denormalized onto the profile for exactly this) rather than a two-hop
  // join through User — subscription active-ness is time-based
  // (expiresAt), so it's checked fresh here, never from a stored boolean
  // that could go stale as time passes with no write to trigger it.
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
    ConsultancyProfile.aggregate([...pipeline, { $skip: skip }, { $limit: limit }]),
    ConsultancyProfile.aggregate([...pipeline, { $count: "total" }]),
  ]);

  const total = totalResult[0]?.total ?? 0;

  res.status(200).json({
    data: data.map((doc) => toPublicProfile(doc as IConsultancyProfile)),
    pagination: { total, page, limit, totalPages: Math.ceil(total / limit) },
  });
});

// @desc    View a single consultant's profile (their "mini-site") — the URL
//          itself always resolves (a 404 would make an old bookmarked/
//          shared link look like the consultant never existed), but the
//          actual profile content is only served while they're currently
//          subscribed — checked live against Subscription, same as
//          searchConsultants, never from the denormalized boolean, so this
//          flips the instant a subscription lapses with no write needed.
//          Otherwise it's the same gap searchConsultants already closes:
//          a direct link would let an unsubscribed consultant stay fully
//          visible to anyone who already has the URL, with no incentive
//          left to resubscribe. `getMyProfile` (GET /me) is unaffected —
//          an owner always sees their own full profile regardless.
// @route   GET /api/consultancy-profiles/:idOrSlug
// @access  Public
export const getProfile = asyncHandler(async (req: Request, res: Response) => {
  const idOrSlug = req.params.idOrSlug as string;

  const profile = mongoose.Types.ObjectId.isValid(idOrSlug)
    ? await ConsultancyProfile.findById(idOrSlug)
    : await ConsultancyProfile.findOne({ slug: idOrSlug });

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

  res.status(200).json(toPublicProfile(profile));
});

interface PortfolioItemPayload {
  title?: string;
  description?: string;
  tags?: string[];
  startedAt?: string;
  completedAt?: string;
}

// Portfolio images are public — the whole point is a shareable mini-site —
// so an individual bad file is never fatal to the request, same as avatar
// uploads elsewhere: whatever's savable gets saved, and errorLogs come back
// as a non-blocking `mediaWarnings` field instead of being silently
// dropped, so the caller actually knows if some of what they attached
// didn't make it in.
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
// @route   POST /api/consultancy-profiles/me/portfolio
// @access  Private
export const addPortfolioItem = asyncHandler(async (req: Request, res: Response) => {
  const profile = await ConsultancyProfile.findOne({ userId: (req.user as IUser)._id });

  if (!profile) {
    res.status(404);
    throw new Error("You don't have a consultancy profile yet");
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

  // Checked here, not just left to the schema's own `completedAt`
  // validator — that one only runs at `profile.save()`, by which point a
  // rejection would surface as an uncaught Mongoose ValidationError (a
  // 500) rather than a clean 400, and any files already saved above would
  // need rolling back. Caught early instead, before anything touches disk.
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
    ...toPublicProfile(profile),
    ...(mediaWarnings.length > 0 ? { mediaWarnings } : {}),
  });
});

// @desc    Add more media to an existing portfolio item
// @route   POST /api/consultancy-profiles/me/portfolio/:itemId/media
// @access  Private
export const addPortfolioMedia = asyncHandler(async (req: Request, res: Response) => {
  const profile = await ConsultancyProfile.findOne({ userId: (req.user as IUser)._id });

  if (!profile) {
    res.status(404);
    throw new Error("You don't have a consultancy profile yet");
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
    ...toPublicProfile(profile),
    ...(mediaWarnings.length > 0 ? { mediaWarnings } : {}),
  });
});

// @desc    Remove one media file from a portfolio item (keeps the item
//          itself, unlike removePortfolioItem below)
// @route   DELETE /api/consultancy-profiles/me/portfolio/:itemId/media/:fileName
// @access  Private
export const removePortfolioMedia = asyncHandler(async (req: Request, res: Response) => {
  const profile = await ConsultancyProfile.findOne({ userId: (req.user as IUser)._id });

  if (!profile) {
    res.status(404);
    throw new Error("You don't have a consultancy profile yet");
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

  res.status(200).json(toPublicProfile(profile));
});

// @desc    Remove a portfolio item and every media file it owns
// @route   DELETE /api/consultancy-profiles/me/portfolio/:itemId
// @access  Private
export const removePortfolioItem = asyncHandler(async (req: Request, res: Response) => {
  const profile = await ConsultancyProfile.findOne({ userId: (req.user as IUser)._id });

  if (!profile) {
    res.status(404);
    throw new Error("You don't have a consultancy profile yet");
  }

  const item = profile.portfolio.id(req.params.itemId as string);

  if (!item) {
    res.status(404);
    throw new Error("Portfolio item not found");
  }

  // Without this, deleting the item would leave every one of its images
  // orphaned on disk forever — nothing else ever cleans up a public file.
  await Promise.all(item.media.map((media) => deleteStoredFile(media.storagePath)));

  item.deleteOne();
  await profile.save();

  res.status(200).json(toPublicProfile(profile));
});
