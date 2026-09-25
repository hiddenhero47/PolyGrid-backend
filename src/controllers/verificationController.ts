import mongoose, { FilterQuery } from "mongoose";
import asyncHandler from "express-async-handler";
import { ValidationError } from "yup";
import { Request, Response } from "express";
import {
  Verification,
  IVerification,
  IVerificationDocument,
  VERIFICATION_STATUS,
  VerificationStatus,
} from "../models/verificationModel";
import { ITemplateDocument, DOCUMENT_FORMAT_MIME } from "../models/verificationTemplateModel";
import { IUser } from "../models/userModel";
import { PROFILE_MODEL_REGISTRY, ProfileType, isKnownProfileType } from "../constants/profileTypes";
import { findActiveTemplate } from "../helpers/verificationTemplateLookup";
import { buildFormSchema } from "../validators/templateFormSchema";
import { uploadHandler, deleteStoredFile, FILE_VISIBILITY } from "../helpers/fileStorage";
import { pickDefinedFields } from "../helpers/sanitize";
import { parseMultipartData } from "../helpers/parseMultipartData";

const paginationParams = (req: Request) => {
  const page = Math.max(Number(req.query.page) || 1, 1);
  const limit = Math.min(Number(req.query.limit) || 20, 100);
  return { page, limit, skip: (page - 1) * limit };
};

// Files must arrive as part of THIS request — never a fileName pointing at
// something uploaded earlier through a different route. Uploading first and
// referencing it later would let a user pile up private files with nothing
// ever attached to them; this way a file only ever gets saved when it's
// actually going into a Verification. Which document each file fulfills is
// read from its multipart field name, which must be exactly one of the
// template's declared document `type`s (e.g. a field literally named
// "business_certificate") — VerificationTemplate is what tells the caller
// (and the frontend, via GET /api/verification-templates/lookup) what
// field names, how many, and in what formats are expected.
const resolveAndSaveDocuments = async (
  userId: string,
  required: ITemplateDocument[],
  files: Express.Multer.File[],
): Promise<{ documents: IVerificationDocument[]; warnings: string[]; issues: string[] }> => {
  const issues: string[] = [];
  const warnings: string[] = [];
  const documents: IVerificationDocument[] = [];
  const savedStoragePaths: string[] = [];

  const knownTypes = new Set(required.map((doc) => doc.type));
  const filesByType = new Map<string, Express.Multer.File[]>();
  for (const file of files) {
    const list = filesByType.get(file.fieldname) ?? [];
    list.push(file);
    filesByType.set(file.fieldname, list);
  }

  for (const fieldname of filesByType.keys()) {
    if (!knownTypes.has(fieldname)) {
      issues.push(`Unknown document type: ${fieldname}`);
    }
  }

  // Cheap checks (unknown field names, more than one file per type) happen
  // before anything touches disk — no point saving bytes for a request
  // that's already going to be rejected.
  for (const [type, matches] of filesByType) {
    if (knownTypes.has(type) && matches.length > 1) {
      issues.push(`Only one file allowed for ${type}`);
    }
  }

  if (issues.length > 0) {
    return { documents, warnings, issues };
  }

  // Saved one at a time (not in parallel) so each file's own success/failure
  // stays cleanly attributed to the document type it was meant to fulfill.
  for (const requirement of required) {
    const [file] = filesByType.get(requirement.type) ?? [];

    if (!file) {
      if (requirement.required) issues.push(`${requirement.label} is required`);
      continue;
    }

    const allowedMimeTypes = requirement.acceptedFormats.map((format) => DOCUMENT_FORMAT_MIME[format]);
    const uploadReq = { files: [file], body: {} } as unknown as Request;

    const { results, errorLogs } = await uploadHandler({
      req: uploadReq,
      visibility: FILE_VISIBILITY.PRIVATE,
      ownerId: userId,
      allowedMimeTypes,
    });

    const saved = results[0];
    if (!saved) {
      const message = `${requirement.label}: ${errorLogs[0] || "failed to save"}`;
      if (requirement.required) {
        issues.push(message);
      } else {
        // Optional document failed — dropped, not fatal (mirrors
        // updateUserProfile's avatarWarnings: a bad optional attachment
        // never blocks the rest of the request on its own).
        warnings.push(message);
      }
      continue;
    }

    savedStoragePaths.push(saved.storagePath);
    documents.push({
      type: requirement.type,
      fileName: saved.fileName,
      mime: saved.mime,
      size: saved.size,
      uploadedAt: new Date(),
    });
  }

  if (issues.length > 0) {
    // Nothing from this attempt should be left behind if the submission as
    // a whole is being rejected — otherwise a required document failing
    // would still leave every *other* successfully-saved file orphaned on
    // disk, exactly the "files with nothing attached to them" problem this
    // whole design exists to avoid.
    await Promise.all(savedStoragePaths.map((storagePath) => deleteStoredFile(storagePath)));
    return { documents: [], warnings, issues };
  }

  return { documents, warnings, issues };
};

