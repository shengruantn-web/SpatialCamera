/**
 * Image size from the file header, read before any decode, so oversized photos are refused
 * without allocating their pixels and analysis can ask the browser for a small bitmap directly.
 * Pure byte parsing: runs in workers and in node tests.
 */

/**
 * Largest photo the browser-side prep will decode. A 48 MP iPhone photo (8064 × 6048 = 48.8 MP)
 * fits; at 4 bytes a pixel the RGBA buffer alone is ~200 MB, so anything bigger risks crashing
 * the worker (two HEIC workers can run at once).
 */
export const MAX_DECODE_PIXELS = 50_000_000;
/** Header bytes to read. EXIF and SOF sit in the first few KB of camera JPEGs; HEIC `meta` comes before `mdat`. */
export const HEADER_BYTES = 256 * 1024;

export type ImageSize = { width: number; height: number };

const u16 = (b: Uint8Array, i: number, little = false) => little ? b[i] | (b[i + 1] << 8) : (b[i] << 8) | b[i + 1];
const u32 = (b: Uint8Array, i: number, little = false) =>
  (little ? (b[i + 3] << 24) | (b[i + 2] << 16) | (b[i + 1] << 8) | b[i] : (b[i] << 24) | (b[i + 1] << 16) | (b[i + 2] << 8) | b[i + 3]) >>> 0;

/** PNG: the IHDR chunk is always first. */
export function pngSize(b: Uint8Array): ImageSize | null {
  const signature = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  if (b.length < 24 || signature.some((v, i) => b[i] !== v)) return null;
  if (String.fromCharCode(b[12], b[13], b[14], b[15]) !== "IHDR") return null;
  const width = u32(b, 16), height = u32(b, 20);
  return width && height ? { width, height } : null;
}

/** EXIF orientation (1–8) from an APP1 payload starting at "Exif\0\0"; 1 when absent. */
function exifOrientation(b: Uint8Array, start: number, end: number): number {
  const tiff = start + 6;
  if (tiff + 8 > end) return 1;
  const little = b[tiff] === 0x49 && b[tiff + 1] === 0x49; // "II" = little-endian, "MM" = big-endian
  if (!little && !(b[tiff] === 0x4d && b[tiff + 1] === 0x4d)) return 1;
  const ifd = tiff + u32(b, tiff + 4, little);
  if (ifd + 2 > end) return 1;
  const count = u16(b, ifd, little);
  for (let k = 0; k < count; k++) {
    const entry = ifd + 2 + k * 12;
    if (entry + 12 > end) break;
    if (u16(b, entry, little) === 0x0112) {
      const value = u16(b, entry + 8, little);
      return value >= 1 && value <= 8 ? value : 1;
    }
  }
  return 1;
}

/** JPEG: frame size from the first SOF marker, and EXIF orientation. Size is as stored (before rotation). */
export function jpegInfo(b: Uint8Array): (ImageSize & { orientation: number }) | null {
  if (b.length < 4 || b[0] !== 0xff || b[1] !== 0xd8) return null;
  let i = 2, orientation = 1;
  while (i + 4 <= b.length) {
    if (b[i] !== 0xff) return null;
    const marker = b[i + 1];
    if (marker === 0xff) { i++; continue; } // fill byte
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) { i += 2; continue; } // no payload
    if (marker === 0xd9 || marker === 0xda) return null; // end of image / scan data before any SOF
    const length = u16(b, i + 2);
    if (length < 2) return null;
    const payload = i + 4, end = Math.min(b.length, i + 2 + length);
    if (marker === 0xe1 && end - payload >= 6 && String.fromCharCode(...b.subarray(payload, payload + 6)) === "Exif\0\0") {
      orientation = exifOrientation(b, payload, end);
    }
    // SOF0–SOF15 except DHT (C4), JPG (C8) and DAC (CC).
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      if (payload + 5 > b.length) return null;
      const height = u16(b, payload + 1), width = u16(b, payload + 3);
      return width && height ? { width, height, orientation } : null;
    }
    i += 2 + length;
  }
  return null;
}

/**
 * HEIC/HEIF: the largest `ispe` (image spatial extent) property. Grid images (iPhone) list each
 * 512 px tile and the full canvas; the canvas is the largest. This is the size before any `clap`
 * crop, so it is an upper bound on the decoded pixels; rotation does not change the pixel count.
 */
export function heicSize(b: Uint8Array): ImageSize | null {
  let best: ImageSize | null = null;
  for (let i = 4; i + 16 <= b.length; i++) {
    if (b[i] !== 0x69 || b[i + 1] !== 0x73 || b[i + 2] !== 0x70 || b[i + 3] !== 0x65) continue; // "ispe"
    if (u32(b, i - 4) !== 20) continue; // box size: header 8 + version/flags 4 + width 4 + height 4
    const width = u32(b, i + 8), height = u32(b, i + 12);
    if (width && height && (!best || width * height > best.width * best.height)) best = { width, height };
  }
  return best;
}

/** Upright display size of a JPEG or PNG (EXIF orientations 5–8 swap the axes), or null if unknown. */
export function displaySize(b: Uint8Array): ImageSize | null {
  const png = pngSize(b);
  if (png) return png;
  const jpeg = jpegInfo(b);
  if (!jpeg) return null;
  return jpeg.orientation >= 5 ? { width: jpeg.height, height: jpeg.width } : { width: jpeg.width, height: jpeg.height };
}

export const megapixels = ({ width, height }: ImageSize) => Math.round(width * height / 1e5) / 10;
