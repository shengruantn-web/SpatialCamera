import type { Capture, CaptureStatus } from "./types";

/** Photos uploaded at once. Enough to hide per-request latency without starving a slow uplink. */
export const UPLOAD_CONCURRENCY = 4;
/** Waits before the 2nd and 3rd attempt of one photo; only network errors, 408, 429 and 5xx are retried. */
export const UPLOAD_RETRY_DELAYS = [1000, 3000];

/**
 * Runs `task` over `items` with at most `limit` in flight. After the first failure no new item starts;
 * in-flight items finish (their uploads are idempotent and resumable), then the first error is thrown.
 */
export async function runPool<T>(items: readonly T[], limit: number, task: (item: T) => Promise<void>) {
  let next = 0;
  let failure: { error: unknown } | null = null;
  async function lane() {
    while (!failure && next < items.length) {
      const item = items[next++];
      try { await task(item); } catch (error) { failure ??= { error }; }
    }
  }
  await Promise.all(Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, lane));
  if (failure) throw (failure as { error: unknown }).error;
}

export type Sleep = (ms: number) => Promise<void>;
const sleep: Sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
/**
 * PUTs one photo, retrying transient failures. A re-PUT before submit replaces the object, so a retry
 * after an ambiguous failure (the response was lost) is safe.
 */
export async function putWithRetry(url: string, body: Blob, mime: string, { fetcher = fetch, wait = sleep, delays = UPLOAD_RETRY_DELAYS } = {}) {
  for (let attempt = 0; ; attempt++) {
    let message = "A photo could not be uploaded. Check your connection and try again.";
    let retryable = true;
    try {
      const response = await fetcher(url, { method: "PUT", body, headers: { "Content-Type": mime } });
      if (response.ok) return;
      const data = await response.json().catch(() => ({})) as { error?: string };
      if (data.error) message = data.error;
      retryable = response.status >= 500 || response.status === 408 || response.status === 429;
    } catch { /* network failure: retryable */ }
    if (!retryable || attempt >= delays.length) throw new Error(message);
    await wait(delays[attempt]);
  }
}

/** Status polling backs off while nothing changes and resets on any change or user action. */
export const POLL_MIN_MS = 2000;
export const POLL_MAX_MS = 20000;
export const nextPollDelay = (previous: number, changed: boolean) => changed ? POLL_MIN_MS : Math.min(Math.round(previous * 1.6), POLL_MAX_MS);
const inFlight: ReadonlySet<CaptureStatus> = new Set(["queued", "aligning", "training", "exporting"]);
/** Whether any capture can still change without the user doing something (terminal states stop polling). */
export const hasActiveCapture = (captures: readonly Capture[]) => captures.some(capture => inFlight.has(capture.status));
/**
 * What the UI shows of the server state. `updated_at` is left out on purpose: worker heartbeats bump it
 * every few seconds and would otherwise keep polling at the fastest rate for a whole training run.
 */
export const pollSignature = (captures: readonly Capture[], processor: boolean) => JSON.stringify([processor, captures.map(c =>
  [c.id, c.name, c.status, c.uploaded_count, c.image_count, c.error, c.alignment_ratio ?? null, c.ready_at ?? null, c.failed_at ?? null, c.spz_bytes ?? null])]);
