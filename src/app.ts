import express, { Express } from "express";
import multer from "multer";
import { errorHandler, notFound } from "./middleware/errorMiddleware";
import handleCors from "./middleware/corsMiddleware";
import userRoutes from "./routes/userRoutes";
import planRoutes from "./routes/planRoutes";
import subscriptionRoutes from "./routes/subscriptionRoutes";
import fileRoutes from "./routes/fileRoutes";
import contactRoutes from "./routes/contactRoutes";
import jobRoutes from "./routes/jobRoutes";
import systemPayoutRoutes from "./routes/systemPayoutRoutes";
import paymentRoutes from "./routes/paymentRoutes";
import consultancyProfileRoutes from "./routes/consultancyProfileRoutes";
import verificationRoutes from "./routes/verificationRoutes";
import verificationTemplateRoutes from "./routes/verificationTemplateRoutes";
import referenceRoutes from "./routes/referenceRoutes";
import conversationRoutes from "./routes/conversationRoutes";
import messageRoutes from "./routes/messageRoutes";
import storeProfileRoutes from "./routes/storeProfileRoutes";
import productRoutes from "./routes/productRoutes";
import storeOrderRoutes from "./routes/storeOrderRoutes";
import digitalCreatorProfileRoutes from "./routes/digitalCreatorProfileRoutes";
import digitalProductRoutes from "./routes/digitalProductRoutes";
import digitalPurchaseRoutes from "./routes/digitalPurchaseRoutes";
import contractorProfileRoutes from "./routes/contractorProfileRoutes";
import tenderProjectRoutes from "./routes/tenderProjectRoutes";
import reviewRoutes from "./routes/reviewRoutes";
import clientProfileRoutes from "./routes/clientProfileRoutes";
import laborProfileRoutes from "./routes/laborProfileRoutes";
import jobOpeningRoutes from "./routes/jobOpeningRoutes";
import adminProfileRoutes from "./routes/adminProfileRoutes";
import deploymentRoutes from "./routes/deploymentRoutes";
import statsRoutes from "./routes/statsRoutes";
import notificationRoutes from "./routes/notificationRoutes";
import { viewPrivateFile, downloadPrivateFile } from "./controllers/fileController";
import { downloadDigitalStoreFile } from "./controllers/digitalStoreController";
import { PUBLIC_DIR } from "./helpers/fileStorage";

// Buffers files in memory (req.files) rather than writing to a temp dir —
// fileStorage.ts's validateAndSave reads the buffer directly to check its
// magic bytes before deciding where (or whether) to persist it to disk.
const forms = multer();

// Builds the Express app without connecting the DB or calling .listen() —
// lets tests use it directly via supertest.
const createApp = (): Express => {
  const app = express();

  // Must be registered before express.json() below — Stripe's webhook
  // signature is computed over the exact raw request bytes, so this one
  // path is deliberately never JSON-parsed. Same ordering house-maduekwe-
  // backend uses for its own Stripe callback route.
  app.use("/api/payments/stripe/webhook", express.raw({ type: "application/json" }));
  app.use(express.json({ limit: "10mb" }));
  app.use(forms.any());
  app.use(express.urlencoded({ extended: false, limit: "10mb" }));
  app.use(handleCors);

  // Public files: served directly, no auth — anyone with the URL can see
  // them, same as house-maduekwe. e.g. GET /public/<fileName>.
  app.use("/public", express.static(PUBLIC_DIR, { maxAge: "365d" }));
  // Private files: NEVER mounted as static. No `protect` here on purpose —
  // a signed `?token=` IS the authorization (minted only after an access
  // check elsewhere, e.g. GET /api/files/private/:ownerId/:fileName/link),
  // which is what lets these go straight into an <img>/<video> src with no
  // custom header. See docs/file-uploads-plan.md.
  app.get("/private/view/:ownerId/:fileName", viewPrivateFile);
  app.get("/private/download/:ownerId/:fileName", downloadPrivateFile);
  // The internal (local-disk) digital-storage provider's own counterpart
  // to the route above — see providers/digitalStorageProviders/index.ts
  // and digitalStoreController.ts. Only ever reached when
  // DIGITAL_STORAGE_PROVIDER=internal (the default).
  app.get("/digital-store/download", downloadDigitalStoreFile);

  app.get("/api/health", (_req, res) => {
    res.json({ server: "running" });
  });

  app.use("/api/users", userRoutes);
  app.use("/api/plans", planRoutes);
  app.use("/api/subscriptions", subscriptionRoutes);
  app.use("/api/files", fileRoutes);
  app.use("/api/contacts", contactRoutes);
  app.use("/api/jobs", jobRoutes);
  app.use("/api/system-payouts", systemPayoutRoutes);
  app.use("/api/payments", paymentRoutes);
  app.use("/api/consultancy-profiles", consultancyProfileRoutes);
  app.use("/api/verifications", verificationRoutes);
  app.use("/api/verification-templates", verificationTemplateRoutes);
  app.use("/api/reference", referenceRoutes);
  app.use("/api/conversations", conversationRoutes);
  app.use("/api/messages", messageRoutes);
  app.use("/api/store-profiles", storeProfileRoutes);
  app.use("/api/products", productRoutes);
  app.use("/api/store-orders", storeOrderRoutes);
  app.use("/api/digital-creator-profiles", digitalCreatorProfileRoutes);
  app.use("/api/digital-products", digitalProductRoutes);
  app.use("/api/digital-purchases", digitalPurchaseRoutes);
  app.use("/api/contractor-profiles", contractorProfileRoutes);
  app.use("/api/tender-projects", tenderProjectRoutes);
  app.use("/api/reviews", reviewRoutes);
  app.use("/api/client-profiles", clientProfileRoutes);
  app.use("/api/labor-profiles", laborProfileRoutes);
  app.use("/api/job-openings", jobOpeningRoutes);
  app.use("/api/admin/profiles", adminProfileRoutes);
  app.use("/api/deployment", deploymentRoutes);
  app.use("/api/stats", statsRoutes);
  app.use("/api/notifications", notificationRoutes);

  app.use(notFound);
  app.use(errorHandler);

  return app;
};

export default createApp;