interface SubmitVerificationPayload {
  profileType?: string;
  profileId?: string;
  country?: string;
  state?: string;
  form?: Record<string, unknown>;
}

// @desc    Submit (or resubmit) KYC/verification for one of my profiles.
//          multipart/form-data: a JSON-stringified `data` field carrying
//          {profileType, profileId, country, state?, form} (see
//          parseMultipartData.ts — mirrors house-maduekwe-backend's
//          shopItems create/update pattern for "structured fields + real
//          files in one request"), plus one file per required/optional
//          document, each attached under a field name equal to the
//          template's document `type` (see GET
//          /api/verification-templates/lookup for what a given
//          profileType+location expects). Never overwrites a previous
//          submission — each one is its own permanent record (see
//          verificationModel.ts); the profile's `verification` pointer
//          just moves to the newest.
// @route   POST /api/verifications
// @access  Private
export const submitVerification = asyncHandler(async (req: Request, res: Response) => {
  const requester = req.user as IUser;
  const { profileType, profileId, country, state, form } = parseMultipartData<SubmitVerificationPayload>(req);

  if (!isKnownProfileType(profileType)) {
    res.status(400);
    throw new Error("Invalid profileType");
  }

  if (!profileId || !mongoose.Types.ObjectId.isValid(profileId)) {
    res.status(400);
    throw new Error("Invalid profileId");
  }

  if (!country) {
    res.status(400);
    throw new Error("country is required");
  }

  const ProfileModel = PROFILE_MODEL_REGISTRY[profileType];
  const profile = await ProfileModel.findById(profileId);

  if (!profile) {
    res.status(404);
    throw new Error("Profile not found");
  }

  if (profile.userId.toString() !== requester.id) {
    res.status(403);
    throw new Error("You can only submit verification for your own profile");
  }

  const template = await findActiveTemplate(profileType, country, state);

  if (!template) {
    res.status(404);
    throw new Error(
      `No verification template configured yet for ${profileType} in ${String(country).toUpperCase()}` +
        (state ? `/${String(state).toUpperCase()}` : ""),
    );
  }

  const formInput = pickDefinedFields<Record<string, unknown>>(
    form ?? {},
    template.fields.map((field) => field.key),
  );

  let validatedForm: Record<string, unknown>;
  try {
    validatedForm = await buildFormSchema(template.fields).validate(formInput, {
      abortEarly: false,
      stripUnknown: true,
    });
  } catch (error) {
    if (error instanceof ValidationError) {
      res.status(400);
      throw new Error(error.errors.join(", "));
    }
    throw error;
  }

  const files = (req.files as Express.Multer.File[] | undefined) ?? [];
  const {
    documents: resolvedDocuments,
    warnings: documentWarnings,
    issues: documentIssues,
  } = await resolveAndSaveDocuments(requester.id, template.documents, files);

  if (documentIssues.length > 0) {
    res.status(400);
    throw new Error(documentIssues.join(", "));
  }

  const verification = await Verification.create({
    profileType,
    profileId: profile._id,
    user: requester._id,
    location: { country: String(country).toUpperCase(), state: state ? String(state).toUpperCase() : undefined },
    templateId: template._id,
    form: validatedForm,
    documents: resolvedDocuments,
    status: VERIFICATION_STATUS.PENDING,
  });

  profile.verification = verification._id;
  await profile.save();

  res.status(201).json({
    ...verification.toObject(),
    ...(documentWarnings.length > 0 ? { documentWarnings } : {}),
  });
});

