import mongoose from "mongoose";
import asyncHandler from "express-async-handler";
import { Request, Response } from "express";
import {
  JobOpening,
  IJobOpening,
  JOB_OPENING_STATUS,
  MAX_OPENING_FILES,
} from "../models/jobOpeningModel";
import { LABOR_SKILL, LaborSkill } from "../models/laborProfileModel";
import {
  JobApplication,
  IJobApplication,
  APPLICATION_STATUS,
} from "../models/jobApplicationModel";
import { LaborProfile } from "../models/laborProfileModel";
import { loadEligibleLaborProfile } from "./laborProfileController";
import { loadEligibleClientProfile } from "./clientProfileController";
import { Job, JOB_TYPE } from "../models/jobModel";
import { getPlatformFeePercent } from "./jobController";
import { IUser, SYSTEM_ROLE } from "../models/userModel";
import { IMediaFile } from "../models/mediaFile";
import {
  uploadHandler,
  deleteStoredFile,
  FILE_VISIBILITY,
  PORTFOLIO_MEDIA_ALLOWED_MIME_TYPES,
} from "../helpers/fileStorage";
import { signFileUrl, FILE_URL_MODE } from "../helpers/fileSigning";
import { connectUsers } from "./contactController";

// The one place opening.files gets turned into signed, servable links —
// shared by getJobOpening/addOpeningFiles/removeOpeningFile so all three
// return the exact same shape.
const toFilesWithLinks = (opening: IJobOpening) =>
  opening.files.map((file) => ({
    fileName: file.fileName,
    mime: file.mime,
    size: file.size,
    url: signFileUrl({ ownerId: opening.postedBy.toString(), fileName: file.fileName, mode: FILE_URL_MODE.VIEW }),
  }));

// Never includes the gated location tier (coordinates/address/
// googleMapsUrl/contactInfo/files) — see getJobOpening for the one place
// that ever adds those back in, and only for an eligible viewer.
const toPublicJobOpening = (opening: IJobOpening) => ({
  id: opening.id,
  postedBy: opening.postedBy,
  title: opening.title,
  description: opening.description,
  category: opening.category,
  workersNeeded: opening.workersNeeded,
  filledCount: opening.filledCount,
  payRate: opening.payRate,
  payType: opening.payType,
  currency: opening.currency,
  employmentType: opening.employmentType,
  generalArea: opening.generalArea,
  applicationDeadline: opening.applicationDeadline,
  status: opening.status,
  createdAt: opening.createdAt,
});

const toPublicApplication = (application: IJobApplication) => ({
  id: application.id,
  posting: application.posting,
  workerId: application.workerId,
  applicant: application.applicant,
  message: application.message,
  status: application.status,
  createdAt: application.createdAt,
});

// @desc    Post a new job opening to the board. Requires a verified,
//          subscribed ClientProfile — same gate as createTenderProject,
//          and the same reasoning: a worker accepting this is about to
//          travel to an address the poster controls.
// @route   POST /api/job-openings
// @access  Private — requires a verified, subscribed client profile
export const createJobOpening = asyncHandler(async (req: Request, res: Response) => {
  const requester = req.user as IUser;

  const clientProfile = await loadEligibleClientProfile(requester._id);
  if (!clientProfile) {
    res.status(402);
    throw new Error("You need a verified client profile with an active subscription to post a job opening");
  }

  const {
    title,
    description,
    category,
    workersNeeded,
    payRate,
    payType,
    currency,
    employmentType,
    generalArea,
    coordinates,
    address,
    googleMapsUrl,
    contactInfo,
    applicationDeadline,
  } = req.body;

  const attachedCount = (req.files as Express.Multer.File[] | undefined)?.length ?? 0;
  if (attachedCount > MAX_OPENING_FILES) {
    res.status(400);
    throw new Error(`You can attach at most ${MAX_OPENING_FILES} files to a job opening`);
  }

  // Real multipart attachments only — req.files, never req.body's
  // base64/url alternatives. Passing the whole `req` to uploadHandler
  // would let those through too, silently saving files the caller never
  // meant to attach and blowing past MAX_OPENING_FILES undetected
  // (checked against req.files.length alone, just above). Same shim
  // digitalProductController.ts's saveFilesForField already uses.
  const shimReq = { files: req.files, body: {} } as unknown as Request;
  const { results, errorLogs } = await uploadHandler({
    req: shimReq,
    visibility: FILE_VISIBILITY.PRIVATE,
    ownerId: requester.id,
    allowedMimeTypes: PORTFOLIO_MEDIA_ALLOWED_MIME_TYPES,
  });

  const files: IMediaFile[] = results.map((r) => ({
    fileName: r.fileName,
    storagePath: r.storagePath,
    mime: r.mime,
    size: r.size,
  }));

  const opening = await JobOpening.create({
    postedBy: requester._id,
    title,
    description,
    category,
    workersNeeded: workersNeeded || 1,
    payRate,
    payType,
    currency: currency || "USD",
    employmentType,
    generalArea,
    coordinates,
    address,
    googleMapsUrl,
    contactInfo,
    applicationDeadline,
    files,
  });

  res.status(201).json({
    ...toPublicJobOpening(opening),
    ...(errorLogs.length > 0 ? { fileWarnings: errorLogs } : {}),
  });
});

