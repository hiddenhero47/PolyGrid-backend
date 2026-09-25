import express from "express";
import {
  startOrGetConversation,
  listConversations,
  listMessages,
  sendMessage,
  markConversationRead,
} from "../controllers/conversationController";
import { protect } from "../middleware/authMiddleware";

const router = express.Router();

router.post("/", protect, startOrGetConversation);
router.get("/", protect, listConversations);
router.get("/:id/messages", protect, listMessages);
router.post("/:id/messages", protect, sendMessage);
router.patch("/:id/read", protect, markConversationRead);

export default router;
