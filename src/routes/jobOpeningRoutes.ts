import express from "express";
import {
  createJobOpening,
  updateMyJobOpening,
  cancelMyJobOpening,
  getMyJobOpenings,
  listJobOpenings,
  getJobOpening,
  applyToJobOpening,
  updateMyApplication,
  withdrawMyApplication,
  getMyApplications,
  getOpeningApplications,
  acceptApplication,
  rejectApplication,
} from "../controllers/jobOpeningController";
import { protect } from "../middleware/authMiddleware";

const router = express.Router();

router.post("/", protect, createJobOpening);
router.get("/", protect, listJobOpenings);
router.get("/me", protect, getMyJobOpenings);
router.get("/applications/mine", protect, getMyApplications);

router.get("/:id", protect, getJobOpening);
router.patch("/:id", protect, updateMyJobOpening);
router.patch("/:id/cancel", protect, cancelMyJobOpening);

router.post("/:id/applications", protect, applyToJobOpening);
router.get("/:id/applications", protect, getOpeningApplications);
router.patch("/:id/applications/mine", protect, updateMyApplication);
router.patch("/:id/applications/mine/withdraw", protect, withdrawMyApplication);
router.patch("/:id/applications/:applicationId/accept", protect, acceptApplication);
router.patch("/:id/applications/:applicationId/reject", protect, rejectApplication);

export default router;
