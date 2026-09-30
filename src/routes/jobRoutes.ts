import express from "express";
import {
  createJob,
  getJob,
  getMyJobs,
  confirmJob,
  updateJob,
  proposeStages,
  acceptProposedStages,
  rejectProposedStages,
  markStageDone,
  verifyStage,
  uploadContract,
  raiseDispute,
  getDisputedJobs,
  resolveDispute,
  cancelJob,
  recordPayment,
  getJobPayments,
  requestRefund,
  getPendingRefundRequests,
  approveRefundRequest,
  declineRefundRequest,
  requestPayout,
  getPendingPayoutRequests,
  approvePayoutRequest,
  declinePayoutRequest,
} from "../controllers/jobController";
import { protect, secureRole } from "../middleware/authMiddleware";
import { SYSTEM_ROLE, REVIEW_ROLES } from "../models/userModel";

const router = express.Router();

router.post("/", protect, createJob);
router.get("/mine", protect, getMyJobs);
// Read-only queues — customer_care can see them too; resolving/approving/
// declining are real changes and stay admin-only below. Must be
// registered before the "/:id" routes so they don't get swallowed as a
// job id.
router.get("/disputes", secureRole([...REVIEW_ROLES]), getDisputedJobs);
router.get("/refund-requests", secureRole([...REVIEW_ROLES]), getPendingRefundRequests);
router.get("/payout-requests", secureRole([...REVIEW_ROLES]), getPendingPayoutRequests);
router.get("/:id", protect, getJob);
router.patch("/:id", protect, updateJob);
router.patch("/:id/confirm", protect, confirmJob);
router.patch("/:id/cancel", protect, cancelJob);

router.post("/:id/stages/propose", protect, proposeStages);
router.patch("/:id/stages/accept", protect, acceptProposedStages);
router.patch("/:id/stages/reject", protect, rejectProposedStages);
router.patch("/:id/stages/:stageId/done", protect, markStageDone);
router.patch("/:id/stages/:stageId/verify", protect, verifyStage);

router.post("/:id/contract", protect, uploadContract);

router.patch("/:id/dispute", protect, raiseDispute);
router.patch(
  "/:id/dispute/resolve",
  secureRole([SYSTEM_ROLE.ADMIN, SYSTEM_ROLE.SUPER_ADMIN]),
  resolveDispute,
);

router.post(
  "/:id/payments",
  secureRole([SYSTEM_ROLE.ADMIN, SYSTEM_ROLE.SUPER_ADMIN]),
  recordPayment,
);
// Read-only — customer_care can see a job's payment history too; the two
// mutating money routes below stay admin-only.
router.get("/:id/payments", secureRole([...REVIEW_ROLES]), getJobPayments);

router.post("/:id/refund-requests", protect, requestRefund);
router.patch(
  "/:id/refund-requests/:refundId/approve",
  secureRole([SYSTEM_ROLE.ADMIN, SYSTEM_ROLE.SUPER_ADMIN]),
  approveRefundRequest,
);
router.patch(
  "/:id/refund-requests/:refundId/decline",
  secureRole([SYSTEM_ROLE.ADMIN, SYSTEM_ROLE.SUPER_ADMIN]),
  declineRefundRequest,
);

router.post("/:id/payout-requests", protect, requestPayout);
router.patch(
  "/:id/payout-requests/:payoutId/approve",
  secureRole([SYSTEM_ROLE.ADMIN, SYSTEM_ROLE.SUPER_ADMIN]),
  approvePayoutRequest,
);
router.patch(
  "/:id/payout-requests/:payoutId/decline",
  secureRole([SYSTEM_ROLE.ADMIN, SYSTEM_ROLE.SUPER_ADMIN]),
  declinePayoutRequest,
);

export default router;
