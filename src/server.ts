process.on("unhandledRejection", (err) => {
  console.error("Unhandled Rejection:", err);
});
process.on("uncaughtException", (err) => {
  console.error("Uncaught Exception:", err);
  process.exit(1);
});

import dotenv from "dotenv";
dotenv.config();

import connectDB from "./config/db";
import createApp from "./app";

const port = process.env.PORT || 4000;

const startServer = async (): Promise<void> => {
  try {
    await connectDB();

    const app = createApp();

    app.listen(port, () => {
      console.log(`🚀 Server started on port ${port}`);
    });
  } catch (error) {
    console.error("Startup failed:", (error as Error).message);
    process.exit(1);
  }
};

startServer();
