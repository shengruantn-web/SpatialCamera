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
