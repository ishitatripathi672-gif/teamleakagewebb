import mongoose from "mongoose";

const DOWNLOAD_MONGODB_URI = process.env.DOWNLOAD_MONGODB_URI!;

if (!DOWNLOAD_MONGODB_URI) {
  throw new Error("Please define the DOWNLOAD_MONGODB_URI in your environment variables");
}

let cachedPromise: Promise<mongoose.Connection> | null = null;
let cachedConnection: mongoose.Connection | null = null;

async function dbConnect(): Promise<mongoose.Connection> {
  if (cachedConnection) {
    return cachedConnection;
  }

  if (!cachedPromise) {
    const maskedUri = DOWNLOAD_MONGODB_URI.replace(/:([^:@]+)@/, ":******@");
    console.log(`[db] Connecting to MongoDB (masked URI): ${maskedUri}`);
    cachedPromise = mongoose.createConnection(DOWNLOAD_MONGODB_URI, {
      dbName: "pw-download",
    }).asPromise();
  }

  cachedConnection = await cachedPromise;
  console.log(`[db] Connected to database: ${cachedConnection.name}`);
  return cachedConnection;
}

export default dbConnect;
