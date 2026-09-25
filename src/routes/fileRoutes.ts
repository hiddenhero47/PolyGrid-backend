import express from "express";
import { uploadPrivateFile, getPrivateFileLink } from "../controllers/fileController";
import { protect } from "../middleware/authMiddleware";

const router = express.Router();

router.use(protect);

router.post("/private", uploadPrivateFile);
router.get("/private/:ownerId/:fileName/link", getPrivateFileLink);

export default router;
