import express from "express";
import { setProfileStatus, getProfileForReview } from "../controllers/adminProfileController";
import { secureRole } from "../middleware/authMiddleware";
import { SYSTEM_ROLE, REVIEW_ROLES } from "../models/userModel";
import { validateBody } from "../validators/validate";
import { setProfileStatusSchema } from "../validators/admin/adminProfileValidator";

const router = express.Router();

router.get("/:profileType/:id", secureRole([...REVIEW_ROLES]), getProfileForReview);
router.patch(
  "/:profileType/:id/status",
  secureRole([SYSTEM_ROLE.ADMIN, SYSTEM_ROLE.SUPER_ADMIN]),
  validateBody(setProfileStatusSchema),
  setProfileStatus,
);

export default router;
