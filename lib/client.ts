import type { Capture, CaptureStatus } from "./types";

/** Photos uploaded at once. Enough to hide per-request latency without starving a slow uplink. */
export const UPLOAD_CONCURRENCY = 4;
/**
 * Base waits before the 2nd…5th attempt of one photo (about 35 s in all, enough to ride out a short outage
 * or a deploy). Each is jittered to 50–150% so a pool of failed uploads does not retry in lockstep. Only
 * network errors, 408, 429 and 5xx are retried; a Retry-After on 429/503 is honoured, up to a minute.
 */
export const UPLOAD_RETRY_DELAYS = [1000, 4000, 10000, 20000];
export const MAX_RETRY_AFTER_MS = 60_000;

/**
 * Runs `task` over `items` with at most `limit` in flight. After the first failure, or once `signal`
 * aborts, no new item starts; in-flight items finish (their uploads are idempotent and resumable, and they
 * see the same signal), then the first error (or the abort reason) is thrown.
 */
export async function runPool<T>(items: readonly T[], limit: number, task: (item: T, signal?: AbortSignal) => Promise<void>, signal?: AbortSignal) {
  let next = 0;
  let failure: { error: unknown } | null = null;
  async function lane() {
    while (!failure && !signal?.aborted && next < items.length) {
      const item = items[next++];
      try { await task(item, signal); } catch (error) { failure ??= { error }; }
    }
  }
  await Promise.all(Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, lane));
  signal?.throwIfAborted();
  if (failure) throw (failure as { error: unknown }).error;
}

export type Sleep = (ms: number, signal?: AbortSignal) => Promise<void>;
/** setTimeout as a promise that rejects with the abort reason as soon as `signal` aborts. */
export const sleep: Sleep = (ms, signal) => new Promise((resolve, reject) => {
  if (signal?.aborted) { reject(signal.reason); return; }
  const onAbort = () => { clearTimeout(timer); reject(signal!.reason); };
  const timer = setTimeout(() => { signal?.removeEventListener("abort", onAbort); resolve(); }, ms);
  signal?.addEventListener("abort", onAbort, { once: true });
});
/** Retry-After as milliseconds (delta-seconds or an HTTP date), or null when absent or unreadable. */
export function retryAfterMs(header: string | null, now = Date.now()) {
  if (!header?.trim()) return null;
  const seconds = Number(header);
  if (Number.isFinite(seconds)) return seconds >= 0 ? seconds * 1000 : null;
  const at = Date.parse(header);
  return Number.isNaN(at) ? null : Math.max(0, at - now);
}
type PutOptions = { fetcher?: typeof fetch; wait?: Sleep; delays?: readonly number[]; random?: () => number; signal?: AbortSignal; label?: string };
/**
 * PUTs one photo, retrying transient failures. A re-PUT before submit replaces the object, so a retry
 * after an ambiguous failure (the response was lost) is safe. An abort stops it at once, mid-request or
 * mid-wait, and is rethrown as is. Errors name the photo (`label`). Resolves to the successful response
 * (S10: a video part's carries its etag).
 */
export async function putWithRetry(url: string, body: Blob, mime: string, { fetcher = fetch, wait = sleep, delays = UPLOAD_RETRY_DELAYS, random = Math.random, signal, label }: PutOptions = {}): Promise<Response> {
  for (let attempt = 0; ; attempt++) {
    let message = "Check your connection and try again.";
    let retryable = true;
    let serverWait: number | null = null;
    try {
      const response = await fetcher(url, { method: "PUT", body, headers: { "Content-Type": mime }, signal });
      if (response.ok) return response;
      const data = await response.json().catch(() => ({})) as { error?: string };
      if (data.error) message = data.error;
      retryable = response.status >= 500 || response.status === 408 || response.status === 429;
      if (response.status === 429 || response.status === 503) serverWait = retryAfterMs(response.headers.get("retry-after"));
    } catch (error) {
      if (signal?.aborted) throw signal.reason;
      void error; // network failure: retryable
    }
    if (!retryable || attempt >= delays.length) throw new Error(`Could not upload ${label ?? "a photo"}. ${message}`);
    const jittered = Math.round(delays[attempt] * (0.5 + random()));
    await wait(Math.min(Math.max(jittered, serverWait ?? 0), MAX_RETRY_AFTER_MS), signal);
  }
}

