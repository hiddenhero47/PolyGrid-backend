import asyncHandler from "express-async-handler";
import { Request, Response } from "express";
import {
  PayoutKyc,
  IPayoutKyc,
  PAYOUT_KYC_METHOD,
  PAYOUT_KYC_STATUS,
  PAYOUT_KYC_ID_TYPE,
  PayoutKycIdType,
} from "../models/payoutKycModel";
import { PayoutKycHistory } from "../models/payoutKycHistoryModel";
import { User, IUser } from "../models/userModel";
import { ITemplateDocument, TEMPLATE_DOCUMENT_FORMAT } from "../models/verificationTemplateModel";
import { resolveAndSaveDocuments } from "./verificationController";
import { getSystemSettings } from "../helpers/systemSettings";
import { getIdentityVerificationProvider } from "../providers/identityVerificationProviders";
import { AppError } from "../middleware/errorMiddleware";
import { NOTIFICATION_TYPE } from "../models/notificationModel";
import { notify } from "../helpers/notify";

const badRequest = (message: string): AppError => {
  const error: AppError = new Error(message);
  error.statusCode = 400;
  return error;
};

// Always exactly these 3 slots, regardless of country — see
// payoutKycModel.ts's own comment on IPayoutKycDocuments.
const REQUIRED_DOCUMENTS: ITemplateDocument[] = [
  { type: "idFront", label: "Government ID — front", required: true, acceptedFormats: [TEMPLATE_DOCUMENT_FORMAT.JPG, TEMPLATE_DOCUMENT_FORMAT.PNG, TEMPLATE_DOCUMENT_FORMAT.WEBP] },
  { type: "idBack", label: "Government ID — back", required: true, acceptedFormats: [TEMPLATE_DOCUMENT_FORMAT.JPG, TEMPLATE_DOCUMENT_FORMAT.PNG, TEMPLATE_DOCUMENT_FORMAT.WEBP] },
  { type: "face", label: "A clear photo of your face", required: true, acceptedFormats: [TEMPLATE_DOCUMENT_FORMAT.JPG, TEMPLATE_DOCUMENT_FORMAT.PNG, TEMPLATE_DOCUMENT_FORMAT.WEBP] },
];

const ID_NUMBER_PATTERN = /^\d{11}$/;

// @desc    Submit payout KYC — automated (BVN/NIN + name match) if the
//          caller's own country has a registered vendor in
//          SystemSettings.countryKycProviders, otherwise the document
//          fallback (3 fixed images, admin-reviewed). Always replaces any
//          existing record for this user — there's only ever one live
//          answer to "is this user payout-KYC verified right now" (unlike
//          Verification's permanent submission history).
// @route   POST /api/users/me/payout-kyc
// @access  Private — behind verifyIdentity (password/2FA re-proof), same
//          sensitivity tier as updatePayoutAccount.
export const submitPayoutKyc = asyncHandler(async (req: Request, res: Response) => {
  const requester = req.user as IUser;

  if (!requester.country) {
    throw badRequest("Set your country before submitting payout KYC");
  }

  const settings = await getSystemSettings();
  const kycProvider = settings.countryKycProviders[requester.country];

  if (kycProvider) {
    const { idType, idNumber } = req.body as { idType?: string; idNumber?: string };

    if (idType !== PAYOUT_KYC_ID_TYPE.BVN && idType !== PAYOUT_KYC_ID_TYPE.NIN) {
      throw badRequest("idType must be 'bvn' or 'nin'");
    }
    if (!idNumber || !ID_NUMBER_PATTERN.test(idNumber)) {
      throw badRequest("idNumber must be an 11-digit number");
    }

    const { matched, reference } = await getIdentityVerificationProvider(kycProvider).verifyMatch({
      idType: idType as PayoutKycIdType,
      idNumber,
      firstName: requester.fullName.firstName,
      lastName: requester.fullName.lastName,
    });

    // $set/$unset explicitly — a plain object here would have Mongoose
    // silently drop any `undefined` value rather than clearing it, which
    // would leave a prior attempt's document-track fields (or this
    // track's own stale failureReason/verifiedAt) lingering. Note: this
    // doesn't delete any document-track image files from storage if a
    // user previously went through that track and is now switching —
    // an accepted, rare-case cleanup gap, not a leak (those files stay
    // private either way).
    const record = await PayoutKyc.findOneAndUpdate(
      { user: requester._id },
      {
        $set: {
          user: requester._id,
          country: requester.country,
          method: PAYOUT_KYC_METHOD.AUTOMATED,
          idType,
          provider: kycProvider,
          last4: idNumber.slice(-4),
          providerReference: reference,
          status: matched ? PAYOUT_KYC_STATUS.VERIFIED : PAYOUT_KYC_STATUS.FAILED,
          ...(matched
            ? { verifiedAt: new Date() }
            : { failureReason: "Submitted name doesn't match the registry record for this number" }),
        },
        $unset: {
          documents: "",
          reviewedBy: "",
          reviewedAt: "",
          rejectionReason: "",
          ...(matched ? { failureReason: "" } : { verifiedAt: "" }),
        },
      },
      { upsert: true, new: true, setDefaultsOnInsert: true },
    );

    if (matched) {
      await PayoutKycHistory.create({
        user: requester._id,
        fullName: { firstName: requester.fullName.firstName, lastName: requester.fullName.lastName },
        country: requester.country,
        method: PAYOUT_KYC_METHOD.AUTOMATED,
        idType,
        provider: kycProvider,
        last4: idNumber.slice(-4),
        providerReference: reference,
        verifiedAt: record.verifiedAt,
      });
    }

    res.status(201).json(record);
    return;
  }

  // Document track — no automated vendor for this country.
  const files = (req.files as Express.Multer.File[] | undefined) ?? [];
  const { documents, warnings, issues } = await resolveAndSaveDocuments(requester.id, REQUIRED_DOCUMENTS, files);

  if (issues.length > 0) {
    throw badRequest(issues.join("; "));
  }

  const record = await PayoutKyc.findOneAndUpdate(
    { user: requester._id },
    {
      $set: {
        user: requester._id,
        country: requester.country,
        method: PAYOUT_KYC_METHOD.DOCUMENT,
        documents: {
          idFront: documents.find((doc) => doc.type === "idFront"),
          idBack: documents.find((doc) => doc.type === "idBack"),
          face: documents.find((doc) => doc.type === "face"),
        },
        status: PAYOUT_KYC_STATUS.PENDING,
      },
      $unset: {
        idType: "",
        provider: "",
        last4: "",
        providerReference: "",
        verifiedAt: "",
        failureReason: "",
        reviewedBy: "",
        reviewedAt: "",
        rejectionReason: "",
      },
    },
    { upsert: true, new: true, setDefaultsOnInsert: true },
  );

  res.status(201).json({ ...record.toObject(), warnings });
});

