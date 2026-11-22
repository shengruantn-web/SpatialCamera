/** Blur + perceptual-hash measurement, off the main thread. One photo per message. */
import { measurePhoto } from "./measure";
import type { AnalysisMessage, JobRequest, WorkerScope } from "./protocol";

const scope = self as unknown as WorkerScope<JobRequest, AnalysisMessage>;
scope.onmessage = async event => {
  const { id, file } = event.data;
  try {
    const { blur, hash } = await measurePhoto(file);
    scope.postMessage({ id, type: "done", blur, hash });
  } catch (error) {
    scope.postMessage({ id, type: "error", message: (error as Error).message || "Could not analyse this photo." });
  }
};
