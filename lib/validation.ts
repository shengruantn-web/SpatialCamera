export const MIN_IMAGES = 12;
export const MAX_IMAGES = 200;
export const MAX_IMAGE_BYTES = 20 * 1024 * 1024;
export const MAX_TOTAL_BYTES = 1024 * 1024 * 1024;
export type ImageInput = { name: string; bytes: number; mime: string };

export function validateManifest(value: unknown): { name: string; images: ImageInput[] } {
  if (!value || typeof value !== "object") throw new Error("Invalid capture.");
  const input = value as Record<string, unknown>;
  if (typeof input.name !== "string" || !input.name.trim() || input.name.trim().length > 80) throw new Error("Give your capture a name of 1–80 characters.");
  if (!Array.isArray(input.images) || input.images.length < MIN_IMAGES || input.images.length > MAX_IMAGES) throw new Error(`Choose ${MIN_IMAGES}–${MAX_IMAGES} overlapping photos.`);
  let total = 0;
  const images = input.images.map((image: unknown) => {
    if (!image || typeof image !== "object") throw new Error("Invalid photo.");
    const item = image as ImageInput;
    if (typeof item.name !== "string" || !item.name.length || item.name.length > 255) throw new Error("Invalid photo filename.");
    if (!["image/jpeg", "image/png"].includes(item.mime)) throw new Error("Use JPG or PNG photos. Convert HEIC photos before uploading.");
    if (!Number.isSafeInteger(item.bytes) || item.bytes <= 0 || item.bytes > MAX_IMAGE_BYTES) throw new Error("Each photo must be smaller than 20 MB.");
    total += item.bytes;
    return { name: item.name, bytes: item.bytes, mime: item.mime };
  });
  if (total > MAX_TOTAL_BYTES) throw new Error("Keep the complete capture under 1 GB.");
  return { name: input.name.trim(), images };
}
export function isImage(bytes: Uint8Array, mime: string) {
  if (mime === "image/jpeg") return bytes.length > 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
  return bytes.length > 8 && [137, 80, 78, 71, 13, 10, 26, 10].every((b, i) => bytes[i] === b);
}
export function isGaussianPly(header: string) {
  return header.startsWith("ply\n") && header.includes("end_header") &&
    /element vertex [1-9]\d*/.test(header) &&
    ["x", "y", "z", "opacity", "scale_0", "scale_1", "scale_2", "rot_0", "rot_1", "rot_2", "rot_3", "f_dc_0", "f_dc_1", "f_dc_2"].every(
      key => new RegExp(`property float ${key}\\r?\\n`).test(header));
}
export const MAX_PLY_BYTES = 90 * 1024 * 1024;
export const MAX_SPZ_BYTES = 48 * 1024 * 1024;
export const MAX_SPLAT_POINTS = 10_000_000;
const SPZ_MAGIC = 0x5053474e; // "NGSP"
const SPZ_SH_DIMS = [0, 3, 8, 15];
/** Decompressed size of a legacy SPZ: the header, then per point position (3×24 bit), alpha, color,
 * scale, rotation (v2: 3 bytes, v3: 4) and the SH coefficients of its degree, one byte each. */
export const spzRawBytes = (version: number, points: number, shDegree: number) =>
  16 + points * (9 + 1 + 3 + 3 + (version >= 3 ? 4 : 3) + SPZ_SH_DIMS[shDegree] * 3);
export const isGzip = (bytes: Uint8Array) => bytes.length >= 18 && bytes[0] === 0x1f && bytes[1] === 0x8b && bytes[2] === 0x08;
/**
 * Checks the 16-byte header of a decompressed SPZ (the gzip "legacy" container, versions 2–3, that the
 * worker writes and Spark reads) against the compressed size the uploader declared. Returns the point
 * count and `rawBytes`, the exact decompressed size the header implies (the API inflates the whole upload
 * and requires exactly that many bytes), or null when the header is not one we serve.
 */
export function parseSpzHeader(header: Uint8Array, compressedBytes: number) {
  if (header.length < 16) return null;
  const view = new DataView(header.buffer, header.byteOffset, 16);
  const [magic, version, points] = [view.getUint32(0, true), view.getUint32(4, true), view.getUint32(8, true)];
  const [shDegree, fractionalBits, flags, reserved] = [header[12], header[13], header[14], header[15]];
  // Flag 0x1 is antialiasing (harmless); 0x2 announces extensions this server does not vet.
  if (magic !== SPZ_MAGIC || (version !== 2 && version !== 3) || points < 1 || points > MAX_SPLAT_POINTS ||
    shDegree > 3 || fractionalBits > 23 || reserved !== 0 || flags & ~0x1) return null;
  // Decompressed size is fixed by the header; gzip can neither expand it ~1000× nor shrink it to nothing.
  const raw = spzRawBytes(version, points, shDegree);
  if (raw > compressedBytes * 1032 || compressedBytes > raw * 1.01 + 1024) return null;
  return { version, points, shDegree, rawBytes: raw };
}
/** Optional `metrics` in a worker status PATCH. Unknown keys are ignored; known keys are range-checked. */
export function parseWorkerMetrics(value: unknown): { alignmentRatio: number | null } {
  if (value === undefined || value === null) return { alignmentRatio: null };
  if (typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid worker metrics.");
  const ratio = (value as Record<string, unknown>).alignment_ratio;
  if (ratio === undefined || ratio === null) return { alignmentRatio: null };
  if (typeof ratio !== "number" || !Number.isFinite(ratio) || ratio < 0 || ratio > 1) throw new Error("Invalid worker metrics: alignment_ratio must be a number from 0 to 1.");
  return { alignmentRatio: ratio };
}
