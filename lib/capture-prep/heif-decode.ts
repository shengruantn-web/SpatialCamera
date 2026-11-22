/**
 * Decode the primary image of a HEIC/HEIF file with libheif-js to upright RGBA pixels.
 * libheif applies the file's irot/imir/clap transforms, so iPhone orientation is preserved.
 * No DOM access: runs in heic.worker.ts and in node tests.
 */
import type { HeifPixels, LibHeif } from "libheif-js/libheif-wasm/libheif.js";

export class HeifDecodeError extends Error {}
/** The image is larger than `maxPixels`; thrown before its pixel buffer is allocated. */
export class HeifTooLargeError extends Error {
  constructor(readonly width: number, readonly height: number) { super(`HEIC image is ${width} × ${height}, over the decode limit.`); }
}

export async function decodeHeif(lib: LibHeif, bytes: Uint8Array, maxPixels = Infinity): Promise<HeifPixels> {
  const decoder = new lib.HeifDecoder();
  try {
    const images = decoder.decode(bytes);
    if (!images.length) throw new HeifDecodeError("No decodable image in this HEIC file.");
    try {
      const primary = images.find(image => image.is_primary()) ?? images[0];
      // Colour (review L1, known limitation): the pixels are passed on as if sRGB. iPhone HEICs are
      // Display P3, signalled by an nclx and/or ICC `colr` box. libheif-js 1.23.5 has no JS wrapper
      // for it; reading it here would mean the C exports _heif_image_handle_get_color_profile_type /
      // _get_raw_color_profile(_size) on `primary.handle` with a _malloc'd buffer, and passing the
      // result to encode() in heic.worker.ts (canvas colorSpace "display-p3" or an APP2 ICC segment).
      const width = primary.get_width(), height = primary.get_height();
      if (width * height > maxPixels) throw new HeifTooLargeError(width, height);
      const pixels = await new Promise<HeifPixels | null>(resolve =>
        primary.display({ data: new Uint8ClampedArray(width * height * 4), width, height }, resolve));
      if (!pixels) throw new HeifDecodeError("The HEIC image data could not be decoded.");
      return pixels;
    } finally {
      images.forEach(image => image.free());
    }
  } finally {
    // Free the native context now rather than on the next decode; WASM memory is not GC'd.
    // decoder.decoder and heif_context_free are libheif-js internals (exact pin 1.23.5); guarded by the "private members" test in tests/capture-prep.test.mjs.
    if (decoder.decoder) lib.heif_context_free(decoder.decoder);
    decoder.decoder = null;
  }
}