// @desc    My own current payout-KYC status, plus which track I'd get if
//          I haven't submitted yet (or submit again) — the frontend needs
//          this to know whether to render the BVN/NIN form or the 3-image
//          upload form before the user ever submits anything.
// @route   GET /api/users/me/payout-kyc
// @access  Private
export const getMyPayoutKyc = asyncHandler(async (req: Request, res: Response) => {
  const requester = req.user as IUser;
  const [record, settings] = await Promise.all([
    PayoutKyc.findOne({ user: requester._id }),
    getSystemSettings(),
  ]);

  const track = requester.country && settings.countryKycProviders[requester.country]
    ? PAYOUT_KYC_METHOD.AUTOMATED
    : PAYOUT_KYC_METHOD.DOCUMENT;

  res.status(200).json({ record, track });
});

// @desc    Revoke my own payout KYC — the only way to unlock fullName/
//          country editing once verified (see userController.ts's
//          updateUserProfile). Clears the payout account too: it can
//          only ever exist alongside a verified record (see
//          updatePayoutAccount), so once that's gone the account's own
//          name/country can no longer be vouched for either.
// @route   DELETE /api/users/me/payout-kyc
// @access  Private — behind verifyIdentity, same sensitivity tier as
//          /payout-account.
export const revokeMyPayoutKyc = asyncHandler(async (req: Request, res: Response) => {
  const requester = req.user as IUser;

  const payoutKyc = await PayoutKyc.findOneAndDelete({ user: requester._id });
  if (!payoutKyc) {
    res.status(404);
    throw new Error("You don't have a payout KYC record to revoke");
  }

  const user = await User.findById(requester.id);
  const hadPayoutAccount = Boolean(user?.payoutAccount);
  if (user?.payoutAccount) {
    user.payoutAccount = undefined;
    await user.save();
  }

  await notify(
    requester._id,
    NOTIFICATION_TYPE.PAYOUT_KYC_REVOKED,
    "Your payout KYC was revoked. You can now change your name/country, then verify again when you're ready.",
  );

  if (hadPayoutAccount) {
    await notify(
      requester._id,
      NOTIFICATION_TYPE.PAYOUT_ACCOUNT_CLEARED,
      "Your saved payout account was removed along with your payout KYC — please add it again once you're re-verified.",
    );
  }

  res.status(200).json({ message: "Payout KYC revoked" });
});

const paginationParams = (req: Request) => {
  const page = Math.max(Number(req.query.page) || 1, 1);
  const limit = Math.min(Number(req.query.limit) || 20, 100);
  return { page, limit, skip: (page - 1) * limit };
};

