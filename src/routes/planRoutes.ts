import express from "express";
import { listPlans, getPlan, createPlan, updatePlan } from "../controllers/planController";
import { secureRole } from "../middleware/authMiddleware";
import { SYSTEM_ROLE } from "../models/userModel";

const router = express.Router();

router.get("/", listPlans);
router.get("/:id", getPlan);
router.post("/", secureRole(SYSTEM_ROLE.SUPER_ADMIN), createPlan);
router.put("/:id", secureRole(SYSTEM_ROLE.SUPER_ADMIN), updatePlan);

export default router;
