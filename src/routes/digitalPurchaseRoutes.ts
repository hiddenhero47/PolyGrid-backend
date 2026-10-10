import express from "express";
import { getMyDigitalPurchases, getDigitalPurchaseDownloadLink } from "../controllers/digitalPurchaseController";
import { protect } from "../middleware/authMiddleware";

const router = express.Router();

router.get("/mine", protect, getMyDigitalPurchases);
router.get("/:id/download", protect, getDigitalPurchaseDownloadLink);

export default router;
