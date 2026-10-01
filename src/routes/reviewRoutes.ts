import express from "express";
import { createReview, getProfileReviews } from "../controllers/reviewController";
import { protect } from "../middleware/authMiddleware";

const router = express.Router();

router.post("/", protect, createReview);
router.get("/", getProfileReviews);

export default router;
