import * as yup from "yup";
import { objectIdString } from "../objectId";

// Contact-connection checks, ownership (loadMyConversation), and the
// self-messaging rejection all stay in conversationController.ts —
// only the shape layer moved here.
export const startOrGetConversationSchema = yup
  .object({
    userId: objectIdString("A valid userId is required").required("A valid userId is required"),
  })
  .noUnknown(true);

export const sendMessageSchema = yup
  .object({
    body: yup.string().trim().required("Message body is required"),
  })
  .noUnknown(true);

export const reportMessageSchema = yup
  .object({
    reason: yup.string().trim().required("A reason is required"),
  })
  .noUnknown(true);

export const resolveMessageReportSchema = yup
  .object({
    redactMessage: yup.boolean().notRequired(),
    note: yup.string().trim().max(1000).notRequired(),
  })
  .noUnknown(true);