const loadMyOpening = async (requesterId: string, openingId: string) => {
  if (!mongoose.Types.ObjectId.isValid(openingId)) return null;

  return JobOpening.findOne({ _id: openingId, postedBy: requesterId });
};

// @desc    Update my job opening — only while still open
// @route   PATCH /api/job-openings/:id
// @access  Private (poster only)
export const updateMyJobOpening = asyncHandler(async (req: Request, res: Response) => {
  const requester = req.user as IUser;
  const opening = await loadMyOpening(requester.id, req.params.id as string);

  if (!opening) {
    res.status(404);
    throw new Error("Job opening not found");
  }

  if (opening.status !== JOB_OPENING_STATUS.OPEN) {
    res.status(400);
    throw new Error("This job opening can no longer be edited");
  }

  const {
    title,
    description,
    category,
    workersNeeded,
    payRate,
    payType,
    currency,
    employmentType,
    generalArea,
    coordinates,
    address,
    googleMapsUrl,
    contactInfo,
    applicationDeadline,
  } = req.body;

  if (title) opening.title = title;
  if (description) opening.description = description;
  if (category !== undefined) opening.category = category;
  if (workersNeeded !== undefined) opening.workersNeeded = workersNeeded;
  if (payRate !== undefined) opening.payRate = payRate;
  if (payType !== undefined) opening.payType = payType;
  if (currency) opening.currency = currency;
  if (employmentType !== undefined) opening.employmentType = employmentType;
  if (generalArea !== undefined) opening.generalArea = generalArea;
  if (coordinates !== undefined) opening.coordinates = coordinates;
  if (address !== undefined) opening.address = address;
  if (googleMapsUrl !== undefined) opening.googleMapsUrl = googleMapsUrl;
  if (contactInfo !== undefined) opening.contactInfo = contactInfo;
  if (applicationDeadline !== undefined) opening.applicationDeadline = applicationDeadline;

  await opening.save();

  res.status(200).json(toPublicJobOpening(opening));
});

