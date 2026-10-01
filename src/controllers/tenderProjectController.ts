import mongoose from "mongoose";
import asyncHandler from "express-async-handler";
import { Request, Response } from "express";
import {
  TenderProject,
  ITenderProject,
  TENDER_CATEGORY,
  TenderCategory,
  TENDER_PROJECT_STATUS,
  MAX_PROJECT_FILES,
} from "../models/tenderProjectModel";
import { Bid, IBid, BID_STATUS, MAX_BID_FILES } from "../models/bidModel";
import { ContractorProfile, IContractorProfile } from "../models/contractorProfileModel";
import { Subscription } from "../models/subscriptionModel";
import { Job, JOB_TYPE } from "../models/jobModel";
import { getPlatformFeePercent } from "./jobController";
import { IUser, SYSTEM_ROLE } from "../models/userModel";
import { IMediaFile } from "../models/mediaFile";
import { uploadHandler, FILE_VISIBILITY } from "../helpers/fileStorage";
import { signFileUrl, FILE_URL_MODE } from "../helpers/fileSigning";
import { parseMultipartData } from "../helpers/parseMultipartData";
import { connectUsers } from "./contactController";

export const toPublicTenderProject = (project: ITenderProject) => ({
  id: project.id,
  postedBy: project.postedBy,
  title: project.title,
  description: project.description,
  category: project.category,
  budgetMin: project.budgetMin,
  budgetMax: project.budgetMax,
  currency: project.currency,
  location: project.location,
  bidDeadline: project.bidDeadline,
  status: project.status,
  bidCount: project.bidCount,
  awardedBid: project.awardedBid,
  job: project.job,
  createdAt: project.createdAt,
});

const toPublicBid = (bid: IBid) => ({
  id: bid.id,
  project: bid.project,
  contractorId: bid.contractorId,
  bidder: bid.bidder,
  amount: bid.amount,
  currency: bid.currency,
  proposal: bid.proposal,
  estimatedDurationDays: bid.estimatedDurationDays,
  status: bid.status,
  createdAt: bid.createdAt,
});

// A contractor is eligible to bid (or see a project's full detail) only
// while verified AND currently subscribed, checked live — same rule as
// every other pillar's "reachable" gate, never read from a stored flag.
const loadEligibleContractorProfile = async (
  userId: mongoose.Types.ObjectId | string,
): Promise<IContractorProfile | null> => {
  const profile = await ContractorProfile.findOne({ userId });
  if (!profile?.isVerified) return null;

  const subscription = profile.currentSubscription
    ? await Subscription.findById(profile.currentSubscription)
    : null;

  return subscription?.isActive() ? profile : null;
};

interface ProjectPayload {
  title?: string;
  description?: string;
  category?: string;
  budgetMin?: number;
  budgetMax?: number;
  currency?: string;
  location?: { country?: string; state?: string };
  bidDeadline?: string;
}

// @desc    Post a new project to the bidding board. Requires any active
//          PolyGrid subscription — there's no dedicated "poster" business
//          profile, just a subscribed account (see
//          authMiddleware.requireActiveSubscription, getting its first
//          real route here).
// @route   POST /api/tender-projects
// @access  Private — requires an active subscription
export const createTenderProject = asyncHandler(async (req: Request, res: Response) => {
  const requester = req.user as IUser;

  const { title, description, category, budgetMin, budgetMax, currency, location, bidDeadline } =
    parseMultipartData<ProjectPayload>(req);

  if (!title || !description || !location?.country) {
    res.status(400);
    throw new Error("Please add a title, description, and location.country");
  }

  if (!category || !Object.values(TENDER_CATEGORY).includes(category as TenderCategory)) {
    res.status(400);
    throw new Error("Please add a valid category");
  }

  if (!bidDeadline || new Date(bidDeadline) <= new Date()) {
    res.status(400);
    throw new Error("bidDeadline must be a date in the future");
  }

  const attachedCount = (req.files as Express.Multer.File[] | undefined)?.length ?? 0;
  if (attachedCount > MAX_PROJECT_FILES) {
    res.status(400);
    throw new Error(`You can attach at most ${MAX_PROJECT_FILES} files to a project`);
  }

  const { results, errorLogs } = await uploadHandler({
    req,
    visibility: FILE_VISIBILITY.PRIVATE,
    ownerId: requester.id,
  });

  const files: IMediaFile[] = results.map((r) => ({
    fileName: r.fileName,
    storagePath: r.storagePath,
    mime: r.mime,
    size: r.size,
  }));

  const project = await TenderProject.create({
    postedBy: requester._id,
    title,
    description,
    category,
    budgetMin,
    budgetMax,
    currency: currency || "USD",
    location,
    bidDeadline,
    files,
  });

  res.status(201).json({
    ...toPublicTenderProject(project),
    ...(errorLogs.length > 0 ? { fileWarnings: errorLogs } : {}),
  });
});

