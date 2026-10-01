import express from "express";
import {
  createTenderProject,
  updateMyTenderProject,
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
} from "../controllers/tenderProjectController";
import { protect, requireActiveSubscription } from "../middleware/authMiddleware";

const router = express.Router();

router.post("/", protect, requireActiveSubscription, createTenderProject);
router.get("/", protect, listTenderProjects);
router.get("/me", protect, getMyTenderProjects);
router.get("/bids/mine", protect, getMyBids);

router.get("/:id", protect, getTenderProject);
router.patch("/:id", protect, updateMyTenderProject);
router.patch("/:id/cancel", protect, cancelMyTenderProject);
router.patch("/:id/award", protect, awardBid);

router.post("/:id/bids", protect, submitBid);
router.get("/:id/bids", protect, getProjectBids);
router.patch("/:id/bids/mine", protect, updateMyBid);
router.patch("/:id/bids/mine/withdraw", protect, withdrawMyBid);

export default router;
