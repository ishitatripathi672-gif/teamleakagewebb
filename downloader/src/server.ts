import "dotenv/config";
import express from "express";
import type { Request, Response } from "express";
import cors from "cors";
import axios from "axios";
import path from "path";
import { fileURLToPath } from "url";
import ffmpeg from "fluent-ffmpeg";
import ffmpegInstaller from "@ffmpeg-installer/ffmpeg";
import fs from "fs";
import { promises as fsPromises } from "fs";
import { randomUUID } from "crypto";
import crypto from "crypto";
import http from "http";
import https from "https";
// @ts-ignore
import { Parser } from "m3u8-parser";
import mongoose from "mongoose";
import dbConnect from "./db.js";
import { getDownloadTokenModel } from "./models/DownloadToken.js";

ffmpeg.setFfmpegPath(ffmpegInstaller.path);

// --- HTTP Keep-Alive Agent Pool for Ultra-Fast Concurrency ---
const httpAgent = new http.Agent({ keepAlive: true, maxSockets: 100 });
const httpsAgent = new https.Agent({ keepAlive: true, maxSockets: 100 });
const httpClient = axios.create({
  httpAgent,
  httpsAgent,
  timeout: 15000,
});

// --- M3U8 & Decryption Helpers ---
const decryptionKeyCache = new Map<string, Buffer>();

function parseM3U8(content: string): any {
  const parser = new Parser();
  parser.push(content);
  parser.end();
  return parser.manifest;
}

function resolveSegmentUrl(playlistUrl: string, segmentUri: string): string {
  try {
    let resolvedUrl = new URL(segmentUri, playlistUrl).href;
    const qIdx = playlistUrl.indexOf("?");
    if (qIdx !== -1 && !resolvedUrl.includes("?")) {
      const signedQuery = playlistUrl.slice(qIdx);
      resolvedUrl += signedQuery;
    }
    return resolvedUrl;
  } catch {
    return segmentUri;
  }
}

async function getDecryptionKey(keyUrl: string): Promise<Buffer> {
  if (decryptionKeyCache.has(keyUrl)) {
    return decryptionKeyCache.get(keyUrl)!;
  }
  const res = await httpClient.get(keyUrl, {
    responseType: "arraybuffer",
    headers: {
      "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
      Referer: "https://physicswallah.live/",
      Origin: "https://physicswallah.live",
    }
  });
  const buf = Buffer.from(res.data);
  decryptionKeyCache.set(keyUrl, buf);
  return buf;
}

function getIvBuffer(key: any, seqNumber: number): Buffer {
  if (key && key.iv) {
    const buf = Buffer.alloc(16);
    for (let i = 0; i < 4; i++) {
      if (key.iv[i] !== undefined) {
        buf.writeUInt32BE(key.iv[i], i * 4);
      }
    }
    return buf;
  }
  const buf = Buffer.alloc(16);
  buf.writeUInt32BE(seqNumber, 12);
  return buf;
}

function decryptSegment(encryptedBuffer: Buffer, keyBuffer: Buffer, ivBuffer: Buffer): Buffer {
  const decipher = crypto.createDecipheriv("aes-128-cbc", keyBuffer, ivBuffer);
  return Buffer.concat([decipher.update(encryptedBuffer), decipher.final()]);
}

// Helper to format seconds to HH:MM:SS
function secondsToTimemark(seconds: number): string {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  return [
    h.toString().padStart(2, "0"),
    m.toString().padStart(2, "0"),
    s.toString().padStart(2, "0")
  ].join(":");
}

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = process.env.PORT || 4500;
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS || "http://localhost:3000").split(",");

// --- CORS ---
app.use(
  cors({
    origin: (origin, callback) => {
      if (!origin || ALLOWED_ORIGINS.includes(origin)) {
        callback(null, true);
      } else {
        callback(null, true); // Allow all for now in dev
      }
    },
  })
);

app.use(express.json());

// Resolve public folder relative to the project root (always pw/downloader/public)
const publicPath = path.resolve(process.cwd(), "public");
app.use(express.static(publicPath));

// --- Active Download Tracker ---
interface ActiveDownload {
  status: "downloading" | "ready" | "merging" | "converting" | "completed" | "failed" | "cancelled";
  timemark: string;
  percent: number;
  error: string | null;
  downloadedSegments: number;
  totalSegments: number;
  outputPath?: string;
}

