import type { NextApiRequest, NextApiResponse } from "next";
import { authenticateUser } from "@/utils/authenticateUser";
import axios from "axios";

// In-memory cache for Pimaxer batches
let cachedBatches: any[] | null = null;
let cacheExpiry = 0;
const CACHE_DURATION = 5 * 60 * 1000; // 5 minutes

export default async function handler(
  req: NextApiRequest,
  res: NextApiResponse
) {
  if (req.method !== "GET") {
    return res.status(405).json({ message: "Method Not Allowed" });
  }

  const { name, page = "1" } = req.query;

  if (!name || typeof name !== "string") {
    return res.status(400).json({ message: "Missing or invalid `name` query" });
  }

  const limit = 10;
  const currentPage = parseInt(page as string, 10);
  const skip = (currentPage - 1) * limit;

  try {
    // Keep same authentication check
    await authenticateUser(req, res);

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

    const searchLower = name.toLowerCase();

    // Filter batches matching search keyword in name or id
    const filtered = (cachedBatches || []).filter((item: any) => {
      const nameMatch = item.name?.toLowerCase().includes(searchLower);
      const idMatch = item.id?.toLowerCase().includes(searchLower);
      return nameMatch || idMatch;
    });

    const totalItems = filtered.length;
    const paginated = filtered.slice(skip, skip + limit);

    // Map Pimaxer fields to match the internal Batch schema format
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
      data: batches,
      currentPage,
      totalPages: Math.ceil(totalItems / limit),
      totalItems,
    });
  } catch (error) {
    console.error("Pimaxer search error:", error);
    return res.status(500).json({ message: "Error While Searching Batches" });
  }
}