const loadMyProject = async (requesterId: string, projectId: string) => {
  if (!mongoose.Types.ObjectId.isValid(projectId)) return null;

  return TenderProject.findOne({ _id: projectId, postedBy: requesterId });
};

// @desc    Update my project — only while still open for bidding
// @route   PATCH /api/tender-projects/:id
// @access  Private (poster only)
export const updateMyTenderProject = asyncHandler(async (req: Request, res: Response) => {
  const requester = req.user as IUser;
  const project = await loadMyProject(requester.id, req.params.id as string);

  if (!project) {
    res.status(404);
    throw new Error("Project not found");
  }

  if (project.status !== TENDER_PROJECT_STATUS.OPEN) {
    res.status(400);
    throw new Error("This project can no longer be edited");
  }

  const { title, description, category, budgetMin, budgetMax, currency, location, bidDeadline } = req.body;

  if (title) project.title = title;
  if (description) project.description = description;
  if (category !== undefined) {
    if (!Object.values(TENDER_CATEGORY).includes(category)) {
      res.status(400);
      throw new Error("Please add a valid category");
    }
    project.category = category;
  }
  if (budgetMin !== undefined) project.budgetMin = budgetMin;
  if (budgetMax !== undefined) project.budgetMax = budgetMax;
  if (currency) project.currency = currency;
  if (location !== undefined) project.location = location;
  if (bidDeadline !== undefined) {
    if (new Date(bidDeadline) <= new Date()) {
      res.status(400);
      throw new Error("bidDeadline must be a date in the future");
    }
    project.bidDeadline = new Date(bidDeadline);
  }

  await project.save();

  res.status(200).json(toPublicTenderProject(project));
});

// @desc    Cancel my project while still open — every pending bid on it
//          is rejected too.
// @route   PATCH /api/tender-projects/:id/cancel
// @access  Private (poster only)
export const cancelMyTenderProject = asyncHandler(async (req: Request, res: Response) => {
  const requester = req.user as IUser;
  const project = await loadMyProject(requester.id, req.params.id as string);

  if (!project) {
    res.status(404);
    throw new Error("Project not found");
  }

  if (project.status !== TENDER_PROJECT_STATUS.OPEN) {
    res.status(400);
    throw new Error("Only an open project can be cancelled");
  }

  project.status = TENDER_PROJECT_STATUS.CANCELLED;
  await project.save();
  await Bid.updateMany(
    { project: project._id, status: BID_STATUS.PENDING },
    { status: BID_STATUS.REJECTED },
  );

  res.status(200).json(toPublicTenderProject(project));
});

// @desc    My own posted projects, any status
// @route   GET /api/tender-projects/me
// @access  Private
export const getMyTenderProjects = asyncHandler(async (req: Request, res: Response) => {
  const requester = req.user as IUser;
  const page = Math.max(Number(req.query.page) || 1, 1);
  const limit = Math.min(Number(req.query.limit) || 20, 100);
  const skip = (page - 1) * limit;

  const filter = { postedBy: requester._id };

  const [projects, total] = await Promise.all([
    TenderProject.find(filter).sort({ createdAt: -1 }).skip(skip).limit(limit),
    TenderProject.countDocuments(filter),
  ]);

  res.status(200).json({
    data: projects.map(toPublicTenderProject),
    pagination: { total, page, limit, totalPages: Math.ceil(total / limit) },
  });
});

