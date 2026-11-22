/*! @license
 * This chunk contains libheif 1.23.5 (https://github.com/strukturag/libheif) and libde265 1.0.15
 * (https://github.com/strukturag/libde265), both under the GNU Lesser General Public License v3,
 * built by libheif-js 1.23.5 (https://github.com/catdad-experiments/libheif-js). The compiled
 * decoder is the separate file libheif-*.wasm next to this one and can be replaced with your own
 * build. Licence text, source links and replacement steps: /third-party-notices.txt
 */
/**
 * Loads the HEIC decoder for heic.worker.ts. The Emscripten glue (~90 KB) and the WASM binary
 * (~1.5 MB) are kept as two separate files, outside the main bundle and Studio, so the LGPL
 * library can be swapped without rebuilding the app (see public/third-party-notices.txt).
 */
import factory, { type LibHeif } from "libheif-js/libheif-wasm/libheif.js";
import wasmUrl from "libheif-js/libheif-wasm/libheif.wasm?url";

export async function createLibheif(): Promise<LibHeif> {
  const response = await fetch(wasmUrl);
  if (!response.ok) throw new Error(`HEIC decoder download failed (${response.status}).`);
  // Passing the bytes avoids Emscripten's own URL detection, which assumes a classic worker.
  return factory({ wasmBinary: await response.arrayBuffer() });
}
