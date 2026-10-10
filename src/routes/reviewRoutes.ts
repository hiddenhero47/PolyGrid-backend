import express from "express";
import { createReview, getProfileReviews } from "../controllers/reviewController";
import { protect } from "../middleware/authMiddleware";
import { validateBody } from "../validators/validate";
import { createReviewSchema } from "../validators/review/reviewValidator";

const router = express.Router();

router.post("/", protect, validateBody(createReviewSchema), createReview);
router.get("/", getProfileReviews);

export default router;
