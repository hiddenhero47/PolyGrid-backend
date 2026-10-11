import express from "express";
import { getTopProfiles, getPlatformOverview } from "../controllers/statsController";
import { secureRole } from "../middleware/authMiddleware";
import { REVIEW_ROLES } from "../models/userModel";

const router = express.Router();

router.get("/top-profiles", getTopProfiles);
router.get("/overview", secureRole([...REVIEW_ROLES]), getPlatformOverview);

export default router;
