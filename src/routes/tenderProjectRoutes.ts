import express from "express";
import {
  createTenderProject,
  updateMyTenderProject,
  addProjectFiles,
  removeProjectFile,
  cancelMyTenderProject,
  getMyTenderProjects,
  listTenderProjects,
  getTenderProject,
  submitBid,
  updateMyBid,
  withdrawMyBid,
  getMyBids,
  getProjectBids,
  awardBid,
  getPublicTenderSummary,
} from "../controllers/tenderProjectController";
import { protect } from "../middleware/authMiddleware";
import { validateBody } from "../validators/validate";
import {
  createTenderProjectSchema,
  updateTenderProjectSchema,
  submitBidSchema,
  updateMyBidSchema,
  awardBidSchema,
} from "../validators/tenderProject/tenderProjectValidator";

const router = express.Router();

// createTenderProject checks for a subscribed ClientProfile itself
// (same inline-check shape as contractor/worker eligibility elsewhere in
// this file), replacing the bare requireActiveSubscription gate this used
// before ClientProfile existed.
router.post("/", protect, validateBody(createTenderProjectSchema), createTenderProject);
router.get("/", protect, listTenderProjects);
router.get("/me", protect, getMyTenderProjects);
router.get("/bids/mine", protect, getMyBids);
// Public, unauthenticated — must stay registered before the "/:id"
// wildcard below, or that catch-all would swallow this literal path.
router.get("/public-summary", getPublicTenderSummary);

router.get("/:id", protect, getTenderProject);
router.patch("/:id", protect, validateBody(updateTenderProjectSchema), updateMyTenderProject);
router.post("/:id/files", protect, addProjectFiles);
router.delete("/:id/files/:fileName", protect, removeProjectFile);
router.patch("/:id/cancel", protect, cancelMyTenderProject);
router.patch("/:id/award", protect, validateBody(awardBidSchema), awardBid);

router.post("/:id/bids", protect, validateBody(submitBidSchema), submitBid);
router.get("/:id/bids", protect, getProjectBids);
router.patch("/:id/bids/mine", protect, validateBody(updateMyBidSchema), updateMyBid);
router.patch("/:id/bids/mine/withdraw", protect, withdrawMyBid);

export default router;
