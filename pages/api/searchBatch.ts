import type { NextApiRequest, NextApiResponse } from "next";
import { authenticateUser } from "@/utils/authenticateUser";
import axios from "axios";

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

    const response = await axios.get(
      `https://pw-batches-blue.vercel.app/v1/search-batch?q=${encodeURIComponent(name)}&limit=200`,
      {
        headers: {
          "Accept": "application/json",
          "User-Agent": "Mozilla/5.0",
        },
        timeout: 15000,
      }
    );

    if (response.data && response.data.success && Array.isArray(response.data.results)) {
      const results = response.data.results;
      const totalItems = results.length;
      const paginated = results.slice(skip, skip + limit);

      // Map API fields to match the internal Batch schema format
      const batches = paginated.map((item: any) => ({
        _id: item.batchId || item._id,
        batchId: item.batchId || item._id,
        batchName: item.batchName || item.name || "",
        batchPrice: item.batchPrice ?? 0,
        batchImage: item.batchImage || "",
        template: item.template || "NORMAL",
        BatchType: item.batchPrice === 0 ? "FREE" : "PAID",
        language: item.language || "Hinglish",
        byName: item.byName || "PW",
        startDate: item.startDate || new Date().toISOString().split("T")[0],
        endDate: item.endDate || new Date().toISOString().split("T")[0],
        batchStatus: true,
      }));

      return res.status(200).json({
        success: true,
        data: batches,
        currentPage,
        totalPages: Math.ceil(totalItems / limit),
        totalItems,
      });
    } else {
      throw new Error("Invalid response structure from search API");
    }
  } catch (error: any) {
    console.error("Batch search API integration error:", error.response?.data || error.message);
    return res.status(500).json({ message: "Error While Searching Batches" });
  }
}
