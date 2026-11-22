// S10 (ADR-0009, spec §7.11): the browser side of a video capture, through R2 multipart.
import { putWithRetry, runPool, sleep, type Sleep } from "./client";
import { VIDEO_TYPES } from "./validation";

/** Video parts in flight at once: three 8 MiB parts keep a fast uplink busy without hoarding memory. */
export const VIDEO_UPLOAD_CONCURRENCY = 3;
export const VIDEO_ACCEPT = Object.keys(VIDEO_TYPES).join(",");

type Json = Record<string, unknown>;
export type VideoUploadOptions = {
  name: string;
  file: Blob & { name?: string; type: string };
  keepVideo: boolean;
  /** An unfinished video capture to upload into instead of creating one (the same file must be chosen again). */
  resumeId?: string;
  fetcher?: typeof fetch;
  wait?: Sleep;
  signal?: AbortSignal;
  /** Called once the capture exists, so the caller can show it (and resume it after a reload). */
  onCreated?: (id: string) => void;
  /** Fraction (0–1) of the video's bytes the server has confirmed. */
  onProgress?: (fraction: number) => void;
};

/** The MIME the server expects: browsers sometimes leave `type` empty for a .mov or .mp4. */
export function videoMime(file: { name?: string; type: string }): string | null {
  if (Object.hasOwn(VIDEO_TYPES, file.type)) return file.type;
  const extension = file.name?.toLowerCase().split(".").pop();
  if (!file.type && extension === "mov") return "video/quicktime";
  if (!file.type && (extension === "mp4" || extension === "m4v")) return "video/mp4";
  return null;
}

/**
 * Creates the capture (unless resuming), uploads the video in parts, completes the upload and submits the
 * capture; returns its id. Each part retries transient failures. A failure or an abort leaves the upload
 * open: retrying, or reopening the capture and choosing the same file, starts a fresh upload (the server
 * aborts the old one, and R2 aborts any upload left incomplete for 7 days).
 */
export async function uploadVideoCapture({ name, file, keepVideo, resumeId, fetcher = fetch, wait = sleep, signal, onCreated, onProgress }: VideoUploadOptions): Promise<string> {
  const mime = videoMime(file);
  if (!mime) throw new Error("Choose an MP4 or MOV video.");
  async function call<T = Json>(path: string, init: RequestInit = {}): Promise<T> {
    const response = await fetcher(`/api/${path}`, { ...init, signal, headers: init.body ? { "Content-Type": "application/json" } : undefined });
    const data = await response.json().catch(() => ({ error: "The server could not be reached. Please try again." })) as T & { error?: string };
    if (!response.ok) throw new Error(data.error ?? "Request failed.");
    return data;
  }
  let id = resumeId;
  if (!id) {
    const created = await call<{ id: string }>("captures", { method: "POST", body: JSON.stringify({ name, source: "video", keep_video: keepVideo, video: { name: file.name || `video.${VIDEO_TYPES[mime]}`, bytes: file.size, mime } }) });
    id = created.id;
  }
  signal?.throwIfAborted();
  onCreated?.(id);
  const { upload, part_bytes: partBytes, parts } = await call<{ upload: string; part_bytes: number; parts: number }>(`captures/${id}/video/upload`, { method: "POST" });
  if (parts !== Math.ceil(file.size / partBytes)) throw new Error("This is not the video this capture was created with. Choose the same file again.");
  const numbers = Array.from({ length: parts }, (_, index) => index + 1);
  const etags = new Map<number, string>();
  let done = 0;
  onProgress?.(0);
  await runPool(numbers, VIDEO_UPLOAD_CONCURRENCY, async n => {
    const body = file.slice((n - 1) * partBytes, n * partBytes);
    const response = await putWithRetry(`/api/captures/${id}/video/parts/${n}?upload=${encodeURIComponent(upload)}`, body, mime,
      { fetcher, wait, signal, label: `part ${n} of the video` });
    const part = await response.json() as { part_number: number; etag: string };
    etags.set(n, part.etag);
    done += body.size; onProgress?.(done / file.size);
  }, signal);
  await call(`captures/${id}/video/complete?upload=${encodeURIComponent(upload)}`, { method: "POST", body: JSON.stringify({ parts: numbers.map(n => ({ part_number: n, etag: etags.get(n) })) }) });
  await call(`captures/${id}/submit`, { method: "POST" });
  return id;
}
