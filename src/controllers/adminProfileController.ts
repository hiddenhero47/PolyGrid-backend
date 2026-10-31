import mongoose, { FilterQuery } from "mongoose";
import asyncHandler from "express-async-handler";
import { Request, Response } from "express";
import {
  PROFILE_MODEL_REGISTRY,
  PROFILE_TYPE,
  PROFILE_NAME_FIELD,
  PROFILE_SLUG_FIELD,
  ProfileType,
  isKnownProfileType,
} from "../constants/profileTypes";
import { PROFILE_STATUS, ProfileStatus } from "../constants/profileStatus";
import { User, IUser } from "../models/userModel";
import { NOTIFICATION_TYPE } from "../models/notificationModel";
import { notify } from "../helpers/notify";
import { sendTemplatedEmail } from "../helpers/emailSender";
import { toPublicProfile as toPublicConsultancyProfile } from "./consultancyProfileController";
import { toPublicContractorProfile } from "./contractorProfileController";
import { toPublicLaborProfile } from "./laborProfileController";
import { toPublicStoreProfile } from "./storeProfileController";
import { toPublicDigitalCreatorProfile } from "./digitalCreatorProfileController";
import { toPublicClientProfile } from "./clientProfileController";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const PROFILE_SERIALIZERS: Record<ProfileType, (profile: any) => unknown> = {
  [PROFILE_TYPE.CONSULTANCY]: toPublicConsultancyProfile,
  [PROFILE_TYPE.CONTRACTOR]: toPublicContractorProfile,
  [PROFILE_TYPE.LABOR]: toPublicLaborProfile,
  [PROFILE_TYPE.STORE]: toPublicStoreProfile,
  [PROFILE_TYPE.DIGITAL_CREATOR]: toPublicDigitalCreatorProfile,
  [PROFILE_TYPE.CLIENT]: toPublicClientProfile,
};

// Fire-and-forget from the banning/unbanning admin's point of view, but
// awaited here so a Mailgun failure surfaces in this request rather than
// racing the response — same reasoning jobController's own
// notify*Decision helpers already use. The status change has already
// saved by the time this runs, so a failed email never undoes it.
const notifyProfileStatusChanged = async (
  ownerId: mongoose.Types.ObjectId,
  banned: boolean,
  banReason?: string,
): Promise<void> => {
  const owner = await User.findById(ownerId).select("email fullName");
  if (!owner) return;

  await sendTemplatedEmail({
    to: owner.email,
    subject: banned ? "Your PolyGrid profile has been suspended" : "Your PolyGrid profile is active again",
    template: "profileStatusChanged",
    variables: { name: owner.fullName, banned, banReason },
  });

  await notify(
    ownerId,
    NOTIFICATION_TYPE.PROFILE_STATUS_CHANGED,
    banned ? "Your profile has been suspended" : "Your profile is active again",
    { banned, banReason },
  );
};

// @desc    Set a profile's moderation status to 'active' (unban/
//          reactivate) or 'banned' — the only path that can ever reach
//          'banned' on any PROFILE_MODEL_REGISTRY entry. Deliberately
//          generic, one endpoint for all six profile types, the same
//          "register it once" pattern Verification/profileSubscriptionSync
//          already use rather than six near-identical per-controller
//          endpoints. Self-service 'active'/'inactive' toggling ("I'm
//          taking a break") stays on each profile's own update endpoint
//          and never reaches here — see constants/profileStatus.ts.
//          An optional `reason` is recorded (bannedBy/bannedAt/banReason)
//          on a ban, and cleared again on an unban — before this, the
//          owner just found their page gone with no explanation on
//          either end.
// @route   PATCH /api/admin/profiles/:profileType/:id/status
// @access  Private (Admin / Super Admin only)
export const setProfileStatus = asyncHandler(async (req: Request, res: Response) => {
  const requester = req.user as IUser;
  const profileType = req.params.profileType as string;
  const id = req.params.id as string;

  if (!isKnownProfileType(profileType)) {
    res.status(400);
    throw new Error("Invalid profileType");
  }

  if (!mongoose.Types.ObjectId.isValid(id)) {
    res.status(404);
    throw new Error("Profile not found");
  }

  const Model = PROFILE_MODEL_REGISTRY[profileType];
  const profile = await Model.findById(id);

  if (!profile) {
    res.status(404);
    throw new Error("Profile not found");
  }

  const { status, reason } = req.body;
  const banned = status === PROFILE_STATUS.BANNED;

  profile.status = status;

  if (banned) {
    profile.bannedBy = requester._id;
    profile.bannedAt = new Date();
    profile.banReason = reason;
  } else {
    profile.bannedBy = undefined;
    profile.bannedAt = undefined;
    profile.banReason = undefined;
  }

  await profile.save();
  await notifyProfileStatusChanged(profile.userId, banned, profile.banReason);

  res.status(200).json({ profileType, id: profile.id, status: profile.status });
});