/** Status polling backs off while nothing changes and resets on any change or user action. */
export const POLL_MIN_MS = 2000;
export const POLL_MAX_MS = 20000;
/** With nothing in flight, state is still re-read this often while visible (e.g. the processor indicator). */
export const IDLE_REFRESH_MS = 60_000;
export const nextPollDelay = (previous: number, changed: boolean) => changed ? POLL_MIN_MS : Math.min(Math.round(previous * 1.6), POLL_MAX_MS);
const inFlight: ReadonlySet<CaptureStatus> = new Set(["queued", "aligning", "training", "exporting"]);
/** Whether any capture can still change without the user doing something (terminal states stop polling). */
export const hasActiveCapture = (captures: readonly Capture[]) => captures.some(capture => inFlight.has(capture.status));
/**
 * What the UI shows of the server state. `updated_at` is left out on purpose: worker heartbeats bump it
 * every few seconds and would otherwise keep polling at the fastest rate for a whole training run.
 */
export const pollSignature = (captures: readonly Capture[], processor: boolean) => JSON.stringify([processor, captures.map(c =>
  [c.id, c.name, c.status, c.uploaded_count, c.image_count, c.error, c.alignment_ratio ?? null, c.ready_at ?? null, c.failed_at ?? null, c.spz_bytes ?? null, c.result_bytes ?? null, c.video_uploaded ?? null])]); // S10: a finished video upload moves its panel to submit-only

/**
 * Orders overlapping requests for the same state: `begin()` numbers a request as it starts, and
 * `accept(n)` is true only if no later-started request has been applied, so a slow, older response can
 * never overwrite newer state.
 */
export function latestOnly() {
  let issued = 0;
  let applied = 0;
  return {
    begin: () => ++issued,
    accept(n: number) { if (n <= applied) return false; applied = n; return true; },
  };
}

export type PollResult = { signature: string; active: boolean };
export type Timers = { set: (callback: () => void, ms: number) => unknown; clear: (handle: unknown) => void };
const POLL_ERROR: PollResult = { signature: "error", active: true };
const browserTimers: Timers = { set: (callback, ms) => setTimeout(callback, ms), clear: handle => clearTimeout(handle as ReturnType<typeof setTimeout>) };
/**
 * Adaptive polling of server-owned state: every 2 s after a change, backing off to 20 s while nothing
 * changes, once a minute when nothing is in flight, and not at all while the page is hidden (the caller
 * wakes it when it becomes visible). `wake()` (a user action) polls at once and resets the backoff; one
 * arriving while a poll is in flight marks it dirty, so another poll runs right after it and the first
 * one's result is discarded (it may predate the action). A `poll` that throws counts as a changed, active
 * result, so polling carries on at the fastest rate instead of stopping for good.
 */
export function createPoller(poll: () => Promise<PollResult>, { hidden = () => false, timers = browserTimers }: { hidden?: () => boolean; timers?: Timers } = {}) {
  let timer: unknown;
  let delay = POLL_MIN_MS;
  let last = "";
  let running = false;
  let dirty = false;
  let stopped = false;
  function unschedule() { if (timer !== undefined) timers.clear(timer); timer = undefined; }
  async function tick() {
    unschedule();
    if (stopped || hidden()) return;
    if (running) { dirty = true; return; }
    running = true;
    let result: PollResult;
    try {
      do {
        dirty = false;
        try { result = await poll(); } catch { result = POLL_ERROR; }
      } while (dirty && !stopped);
    } finally { running = false; }
    if (stopped) return;
    delay = nextPollDelay(delay, result.signature !== last); last = result.signature;
    if (!hidden()) timer = timers.set(() => void tick(), result.active ? delay : IDLE_REFRESH_MS);
  }
  return {
    wake() { last = ""; return tick(); },
    stop() { stopped = true; unschedule(); },
  };
}
