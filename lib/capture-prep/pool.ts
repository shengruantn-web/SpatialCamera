/**
 * Small Web Worker pool for capture prep: workers are created on first use, run one photo at a
 * time (bounding memory: a 12 MP decode is ~50 MB of RGBA), and are terminated after a quiet
 * period so the HEIC decoder's WASM heap is released.
 *
 * `run` never rejects. Every way a job can end (result, cancel, watchdog timeout, worker crash,
 * worker that never loaded, spawn/postMessage throwing) resolves to a final message, so callers
 * using Promise.all cannot lose a batch and progress UIs cannot get stuck.
 */
import type { AnalysisMessage, ConversionMessage, FailureReason } from "./protocol";

type Message = { id: number; type: string };
/** Error results the pool itself produces; workers send the same shape. */
type Failure = { id: number; type: "error"; message: string; reason: FailureReason };

export type RunOptions<M> = {
  /** Intermediate ("stage") messages. */
  onMessage?: (message: M) => void;
  /** Aborting drops a queued job, or terminates the worker running it; the job resolves as cancelled. */
  signal?: AbortSignal;
};

export type PoolOptions = {
  size: number;
  /** Watchdog per job, from dispatch: a hung decode is terminated and reported instead of blocking forever. */
  timeoutMs: number;
  /** Terminate idle workers after this long without work. */
  idleMs?: number;
  messages: {
    /** The worker died while working (it had loaded): typically out of memory. */
    crash: string;
    /** The worker script never loaded (offline, blocked, or a bad deploy). */
    load: string;
    timeout: string;
    cancelled: string;
  };
};

type Job<M> = {
  id: number;
  file: File;
  onMessage?: (message: M) => void;
  settle: (message: M | Failure) => void;
  timer?: ReturnType<typeof setTimeout>;
};
type Slot = { worker: Worker; loaded: boolean };

/** Default: idle workers are terminated after 20 s. */
const IDLE_TERMINATE_MS = 20_000;

export class WorkerPool<M extends Message> {
  private idle: Slot[] = [];
  private running = new Map<Slot, Job<M>>();
  private queue: Job<M>[] = [];
  private nextId = 1;
  private idleTimer: ReturnType<typeof setTimeout> | undefined;

  constructor(private readonly create: () => Worker, private readonly options: PoolOptions) {}

  /** Resolves with the final ("done" or "error") message; never rejects. */
  run(file: File, { onMessage, signal }: RunOptions<M> = {}): Promise<M | Failure> {
    return new Promise(resolve => {
      const id = this.nextId++;
      const fail = (reason: FailureReason, message: string): Failure => ({ id, type: "error", message, reason });
      let settled = false;
      const job: Job<M> = {
        id, file, onMessage,
        settle: message => {
          if (settled) return;
          settled = true;
          clearTimeout(job.timer);
          signal?.removeEventListener("abort", onAbort);
          resolve(message);
        },
      };
      const onAbort = () => {
        const queued = this.queue.indexOf(job);
        if (queued >= 0) this.queue.splice(queued, 1);
        else this.retire(this.slotOf(job));
        job.settle(fail("cancelled", this.options.messages.cancelled));
        this.pump();
      };
      if (signal?.aborted) { job.settle(fail("cancelled", this.options.messages.cancelled)); return; }
      signal?.addEventListener("abort", onAbort, { once: true });
      this.queue.push(job);
      this.pump();
    });
  }

  private slotOf(job: Job<M>): Slot | undefined {
    for (const [slot, running] of this.running) if (running === job) return slot;
    return undefined;
  }

  /** Stop a worker for good and forget it, wherever it is. */
  private retire(slot: Slot | undefined) {
    if (!slot) return;
    this.running.delete(slot);
    this.idle = this.idle.filter(s => s !== slot);
    try { slot.worker.terminate(); } catch { /* already gone */ }
  }

  private pump() {
    clearTimeout(this.idleTimer);
    while (this.queue.length && (this.idle.length || this.running.size < this.options.size)) {
      const job = this.queue.shift()!;
      let slot: Slot | undefined;
      try {
        slot = this.idle.pop() ?? this.spawn();
        this.running.set(slot, job);
        job.timer = setTimeout(() => {
          this.retire(slot);
          job.settle({ id: job.id, type: "error", message: this.options.messages.timeout, reason: "timeout" });
          this.pump();
        }, this.options.timeoutMs);
        slot.worker.postMessage({ id: job.id, file: job.file });
      } catch (error) {
        // Worker construction (CSP, too many workers) or structured clone failed: fail this photo only.
        this.retire(slot);
        job.settle({ id: job.id, type: "error", message: `${this.options.messages.load} (${(error as Error)?.message || "unknown error"})`, reason: "load" });
      }
    }
    if (!this.queue.length && !this.running.size) this.idleTimer = setTimeout(() => this.terminate(), this.options.idleMs ?? IDLE_TERMINATE_MS);
  }

