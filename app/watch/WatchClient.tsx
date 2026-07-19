"use client";

import React, { useEffect, useState } from "react";
import dynamic from "next/dynamic";
import { useSearchParams, useRouter } from "next/navigation";
import { Heart } from "lucide-react";
import "../globals.css";
import { toast } from "sonner";

const YouTubePlayer = dynamic(() => import("@/app/components/YouTubePlayer"), {
  ssr: false,
});

const DashPlayer = dynamic(() => import("@/app/components/dashPlayer"), {
  ssr: false,
});

const HLSPlayer = dynamic(() => import("@/app/components/HLSPlayer"), {
  ssr: false,
});

export default function WatchPageClient() {
  const params = useSearchParams();
  const router = useRouter();

  const [videoType, setVideoType] = useState<"youtube" | "penpencilvdo" | null>(
    null
  );
  const [videoUrl, setVideoUrl] = useState<string | null>(null);
  const [fallbackUrl, setFallbackUrl] = useState<string | null>(null);
  const [clearKeys, setClearKeys] = useState<any>(null);
  const [signedUrlQuery, setSignedUrlQuery] = useState<string>("");
  const [loading, setLoading] = useState(false);
  const [attachments, setAttachments] = useState<any[]>([]);
  const [downloadUrl, setDownloadUrl] = useState<string>("");
  const [isBatchUnavailable, setIsBatchUnavailable] = useState(false);
  const [lectureData, setLectureData] = useState<any>(null);

  // Params
  const batchId = params?.get("batchId") || "";
  const subjectId = params?.get("SubjectId") || "";
  const ContentId = params?.get("ContentId") || params?.get("ChildId") || "";

  const saveWatchHistory = (lecture: {
    id: string;
    title: string;
    thumbnail: string;
    duration: string;
    batchId: string;
    subjectId: string;
    type: string;
    videoUrl: string;
    isLocked: boolean;
  }) => {
    if (typeof window === "undefined") return;
    try {
      const raw = localStorage.getItem("watchHistory") || "[]";
      const history = JSON.parse(raw);

      const now = new Date();
      const timeString = now.toLocaleTimeString("en-IN", {
        hour: "2-digit",
        minute: "2-digit",
      });
      const dateString = now.toLocaleDateString("en-IN", {
        day: "numeric",
        month: "short",
      });

      const historyItem = {
        ...lecture,
        formattedTime: `${dateString} at ${timeString}`,
        timestamp: now.getTime(),
      };

      const filtered = history.filter((item: any) => item.id !== lecture.id);
      filtered.unshift(historyItem);

      const limited = filtered.slice(0, 4);
      localStorage.setItem("watchHistory", JSON.stringify(limited));
    } catch (err) {
      console.error("Failed to save watch history:", err);
    }
  };

  // Clean up VideoUrl from query params to keep the address bar clean
  useEffect(() => {
    if (typeof window !== "undefined") {
      const urlParams = new URLSearchParams(window.location.search);
      if (urlParams.has("VideoUrl") || urlParams.has("videoUrl")) {
        urlParams.delete("VideoUrl");
        urlParams.delete("videoUrl");
        const newSearch = urlParams.toString();
        const newPath = window.location.pathname + (newSearch ? `?${newSearch}` : "");
        window.history.replaceState(null, "", newPath);
      }
    }
  }, []);

  useEffect(() => {
    if (!batchId || !subjectId || !ContentId) return;

    const controller = new AbortController();
    const signal = controller.signal;

    const fetchVideoData = async () => {
      setLoading(true);
      setIsBatchUnavailable(false);

      try {
        // Step 0: Get video type and URL, handling potential failures gracefully
        let scheduleData: any = null;
        try {
          const scheduleRes = await fetch(
            `/api/Schedule?BatchId=${batchId}&SubjectId=${subjectId}&ContentId=${ContentId}`,
            { signal }
          );
          if (scheduleRes.ok) {
            scheduleData = await scheduleRes.json();
          }
        } catch (err) {
          console.warn("[WatchClient] Failed to fetch schedule data, will use query params or fallback:", err);
        }

        if (signal.aborted) return;

        const urlType = params?.get("Type") || scheduleData?.data?.urlType;
        if (!urlType) {
          throw new Error("Invalid Schedule API response and no video Type parameter provided");
        }

        const homeworks = scheduleData?.data?.homeworkIds || [];
        const extractedAttachments: any[] = [];
        homeworks.forEach((hw: any) => {
          if (hw?.attachmentIds) {
            hw.attachmentIds.forEach((att: any) => {
              if (att?.baseUrl && att?.key) {
                extractedAttachments.push({
                  ...att,
                  homeworkName: hw.name || hw.topic || "Attachment",
                });
              }
            });
          }
        });
        setAttachments(extractedAttachments);

        const url = scheduleData?.data?.url || "";

        if (urlType === "youtube") {
          setVideoType("youtube");
          setVideoUrl(url);

          saveWatchHistory({
            id: ContentId,
            title: scheduleData?.data?.topic || scheduleData?.data?.videoDetails?.name || "Lecture",
            thumbnail: scheduleData?.data?.videoDetails?.image || "/assets/img/video-placeholder.svg",
            duration: scheduleData?.data?.videoDetails?.duration || "",
            batchId,
            subjectId,
            type: "youtube",
            videoUrl: url,
            isLocked: scheduleData?.data?.isLocked ?? false,
          });
          return;
        }

        if (urlType === "penpencilvdo") {
          setVideoType("penpencilvdo");

          const videoId = params?.get("videoId") || scheduleData?.data?.videoDetails?._id || "";
          const videoIdQuery = videoId ? `&videoId=${encodeURIComponent(videoId)}` : "";

          const isKhazana = params?.get("isKhazana") === "true";
          const programId = params?.get("programId") || "";
          const chapterId = params?.get("chapterId") || "";
          const khazanaQuery = isKhazana ? `&isKhazana=true&programId=${encodeURIComponent(programId)}&chapterId=${encodeURIComponent(chapterId)}` : "";

          const signature = scheduleData?.videoSignature || "";
          const timestamp = scheduleData?.videoTimestamp || "";
          const signatureQuery = signature && timestamp ? `&signature=${encodeURIComponent(signature)}&timestamp=${encodeURIComponent(timestamp)}` : "";

          // Step 1: Get proxy stream URL and metadata
          const penRes = await fetch(
            `/api/get-url?parentId=${batchId}&childId=${ContentId}${videoIdQuery}${khazanaQuery}${signatureQuery}`,
            {
              signal,
              headers: {
                "X-Internal-Secret": process.env.NEXT_PUBLIC_INTERNAL_API_SECRET || "",
              },
            }
          );

          if (signal.aborted) return;

          if (penRes.status === 403 || penRes.status === 404) {
            setIsBatchUnavailable(true);
            return;
          }

          const penData = await penRes.json();
          const finalUrl = penData?.url;

          if (!finalUrl) {
            setIsBatchUnavailable(true);
            return;
          }

          // Step 2: Set player state with the decrypted stream details
          const hasClearKeys = penData?.clearKeys && Object.keys(penData.clearKeys).length > 0;
          
          let priorityUrl = "";
          let fallback = "";

          const signedQuery = penData?.signedUrl || "";
          const localDashUrl = `/api/proxy?url=${encodeURIComponent(finalUrl + signedQuery)}`;
          const localHlsUrl = penData?.vid 
            ? `/api/stream/m3u8?vid=${penData.vid}&batchId=${batchId}&signed=${encodeURIComponent(signedQuery)}`
            : null;

          if (finalUrl.includes("pimaxer.in")) {
            const uuidMatch = finalUrl.match(/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i);
            if (uuidMatch) {
              const uuid = uuidMatch[1];
              priorityUrl = `https://stream.pimaxer.in/${uuid}/master.m3u8`;
            } else {
              priorityUrl = finalUrl;
            }
            fallback = penData?.fallbackUrl || null;
          } else if (hasClearKeys) {
            // Secure/DRM content: Use local DASH (.mpd) as priority and local HLS (.m3u8) as fallback
            priorityUrl = localDashUrl;
            fallback = localHlsUrl || penData?.fallbackUrl || finalUrl;
          } else {
            // Standard content: Use local HLS (.m3u8) as priority and local DASH (.mpd) as fallback
            priorityUrl = localHlsUrl || finalUrl;
            fallback = localDashUrl;
          }

          setVideoUrl(priorityUrl);
          setFallbackUrl(fallback);
          // Pass the signed query params so dashPlayer can append them to segment requests
          setSignedUrlQuery(penData?.signedUrl || "");
          setClearKeys(penData?.clearKeys || null);
          setDownloadUrl(penData?.downloadUrl || "");
          setVideoType("penpencilvdo");

          // Auto-cache UUID → signed URL so /api/stream/{uuid}/master.m3u8 works directly
          if (penData?.vid && signedQuery) {
            fetch("/api/stream/cache", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ uuid: penData.vid, signedQuery }),
            }).catch(() => {}); // fire-and-forget, don't block playback
          }

          const lectureMeta = {
            id: ContentId,
            title: penData.title || penData.topic || scheduleData?.data?.topic || scheduleData?.data?.videoDetails?.name || "Lecture",
            thumbnail: penData.thumbnail || scheduleData?.data?.videoDetails?.image || "/assets/img/video-placeholder.svg",
            duration: penData.duration || scheduleData?.data?.videoDetails?.duration || "",
            batchId,
            subjectId,
            type: "penpencilvdo",
            videoUrl: priorityUrl,
            isLocked: scheduleData?.data?.isLocked ?? false,
          };
          saveWatchHistory(lectureMeta);
          setLectureData(lectureMeta);
        } else {
          setVideoType(null);
        }
      } catch (err: any) {
        if (err.name === "AbortError" || signal.aborted) {
          return;
        }
        console.error("Video setup failed:", err);
        let message = "Unknown error";
        if (typeof err === "string") message = err;
        else if (err && typeof err === "object" && "message" in err && typeof (err as any).message === "string") message = (err as any).message;

        if (
          message.toLowerCase().includes("unavailable") ||
          message.toLowerCase().includes("contact admin") ||
          message.toLowerCase().includes("forbidden") ||
          message.toLowerCase().includes("403")
        ) {
          setIsBatchUnavailable(true);
        } else {
          toast.error(`${message} - Try refreshing the page!`);
        }
      } finally {
        if (!signal.aborted) {
          setLoading(false);
        }
      }
    };

    fetchVideoData();

    return () => {
      controller.abort();
    };
  }, [batchId, subjectId, ContentId]);

  // ✅ Auto-rotate to landscape for all video types
  useEffect(() => {
    if (typeof window === "undefined") return;

    const handleFullscreenChange = () => {
      const isFullscreen = !!document.fullscreenElement;

      if (isFullscreen && (screen.orientation && typeof (screen.orientation as any).lock === "function")) {
        (screen.orientation as any).lock("landscape").catch((err: unknown) => {
          console.warn("Orientation lock failed:", err);
        });
      } else if (screen.orientation?.unlock) {
        screen.orientation.unlock?.();
      }
    };

    document.addEventListener("fullscreenchange", handleFullscreenChange);

    return () => {
      document.removeEventListener("fullscreenchange", handleFullscreenChange);
    };
  }, []);

  const handleHLSError = (error: any) => {
    console.warn("HLS player failed, attempting fallback to DASH/ClearKey...", error);
    if (fallbackUrl) {
      toast.info("Adapting player settings for secure content...");
      setVideoUrl(fallbackUrl);
    } else {
      console.error("No fallback URL available for HLS failure");
      toast.error("Video streaming failed. Please try refreshing the page.");
    }
  };

  return (
    <div className="h-[100%] md:overflow-auto lg:overflow-hidden select-none">
      <div className="relative" style={{ height: "100%" }}>
        {loading && (
          <div className="absolute inset-0 z-50 flex flex-col items-center justify-center bg-gradient-to-br from-[#eef7f0]/90 via-[#e4f6e8]/90 to-[#f5f8ff]/90 dark:from-[#0F1908]/95 dark:via-[#1C2B22]/95 dark:to-[#151D1A]/95 backdrop-blur-md transition-colors duration-300">
            <div className="p-8 rounded-2xl bg-white/85 dark:bg-[#1C2B22]/85 backdrop-blur-md border border-emerald-500/10 dark:border-emerald-400/10 shadow-spring-xl flex flex-col items-center max-w-sm w-full mx-4 text-center animate-gentle-pulse">
              
              {/* Premium Rotating Spinner */}
              <div className="relative w-16 h-16 mb-5">
                <div className="absolute inset-0 rounded-full border-4 border-emerald-500/10 dark:border-emerald-400/10" />
                <div className="absolute inset-0 rounded-full border-4 border-t-emerald-500 dark:border-t-emerald-400 border-r-transparent animate-spin" />
                <span className="absolute inset-0 flex items-center justify-center text-2xl animate-bounce">
                  🎬
                </span>
              </div>
              
              <h3 className="text-lg font-bold text-gray-900 dark:text-gray-100 mb-1.5 font-poppins">
                Getting Video URL
              </h3>
              
              <p className="text-xs text-gray-500 dark:text-gray-400 max-w-[240px] leading-relaxed font-inter">
                Securing a high-speed streaming channel. Please wait...
              </p>
              
              {/* Animated Progress Indicator Bar */}
              <div className="w-full bg-gray-100 dark:bg-gray-800 h-1.5 rounded-full mt-6 overflow-hidden">
                <div className="h-full bg-gradient-to-r from-emerald-500 to-teal-400 dark:from-emerald-400 dark:to-teal-300 rounded-full w-2/3 animate-pulse" style={{ animationDuration: '1.5s' }} />
              </div>
            </div>
          </div>
        )}

        {!loading && !isBatchUnavailable && videoType === "youtube" && videoUrl && (
          <YouTubePlayer videoId={extractYouTubeVideoId(videoUrl)} ContentId={ContentId} />
        )}

        {!loading && !isBatchUnavailable && videoType === "penpencilvdo" && videoUrl ? (
          videoUrl.includes(".m3u8") ? (
            <HLSPlayer
              baseUrl={videoUrl}
              signedQuery={signedUrlQuery}
              attachments={attachments}
              downloadUrl={downloadUrl || undefined}
              lectureTitle={lectureData?.title || ""}
              lectureThumbnail={lectureData?.thumbnail || ""}
              onError={handleHLSError}
            />
          ) : (
            <DashPlayer
              src={videoUrl}
              type="dash"
              attachments={attachments}
              signedUrlQuery={signedUrlQuery}
              drmConfig={clearKeys ? { clearKeys } : undefined}
              ContentId={ContentId}
              lectureTitle={lectureData?.title || ""}
              lectureThumbnail={lectureData?.thumbnail || ""}
              batchId={batchId}
            />
          )
        ) : !loading && (videoType === null || isBatchUnavailable) ? (
          <div className="flex flex-col items-center justify-center min-h-[400px] h-full p-6 text-center bg-gradient-to-br from-[#eef7f0] via-[#e4f6e8] to-[#f5f8ff] dark:from-[#0F1908] dark:via-[#1C2B22] dark:to-[#151D1A] transition-colors duration-300">
            <div className="w-full max-w-md p-8 rounded-2xl bg-white/80 dark:bg-[#1c2b22]/80 backdrop-blur-md shadow-xl border border-red-500/10 flex flex-col items-center animate-scaleIn">
              <Heart className="w-16 h-16 text-red-500 fill-red-500 animate-pulse mb-4 drop-shadow-[0_0_10px_rgba(239,68,68,0.5)]" />
              <h2 className="text-xl font-bold text-gray-900 dark:text-gray-100 mb-3 leading-snug">
                This batch is unavailable. Ask your friend to donate this.
              </h2>
              <p className="text-xs text-gray-500 dark:text-gray-400 mb-6 leading-relaxed">
                If your friend has this batch, then login here and that batch will be automatically added.
              </p>

              <div className="flex flex-col sm:flex-row gap-3 w-full justify-center">
                <button
                  onClick={() => {
                    if (typeof window !== "undefined") {
                      sessionStorage.setItem("donate_batch_id", batchId);
                    }
                    router.push("/study/donate");
                  }}
                  className="px-6 py-2.5 spring-btn-primary flex items-center justify-center gap-2 shadow-md"
                >
                  <Heart size={15} fill="#ffffff" />
                  Donate Batch
                </button>
                <button
                  onClick={() => router.back()}
                  className="px-6 py-2.5 bg-gray-100 hover:bg-gray-200 dark:bg-gray-800 dark:hover:bg-gray-700 text-gray-700 dark:text-gray-300 font-semibold rounded-xl transition-all duration-300 active:scale-95"
                >
                  Go Back
                </button>
              </div>
            </div>
          </div>
        ) : null}
      </div>
    </div>
  );
}

// Extract YouTube video ID helper
function extractYouTubeVideoId(url: string): string {
  try {
    const parsedUrl = new URL(url);

    if (parsedUrl.hostname === "youtu.be") {
      return parsedUrl.pathname.slice(1);
    }

    const vParam = parsedUrl.searchParams.get("v");
    if (vParam && vParam.length === 11) {
      return vParam;
    }

    const match = parsedUrl.pathname.match(
      /\/(embed|v|shorts)\/([a-zA-Z0-9_-]{11})/
    );
    if (match && match[2]) {
      return match[2];
    }

    return "";
  } catch {
    return "";
  }
}
