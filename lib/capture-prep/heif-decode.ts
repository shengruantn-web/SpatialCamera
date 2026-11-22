/**
 * Decode the primary image of a HEIC/HEIF file with libheif-js to upright RGBA pixels.
 * libheif applies the file's irot/imir/clap transforms, so iPhone orientation is preserved.
 * No DOM access: runs in heic.worker.ts and in node tests.
 */
import type { HeifPixels, LibHeif } from "libheif-js/libheif-wasm/libheif-bundle.mjs";

export class HeifDecodeError extends Error {}

export async function decodeHeif(lib: LibHeif, bytes: Uint8Array): Promise<HeifPixels> {
  const decoder = new lib.HeifDecoder();
  try {
    const images = decoder.decode(bytes);
    if (!images.length) throw new HeifDecodeError("No decodable image in this HEIC file.");
    try {
      const primary = images.find(image => image.is_primary()) ?? images[0];
      const width = primary.get_width(), height = primary.get_height();
      const pixels = await new Promise<HeifPixels | null>(resolve =>
        primary.display({ data: new Uint8ClampedArray(width * height * 4), width, height }, resolve));
      if (!pixels) throw new HeifDecodeError("The HEIC image data could not be decoded.");
      return pixels;
    } finally {
      images.forEach(image => image.free());
    }
  } finally {
    // Free the native context now rather than on the next decode; WASM memory is not GC'd.
    if (decoder.decoder) lib.heif_context_free(decoder.decoder);
    decoder.decoder = null;
  }
}
