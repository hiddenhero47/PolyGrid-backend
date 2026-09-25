import asyncHandler from "express-async-handler";
import { FilterQuery } from "mongoose";
import { Request, Response } from "express";
import { VerificationTemplate, IVerificationTemplate } from "../models/verificationTemplateModel";
import { isKnownProfileType } from "../constants/profileTypes";
import { findActiveTemplate } from "../helpers/verificationTemplateLookup";

// @desc    Create a verification template for a profileType + location.
//          Supersedes rather than edits: if an active template already
//          exists for the same profileType+country+state, it's deactivated
//          first and this becomes the next version — see
//          verificationTemplateModel.ts for why (a Verification's stored
//          templateId must keep resolving to the exact version it was
//          validated against).
// @route   POST /api/verification-templates
// @access  Private (Admin / Super Admin only)
export const createTemplate = asyncHandler(async (req: Request, res: Response) => {
  const { profileType, country, state, name, fields, documents } = req.body;

  if (!isKnownProfileType(profileType)) {
    res.status(400);
    throw new Error("Invalid profileType");
  }

  const normalizedState = state || null;

  const previous = await VerificationTemplate.findOneAndUpdate(
    { profileType, country, state: normalizedState, isActive: true },
    { isActive: false },
  );

  const template = await VerificationTemplate.create({
    profileType,
    country,
    state: normalizedState,
    name,
    fields,
    documents,
    version: (previous?.version ?? 0) + 1,
    isActive: true,
  });

  res.status(201).json(template);
});

// @desc    List verification templates — admin catalog management
// @route   GET /api/verification-templates
// @access  Private (Admin / Super Admin only)
export const getTemplates = asyncHandler(async (req: Request, res: Response) => {
  const { profileType, country, isActive } = req.query as {
    profileType?: string;
    country?: string;
    isActive?: string;
  };

  const filter: FilterQuery<IVerificationTemplate> = {};

  if (isKnownProfileType(profileType)) {
    filter.profileType = profileType;
  }
  if (country) {
    filter.country = String(country).toUpperCase();
  }
  if (isActive !== undefined) {
    filter.isActive = isActive === "true";
  }

  const templates = await VerificationTemplate.find(filter).sort({ createdAt: -1 });

  res.status(200).json({ data: templates });
});

// @desc    Resolve the active template for a profileType + location — what
//          the frontend calls before rendering a verification form, and the
//          exact same resolution submitVerification uses server-side, so
//          both sides always agree on which template applies.
// @route   GET /api/verification-templates/lookup
// @access  Private (any authenticated user)
export const lookupTemplate = asyncHandler(async (req: Request, res: Response) => {
  const { profileType, country, state } = req.query as {
    profileType?: string;
    country?: string;
    state?: string;
  };

  if (!isKnownProfileType(profileType)) {
    res.status(400);
    throw new Error("Invalid profileType");
  }

  if (!country) {
    res.status(400);
    throw new Error("country is required");
  }

  const template = await findActiveTemplate(profileType, country, state);

  if (!template) {
    res.status(404);
    throw new Error(
      `No verification template configured yet for ${profileType} in ${country}${state ? "/" + state : ""}`,
    );
  }

  res.status(200).json(template);
});
