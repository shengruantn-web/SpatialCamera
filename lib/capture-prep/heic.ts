/**
 * Pure HEIC/HEIF helpers (PRD R1.3). The server only accepts JPEG/PNG (lib/validation.ts),
 * so HEIC photos are converted to JPEG in the browser before the manifest is created.
 */
import { MAX_IMAGE_BYTES } from "../validation";

export const HEIC_EXTENSIONS = [".heic", ".heif", ".hif"];
export const HEIC_MIME_TYPES = ["image/heic", "image/heif", "image/heic-sequence", "image/heif-sequence"];
/** ISOBMFF brands that identify HEVC-coded HEIF still images. */
const HEIC_BRANDS = new Set(["heic", "heix", "heim", "heis", "hevc", "hevx", "hevm", "hevs"]);
/** Generic HEIF brands; also used by AVIF, so they only count alongside an HEVC brand. */
const GENERIC_HEIF_BRANDS = new Set(["mif1", "msf1", "mif2"]);

/** Initial JPEG quality for converted photos (close to iPhone "Most Compatible" output). */
export const JPEG_QUALITY = 0.92;
/** Qualities tried in order while the encoded JPEG exceeds the per-photo limit. */
export const JPEG_QUALITY_LADDER = [0.92, 0.85, 0.75, 0.65] as const;
/** Never shrink a converted photo below this fraction of its original dimensions. */
export const MIN_DOWNSCALE = 0.25;

export function hasHeicExtension(name: string): boolean {
  const lower = name.toLowerCase();
  return HEIC_EXTENSIONS.some(ext => lower.endsWith(ext));
}
export function isHeicMime(mime: string): boolean {
  return HEIC_MIME_TYPES.includes(mime.toLowerCase());
}

/** Detect HEIC from the leading bytes (ftyp box). Needs ≥ 12 bytes; 64 is plenty. */
export function sniffHeic(bytes: Uint8Array): boolean {
  if (bytes.length < 12) return false;
  const ascii = (at: number) => String.fromCharCode(bytes[at], bytes[at + 1], bytes[at + 2], bytes[at + 3]);
  if (ascii(4) !== "ftyp") return false;
  const boxSize = ((bytes[0] << 24) | (bytes[1] << 16) | (bytes[2] << 8) | bytes[3]) >>> 0;
  const end = Math.min(bytes.length, boxSize >= 16 ? boxSize : 16);
  const brands = [ascii(8)];
  for (let at = 16; at + 4 <= end; at += 4) brands.push(ascii(at));
  if (HEIC_BRANDS.has(brands[0])) return true;
  return GENERIC_HEIF_BRANDS.has(brands[0]) && brands.some(b => HEIC_BRANDS.has(b));
}

/**
 * Cheap check from name/MIME only. iPhone files often arrive with an empty MIME type, so the
 * extension matters; callers sniff bytes when this returns "unknown".
 */
export function classifyByNameAndType(name: string, mime: string): "heic" | "not-heic" | "unknown" {
  if (isHeicMime(mime) || hasHeicExtension(name)) return "heic";
  if (mime === "image/jpeg" || mime === "image/png") return "not-heic";
  return "unknown";
}

/** "IMG_0001.HEIC" → "IMG_0001.jpg". */
export function jpegName(name: string): string {
  const base = name.replace(/\.[^./\\]*$/, "");
  return `${base || "photo"}.jpg`;
}

export type EncodeAttempt = { quality: number; scale: number };
export type EncodeDecision = { kind: "done" } | { kind: "retry"; next: EncodeAttempt } | { kind: "give-up" };

/**
 * Given the size of the last JPEG encode, decide the next attempt so the converted photo
 * fits the server's per-photo limit: step down the quality ladder first, then downscale.
 */
export function nextEncodeAttempt(last: EncodeAttempt & { bytes: number }, limit = MAX_IMAGE_BYTES): EncodeDecision {
  if (last.bytes <= limit) return { kind: "done" };
  const lower = JPEG_QUALITY_LADDER.find(q => q < last.quality - 1e-9);
  if (lower !== undefined) return { kind: "retry", next: { quality: lower, scale: last.scale } };
  // JPEG size scales roughly with pixel count, so shrink each side by √(limit / bytes), with margin.
  const scale = last.scale * Math.min(0.9, Math.sqrt(limit / last.bytes) * 0.95);
  if (scale < MIN_DOWNSCALE) return { kind: "give-up" };
  return { kind: "retry", next: { quality: last.quality, scale } };
}
