/**
 * Browser-side measurement of one photo: decode (honouring EXIF orientation) straight to ≤512 px,
 * then run the pure metrics. Used by analysis.worker.ts and by the calibration script, so the
 * thresholds are calibrated on exactly this pipeline.
 */
import { displaySize, HEADER_BYTES } from "./dimensions";
import { dHash, fitWithin, laplacianVariance, toGrayscale } from "./metrics";

export type PhotoMeasurement = { blur: number; hash: string };

/**
 * Decode at analysis size. When the header gives the upright size, the browser resizes during
 * decode ("high" = a proper downsampling filter), so a 48 MP photo never becomes a 190 MB bitmap.
 * Without a readable header it falls back to a full decode.
 */
async function decodeSmall(blob: Blob): Promise<ImageBitmap> {
  const size = displaySize(new Uint8Array(await blob.slice(0, HEADER_BYTES).arrayBuffer()));
  if (size) {
    const target = fitWithin(size.width, size.height);
    if (target.width < size.width) {
      try {
        return await createImageBitmap(blob, { resizeWidth: target.width, resizeHeight: target.height, resizeQuality: "high" });
      } catch { /* resize options unsupported: full decode below */ }
    }
  }
  return createImageBitmap(blob);
}

export async function measurePhoto(blob: Blob): Promise<PhotoMeasurement> {
  const bitmap = await decodeSmall(blob);
  try {
    const { width, height } = fitWithin(bitmap.width, bitmap.height);
    const canvas = new OffscreenCanvas(width, height);
    const ctx = canvas.getContext("2d", { willReadFrequently: true });
    if (!ctx) throw new Error("2D canvas is not available.");
    // Transparent PNG areas would read as black; flatten onto white, as the JPEG encoder does.
    ctx.fillStyle = "#fff";
    ctx.fillRect(0, 0, width, height);
    // Only the fallback path still needs a real downscale; "high" avoids aliasing, which inflates the Laplacian.
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = "high";
    ctx.drawImage(bitmap, 0, 0, width, height);
    const gray = toGrayscale(ctx.getImageData(0, 0, width, height).data, width, height);
    return { blur: laplacianVariance(gray, width, height), hash: dHash(gray, width, height) };
  } finally {
    bitmap.close();
  }
}