  private spawn(): Slot {
    const slot: Slot = { worker: this.create(), loaded: false };
    slot.worker.onmessage = (event: MessageEvent<M>) => {
      slot.loaded = true; // any message, including the startup "ready", proves the script loaded
      const job = this.running.get(slot);
      if (!job || event.data.id !== job.id) return;
      if (event.data.type === "stage") { job.onMessage?.(event.data); return; }
      this.running.delete(slot);
      this.idle.push(slot);
      job.settle(event.data);
      this.pump();
    };
    // An error before any message means the script never loaded; after that it is a crash
    // (typically out of memory). Either way only the photo in hand fails, and the worker is dropped.
    slot.worker.onerror = event => {
      event.preventDefault();
      const job = this.running.get(slot);
      this.retire(slot);
      job?.settle(slot.loaded
        ? { id: job.id, type: "error", message: this.options.messages.crash, reason: "crash" }
        : { id: job.id, type: "error", message: this.options.messages.load, reason: "load" });
      this.pump();
    };
    return slot;
  }

  /** Terminate idle workers (running jobs are left to finish). */
  terminate() {
    clearTimeout(this.idleTimer);
    this.idle.forEach(slot => slot.worker.terminate());
    this.idle = [];
  }

  /** For tests and diagnostics. */
  get stats() {
    return { idle: this.idle.length, running: this.running.size, queued: this.queue.length };
  }
}

/** Workers, OffscreenCanvas and module workers are all needed (Chrome 80+, Safari 16.4+, Firefox 114+). */
export function prepSupported(): boolean {
  return typeof Worker !== "undefined" && typeof OffscreenCanvas !== "undefined" && typeof createImageBitmap !== "undefined";
}

/**
 * Watchdog for one HEIC conversion. A phone HEIC converts in seconds, and the first one also
 * downloads the 1.5 MB decoder, so a minute only fires on a hang or a device that is thrashing.
 */
export const HEIC_TIMEOUT_MS = 60_000;
/** Watchdog for one blur/duplicate check (a 512 px decode + two passes; ~50 ms typical). */
export const ANALYSIS_TIMEOUT_MS = 30_000;

const cores = () => (typeof navigator !== "undefined" && navigator.hardwareConcurrency) || 2;
let heic: WorkerPool<ConversionMessage> | undefined;
let analysis: WorkerPool<AnalysisMessage> | undefined;

export function heicPool(): WorkerPool<ConversionMessage> {
  heic ??= new WorkerPool<ConversionMessage>(
    () => new Worker(new URL("./heic.worker.ts", import.meta.url), { type: "module", name: "heic-convert" }),
    {
      // Two at a time: each decode holds ~100 MB (RGBA + canvas) and the WASM heap grows per worker.
      size: Math.max(1, Math.min(2, cores() - 1)),
      timeoutMs: HEIC_TIMEOUT_MS,
      messages: {
        crash: "The converter stopped unexpectedly (usually out of memory). Close other tabs or add fewer HEIC photos at a time.",
        load: "The HEIC converter could not be loaded. Check your connection and add this photo again, or export it as JPEG.",
        timeout: "Converting this photo took longer than a minute, so it was stopped. Export it as JPEG and add it again.",
        cancelled: "Conversion cancelled.",
      },
    });
  return heic;
}

export function analysisPool(): WorkerPool<AnalysisMessage> {
  analysis ??= new WorkerPool<AnalysisMessage>(
    () => new Worker(new URL("./analysis.worker.ts", import.meta.url), { type: "module", name: "photo-checks" }),
    {
      size: Math.max(1, Math.min(4, cores() - 1)),
      timeoutMs: ANALYSIS_TIMEOUT_MS,
      messages: {
        crash: "The photo check stopped unexpectedly.",
        load: "The photo check could not be loaded.",
        timeout: "The photo check took too long.",
        cancelled: "Check cancelled.",
      },
    });
  return analysis;
}