const activeDownloads: Record<string, ActiveDownload> = {};
const activeConnections: Record<string, number> = {};

interface QualityVariant {
  height: number;
  width: number;
  bandwidth: number;
  label: string;
  url: string;
}

// --- Helpers ---

// Parse M3U8 master playlist to extract quality variants
async function parseM3U8Qualities(m3u8Url: string): Promise<QualityVariant[]> {
  try {
    const response = await axios.get(m3u8Url, {
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/138.0.0.0 Safari/537.36",
        Referer: "https://physicswallah.live/",
        Origin: "https://physicswallah.live",
      },
      timeout: 10000,
    });

    const text = response.data;
    const lines = text.split(/\r?\n/);
    const qualities: QualityVariant[] = [];

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i].trim();
      if (line.startsWith("#EXT-X-STREAM-INF:")) {
        const resolutionMatch = line.match(/RESOLUTION=(\d+)x(\d+)/);
        const bandwidthMatch = line.match(/BANDWIDTH=(\d+)/);

        if (resolutionMatch) {
          const width = parseInt(resolutionMatch[1]);
          const height = parseInt(resolutionMatch[2]);
          const bandwidth = bandwidthMatch ? parseInt(bandwidthMatch[1]) : 0;

          // Next line is the URL for this quality
          let variantUrl = "";
          if (i + 1 < lines.length) {
            variantUrl = lines[i + 1].trim();
            // Make it absolute if relative
            if (!variantUrl.startsWith("http")) {
              const baseUrl = m3u8Url.substring(0, m3u8Url.lastIndexOf("/") + 1);
              variantUrl = baseUrl + variantUrl;
            }
          }

          qualities.push({
            height,
            width,
            bandwidth,
            label: `${height}p`,
            url: variantUrl,
          });
        }
      }
    }

    // Sort by height ascending
    qualities.sort((a, b) => a.height - b.height);
    return qualities;
  } catch (err: any) {
    console.error("Failed to parse M3U8:", err.message);
    return [];
  }
}

// --- ROUTES ---

// GET /api/download-progress — Check status/progress of an active download
app.get("/api/download-progress", (req: Request, res: Response) => {
  const downloadId = req.query.downloadId as string;

  if (!downloadId) {
    return res.status(400).json({ success: false, message: "downloadId is required" });
  }

  const progress = activeDownloads[downloadId];
  if (!progress) {
    return res.json({ success: true, status: "idle", percent: 0 });
  }

  return res.json({
    success: true,
    ...progress
  });
});

async function findToken(token: string) {
  const conn = await dbConnect();
  const DownloadToken = getDownloadTokenModel(conn);
  let tokenDoc = await DownloadToken.findOne({ tokenId: token });

  if (!tokenDoc) {
    console.log(`[db] Token ${token} not found in pw-download database. Trying 'test' database fallback...`);
    try {
      const testConn = mongoose.createConnection(process.env.DOWNLOAD_MONGODB_URI!, {
        dbName: "test"
      });
      await testConn.asPromise();
      const TestDownloadToken = getDownloadTokenModel(testConn);
      tokenDoc = await TestDownloadToken.findOne({ tokenId: token });
      await testConn.close();
      if (tokenDoc) {
        console.log(`[db] Token found in 'test' database fallback.`);
      }
    } catch (err: any) {
      console.error(`[db] Failed connecting to test database fallback:`, err.message);
    }
  }
  return tokenDoc;
}

// GET /api/video-info — Takes token and returns qualities
app.get("/api/video-info", async (req: Request, res: Response) => {
  const token = req.query.token as string;

  if (!token) {
    return res.status(400).json({ success: false, message: "token is required" });
  }

  try {
    const tokenDoc = await findToken(token);

    if (!tokenDoc) {
      return res.status(404).json({ success: false, message: "Download link has expired or is invalid." });
    }

    console.log(`[video-info] Parsing qualities for lecture: ${tokenDoc.lectureName}`);

    // Parse the master playlist to get quality variants
    const qualities = await parseM3U8Qualities(tokenDoc.videoUrl);

    return res.json({
      success: true,
      qualities,
      lectureName: tokenDoc.lectureName,
      thumbnail: tokenDoc.thumbnail || "",
      duration: tokenDoc.duration || 0,
    });
  } catch (err: any) {
    console.error("[video-info] Error:", err.message);
    return res.status(500).json({ success: false, message: err.message });
  }
});

