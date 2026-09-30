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

const port = process.env.PORT || 4000;

const startServer = async (): Promise<void> => {
  try {
    await connectDB();

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
  } catch (error) {
    console.error("Startup failed:", (error as Error).message);
    process.exit(1);
  }
};

startServer();
