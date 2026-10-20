import express from "express";
import {
  createReview,
  getProfileReviews,
  getReviewsForModeration,
  hideReview,
  unhideReview,
  deleteReview,
} from "../controllers/reviewController";
import { protect, secureRole } from "../middleware/authMiddleware";
import { SYSTEM_ROLE, REVIEW_ROLES } from "../models/userModel";
import { validateBody } from "../validators/validate";
import { createReviewSchema, hideReviewSchema } from "../validators/review/reviewValidator";

const router = express.Router();

router.post("/", protect, validateBody(createReviewSchema), createReview);
router.get("/", getProfileReviews);
router.get("/moderation", secureRole([...REVIEW_ROLES]), getReviewsForModeration);
router.patch(
  "/:id/hide",
  secureRole([SYSTEM_ROLE.ADMIN, SYSTEM_ROLE.SUPER_ADMIN]),
  validateBody(hideReviewSchema),
  hideReview,
);
router.patch("/:id/unhide", secureRole([SYSTEM_ROLE.ADMIN, SYSTEM_ROLE.SUPER_ADMIN]), unhideReview);
router.delete("/:id", secureRole([SYSTEM_ROLE.ADMIN, SYSTEM_ROLE.SUPER_ADMIN]), deleteReview);

export default router;
