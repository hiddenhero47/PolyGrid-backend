import express from "express";
import { getMyDigitalPurchases } from "../controllers/digitalPurchaseController";
import { protect } from "../middleware/authMiddleware";

const router = express.Router();

router.get("/mine", protect, getMyDigitalPurchases);

export default router;