// @desc    Get my own verification submissions, newest first
// @route   GET /api/verifications/me
// @access  Private
export const getMyVerifications = asyncHandler(async (req: Request, res: Response) => {
  const { page, limit, skip } = paginationParams(req);
  const filter: FilterQuery<IVerification> = { user: (req.user as IUser)._id };

  const profileType = req.query.profileType as string | undefined;
  if (isKnownProfileType(profileType)) {
    filter.profileType = profileType;
  }

  const [data, total] = await Promise.all([
    Verification.find(filter).sort({ createdAt: -1 }).skip(skip).limit(limit),
    Verification.countDocuments(filter),
  ]);

  res.status(200).json({
    data,
    pagination: { total, page, limit, totalPages: Math.ceil(total / limit) },
  });
});

// @desc    List verification submissions — the admin review queue, across
//          every pillar
// @route   GET /api/verifications
// @access  Private (Admin / Super Admin only)
export const getVerifications = asyncHandler(async (req: Request, res: Response) => {
  const { page, limit, skip } = paginationParams(req);
  const { status, profileType } = req.query as { status?: string; profileType?: string };

  const filter: FilterQuery<IVerification> = {};

  if (status && Object.values(VERIFICATION_STATUS).includes(status as VerificationStatus)) {
    filter.status = status as VerificationStatus;
  }

  if (isKnownProfileType(profileType)) {
    filter.profileType = profileType;
  }

  const [data, total] = await Promise.all([
    Verification.find(filter)
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(limit)
      .populate("user", "fullName email"),
    Verification.countDocuments(filter),
  ]);

  res.status(200).json({
    data,
    pagination: { total, page, limit, totalPages: Math.ceil(total / limit) },
  });
});

// @desc    Approve a verification — flips the target profile's isVerified
//          and repoints its `verification` to this record
// @route   PATCH /api/verifications/:id/approve
// @access  Private (Admin / Super Admin only)
export const approveVerification = asyncHandler(async (req: Request, res: Response) => {
  const admin = req.user as IUser;
  const verification = await Verification.findById(req.params.id);

  if (!verification) {
    res.status(404);
    throw new Error("Verification not found");
  }

  if (verification.status !== VERIFICATION_STATUS.PENDING) {
    res.status(400);
    throw new Error("This verification is not pending");
  }

  verification.status = VERIFICATION_STATUS.APPROVED;
  verification.reviewedBy = admin._id as mongoose.Types.ObjectId;
  verification.reviewedAt = new Date();
  await verification.save();

  const ProfileModel = PROFILE_MODEL_REGISTRY[verification.profileType as ProfileType];
  await ProfileModel.updateOne(
    { _id: verification.profileId },
    { isVerified: true, verification: verification._id },
  );

  res.status(200).json(verification);
});

// @desc    Reject a verification
// @route   PATCH /api/verifications/:id/reject
// @access  Private (Admin / Super Admin only)
export const rejectVerification = asyncHandler(async (req: Request, res: Response) => {
  const admin = req.user as IUser;
  const { reason } = req.body;

  const verification = await Verification.findById(req.params.id);

  if (!verification) {
    res.status(404);
    throw new Error("Verification not found");
  }

  if (verification.status !== VERIFICATION_STATUS.PENDING) {
    res.status(400);
    throw new Error("This verification is not pending");
  }

  verification.status = VERIFICATION_STATUS.REJECTED;
  verification.rejectionReason = reason;
  verification.reviewedBy = admin._id as mongoose.Types.ObjectId;
  verification.reviewedAt = new Date();
  await verification.save();

  res.status(200).json(verification);
});
