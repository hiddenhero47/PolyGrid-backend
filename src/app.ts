import express, { Express } from "express";
import { errorHandler, notFound } from "./middleware/errorMiddleware";
import handleCors from "./middleware/corsMiddleware";
import userRoutes from "./routes/userRoutes";
import planRoutes from "./routes/planRoutes";
import subscriptionRoutes from "./routes/subscriptionRoutes";

// Builds the Express app without connecting the DB or calling .listen() —
// lets tests use it directly via supertest.
const createApp = (): Express => {
  const app = express();

  app.use(express.json({ limit: "10mb" }));
  app.use(express.urlencoded({ extended: false, limit: "10mb" }));
  app.use(handleCors);

  app.get("/api/health", (_req, res) => {
    res.json({ server: "running" });
  });

  app.use("/api/users", userRoutes);
  app.use("/api/plans", planRoutes);
  app.use("/api/subscriptions", subscriptionRoutes);

  app.use(notFound);
  app.use(errorHandler);

  return app;
};

export default createApp;
