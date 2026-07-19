import type { NextApiRequest, NextApiResponse } from "next";
import { authenticateUser } from "@/utils/authenticateUser";
import axios from "axios";

// In-memory cache for Pimaxer batches
let cachedBatches: any[] | null = null;
let cacheExpiry = 0;
const CACHE_DURATION = 5 * 60 * 1000; // 5 minutes

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== "GET") {
    return res.status(405).json({ message: "Method not allowed" });
  }

  const { page = "1" } = req.query;
  const pageNum = parseInt(page as string, 10);

  if (isNaN(pageNum) || pageNum <= 0) {
    return res.status(400).json({ message: "Invalid page parameter" });
  }

  try {
    // 🔒 Enforce authentication first
    await authenticateUser(req, res);
  } catch (err: any) {
    return res.status(401).json({ message: err.message || "Unauthorized" });
  }

  try {
    const LIMIT = 15;
    const skip = (pageNum - 1) * LIMIT;

    const now = Date.now();
    if (!cachedBatches || now > cacheExpiry) {
      const response = await axios.get("https://api.pimaxer.in/v2/batches", {
        headers: {
          "Accept": "application/json",
          "User-Agent": "Mozilla/5.0",
        },
        timeout: 15000,
      });

      if (response.data && response.data.success && Array.isArray(response.data.data)) {
        cachedBatches = response.data.data;
        cacheExpiry = now + CACHE_DURATION;
      } else {
        throw new Error("Invalid response from Pimaxer API");
      }
    }

    const totalItems = (cachedBatches || []).length;
    const paginated = (cachedBatches || []).slice(skip, skip + LIMIT);

    const batches = paginated.map((item: any) => ({
      _id: item.id,
      batchId: item.id,
      batchName: item.name,
      batchPrice: item.offPrice ?? item.actualPrice ?? 0,
      batchImage: item.pngUrl || "",
      template: "NORMAL",
      BatchType: item.actualPrice === 0 ? "FREE" : "PAID",
      language: item.medium || "Hinglish",
      byName: item.exam || "PW",
      startDate: item.startsOn || new Date().toISOString().split("T")[0],
      endDate: item.startsOn || new Date().toISOString().split("T")[0],
      batchStatus: true,
    }));

    return res.status(200).json({
      success: true,
      currentPage: pageNum,
      totalPages: Math.ceil(totalItems / LIMIT),
      totalItems,
      data: batches,
    });
  } catch (err: any) {
    console.error("Pimaxer AllBatches error:", err);
    return res.status(500).json({ message: err.message || "Failed to fetch batches" });
  }
}

