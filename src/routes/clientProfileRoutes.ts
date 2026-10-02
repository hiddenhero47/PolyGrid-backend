import express from "express";
import {
  createClientProfile,
  getMyClientProfile,
  updateMyClientProfile,
  getClientProfile,
} from "../controllers/clientProfileController";
import { protect } from "../middleware/authMiddleware";

const router = express.Router();

router.post("/", protect, createClientProfile);
router.get("/me", protect, getMyClientProfile);
router.patch("/me", protect, updateMyClientProfile);

// Catch-all by id — must stay last so it doesn't shadow /me.
router.get("/:id", getClientProfile);

export default router;
