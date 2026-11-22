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

/**
 * Name for a converted photo: "IMG_0001.HEIC" → "IMG_0001.heic.jpg" (review L4). Keeping the
 * original extension means it cannot collide with a real "IMG_0001.jpg" from the same camera
 * roll, and it is deterministic, so adding the same HEIC again de-duplicates by name and size.
 */
export function jpegName(name: string): string {
  const match = /^(.*?)(\.[^./\\]*)?$/.exec(name)!;
  const stem = match[1] || "photo", ext = (match[2] ?? "").toLowerCase();
  return ext === ".jpg" ? `${stem}.jpg` : `${stem}${ext}.jpg`;
}

/**
 * `name`, or "stem (2).ext", "stem (3).ext", … — the first name that no *other* photo uses.
 * `taken` maps names already in the selection (and earlier in this batch) to their byte sizes.
 * A name held by a photo of the same size is returned unchanged: that is the same photo added
 * again, and the caller's name + size check drops it.
 */
export function uniqueName(name: string, size: number, taken: ReadonlyMap<string, ReadonlySet<number>>): string {
  const dot = name.lastIndexOf(".");
  const stem = dot > 0 ? name.slice(0, dot) : name, ext = dot > 0 ? name.slice(dot) : "";
  for (let n = 1; ; n++) {
    const candidate = n === 1 ? name : `${stem} (${n})${ext}`;
    const sizes = taken.get(candidate);
    if (!sizes || sizes.has(size)) return candidate;
  }
}

type Named = { name: string; size: number };
const addName = (index: Map<string, Set<number>>, { name, size }: Named) => index.set(name, (index.get(name) ?? new Set<number>()).add(size));

/**
 * Final names for one add: `batch[i].converted` marks JPEGs made from HEIC, which get a
 * `uniqueName` against the photos already selected, the batch's other files, and the converted
 * photos named before them. Other files keep their names (Studio's name + size check handles them).
 */
export function convertedNames(selected: readonly Named[], batch: readonly (Named & { converted: boolean })[]): string[] {
  const taken = new Map<string, Set<number>>();
  [...selected, ...batch.filter(item => !item.converted)].forEach(item => addName(taken, item));
  return batch.map(item => {
    if (!item.converted) return item.name;
    const name = uniqueName(item.name, item.size, taken);
    addName(taken, { name, size: item.size });
    return name;
  });
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

/**
 * Review item 6: which HEICs of one add would go over the photo limit and so are not converted.
 * `sources[i]` is the source key of a HEIC (null for other files). Only HEICs that will actually be
 * added use a slot: not other files (Studio applies the limit to them), not a repeat of a source
 * earlier in the add, and not a source whose converted copy is already selected (`selected`).
 */
export function heicOverLimit(sources: readonly (string | null)[], slots: number, selected: ReadonlySet<string>): boolean[] {
  const verdict = new Map<string, boolean>([...selected].map(source => [source, false]));
  let used = 0;
  return sources.map(source => {
    if (source === null) return false;
    if (!verdict.has(source)) verdict.set(source, used++ >= slots);
    return verdict.get(source)!;
  });
}
