import express from "express";
import { reportMessage, getMessageReports, resolveMessageReport } from "../controllers/conversationController";
import { protect, secureRole } from "../middleware/authMiddleware";
import { REVIEW_ROLES, SYSTEM_ROLE } from "../models/userModel";
import { validateBody } from "../validators/validate";
import { reportMessageSchema, resolveMessageReportSchema } from "../validators/conversation/conversationValidator";

const router = express.Router();

router.post("/:id/report", protect, validateBody(reportMessageSchema), reportMessage);
// Viewing the queue stays read-only for customer_care, same convention
// as every other review queue — but resolving one is a real mutation,
// so that stays Admin/Super-Admin-only.
router.get("/reports", secureRole([...REVIEW_ROLES]), getMessageReports);
router.patch(
  "/reports/:id/resolve",
  secureRole([SYSTEM_ROLE.ADMIN, SYSTEM_ROLE.SUPER_ADMIN]),
  validateBody(resolveMessageReportSchema),
  resolveMessageReport,
);

export default router;