// @desc    Browse the bidding board — only reachable by an eligible
//          (verified + subscribed) contractor, since there's no public
//          teaser here the way Digital/Physical products get one: a
//          project's detail is the whole point of browsing, not a
//          marketing preview.
// @route   GET /api/tender-projects?category=&country=
// @access  Private (eligible contractor only)
export const listTenderProjects = asyncHandler(async (req: Request, res: Response) => {
  const requester = req.user as IUser;
  const eligible = await loadEligibleContractorProfile(requester._id);

  if (!eligible) {
    res.status(403);
    throw new Error("Only a verified, currently-subscribed contractor profile can browse the bidding board");
  }

  const page = Math.max(Number(req.query.page) || 1, 1);
  const limit = Math.min(Number(req.query.limit) || 20, 100);
  const skip = (page - 1) * limit;

  const { category, country } = req.query as { category?: string; country?: string };

  const filter: Record<string, unknown> = {
    status: TENDER_PROJECT_STATUS.OPEN,
    bidDeadline: { $gt: new Date() },
  };

  if (category && Object.values(TENDER_CATEGORY).includes(category as TenderCategory)) {
    filter.category = category;
  }
  if (country) {
    filter["location.country"] = String(country).toUpperCase();
  }

  const [projects, total] = await Promise.all([
    TenderProject.find(filter).sort({ createdAt: -1 }).skip(skip).limit(limit),
    TenderProject.countDocuments(filter),
  ]);

  res.status(200).json({
    data: projects.map(toPublicTenderProject),
    pagination: { total, page, limit, totalPages: Math.ceil(total / limit) },
  });
});

// @desc    View a single project's full detail, including signed links for
//          its attached files — gated to the poster, an eligible
//          contractor, or an admin. Everyone else gets the same
//          `{available: false}` shape the rest of this codebase uses for
//          "exists but withheld," not a 403/404 that would reveal whether
//          the id is even real.
// @route   GET /api/tender-projects/:id
// @access  Private
export const getTenderProject = asyncHandler(async (req: Request, res: Response) => {
  const requester = req.user as IUser;
  const id = req.params.id as string;

  if (!mongoose.Types.ObjectId.isValid(id)) {
    res.status(404);
    throw new Error("Project not found");
  }

  const project = await TenderProject.findById(id);
  if (!project) {
    res.status(404);
    throw new Error("Project not found");
  }

  const isPoster = project.postedBy.toString() === requester.id;
  const isAdmin =
    requester.systemRole === SYSTEM_ROLE.ADMIN || requester.systemRole === SYSTEM_ROLE.SUPER_ADMIN;
  const eligible = isPoster || isAdmin ? null : await loadEligibleContractorProfile(requester._id);

  if (!isPoster && !isAdmin && !eligible) {
    res.status(200).json({ available: false, message: "This project is not currently available." });
    return;
  }

  const files = project.files.map((file) => ({
    fileName: file.fileName,
    mime: file.mime,
    size: file.size,
    url: signFileUrl({ ownerId: project.postedBy.toString(), fileName: file.fileName, mode: FILE_URL_MODE.VIEW }),
  }));

  res.status(200).json({ ...toPublicTenderProject(project), files });
});

interface BidPayload {
  amount?: number;
  currency?: string;
  proposal?: string;
  estimatedDurationDays?: number;
}