// GET /api/prepare-download — Starts parallel HLS segment downloading in the background
app.get("/api/prepare-download", async (req: Request, res: Response) => {
  const token = req.query.token as string;
  const quality = req.query.quality as string;
  const downloadId = req.query.downloadId as string;

  if (!token || !downloadId) {
    return res.status(400).json({ success: false, message: "token and downloadId are required" });
  }

  try {
    const tokenDoc = await findToken(token);

    if (!tokenDoc) {
      return res.status(404).json({ success: false, message: "Download link has expired or is invalid." });
    }

    const totalDurationSeconds = tokenDoc.duration || 0;
    const m3u8Url = tokenDoc.videoUrl;

    let downloadUrl = m3u8Url;
    if (quality && quality !== "auto" && quality !== "Original" && quality !== m3u8Url) {
      downloadUrl = quality;
    }

    const tempDirPath = path.join(process.cwd(), "temp", downloadId);

    // Initialize tracking
    activeDownloads[downloadId] = {
      status: "downloading",
      timemark: "00:00:00.00",
      percent: 0,
      error: null,
      downloadedSegments: 0,
      totalSegments: 0
    };

    // Respond immediately to the client
    res.json({ success: true, message: "Download preparation started" });

  // Start background download
  (async () => {
    let cancelled = false;

    // We can clean up if the tracker is deleted or flagged
    const checkCancelledInterval = setInterval(() => {
      if (!activeDownloads[downloadId] || activeDownloads[downloadId].status === "cancelled") {
        cancelled = true;
        clearInterval(checkCancelledInterval);
      }
    }, 2000);

    try {
      // 1. Fetch M3U8 (uses httpClient keep-alive)
      const m3u8Res = await httpClient.get(downloadUrl, {
        headers: {
          "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/138.0.0.0 Safari/537.36",
          Referer: "https://physicswallah.live/",
          Origin: "https://physicswallah.live",
        }
      });

      let manifest = parseM3U8(m3u8Res.data);

      // If it's a master playlist, pick the highest quality
      if (manifest.playlists && manifest.playlists.length > 0) {
        const best = manifest.playlists.reduce((a: any, b: any) =>
          ((b.attributes?.BANDWIDTH || 0) > (a.attributes?.BANDWIDTH || 0)) ? b : a
        );
        const mediaUrl = resolveSegmentUrl(downloadUrl, best.uri);
        console.log(`[prepare-download] Master playlist found. Selecting highest quality stream: ${mediaUrl}`);
        
        const mediaRes = await httpClient.get(mediaUrl, {
          headers: {
            "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
            Referer: "https://physicswallah.live/",
            Origin: "https://physicswallah.live",
          }
        });
        manifest = parseM3U8(mediaRes.data);
        downloadUrl = mediaUrl;
      }

      const segments = manifest.segments || [];
      const totalSegments = segments.length;
      if (totalSegments === 0) {
        throw new Error("No segments found in the M3U8 playlist.");
      }

      const segmentUrls = segments.map((seg: any) => resolveSegmentUrl(downloadUrl, seg.uri));

      if (activeDownloads[downloadId]) {
        activeDownloads[downloadId].totalSegments = totalSegments;
      }

      await fsPromises.mkdir(tempDirPath, { recursive: true });

      // Parallel download
      const concurrency = 32;
      let currentIdx = 0;
      let downloadedCount = 0;

      const worker = async () => {
        while (!cancelled) {
          const myIndex = currentIdx++;
          if (myIndex >= totalSegments) break;

          const url = segmentUrls[myIndex];
          const segmentPath = path.join(tempDirPath, `segment_${myIndex}.ts`);

          let retries = 3;
          while (retries > 0 && !cancelled) {
            try {
              const res = await httpClient.get(url, {
                responseType: "arraybuffer",
                headers: {
                  "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
                  Referer: "https://physicswallah.live/",
                  Origin: "https://physicswallah.live",
                }
              });
              
              let segmentBuffer = Buffer.from(res.data);
              
              // Decrypt segment if encrypted with AES-128
              const segment = segments[myIndex];
              if (segment && segment.key && segment.key.method === "AES-128") {
                try {
                  const keyUrl = resolveSegmentUrl(downloadUrl, segment.key.uri);
                  const keyBuffer = await getDecryptionKey(keyUrl);
                  const ivBuffer = getIvBuffer(segment.key, myIndex);
                  segmentBuffer = decryptSegment(segmentBuffer, keyBuffer, ivBuffer);
                } catch (decErr: any) {
                  console.error(`[decryption] Failed for segment ${myIndex}:`, decErr.message);
                }
              }

              await fsPromises.writeFile(segmentPath, segmentBuffer);
              downloadedCount++;
              break;
            } catch (err: any) {
              retries--;
              if (retries === 0) {
                throw new Error(`Failed to download segment ${myIndex} after retries: ${err.message}`);
              }
              await new Promise((resolve) => setTimeout(resolve, 1000));
            }
          }

          if (activeDownloads[downloadId] && !cancelled) {
            const percent = Math.min(Math.round((downloadedCount / totalSegments) * 98), 98);

            activeDownloads[downloadId].percent = percent;
            activeDownloads[downloadId].downloadedSegments = downloadedCount;

            const estSeconds = Math.round((downloadedCount / totalSegments) * totalDurationSeconds);
            activeDownloads[downloadId].timemark = secondsToTimemark(estSeconds);
          }
        }
      };

      const workers = [];
      for (let i = 0; i < concurrency; i++) {
        workers.push(worker());
      }

      await Promise.all(workers);
      clearInterval(checkCancelledInterval);

      if (cancelled) {
        try {
          await fsPromises.rm(tempDirPath, { recursive: true, force: true });
        } catch {}
        return;
      }

      // Merge segments in order into a single merged.ts
      if (activeDownloads[downloadId]) {
        activeDownloads[downloadId].status = "converting";
        activeDownloads[downloadId].percent = 98;
      }

      const mergedTsPath = path.join(tempDirPath, "merged.ts");
      const writeStream = fs.createWriteStream(mergedTsPath);
      
      for (let i = 0; i < totalSegments; i++) {
        if (cancelled) break;
        const segmentPath = path.join(tempDirPath, `segment_${i}.ts`);
        if (fs.existsSync(segmentPath)) {
          await new Promise<void>((resolve, reject) => {
            const readStream = fs.createReadStream(segmentPath);
            readStream.pipe(writeStream, { end: false });
            readStream.on("end", () => {
              try { fs.unlinkSync(segmentPath); } catch {}
              resolve();
            });
            readStream.on("error", reject);
          });
        }
      }
      
      await new Promise<void>((resolve, reject) => {
        writeStream.end(() => resolve());
        writeStream.on("error", reject);
      });

      if (cancelled) {
        try {
          await fsPromises.rm(tempDirPath, { recursive: true, force: true });
        } catch {}
        return;
      }

      // Convert TS to MP4 using FFmpeg
      const mp4Path = path.join(tempDirPath, "video.mp4");
      let conversionSuccess = false;

      try {
        await new Promise<void>((resolve, reject) => {
          ffmpeg(mergedTsPath)
            .outputOptions([
              "-c", "copy",
              "-bsf:a", "aac_adtstoasc",
              "-movflags", "+faststart",
            ])
            .save(mp4Path)
            .on("end", () => {
              conversionSuccess = true;
              resolve();
            })
            .on("error", (err) => {
              console.error("[ffmpeg] Concat Error:", err.message);
              resolve(); // resolve so we can fall back to TS
            });
        });
      } catch (ffErr: any) {
        console.error("[ffmpeg] Concat wrapper failed:", ffErr.message);
      }

      if (cancelled) {
        try {
          await fsPromises.rm(tempDirPath, { recursive: true, force: true });
        } catch {}
        return;
      }

      let finalOutputPath = mergedTsPath;
      if (conversionSuccess && fs.existsSync(mp4Path)) {
        try { fs.unlinkSync(mergedTsPath); } catch {}
        finalOutputPath = mp4Path;
      } else {
        console.log("[prepare-download] Serving .ts file directly (conversion failed)");
      }

      if (activeDownloads[downloadId]) {
        activeDownloads[downloadId].status = "completed";
        activeDownloads[downloadId].percent = 100;
        activeDownloads[downloadId].outputPath = finalOutputPath;
      }

    } catch (err: any) {
      clearInterval(checkCancelledInterval);
      console.error(`[prepare-download] Error for ${downloadId}:`, err.message);
      if (activeDownloads[downloadId]) {
        activeDownloads[downloadId].status = "failed";
        activeDownloads[downloadId].error = err.message;
      }
      try {
        await fsPromises.rm(tempDirPath, { recursive: true, force: true });
      } catch {}
    }
  })();
  } catch (outerErr: any) {
    console.error("[prepare-download] Error starting download:", outerErr.message);
    if (!res.headersSent) {
      res.status(500).json({ success: false, message: outerErr.message });
    }
  }
});

