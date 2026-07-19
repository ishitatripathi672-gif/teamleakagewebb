import mongoose, { Schema, Document, Model } from "mongoose";

export interface IVideoStream extends Document {
  uuid: string;          // CDN UUID (e.g. cbcc07de-0cd0-458a-ab5e-2536c5c833b5)
  signedQuery: string;   // CloudFront query string (e.g. ?URLPrefix=...&Expires=...&Signature=...)
  expiresAt: Date;       // When the signed URL expires (from Expires param)
  keyHex?: string;       // Pre-resolved AES-128 decryption key hex
  createdAt: Date;
  updatedAt: Date;
}

const VideoStreamSchema = new Schema<IVideoStream>(
  {
    uuid: { type: String, required: true, unique: true, index: true },
    signedQuery: { type: String, required: true },
    expiresAt: { type: Date, required: true, index: { expires: 0 } }, // TTL index: auto-delete when expired
    keyHex: { type: String },
  },
  { timestamps: true }
);

const VideoStream: Model<IVideoStream> =
  mongoose.models.VideoStream ||
  mongoose.model<IVideoStream>("VideoStream", VideoStreamSchema);

export default VideoStream;