// @desc    Submit a bid on an open project — sealed from every other
//          contractor; only the poster ever sees the full list.
// @route   POST /api/tender-projects/:id/bids
// @access  Private (eligible contractor only)
export const submitBid = asyncHandler(async (req: Request, res: Response) => {
  const requester = req.user as IUser;
  const id = req.params.id as string;

  if (!mongoose.Types.ObjectId.isValid(id)) {
    res.status(404);
    throw new Error("Project not found");
  }

  const project = await TenderProject.findById(id);
  if (!project) {
    res.status(404);
    throw new Error("Project not found");
  }

  const contractor = await loadEligibleContractorProfile(requester._id);
  if (!contractor) {
    res.status(403);
    throw new Error("Only a verified, currently-subscribed contractor profile can bid");
  }

  if (project.postedBy.toString() === requester.id) {
    res.status(400);
    throw new Error("You can't bid on your own project");
  }

  if (project.status !== TENDER_PROJECT_STATUS.OPEN || project.bidDeadline <= new Date()) {
    res.status(400);
    throw new Error("This project is no longer accepting bids");
  }

  const existing = await Bid.findOne({ project: project._id, contractorId: contractor._id });
  if (existing) {
    res.status(400);
    throw new Error("You already have a bid on this project — update it instead");
  }

  const { amount, currency, proposal, estimatedDurationDays } = parseMultipartData<BidPayload>(req);

  if (!amount || amount <= 0) {
    res.status(400);
    throw new Error("A positive amount is required");
  }

  if (!proposal) {
    res.status(400);
    throw new Error("Please add a proposal");
  }

  const attachedCount = (req.files as Express.Multer.File[] | undefined)?.length ?? 0;
  if (attachedCount > MAX_BID_FILES) {
    res.status(400);
    throw new Error(`You can attach at most ${MAX_BID_FILES} files to a bid`);
  }

  const { results, errorLogs } = await uploadHandler({
    req,
    visibility: FILE_VISIBILITY.PRIVATE,
    ownerId: requester.id,
  });

  const files: IMediaFile[] = results.map((r) => ({
    fileName: r.fileName,
    storagePath: r.storagePath,
    mime: r.mime,
    size: r.size,
  }));

  const bid = await Bid.create({
    project: project._id,
    contractorId: contractor._id,
    bidder: requester._id,
    amount,
    currency: currency || "USD",
    proposal,
    estimatedDurationDays,
    files,
  });

  project.bidCount += 1;
  await project.save();

  res.status(201).json({ ...toPublicBid(bid), ...(errorLogs.length > 0 ? { fileWarnings: errorLogs } : {}) });
});

const loadMyPendingBid = async (projectId: string, contractorProfileId: mongoose.Types.ObjectId) => {
  if (!mongoose.Types.ObjectId.isValid(projectId)) return null;

  return Bid.findOne({ project: projectId, contractorId: contractorProfileId });
};

// @desc    Revise my own bid — only while still pending and before the
//          project's deadline.
// @route   PATCH /api/tender-projects/:id/bids/mine
// @access  Private (the bid's own contractor only)
export const updateMyBid = asyncHandler(async (req: Request, res: Response) => {
  const requester = req.user as IUser;
  const contractor = await loadEligibleContractorProfile(requester._id);

  if (!contractor) {
    res.status(403);
    throw new Error("Only a verified, currently-subscribed contractor profile can bid");
  }

  const bid = await loadMyPendingBid(req.params.id as string, contractor._id as mongoose.Types.ObjectId);
  if (!bid) {
    res.status(404);
    throw new Error("Bid not found");
  }

  if (bid.status !== BID_STATUS.PENDING) {
    res.status(400);
    throw new Error(`This bid has already been ${bid.status}`);
  }

  const project = await TenderProject.findById(bid.project);
  if (!project || project.status !== TENDER_PROJECT_STATUS.OPEN || project.bidDeadline <= new Date()) {
    res.status(400);
    throw new Error("This project is no longer accepting bid changes");
  }

  const { amount, currency, proposal, estimatedDurationDays } = req.body;

  if (amount !== undefined) {
    if (!amount || amount <= 0) {
      res.status(400);
      throw new Error("A positive amount is required");
    }
    bid.amount = amount;
  }
  if (currency) bid.currency = currency;
  if (proposal) bid.proposal = proposal;
  if (estimatedDurationDays !== undefined) bid.estimatedDurationDays = estimatedDurationDays;

  await bid.save();

  res.status(200).json(toPublicBid(bid));
});

// @desc    Withdraw my own bid
// @route   PATCH /api/tender-projects/:id/bids/mine/withdraw
// @access  Private (the bid's own contractor only)
export const withdrawMyBid = asyncHandler(async (req: Request, res: Response) => {
  const requester = req.user as IUser;
  const contractor = await loadEligibleContractorProfile(requester._id);

  if (!contractor) {
    res.status(403);
    throw new Error("Only a verified, currently-subscribed contractor profile can bid");
  }

  const bid = await loadMyPendingBid(req.params.id as string, contractor._id as mongoose.Types.ObjectId);
  if (!bid) {
    res.status(404);
    throw new Error("Bid not found");
  }

  if (bid.status !== BID_STATUS.PENDING) {
    res.status(400);
    throw new Error(`This bid has already been ${bid.status}`);
  }

  bid.status = BID_STATUS.WITHDRAWN;
  await bid.save();

  await TenderProject.updateOne({ _id: bid.project }, { $inc: { bidCount: -1 } });

  res.status(200).json(toPublicBid(bid));
});

