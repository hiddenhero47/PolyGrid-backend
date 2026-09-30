import express from "express";
import { reportMessage, getMessageReports } from "../controllers/conversationController";
import { protect, secureRole } from "../middleware/authMiddleware";
import { REVIEW_ROLES } from "../models/userModel";

const router = express.Router();

router.post("/:id/report", protect, reportMessage);
// Read-only — nothing here mutates a report, so there's no admin-only
// counterpart route to exclude customer_care from.
router.get("/reports", secureRole([...REVIEW_ROLES]), getMessageReports);

export default router;
