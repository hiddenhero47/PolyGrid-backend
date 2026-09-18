import express from "express";
import {
  grantSubscription,
  getMySubscriptions,
  getUserSubscriptions,
  getCurrentPlan,
} from "../controllers/subscriptionController";
import { protect, secureRole, attachCurrentPlan } from "../middleware/authMiddleware";
import { SYSTEM_ROLE } from "../models/userModel";

const router = express.Router();

router.get("/me", protect, getMySubscriptions);
router.get("/current", protect, attachCurrentPlan, getCurrentPlan);
router.get(
  "/users/:userId",
  secureRole([SYSTEM_ROLE.ADMIN, SYSTEM_ROLE.SUPER_ADMIN]),
  getUserSubscriptions,
);
router.post(
  "/",
  secureRole([SYSTEM_ROLE.ADMIN, SYSTEM_ROLE.SUPER_ADMIN]),
  grantSubscription,
);

export default router;
