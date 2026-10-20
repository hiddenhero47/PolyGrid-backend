import express from "express";
import {
  createJobOpening,
  updateMyJobOpening,
  addOpeningFiles,
  removeOpeningFile,
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
  getPublicJobOpeningSummary,
} from "../controllers/jobOpeningController";
import { protect } from "../middleware/authMiddleware";
import { validateBody } from "../validators/validate";
import {
  createJobOpeningSchema,
  updateJobOpeningSchema,
  applyToJobOpeningSchema,
  updateMyApplicationSchema,
} from "../validators/jobOpening/jobOpeningValidator";

const router = express.Router();

router.post("/", protect, validateBody(createJobOpeningSchema), createJobOpening);
router.get("/", protect, listJobOpenings);
router.get("/me", protect, getMyJobOpenings);
router.get("/applications/mine", protect, getMyApplications);
// Public, unauthenticated — must stay registered before the "/:id"
// wildcard below, or that catch-all would swallow this literal path.
router.get("/public-summary", getPublicJobOpeningSummary);

router.get("/:id", protect, getJobOpening);
router.patch("/:id", protect, validateBody(updateJobOpeningSchema), updateMyJobOpening);
router.post("/:id/files", protect, addOpeningFiles);
router.delete("/:id/files/:fileName", protect, removeOpeningFile);
router.patch("/:id/cancel", protect, cancelMyJobOpening);

router.post("/:id/applications", protect, validateBody(applyToJobOpeningSchema), applyToJobOpening);
router.get("/:id/applications", protect, getOpeningApplications);
router.patch("/:id/applications/mine", protect, validateBody(updateMyApplicationSchema), updateMyApplication);
router.patch("/:id/applications/mine/withdraw", protect, withdrawMyApplication);
router.patch("/:id/applications/:applicationId/accept", protect, acceptApplication);
router.patch("/:id/applications/:applicationId/reject", protect, rejectApplication);

export default router;
