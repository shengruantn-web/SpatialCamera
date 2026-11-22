/**
 * HEIC/HEIF → JPEG conversion, off the main thread. One photo per message.
 * Safari decodes HEIC natively; elsewhere libheif-js (LGPL-3.0: ~90 KB glue + ~1.5 MB WASM, two
 * separate files) is loaded on first need with a dynamic import, so it never reaches the main bundle.
 */
import type { LibHeif } from "libheif-js/libheif-wasm/libheif.js";
import { JPEG_QUALITY, nextEncodeAttempt, type EncodeAttempt } from "./heic";
import { HEADER_BYTES, heicSize, MAX_DECODE_PIXELS, megapixels, type ImageSize } from "./dimensions";
import { decodeHeif, HeifDecodeError, HeifTooLargeError } from "./heif-decode";
import type { ConversionMessage, ConversionStage, JobRequest, WorkerScope } from "./protocol";

const scope = self as unknown as WorkerScope<JobRequest, ConversionMessage>;
scope.postMessage({ id: 0, type: "ready" });

/** Error whose message is shown to the user as-is. */
class ConversionError extends Error {}

const EXPORT_HINT = "Export it as JPEG instead (iPhone: Settings › Camera › Formats › Most Compatible, or share it from Photos as JPEG) and add it again.";

let libheif: Promise<LibHeif> | null = null;
function loadLibheif(): Promise<LibHeif> {
  libheif ??= import("./libheif-loader")
    .then(module => module.createLibheif())
    .catch(error => { libheif = null; throw error; });
  return libheif;
}

const tooLarge = (size: ImageSize) => new ConversionError(
  `This photo is ${size.width} × ${size.height} (${megapixels(size)} MP), larger than the ${MAX_DECODE_PIXELS / 1e6} MP the browser converter can handle safely. Export it as a JPEG or reduce its size and add it again.`);

async function decode(file: File, stage: (s: ConversionStage) => void): Promise<ImageBitmap> {
  stage("decoding");
  // Refuse oversized photos from the header, before any decoder allocates their pixels.
  const declared = heicSize(new Uint8Array(await file.slice(0, HEADER_BYTES).arrayBuffer()));
  if (declared && declared.width * declared.height > MAX_DECODE_PIXELS) throw tooLarge(declared);
  // Safari (and any browser with a HEIC codec) decodes natively, applying the file's rotation.
  try { return await createImageBitmap(file); } catch { /* no native HEIC support: use libheif */ }
  let lib: LibHeif;
  try {
    if (!libheif) stage("loading-decoder");
    lib = await loadLibheif();
  } catch {
    throw new ConversionError("The HEIC converter could not be downloaded. Check your connection and add this photo again, or export it as JPEG.");
  }
  stage("decoding");
  try {
    const pixels = await decodeHeif(lib, new Uint8Array(await file.arrayBuffer()), MAX_DECODE_PIXELS);
    return await createImageBitmap(new ImageData(pixels.data, pixels.width, pixels.height));
  } catch (error) {
    if (error instanceof HeifTooLargeError) throw tooLarge(error);
    if (error instanceof HeifDecodeError) throw new ConversionError(`This HEIC file could not be read; it may be damaged or use an unsupported variant. ${EXPORT_HINT}`);
    throw error;
  }
}

async function encode(bitmap: ImageBitmap): Promise<{ blob: Blob; attempt: EncodeAttempt; width: number; height: number }> {
  let attempt: EncodeAttempt = { quality: JPEG_QUALITY, scale: 1 };
  for (;;) {
    const width = Math.max(1, Math.round(bitmap.width * attempt.scale));
    const height = Math.max(1, Math.round(bitmap.height * attempt.scale));
    const canvas = new OffscreenCanvas(width, height);
    // Review L1: sRGB canvas, no ICC in the output; a Display-P3 profile from heif-decode.ts would be applied here.
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new ConversionError("This browser cannot convert HEIC photos. " + EXPORT_HINT);
    ctx.fillStyle = "#fff"; // JPEG has no alpha; flatten any transparency onto white.
    ctx.fillRect(0, 0, width, height);
    ctx.imageSmoothingQuality = "high";
    ctx.drawImage(bitmap, 0, 0, width, height);
    const blob = await canvas.convertToBlob({ type: "image/jpeg", quality: attempt.quality });
    if (blob.type !== "image/jpeg") throw new ConversionError("This browser cannot encode JPEG photos. " + EXPORT_HINT);
    const decision = nextEncodeAttempt({ ...attempt, bytes: blob.size });
    if (decision.kind === "done") return { blob, attempt, width, height };
    if (decision.kind === "give-up") throw new ConversionError("This photo stays over 20 MB even at reduced quality and size. Export it as a smaller JPEG and add it again.");
    attempt = decision.next;
  }
}

scope.onmessage = async event => {
  const { id, file } = event.data;
  const stage = (s: ConversionStage) => scope.postMessage({ id, type: "stage", stage: s });
  let bitmap: ImageBitmap | null = null;
  try {
    bitmap = await decode(file, stage);
    stage("encoding");
    const { blob, attempt, width, height } = await encode(bitmap);
    scope.postMessage({ id, type: "done", blob, quality: attempt.quality, scale: attempt.scale, width, height });
  } catch (error) {
    const message = error instanceof ConversionError ? error.message
      : error instanceof RangeError ? "Ran out of memory converting this photo. Close other tabs or add fewer HEIC photos at a time."
      : `Conversion failed (${(error as Error)?.message || "unknown error"}). ${EXPORT_HINT}`;
    scope.postMessage({ id, type: "error", reason: "failed", message });
  } finally {
    bitmap?.close();
  }
};
