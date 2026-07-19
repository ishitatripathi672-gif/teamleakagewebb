import path from "path";
import { fileURLToPath } from "url";
import dotenv from "dotenv";
import mongoose from "mongoose";

// Emulate __dirname for ESM
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Load environment variables with correct Next.js precedence
dotenv.config({ path: path.resolve(__dirname, "../.env") });
dotenv.config({ path: path.resolve(__dirname, "../.env.local"), override: true });
if (process.env.NODE_ENV === "production") {
  dotenv.config({ path: path.resolve(__dirname, "../.env.production"), override: true });
}

const DOWNLOAD_MONGODB_URI = process.env.DOWNLOAD_MONGODB_URI!;

if (!DOWNLOAD_MONGODB_URI) {
  throw new Error("Please define the DOWNLOAD_MONGODB_URI in .env or .env.local");
}

interface MongooseCache {
  conn: mongoose.Connection | null;
  promise: Promise<mongoose.Connection> | null;
}

declare global {
  // eslint-disable-next-line no-var
  var downloadMongoose: MongooseCache;
}

let cached: MongooseCache = global.downloadMongoose || { conn: null, promise: null };

async function downloadDbConnect(): Promise<mongoose.Connection> {
  if (cached.conn) {
    return cached.conn;
  }

  if (!cached.promise) {
    const maskedUri = DOWNLOAD_MONGODB_URI.replace(/:([^:@]+)@/, ":******@");
    console.log(`[downloadDb] Connecting to MongoDB (masked URI): ${maskedUri}`);
    // Connect using mongoose.createConnection to keep it separate from the main DB connection
    cached.promise = mongoose.createConnection(DOWNLOAD_MONGODB_URI, {
      dbName: "pw-download",
    }).asPromise();
  }

  cached.conn = await cached.promise;
  console.log(`[downloadDb] Connected to database: ${cached.conn.name}`);
  global.downloadMongoose = cached;
  return cached.conn;
}

export default downloadDbConnect;
