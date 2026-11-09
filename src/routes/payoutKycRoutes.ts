import express from "express";
import { getPayoutKycRecords, approvePayoutKyc, rejectPayoutKyc } from "../controllers/payoutKycController";
import { secureRole } from "../middleware/authMiddleware";
import { SYSTEM_ROLE, REVIEW_ROLES } from "../models/userModel";
import { validateBody } from "../validators/validate";
import { rejectPayoutKycSchema } from "../validators/user/payoutKycValidator";

// The admin-review side of payout KYC (document track only — see
// payoutKycController.ts). Self-service submission/status live under
// /api/users/me/payout-kyc instead (userRoutes.ts), same sibling
// placement as /api/users/payout-account.
const router = express.Router();

// Read-only queue — customer_care can see it too; approve/reject stay
// admin-only, same split verificationRoutes.ts already uses.
router.get("/", secureRole([...REVIEW_ROLES]), getPayoutKycRecords);
router.patch("/:id/approve", secureRole([SYSTEM_ROLE.ADMIN, SYSTEM_ROLE.SUPER_ADMIN]), approvePayoutKyc);
router.patch(
  "/:id/reject",
  secureRole([SYSTEM_ROLE.ADMIN, SYSTEM_ROLE.SUPER_ADMIN]),
  validateBody(rejectPayoutKycSchema),
  rejectPayoutKyc,
);

export default router;
