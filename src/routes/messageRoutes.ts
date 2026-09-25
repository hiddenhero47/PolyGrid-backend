import express from "express";
import { reportMessage, getMessageReports } from "../controllers/conversationController";
import { protect, secureRole } from "../middleware/authMiddleware";
import { SYSTEM_ROLE } from "../models/userModel";

const router = express.Router();

router.post("/:id/report", protect, reportMessage);
router.get("/reports", secureRole([SYSTEM_ROLE.ADMIN, SYSTEM_ROLE.SUPER_ADMIN]), getMessageReports);

export default router;
