export type CaptureStatus = "uploading" | "queued" | "aligning" | "training" | "exporting" | "ready" | "failed";
export type Capture = {
  id: string; name: string; status: CaptureStatus;
  created_at: number; updated_at: number; image_count: number; uploaded_count: number;
  error: string | null; result_bytes: number | null;
  // Size of the SPZ the viewer loads; null when only the PLY was delivered (it then loads the PLY).
  spz_bytes?: number | null;
  // Stage entry times (ms) for the current attempt, and the worker-reported alignment ratio (0..1).
  queued_at?: number | null; aligning_at?: number | null; training_at?: number | null; exporting_at?: number | null;
  ready_at?: number | null; failed_at?: number | null; alignment_ratio?: number | null;
  // S10 (ADR-0009): a video capture has image_count 0; frames are extracted by the GPU worker.
  source_kind?: "photos" | "video"; video_bytes?: number | null; video_uploaded?: number | null; keep_video?: number | null;
  // 1 while the source video is stored (uploaded and not yet deleted after publishing, or kept).
  video_stored?: number | null;
};
export const stages = ["queued", "aligning", "training", "exporting", "ready"] as const;
export const statusLabels: Record<CaptureStatus, string> = {
  uploading: "Upload incomplete", queued: "Waiting for processor", aligning: "Aligning cameras",
  training: "Building your splat", exporting: "Preparing your scene", ready: "Ready to explore", failed: "Needs attention",
};
