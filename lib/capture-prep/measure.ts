/**
 * Browser-side measurement of one photo: decode (honouring EXIF orientation), downscale to
 * ≤512 px on an OffscreenCanvas, then run the pure metrics. Used by analysis.worker.ts and by
 * the calibration script, so the thresholds are calibrated on exactly this pipeline.
 */
import { dHash, fitWithin, laplacianVariance, toGrayscale } from "./metrics";

export type PhotoMeasurement = { blur: number; hash: string; width: number; height: number };

export async function measurePhoto(blob: Blob): Promise<PhotoMeasurement> {
  const bitmap = await createImageBitmap(blob);
  try {
    const { width, height } = fitWithin(bitmap.width, bitmap.height);
    const canvas = new OffscreenCanvas(width, height);
    const ctx = canvas.getContext("2d", { willReadFrequently: true });
    if (!ctx) throw new Error("2D canvas is not available.");
    // "high" uses a proper downsampling filter; the default can alias, which inflates the Laplacian.
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = "high";
    ctx.drawImage(bitmap, 0, 0, width, height);
    const gray = toGrayscale(ctx.getImageData(0, 0, width, height).data, width, height);
    return { blur: laplacianVariance(gray, width, height), hash: dHash(gray, width, height), width: bitmap.width, height: bitmap.height };
  } finally {
    bitmap.close();
  }
}