// GET /api/download — Streams the compiled MP4 file to the client using ffmpeg concat
app.get("/api/download", async (req: Request, res: Response) => {
  const downloadId = req.query.downloadId as string;
  const lectureName = req.query.lectureName as string;

  if (!downloadId) {
    return res.status(400).json({ success: false, message: "downloadId is required" });
  }

  const progress = activeDownloads[downloadId];
  if (!progress || progress.status !== "completed" || !progress.outputPath) {
    return res.status(404).json({ success: false, message: "Download not ready or expired." });
  }

  const filePath = progress.outputPath;
  const ext = path.extname(filePath);
  const safeName = (lectureName || "lecture").replace(/[^a-zA-Z0-9\s\-_().]/g, "").trim() || "lecture";
  const fileName = `${safeName}${ext}`;

  console.log(`[download] Serving finished static file: ${fileName} from path: ${filePath}`);

  // Disable request timeout
  req.socket.setTimeout(0);
  req.socket.setKeepAlive(true, 15000);

  activeConnections[downloadId] = (activeConnections[downloadId] || 0) + 1;

  res.download(filePath, fileName, (err) => {
    if (err) {
      console.error(`[download] Error sending file for ${downloadId}:`, err.message);
    }
    
    activeConnections[downloadId] = (activeConnections[downloadId] || 1) - 1;
    
    if (activeConnections[downloadId] <= 0) {
      delete activeConnections[downloadId];
      setTimeout(async () => {
        const tempDirPath = path.join(process.cwd(), "temp", downloadId);
        try {
          if (fs.existsSync(tempDirPath)) {
            await fsPromises.rm(tempDirPath, { recursive: true, force: true });
            console.log(`[cleanup] Deleted temp directory: ${tempDirPath}`);
          }
          delete activeDownloads[downloadId];
        } catch (cleanupErr: any) {
          console.error(`[cleanup] Failed to delete temp directory: ${cleanupErr.message}`);
        }
      }, 10000);
    }
  });
});

