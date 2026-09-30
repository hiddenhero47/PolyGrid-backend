import express from "express";
import {
  listDigitalProductFeed,
  getDigitalProduct,
  getDigitalProductDownloadLink,
} from "../controllers/digitalProductController";
import { protect } from "../middleware/authMiddleware";

const router = express.Router();

router.get("/feed", listDigitalProductFeed);
router.get("/:id/download", protect, getDigitalProductDownloadLink);
router.get("/:id", getDigitalProduct);

export default router;
