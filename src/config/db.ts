import mongoose from "mongoose";
import "colors";

const connectDB = async (): Promise<void> => {
  try {
    const conn = await mongoose.connect(process.env.MONGO_URI as string);

    console.log(`MongoDB Connected: ${conn.connection.host}`.cyan.underline);
  } catch (error) {
    console.log("database connection failed".red.underline);
    process.exit(1);
  }
};

export default connectDB;