// GET /api/proxy — Proxy for M3U8/segment fetching
app.get("/api/proxy", async (req: Request, res: Response) => {
  const queryUrl = req.query.url;

  if (!queryUrl || typeof queryUrl !== "string") {
    return res.status(400).json({ error: "Missing or invalid url parameter." });
  }

  try {
    const response = await axios.get(queryUrl, {
      responseType: "arraybuffer",
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
        Referer: "https://physicswallah.live/",
        Origin: "https://physicswallah.live",
      },
      timeout: 15000,
    });

    const contentType = response.headers["content-type"];
    const contentTypeStr = typeof contentType === "string" ? contentType : "application/octet-stream";
    res.setHeader("Content-Type", contentTypeStr);
    res.setHeader("Cache-Control", "public, max-age=86400");

    return res.status(200).send(Buffer.from(response.data));
  } catch (error: any) {
    console.error("Proxy error:", error.message);
    return res.status(error.response?.status || 500).json({ error: `Proxy failed: ${error.message}` });
  }
});

// Fallback to index.html
app.get("*", (req: Request, res: Response) => {
  res.sendFile(path.join(publicPath, "index.html"));
});

app.listen(PORT, () => {
  console.log(`\n🎬 PW Video Downloader server running at http://localhost:${PORT}\n`);
});