// @desc    My own bids, across every project
// @route   GET /api/tender-projects/bids/mine
// @access  Private
export const getMyBids = asyncHandler(async (req: Request, res: Response) => {
  const requester = req.user as IUser;
  const contractor = await ContractorProfile.findOne({ userId: requester._id }).select("_id");

  if (!contractor) {
    res.status(404);
    throw new Error("You don't have a contractor profile yet");
  }

  const page = Math.max(Number(req.query.page) || 1, 1);
  const limit = Math.min(Number(req.query.limit) || 20, 100);
  const skip = (page - 1) * limit;

  const filter = { contractorId: contractor._id };

  const [bids, total] = await Promise.all([
    Bid.find(filter).sort({ createdAt: -1 }).skip(skip).limit(limit),
    Bid.countDocuments(filter),
  ]);

  res.status(200).json({
    data: bids.map(toPublicBid),
    pagination: { total, page, limit, totalPages: Math.ceil(total / limit) },
  });
});

// @desc    Every bid on my project — sealed from everyone but the poster.
// @route   GET /api/tender-projects/:id/bids
// @access  Private (poster only)
export const getProjectBids = asyncHandler(async (req: Request, res: Response) => {
  const requester = req.user as IUser;
  const project = await loadMyProject(requester.id, req.params.id as string);

  if (!project) {
    res.status(404);
    throw new Error("Project not found");
  }

  const bids = await Bid.find({ project: project._id })
    .sort({ createdAt: -1 })
    .populate("contractorId", "headline slug ratingAverage ratingCount")
    .populate("bidder", "fullName email");

  res.status(200).json(bids.map(toPublicBid));
});

// @desc    Award the project to one bid — accepts it, rejects every other
//          pending bid, and spins up a real Job (jobType: 'tenders') with
//          the poster as the confirmed client and the contractor as the
//          not-yet-confirmed provider, same default roles `createJob`
//          already uses (the poster is the one calling this, so there's
//          no need for Store checkout's asymmetric-roles trick).
// @route   PATCH /api/tender-projects/:id/award
// @access  Private (poster only)
export const awardBid = asyncHandler(async (req: Request, res: Response) => {
  const requester = req.user as IUser;
  const project = await loadMyProject(requester.id, req.params.id as string);

  if (!project) {
    res.status(404);
    throw new Error("Project not found");
  }

  if (project.status !== TENDER_PROJECT_STATUS.OPEN) {
    res.status(400);
    throw new Error("Only an open project can be awarded");
  }

  const { bidId } = req.body;

  if (!bidId || !mongoose.Types.ObjectId.isValid(bidId)) {
    res.status(400);
    throw new Error("A valid bidId is required");
  }

  const bid = await Bid.findOne({ _id: bidId, project: project._id });
  if (!bid) {
    res.status(404);
    throw new Error("Bid not found on this project");
  }

  if (bid.status !== BID_STATUS.PENDING) {
    res.status(400);
    throw new Error(`This bid has already been ${bid.status}`);
  }

  bid.status = BID_STATUS.ACCEPTED;
  await bid.save();

  await Bid.updateMany(
    { project: project._id, _id: { $ne: bid._id }, status: BID_STATUS.PENDING },
    { status: BID_STATUS.REJECTED },
  );

  const job = await Job.create({
    jobTitle: project.title,
    jobDescription: project.description,
    jobType: JOB_TYPE.TENDERS,
    createdBy: requester._id,
    client: { userId: requester._id, isConfirmed: true },
    provider: { userId: bid.bidder, isConfirmed: false },
    totalAmount: bid.amount,
    currency: bid.currency,
    platformFeePercent: getPlatformFeePercent(),
  });

  await connectUsers(requester._id as mongoose.Types.ObjectId, bid.bidder as mongoose.Types.ObjectId);

  project.status = TENDER_PROJECT_STATUS.AWARDED;
  project.awardedBid = bid._id as mongoose.Types.ObjectId;
  project.job = job._id as mongoose.Types.ObjectId;
  await project.save();

  res.status(200).json({ ...toPublicTenderProject(project), job });
});
