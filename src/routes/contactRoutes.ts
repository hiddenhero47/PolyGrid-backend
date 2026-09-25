import express from "express";
import { addContact, getContacts, removeContact } from "../controllers/contactController";
import { protect } from "../middleware/authMiddleware";

const router = express.Router();

router.use(protect);

router.post("/", addContact);
router.get("/", getContacts);
router.delete("/:userId", removeContact);

export default router;