// @desc    The document-track admin review queue (automated-track records
//          never sit PENDING — the vendor's match result decides them
//          immediately).
// @route   GET /api/payout-kyc?status=pending
// @access  Private (REVIEW_ROLES — read-only)
export const getPayoutKycRecords = asyncHandler(async (req: Request, res: Response) => {
  const { page, limit, skip } = paginationParams(req);
  const { status } = req.query as { status?: string };

  const filter: Record<string, unknown> = {};
  if (status && Object.values(PAYOUT_KYC_STATUS).includes(status as (typeof PAYOUT_KYC_STATUS)[keyof typeof PAYOUT_KYC_STATUS])) {
    filter.status = status;
  }

  const [data, total] = await Promise.all([
    PayoutKyc.find(filter)
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(limit)
      .populate("user", "fullName email country"),
    PayoutKyc.countDocuments(filter),
  ]);

  res.status(200).json({ data, pagination: { total, page, limit, totalPages: Math.ceil(total / limit) } });
});

// @desc    Permanent bookkeeping log of every payout KYC verification
//          that has ever happened — unlike the live PayoutKyc record
//          above (one per user, overwritten/deleted as they
//          resubmit/revoke), this never changes once written. Optional
//          `userId` narrows it to one person's own verification history.
// @route   GET /api/payout-kyc/history?userId=
// @access  Private (REVIEW_ROLES — read-only)
export const getPayoutKycHistory = asyncHandler(async (req: Request, res: Response) => {
  const { page, limit, skip } = paginationParams(req);
  const { userId } = req.query as { userId?: string };

  const filter: Record<string, unknown> = {};
  if (userId) {
    filter.user = userId;
  }

  const [data, total] = await Promise.all([
    PayoutKycHistory.find(filter)
      .sort({ verifiedAt: -1 })
      .skip(skip)
      .limit(limit)
      .populate("user", "userName email")
      .populate("reviewedBy", "userName email"),
    PayoutKycHistory.countDocuments(filter),
  ]);

  res.status(200).json({ data, pagination: { total, page, limit, totalPages: Math.ceil(total / limit) } });
});

const loadPendingDocumentKyc = async (id: string): Promise<IPayoutKyc> => {
  const record = await PayoutKyc.findById(id);

  if (!record) {
    const error: AppError = new Error("Payout KYC record not found");
    error.statusCode = 404;
    throw error;
  }

  if (record.method !== PAYOUT_KYC_METHOD.DOCUMENT) {
    throw badRequest("Only document-track payout KYC can be reviewed by hand");
  }

  if (record.status !== PAYOUT_KYC_STATUS.PENDING) {
    throw badRequest(`This record has already been marked ${record.status}`);
  }

  return record;
};

// @desc    Approve a document-track payout-KYC submission.
// @route   PATCH /api/payout-kyc/:id/approve
// @access  Private (Admin / Super Admin only)
export const approvePayoutKyc = asyncHandler(async (req: Request, res: Response) => {
  const admin = req.user as IUser;
  const record = await loadPendingDocumentKyc(req.params.id as string);

  record.status = PAYOUT_KYC_STATUS.VERIFIED;
  record.verifiedAt = new Date();
  record.reviewedBy = admin._id as typeof record.reviewedBy;
  record.reviewedAt = new Date();
  await record.save();

  const owner = await User.findById(record.user);
  if (owner) {
    await PayoutKycHistory.create({
      user: record.user,
      fullName: { firstName: owner.fullName.firstName, lastName: owner.fullName.lastName },
      country: record.country,
      method: PAYOUT_KYC_METHOD.DOCUMENT,
      documents: record.documents,
      reviewedBy: admin._id,
      verifiedAt: record.verifiedAt,
    });
  }

  await notify(record.user, NOTIFICATION_TYPE.PAYOUT_KYC_DECIDED, "Your payout KYC was approved", {
    payoutKycId: record.id,
    approved: true,
  });

  res.status(200).json(record);
});

// @desc    Reject a document-track payout-KYC submission.
// @route   PATCH /api/payout-kyc/:id/reject
// @access  Private (Admin / Super Admin only)
export const rejectPayoutKyc = asyncHandler(async (req: Request, res: Response) => {
  const admin = req.user as IUser;
  const record = await loadPendingDocumentKyc(req.params.id as string);
  const { rejectionReason } = req.body;

  record.status = PAYOUT_KYC_STATUS.FAILED;
  record.failureReason = rejectionReason;
  record.rejectionReason = rejectionReason;
  record.reviewedBy = admin._id as typeof record.reviewedBy;
  record.reviewedAt = new Date();
  await record.save();

  await notify(record.user, NOTIFICATION_TYPE.PAYOUT_KYC_DECIDED, "Your payout KYC was rejected", {
    payoutKycId: record.id,
    approved: false,
    rejectionReason,
  });

  res.status(200).json(record);
});
