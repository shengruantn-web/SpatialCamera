/** Messages between the Studio page and the capture-prep Web Workers. */
export type JobRequest = { id: number; file: File };

/**
 * Why a job failed. Workers send "failed" (a readable per-photo error); the pool adds the rest.
 * "load": the worker script never started; "crash": it died mid-job; "cancelled": the caller aborted.
 */
export type FailureReason = "failed" | "load" | "crash" | "timeout" | "cancelled";
/** Posted once by each worker when its module has loaded, so the pool can tell a load failure from a crash. */
export type ReadyMessage = { id: 0; type: "ready" };

export type AnalysisMessage =
  | { id: number; type: "done"; blur: number; hash: string }
  | { id: number; type: "error"; message: string; reason?: FailureReason };

export type ConversionStage = "loading-decoder" | "decoding" | "encoding";
export type ConversionMessage =
  | { id: number; type: "stage"; stage: ConversionStage }
  | { id: number; type: "done"; blob: Blob; quality: number; scale: number; width: number; height: number }
  | { id: number; type: "error"; message: string; reason?: FailureReason };

/** The subset of DedicatedWorkerGlobalScope the workers use (the project compiles against the DOM lib). */
export type WorkerScope<In, Out> = {
  onmessage: ((event: MessageEvent<In>) => void) | null;
  postMessage(message: Out | ReadyMessage): void;
};