// @desc    Add more files to my job opening (site photos) — only while
//          still open, same editing window as updateMyJobOpening. Real
//          multipart attachments only — req.files, never req.body's
//          base64/url alternatives (see createJobOpening's shim and why
//          it matters: passing the whole `req` to uploadHandler would
//          let those through too, uncounted against MAX_OPENING_FILES).
//          Images only — jpeg/png/avif — same rule as the portfolio
//          uploads on labor/contractor/consultancy profiles.
// @route   POST /api/job-openings/:id/files
// @access  Private (poster only)
export const addOpeningFiles = asyncHandler(async (req: Request, res: Response) => {
  const requester = req.user as IUser;
  const opening = await loadMyOpening(requester.id, req.params.id as string);

  if (!opening) {
    res.status(404);
    throw new Error("Job opening not found");
  }

  if (opening.status !== JOB_OPENING_STATUS.OPEN) {
    res.status(400);
    throw new Error("This job opening can no longer be edited");
  }

  const attachedCount = (req.files as Express.Multer.File[] | undefined)?.length ?? 0;
  if (attachedCount === 0) {
    res.status(400);
    throw new Error("Attach at least one file");
  }

  if (opening.files.length + attachedCount > MAX_OPENING_FILES) {
    res.status(400);
    throw new Error(
      `This job opening already has ${opening.files.length} of ${MAX_OPENING_FILES} files allowed — attach fewer`,
    );
  }

  const shimReq = { files: req.files, body: {} } as unknown as Request;

  const { results, errorLogs } = await uploadHandler({
    req: shimReq,
    visibility: FILE_VISIBILITY.PRIVATE,
    ownerId: requester.id,
    allowedMimeTypes: PORTFOLIO_MEDIA_ALLOWED_MIME_TYPES,
  });

  const newFiles: IMediaFile[] = results.map((r) => ({
    fileName: r.fileName,
    storagePath: r.storagePath,
    mime: r.mime,
    size: r.size,
  }));

  opening.files.push(...newFiles);
  await opening.save();

  res.status(201).json({
    ...toPublicJobOpening(opening),
    files: toFilesWithLinks(opening),
    ...(errorLogs.length > 0 ? { fileWarnings: errorLogs } : {}),
  });
});

// @desc    Remove one file from my job opening — only while still open,
//          same editing window as updateMyJobOpening.
// @route   DELETE /api/job-openings/:id/files/:fileName
// @access  Private (poster only)
export const removeOpeningFile = asyncHandler(async (req: Request, res: Response) => {
  const requester = req.user as IUser;
  const opening = await loadMyOpening(requester.id, req.params.id as string);

  if (!opening) {
    res.status(404);
    throw new Error("Job opening not found");
  }

  if (opening.status !== JOB_OPENING_STATUS.OPEN) {
    res.status(400);
    throw new Error("This job opening can no longer be edited");
  }

  const fileName = req.params.fileName as string;
  const file = opening.files.find((f) => f.fileName === fileName);

  if (!file) {
    res.status(404);
    throw new Error("File not found on this job opening");
  }

  await deleteStoredFile(file.storagePath);
  opening.files = opening.files.filter((f) => f.fileName !== fileName) as typeof opening.files;
  await opening.save();

  res.status(200).json({ ...toPublicJobOpening(opening), files: toFilesWithLinks(opening) });
});

// @desc    Cancel my job opening while still open — rejects every pending
//          application too.
// @route   PATCH /api/job-openings/:id/cancel
// @access  Private (poster only)
export const cancelMyJobOpening = asyncHandler(async (req: Request, res: Response) => {
  const requester = req.user as IUser;
  const opening = await loadMyOpening(requester.id, req.params.id as string);

  if (!opening) {
    res.status(404);
    throw new Error("Job opening not found");
  }

  if (opening.status !== JOB_OPENING_STATUS.OPEN) {
    res.status(400);
    throw new Error("Only an open job opening can be cancelled");
  }

  opening.status = JOB_OPENING_STATUS.CANCELLED;
  await opening.save();
  await JobApplication.updateMany(
    { posting: opening._id, status: APPLICATION_STATUS.PENDING },
    { status: APPLICATION_STATUS.REJECTED },
  );

  res.status(200).json(toPublicJobOpening(opening));
});

// @desc    My own posted job openings, any status
// @route   GET /api/job-openings/me
// @access  Private
export const getMyJobOpenings = asyncHandler(async (req: Request, res: Response) => {
  const requester = req.user as IUser;
  const page = Math.max(Number(req.query.page) || 1, 1);
  const limit = Math.min(Number(req.query.limit) || 20, 100);
  const skip = (page - 1) * limit;

  const filter = { postedBy: requester._id };

  const [openings, total] = await Promise.all([
    JobOpening.find(filter).sort({ createdAt: -1 }).skip(skip).limit(limit),
    JobOpening.countDocuments(filter),
  ]);

  res.status(200).json({
    data: openings.map(toPublicJobOpening),
    pagination: { total, page, limit, totalPages: Math.ceil(total / limit) },
  });
});

