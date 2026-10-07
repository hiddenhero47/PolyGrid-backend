import express from "express";
import {
  startOrGetConversation,
  listConversations,
  listMessages,
  sendMessage,
  markConversationRead,
} from "../controllers/conversationController";
import { protect } from "../middleware/authMiddleware";
import { validateBody } from "../validators/validate";
import {
  startOrGetConversationSchema,
  sendMessageSchema,
} from "../validators/conversation/conversationValidator";

const router = express.Router();

router.post("/", protect, validateBody(startOrGetConversationSchema), startOrGetConversation);
router.get("/", protect, listConversations);
router.get("/:id/messages", protect, listMessages);
router.post("/:id/messages", protect, validateBody(sendMessageSchema), sendMessage);
router.patch("/:id/read", protect, markConversationRead);

export default router;
