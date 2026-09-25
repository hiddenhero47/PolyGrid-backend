import express from "express";
import {
  submitVerification,
  getMyVerifications,
  getVerifications,
  approveVerification,
  rejectVerification,
} from "../controllers/verificationController";
import { protect, secureRole } from "../middleware/authMiddleware";
import { SYSTEM_ROLE } from "../models/userModel";
import { validateBody } from "../validators/validate";
import { rejectVerificationSchema } from "../validators/verificationValidator";

const router = express.Router();

// multipart/form-data — see submitVerification's own doc comment for the
// exact shape. forms.any() (multer) is already mounted globally in app.ts.
router.post("/", protect, submitVerification);
router.get("/me", protect, getMyVerifications);
router.get("/", secureRole([SYSTEM_ROLE.ADMIN, SYSTEM_ROLE.SUPER_ADMIN]), getVerifications);
router.patch(
  "/:id/approve",
  secureRole([SYSTEM_ROLE.ADMIN, SYSTEM_ROLE.SUPER_ADMIN]),
  approveVerification,
);
router.patch(
  "/:id/reject",
  secureRole([SYSTEM_ROLE.ADMIN, SYSTEM_ROLE.SUPER_ADMIN]),
  validateBody(rejectVerificationSchema),
  rejectVerification,
);

export default router;