// @desc    Browse the job board — only reachable by an eligible (verified
//          + subscribed) worker. Only ever returns the public tier
//          (generalArea, never exact coordinates/address/contact) — see
//          getJobOpening for why.
// @route   GET /api/job-openings?category=&country=
// @access  Private (eligible worker only)
export const listJobOpenings = asyncHandler(async (req: Request, res: Response) => {
  const requester = req.user as IUser;
  const eligible = await loadEligibleLaborProfile(requester._id);

  if (!eligible) {
    res.status(403);
    throw new Error("Only a verified, currently-subscribed worker profile can browse the job board");
  }

  const page = Math.max(Number(req.query.page) || 1, 1);
  const limit = Math.min(Number(req.query.limit) || 20, 100);
  const skip = (page - 1) * limit;

  const { category, country } = req.query as { category?: string; country?: string };

  const filter: Record<string, unknown> = { status: JOB_OPENING_STATUS.OPEN };

  if (category && Object.values(LABOR_SKILL).includes(category as LaborSkill)) {
    filter.category = category;
  }
  if (country) {
    filter["generalArea.country"] = String(country).toUpperCase();
  }

  const [openings, total] = await Promise.all([
    JobOpening.find(filter).sort({ createdAt: -1 }).skip(skip).limit(limit),
    JobOpening.countDocuments(filter),
  ]);

  res.status(200).json({
    data: openings.map(toPublicJobOpening),
    pagination: { total, page, limit, totalPages: Math.ceil(total / limit) },
  });
});

// @desc    View a single job opening. The public tier (generalArea,
//          pay, description) is shown to the poster, an eligible worker,
//          or an admin. The gated tier — exact coordinates, address,
//          Google Maps link, contact info, and attached files — is only
//          added on top for the poster, an admin, or a worker whose
//          *application has been accepted* on this posting. Merely
//          being eligible to browse, or having applied, is not enough:
//          a worker learns exactly where to go only once the poster has
//          actually committed to them. See docs/siteforce-plan.md.
// @route   GET /api/job-openings/:id
// @access  Private
export const getJobOpening = asyncHandler(async (req: Request, res: Response) => {
  const requester = req.user as IUser;
  const id = req.params.id as string;

  if (!mongoose.Types.ObjectId.isValid(id)) {
    res.status(404);
    throw new Error("Job opening not found");
  }

  const opening = await JobOpening.findById(id);
  if (!opening) {
    res.status(404);
    throw new Error("Job opening not found");
  }

  const isPoster = opening.postedBy.toString() === requester.id;
  const isAdmin =
    requester.systemRole === SYSTEM_ROLE.ADMIN || requester.systemRole === SYSTEM_ROLE.SUPER_ADMIN;

  if (!isPoster && !isAdmin) {
    const eligible = await loadEligibleLaborProfile(requester._id);

    if (!eligible) {
      res.status(200).json({ available: false, message: "This job opening is not currently available." });
      return;
    }

    const accepted = await JobApplication.exists({
      posting: opening._id,
      workerId: eligible._id,
      status: APPLICATION_STATUS.ACCEPTED,
    });

    if (!accepted) {
      // Eligible to browse, but not accepted — public tier only.
      res.status(200).json(toPublicJobOpening(opening));
      return;
    }
  }

  res.status(200).json({
    ...toPublicJobOpening(opening),
    coordinates: opening.coordinates,
    address: opening.address,
    googleMapsUrl: opening.googleMapsUrl,
    contactInfo: opening.contactInfo,
    files: toFilesWithLinks(opening),
  });
});

// @desc    Apply to a job opening.
// @route   POST /api/job-openings/:id/applications
// @access  Private (eligible worker only)
export const applyToJobOpening = asyncHandler(async (req: Request, res: Response) => {
  const requester = req.user as IUser;
  const id = req.params.id as string;

  if (!mongoose.Types.ObjectId.isValid(id)) {
    res.status(404);
    throw new Error("Job opening not found");
  }

  const opening = await JobOpening.findById(id);
  if (!opening) {
    res.status(404);
    throw new Error("Job opening not found");
  }

  const worker = await loadEligibleLaborProfile(requester._id);
  if (!worker) {
    res.status(403);
    throw new Error("Only a verified, currently-subscribed worker profile can apply");
  }

  if (opening.postedBy.toString() === requester.id) {
    res.status(400);
    throw new Error("You can't apply to your own job opening");
  }

  if (
    opening.status !== JOB_OPENING_STATUS.OPEN ||
    (opening.applicationDeadline && opening.applicationDeadline <= new Date())
  ) {
    res.status(400);
    throw new Error("This job opening is no longer accepting applications");
  }

  const existing = await JobApplication.findOne({ posting: opening._id, workerId: worker._id });
  if (existing) {
    res.status(400);
    throw new Error("You've already applied to this job opening");
  }

  const { message } = req.body;

  const application = await JobApplication.create({
    posting: opening._id,
    workerId: worker._id,
    applicant: requester._id,
    message,
  });

  res.status(201).json(toPublicApplication(application));
});

