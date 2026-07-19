import mongoose, { Schema, Document, Model } from "mongoose";

export interface IDownloadToken extends Document {
  tokenId: string;
  videoUrl: string;
  lectureName: string;
  thumbnail?: string;
  duration?: number;
  createdAt: Date;
}

export const DownloadTokenSchema = new Schema<IDownloadToken>({
  tokenId: { type: String, required: true, unique: true },
  videoUrl: { type: String, required: true },
  lectureName: { type: String, required: true },
  thumbnail: { type: String },
  duration: { type: Number },
  createdAt: { type: Date, default: Date.now, expires: 600 } // TTL: 10 minutes
});

export function getDownloadTokenModel(connection: mongoose.Connection): Model<IDownloadToken> {
  return connection.models.DownloadToken || connection.model<IDownloadToken>("DownloadToken", DownloadTokenSchema);
}
