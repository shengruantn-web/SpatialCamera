/**
 * Scene download for the viewer, kept free of React and three.js so it can be tested in Node.
 */
/** The scene's bytes never arrived in full (network, HTTP status, or an abort). Not a decoding problem. */
export class DownloadError extends Error {}
export type Download = { failure: unknown };
/**
 * Fetches a scene on the main thread (so an AbortSignal can stop it) and hands Spark a stream of its body,
 * counting bytes for the progress display as Spark pulls them. Spark cannot take a stream that errors (its
 * worker would wait forever), so a broken download ends the stream early and is recorded in `download`;
 * the caller checks it before blaming the file.
 */
export async function openScene(url: string, signal: AbortSignal, onBytes: (loaded: number, total: number, done: boolean) => void, fetcher: typeof fetch = fetch) {
  let response: Response;
  try { response = await fetcher(url, { signal }); }
  catch (error) { throw new DownloadError(String(error)); }
  if (!response.ok || !response.body) throw new DownloadError(`HTTP ${response.status}`);
  // Content-Length counts encoded bytes; with a Content-Encoding the stream yields more than that.
  const length = Number(response.headers.get("content-length"));
  const total = !response.headers.get("content-encoding") && Number.isFinite(length) && length > 0 ? length : 0;
  // Spark picks its decoder from the file name; the scene route says which format it served.
  const format = response.headers.get("x-splat-format") ?? new URL(url, globalThis.location?.href ?? "http://localhost/").pathname.match(/\.(\w+)$/)?.[1] ?? "ply";
  const reader = response.body.getReader();
  const download: Download = { failure: null };
  let loaded = 0;
  const stream = new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const { done, value } = await reader.read();
        if (done) {
          if (total && loaded < total) throw new Error(`body ended at ${loaded} of ${total} bytes`);
          onBytes(loaded, total, true); controller.close(); return;
        }
        loaded += value.byteLength;
        onBytes(loaded, total >= loaded ? total : 0, false);
        controller.enqueue(value);
      } catch (error) {
        download.failure = error ?? new Error("download failed");
        controller.close();
      }
    },
    cancel(reason) { void reader.cancel(reason).catch(() => {}); },
  });
  return { stream, streamLength: total || undefined, fileName: `scene.${format.toLowerCase()}`, download };
}

export type SceneOutcome = "show" | "download-error" | "fallback" | "decode-error";
/**
 * What the viewer does once Spark settles: a download that broke is reported as such even if a partial file
 * happened to decode; a file that arrived whole but will not decode falls back to `fallbackUrl` (the PLY
 * behind an SPZ) once, and is otherwise reported as undecodable.
 */
export function sceneOutcome({ failure, decodeError, url, fallbackUrl }: { failure: unknown; decodeError: unknown; url?: string; fallbackUrl?: string }): SceneOutcome {
  if (failure) return "download-error";
  if (!decodeError) return "show";
  return fallbackUrl && url !== fallbackUrl ? "fallback" : "decode-error";
}