// @desc    View any profile's full detail, bypassing the public view's
//          gating entirely — banned, unverified, never subscribed, all of
//          it. The public single-view endpoints (e.g.
//          consultancyProfileController.getProfile) withhold content
//          exactly because that's a discoverability paywall tied to the
//          global subscription rule; an admin/customer_care reviewer
//          deciding whether to approve a KYC submission needs to see the
//          profile regardless of whether its owner happens to be
//          currently subscribed. Same REVIEW_ROLES read access as the
//          verification queue itself (GET /api/verifications) — this
//          exists for that workflow, not as a general-purpose admin
//          profile viewer.
// @route   GET /api/admin/profiles/:profileType/:id
// @access  Private (Admin / Super Admin / Customer Care — read-only)
export const getProfileForReview = asyncHandler(async (req: Request, res: Response) => {
  const profileType = req.params.profileType as string;
  const id = req.params.id as string;

  if (!isKnownProfileType(profileType)) {
    res.status(400);
    throw new Error("Invalid profileType");
  }

  if (!mongoose.Types.ObjectId.isValid(id)) {
    res.status(404);
    throw new Error("Profile not found");
  }

  const Model = PROFILE_MODEL_REGISTRY[profileType];
  const profile = await Model.findById(id);

  if (!profile) {
    res.status(404);
    throw new Error("Profile not found");
  }

  res.status(200).json({
    // Ban detail is moderation-only — deliberately never added to
    // toPublicXProfile itself (every pillar's public search/profile-page
    // serializer), which would leak a ban reason to the public. Spread
    // on top here instead, same "extra fields only the admin view gets"
    // instinct reviewController.toAdminReview already uses.
    ...(PROFILE_SERIALIZERS[profileType](profile) as Record<string, unknown>),
    bannedBy: profile.bannedBy,
    bannedAt: profile.bannedAt,
    banReason: profile.banReason,
  });
});

// @desc    Search profiles of one type — the Profile moderation page's
//          search. Nothing previously let an admin/customer_care reviewer
//          find a profile to moderate at all; a profile was only ever
//          reached from its public page or the verification drawer. `q`
//          matches the profile's own name field (see PROFILE_NAME_FIELD)
//          or slug (see PROFILE_SLUG_FIELD — ClientProfile has none), or
//          the owning User's fullName/email. `status` includes
//          `banned`/`inactive`, unlike every public search/browse
//          endpoint for this same profile type, which excludes both (see
//          constants/profileStatus.ts).
// @route   GET /api/admin/profiles?profileType=&q=&status=&page=&limit=
// @access  Private (Admin / Super Admin / Customer Care — read-only)
export const searchProfilesForAdmin = asyncHandler(async (req: Request, res: Response) => {
  const profileType = req.query.profileType as string | undefined;

  if (!profileType || !isKnownProfileType(profileType)) {
    res.status(400);
    throw new Error("A valid profileType is required");
  }

  const Model = PROFILE_MODEL_REGISTRY[profileType];
  const nameField = PROFILE_NAME_FIELD[profileType];
  const slugField = PROFILE_SLUG_FIELD[profileType];

  const { q, status } = req.query as { q?: string; status?: string };

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const filter: FilterQuery<any> = {};

  if (status && Object.values(PROFILE_STATUS).includes(status as ProfileStatus)) {
    filter.status = status as ProfileStatus;
  }

  if (q && q.trim()) {
    // Same "escape before building a RegExp" convention getUsers/searchJobs
    // already use.
    const escaped = q.trim().replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const pattern = new RegExp(escaped, "i");

    const matchingUsers = await User.find({ $or: [{ fullName: pattern }, { email: pattern }] }).select("_id");

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const orConditions: FilterQuery<any>[] = [
      { [nameField]: pattern },
      { userId: { $in: matchingUsers.map((u) => u._id) } },
    ];
    if (slugField) orConditions.push({ [slugField]: pattern });

    filter.$or = orConditions;
  }

  const page = Math.max(Number(req.query.page) || 1, 1);
  const limit = Math.min(Number(req.query.limit) || 20, 100);
  const skip = (page - 1) * limit;

  const [profiles, total] = await Promise.all([
    Model.find(filter).sort({ createdAt: -1 }).skip(skip).limit(limit),
    Model.countDocuments(filter),
  ]);

  const owners = await User.find({ _id: { $in: profiles.map((profile) => profile.userId) } }).select(
    "fullName email",
  );
  const ownerById = new Map(owners.map((owner) => [owner.id, owner]));

  res.status(200).json({
    data: profiles.map((profile) => {
      const owner = ownerById.get(profile.userId.toString());

      return {
        id: profile.id,
        profileType,
        name: profile[nameField],
        slug: slugField ? profile[slugField] : undefined,
        status: profile.status,
        isVerified: profile.isVerified,
        owner: owner ? { id: owner.id, fullName: owner.fullName, email: owner.email } : null,
        ratingAverage: profile.ratingAverage,
        ratingCount: profile.ratingCount,
        createdAt: profile.createdAt,
      };
    }),
    pagination: { total, page, limit, totalPages: Math.ceil(total / limit) },
  });
});
