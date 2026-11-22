/** Messages between the Studio page and the capture-prep Web Workers. */
export type JobRequest = { id: number; file: File };

export type AnalysisMessage =
  | { id: number; type: "done"; blur: number; hash: string }
  | { id: number; type: "error"; message: string };

export type ConversionStage = "loading-decoder" | "decoding" | "encoding";
export type ConversionMessage =
  | { id: number; type: "stage"; stage: ConversionStage }
  | { id: number; type: "done"; blob: Blob; quality: number; scale: number; width: number; height: number }
  | { id: number; type: "error"; message: string };

/** The subset of DedicatedWorkerGlobalScope the workers use (the project compiles against the DOM lib). */
export type WorkerScope<In, Out> = {
  onmessage: ((event: MessageEvent<In>) => void) | null;
  postMessage(message: Out): void;
};
