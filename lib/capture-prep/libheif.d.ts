/**
 * Types for the part of libheif-js (LGPL-3.0) used by heic.worker.ts. The package ships only
 * Emscripten-level typings; this ESM bundle has the WASM inlined, so it needs no asset URL.
 */
declare module "libheif-js/libheif-wasm/libheif-bundle.mjs" {
  export type HeifPixels = { data: Uint8ClampedArray<ArrayBuffer>; width: number; height: number };
  export interface HeifImage {
    get_width(): number;
    get_height(): number;
    is_primary(): boolean;
    /** Decodes to RGBA with irot/imir/clap applied. Calls back with null on failure. */
    display(target: HeifPixels, callback: (result: HeifPixels | null) => void): void;
    /** Releases the image handle. */
    free(): void;
  }
  export interface HeifDecoder {
    /** Returns [] (and logs) when the file cannot be parsed. */
    decode(buffer: ArrayBuffer | Uint8Array): HeifImage[];
    /** Native context of the last decode; freed by the next decode or heif_context_free. */
    decoder: unknown;
  }
  export interface LibHeif {
    HeifDecoder: new () => HeifDecoder;
    heif_context_free(context: unknown): void;
  }
  const factory: (options?: Record<string, unknown>) => Promise<LibHeif>;
  export default factory;
}
