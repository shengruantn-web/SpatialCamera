/**
 * Small Web Worker pool for capture prep: workers are created on first use, run one photo at a
 * time (bounding memory: a 12 MP decode is ~50 MB of RGBA), and are terminated after a quiet
 * period so the HEIC decoder's WASM heap is released.
 */
import type { AnalysisMessage, ConversionMessage } from "./protocol";

type Message = { id: number; type: string };
type Job<M extends Message> = { id: number; file: File; onMessage?: (message: M) => void; resolve: (message: M) => void };

/** Terminate idle workers after this long without work. */
const IDLE_TERMINATE_MS = 20_000;

export class WorkerPool<M extends Message> {
  private idle: Worker[] = [];
  private running = new Map<Worker, Job<M>>();
  private queue: Job<M>[] = [];
  private nextId = 1;
  private idleTimer: ReturnType<typeof setTimeout> | undefined;

  constructor(private readonly create: () => Worker, private readonly size: number, private readonly crashMessage: string) {}

  /** Resolves with the final ("done" or "error") message; never rejects. Intermediate messages go to onMessage. */
  run(file: File, onMessage?: (message: M) => void): Promise<M> {
    return new Promise(resolve => {
      this.queue.push({ id: this.nextId++, file, onMessage, resolve });
      this.pump();
    });
  }

  private pump() {
    clearTimeout(this.idleTimer);
    while (this.queue.length && (this.idle.length || this.running.size < this.size)) {
      const worker = this.idle.pop() ?? this.spawn();
      const job = this.queue.shift()!;
      this.running.set(worker, job);
      worker.postMessage({ id: job.id, file: job.file });
    }
    if (!this.queue.length && !this.running.size) this.idleTimer = setTimeout(() => this.terminate(), IDLE_TERMINATE_MS);
  }

  private spawn(): Worker {
    const worker = this.create();
    worker.onmessage = (event: MessageEvent<M>) => {
      const job = this.running.get(worker);
      if (!job || event.data.id !== job.id) return;
      if (event.data.type === "stage") { job.onMessage?.(event.data); return; }
      this.running.delete(worker);
      this.idle.push(worker);
      job.resolve(event.data);
      this.pump();
    };
    // A crash (typically out of memory) fails only the photo it was working on.
    worker.onerror = event => {
      event.preventDefault();
      const job = this.running.get(worker);
      this.running.delete(worker);
      worker.terminate();
      job?.resolve({ id: job.id, type: "error", message: this.crashMessage } as unknown as M);
      this.pump();
    };
    return worker;
  }

  terminate() {
    clearTimeout(this.idleTimer);
    this.idle.forEach(worker => worker.terminate());
    this.idle = [];
  }
}

/** Workers, OffscreenCanvas and module workers are all needed (Chrome 80+, Safari 16.4+, Firefox 114+). */
export function prepSupported(): boolean {
  return typeof Worker !== "undefined" && typeof OffscreenCanvas !== "undefined" && typeof createImageBitmap !== "undefined";
}

const cores = () => (typeof navigator !== "undefined" && navigator.hardwareConcurrency) || 2;
let heic: WorkerPool<ConversionMessage> | undefined;
let analysis: WorkerPool<AnalysisMessage> | undefined;

export function heicPool(): WorkerPool<ConversionMessage> {
  heic ??= new WorkerPool<ConversionMessage>(
    () => new Worker(new URL("./heic.worker.ts", import.meta.url), { type: "module", name: "heic-convert" }),
    // Two at a time: each decode holds ~100 MB (RGBA + canvas) and the WASM heap grows per worker.
    Math.max(1, Math.min(2, cores() - 1)),
    "The converter stopped unexpectedly (usually out of memory). Close other tabs or add fewer HEIC photos at a time.");
  return heic;
}

export function analysisPool(): WorkerPool<AnalysisMessage> {
  analysis ??= new WorkerPool<AnalysisMessage>(
    () => new Worker(new URL("./analysis.worker.ts", import.meta.url), { type: "module", name: "photo-checks" }),
    Math.max(1, Math.min(4, cores() - 1)),
    "The photo check stopped unexpectedly.");
  return analysis;
}