const loadMyApplication = async (postingId: string, workerProfileId: mongoose.Types.ObjectId) => {
  if (!mongoose.Types.ObjectId.isValid(postingId)) return null;

  return JobApplication.findOne({ posting: postingId, workerId: workerProfileId });
};

// @desc    Revise my own application's message — only while pending.
// @route   PATCH /api/job-openings/:id/applications/mine
// @access  Private (the application's own worker only)
export const updateMyApplication = asyncHandler(async (req: Request, res: Response) => {
  const requester = req.user as IUser;
  const worker = await loadEligibleLaborProfile(requester._id);

  if (!worker) {
    res.status(403);
    throw new Error("Only a verified, currently-subscribed worker profile can apply");
  }

  const application = await loadMyApplication(req.params.id as string, worker._id as mongoose.Types.ObjectId);
  if (!application) {
    res.status(404);
    throw new Error("Application not found");
  }

  if (application.status !== APPLICATION_STATUS.PENDING) {
    res.status(400);
    throw new Error(`This application has already been ${application.status}`);
  }

  const { message } = req.body;
  if (message !== undefined) application.message = message;

  await application.save();

  res.status(200).json(toPublicApplication(application));
});

// @desc    Withdraw my own application
// @route   PATCH /api/job-openings/:id/applications/mine/withdraw
// @access  Private (the application's own worker only)
export const withdrawMyApplication = asyncHandler(async (req: Request, res: Response) => {
  const requester = req.user as IUser;
  const worker = await loadEligibleLaborProfile(requester._id);

  if (!worker) {
    res.status(403);
    throw new Error("Only a verified, currently-subscribed worker profile can apply");
  }

  const application = await loadMyApplication(req.params.id as string, worker._id as mongoose.Types.ObjectId);
  if (!application) {
    res.status(404);
    throw new Error("Application not found");
  }

  if (application.status !== APPLICATION_STATUS.PENDING) {
    res.status(400);
    throw new Error(`This application has already been ${application.status}`);
  }

  application.status = APPLICATION_STATUS.WITHDRAWN;
  await application.save();

  res.status(200).json(toPublicApplication(application));
});

// @desc    My own applications, across every posting
// @route   GET /api/job-openings/applications/mine
// @access  Private
export const getMyApplications = asyncHandler(async (req: Request, res: Response) => {
  const requester = req.user as IUser;
  const worker = await LaborProfile.findOne({ userId: requester._id }).select("_id");

  if (!worker) {
    res.status(404);
    throw new Error("You don't have a labor profile yet");
  }

  const page = Math.max(Number(req.query.page) || 1, 1);
  const limit = Math.min(Number(req.query.limit) || 20, 100);
  const skip = (page - 1) * limit;

  const filter = { workerId: worker._id };

  const [applications, total] = await Promise.all([
    JobApplication.find(filter).sort({ createdAt: -1 }).skip(skip).limit(limit),
    JobApplication.countDocuments(filter),
  ]);

  res.status(200).json({
    data: applications.map(toPublicApplication),
    pagination: { total, page, limit, totalPages: Math.ceil(total / limit) },
  });
});

