import express from "express";
import {
  submitVerification,
  getMyVerifications,
  getVerifications,
  approveVerification,
  rejectVerification,
} from "../controllers/verificationController";
import { protect, secureRole } from "../middleware/authMiddleware";
import { SYSTEM_ROLE, REVIEW_ROLES } from "../models/userModel";
import { validateBody } from "../validators/validate";
import { rejectVerificationSchema } from "../validators/verificationValidator";

const router = express.Router();

// multipart/form-data — see submitVerification's own doc comment for the
// exact shape. forms.any() (multer) is already mounted globally in app.ts.
router.post("/", protect, submitVerification);
router.get("/me", protect, getMyVerifications);
// Read-only queue — customer_care can see it too; approve/reject below stay
// admin-only since those actually flip a profile's isVerified.
router.get("/", secureRole([...REVIEW_ROLES]), getVerifications);
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
