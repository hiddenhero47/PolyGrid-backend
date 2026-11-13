import { IPayment } from "../models/paymentModel";
import { User } from "../models/userModel";
import { NOTIFICATION_TYPE } from "../models/notificationModel";
import { notify } from "./notify";
import { sendTemplatedEmail } from "./emailSender";

// Tells the buyer their payment is under routine review (released:
// false) or has cleared (released: true) — see
// helpers/paymentReconciliation.ts (where a hold starts) and
// helpers/paymentHoldRelease.ts (where it ends). Same "fire-and-forget
// from the caller's point of view, but awaited so a Mailgun failure
// surfaces here rather than racing the response" shape as
// systemPayoutController.ts's notifySystemPayoutSettled.
export const notifyPaymentHoldUpdate = async (payment: IPayment, released: boolean): Promise<void> => {
  const recipient = await User.findById(payment.user).select("email userName");
  if (!recipient) return;

  await sendTemplatedEmail({
    to: recipient.email,
    subject: released ? "Your payment has cleared" : "Your payment is under review",
    template: "paymentHoldUpdate",
    variables: {
      name: recipient.userName,
      amount: payment.amount,
      currency: payment.currency,
      released,
    },
  });

  await notify(
    payment.user,
    NOTIFICATION_TYPE.PAYMENT_ON_HOLD,
    released ? "Your payment has cleared" : "Your payment is under review",
    {
      paymentId: payment.id,
      amount: payment.amount,
      currency: payment.currency,
      released,
      // So the bell can open the actual job/purchase/subscription this
      // hold is about, not a generic "payments" page.
      targetType: payment.targetType,
      targetId: payment.targetId,
    },
  );
};
