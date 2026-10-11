process.on("unhandledRejection", (err) => {
  console.error("Unhandled Rejection:", err);
});
process.on("uncaughtException", (err) => {
  console.error("Uncaught Exception:", err);
  process.exit(1);
});

import http from "http";
import dotenv from "dotenv";
dotenv.config();

import connectDB from "./config/db";
import createApp from "./app";
import { initSocket } from "./socket";
import { loadTemplates } from "./helpers/emailSender";
import { startCronJobs } from "./jobs/cronIndex";

const port = process.env.PORT || 4000;

const startServer = async (): Promise<void> => {
  try {
    await connectDB();

    // Deployment setup (first Super Admin, placeholder verification
    // templates — see helpers/deploymentSetup.ts) is deliberately NOT run
    // here. PM2 restarts this process on every deploy (every push to
    // main), and the tasks are idempotent no-ops after the first real
    // run — running them on every single restart would just be dead
    // weight forever. Call POST /api/deployment/setup (time-window-
    // guarded, see routes/deploymentRoutes.ts) instead, the one time it's
    // actually needed.

    // Same reasoning as house-maduekwe-backend's server.js: compile every
    // email template once at boot, so a broken/missing template file fails
    // loudly at startup instead of the first time something tries to send
    // it mid-request.
    await loadTemplates();

    const app = createApp();
    // Socket.IO attaches to the raw http.Server, not the Express app
    // itself — app.listen() (used previously) creates one internally with
    // no way to hand it to Socket.IO afterward, so the server is built
    // explicitly here instead.
    const httpServer = http.createServer(app);
    initSocket(httpServer);

    httpServer.listen(port, () => {
      console.log(`🚀 Server started on port ${port}`);
    });

    // Mirrors house-maduekwe-backend's own server.js call to its
    // jobs/cronIndex.js — see jobs/cronIndex.ts.
    startCronJobs();
  } catch (error) {
    console.error("Startup failed:", (error as Error).message);
    process.exit(1);
  }
};

startServer();