// @desc    Every application on my job opening — kept to the poster only,
//          same privacy reasoning Tenders' sealed bids use (an
//          applicant's identity shouldn't be handed to other applicants
//          either, even with no price involved to hide).
// @route   GET /api/job-openings/:id/applications
// @access  Private (poster only)
export const getOpeningApplications = asyncHandler(async (req: Request, res: Response) => {
  const requester = req.user as IUser;
  const opening = await loadMyOpening(requester.id, req.params.id as string);

  if (!opening) {
    res.status(404);
    throw new Error("Job opening not found");
  }

  // `applicant` is never populated with `email` — a formal Contact
  // connection (connectUsers) only exists once this specific application
  // is actually accepted (see acceptApplication below), same as
  // awardBid's identical gate in tenderProjectController.ts. Handing the
  // poster a worker's email while merely reviewing pending applications
  // would let them skip that gate entirely, for every applicant, by
  // just listing the applications.
  const applications = await JobApplication.find({ posting: opening._id })
    .sort({ createdAt: -1 })
    .populate("workerId", "headline slug ratingAverage ratingCount")
    .populate("applicant", "fullName");

  res.status(200).json(applications.map(toPublicApplication));
});

// @desc    Accept an application — creates a Job for that one worker
//          (jobType: 'siteforce', poster as confirmed client, worker as
//          unconfirmed provider, same default-roles reasoning
//          awardBid uses). Once accepted applications reach
//          `workersNeeded`, the opening moves to `filled` and every
//          other pending application is rejected.
// @route   PATCH /api/job-openings/:id/applications/:applicationId/accept
// @access  Private (poster only)
export const acceptApplication = asyncHandler(async (req: Request, res: Response) => {
  const requester = req.user as IUser;
  const opening = await loadMyOpening(requester.id, req.params.id as string);

  if (!opening) {
    res.status(404);
    throw new Error("Job opening not found");
  }

  if (opening.status !== JOB_OPENING_STATUS.OPEN) {
    res.status(400);
    throw new Error("This job opening is no longer open");
  }

  const application = await JobApplication.findOne({
    _id: req.params.applicationId,
    posting: opening._id,
  });
  if (!application) {
    res.status(404);
    throw new Error("Application not found on this job opening");
  }

  if (application.status !== APPLICATION_STATUS.PENDING) {
    res.status(400);
    throw new Error(`This application has already been ${application.status}`);
  }

  const job = await Job.create({
    jobTitle: opening.title,
    jobDescription: opening.description,
    jobType: JOB_TYPE.SITEFORCE,
    createdBy: requester._id,
    client: { userId: requester._id, isConfirmed: true },
    provider: { userId: application.applicant, isConfirmed: false },
    totalAmount: opening.payRate,
    currency: opening.currency,
    platformFeePercent: getPlatformFeePercent(),
  });

  application.status = APPLICATION_STATUS.ACCEPTED;
  application.job = job._id as mongoose.Types.ObjectId;
  await application.save();

  await connectUsers(requester._id as mongoose.Types.ObjectId, application.applicant as mongoose.Types.ObjectId);

  opening.filledCount += 1;
  if (opening.filledCount >= opening.workersNeeded) {
    opening.status = JOB_OPENING_STATUS.FILLED;
    await JobApplication.updateMany(
      { posting: opening._id, status: APPLICATION_STATUS.PENDING },
      { status: APPLICATION_STATUS.REJECTED },
    );
  }
  await opening.save();

  res.status(200).json({ ...toPublicApplication(application), job, opening: toPublicJobOpening(opening) });
});

// @desc    Explicitly reject an application without accepting another —
//          a poster can do this proactively rather than waiting for the
//          opening to auto-fill-and-reject-the-rest.
// @route   PATCH /api/job-openings/:id/applications/:applicationId/reject
// @access  Private (poster only)
export const rejectApplication = asyncHandler(async (req: Request, res: Response) => {
  const requester = req.user as IUser;
  const opening = await loadMyOpening(requester.id, req.params.id as string);

  if (!opening) {
    res.status(404);
    throw new Error("Job opening not found");
  }

  const application = await JobApplication.findOne({
    _id: req.params.applicationId,
    posting: opening._id,
  });
  if (!application) {
    res.status(404);
    throw new Error("Application not found on this job opening");
  }

  if (application.status !== APPLICATION_STATUS.PENDING) {
    res.status(400);
    throw new Error(`This application has already been ${application.status}`);
  }

  application.status = APPLICATION_STATUS.REJECTED;
  await application.save();

  res.status(200).json(toPublicApplication(application));
});
