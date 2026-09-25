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
} from "../controllers/jobController";
import { protect, secureRole } from "../middleware/authMiddleware";
import { SYSTEM_ROLE } from "../models/userModel";

const router = express.Router();

router.post("/", protect, createJob);
router.get("/mine", protect, getMyJobs);
router.get("/disputes", secureRole([SYSTEM_ROLE.ADMIN, SYSTEM_ROLE.SUPER_ADMIN]), getDisputedJobs);
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

export default router;
