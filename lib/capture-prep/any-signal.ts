/**
 * An AbortSignal that fires when any input does (AbortSignal.any is too new for Safari 16.4).
 * Call `dispose()` when done so the inputs, which outlive it, drop their listeners (S6 review
 * item 8); it also runs by itself once the combined signal fires.
 */
export function anySignal(signals: readonly AbortSignal[]): { signal: AbortSignal; dispose(): void } {
  const controller = new AbortController();
  const abort = () => controller.abort();
  const dispose = () => signals.forEach(signal => signal.removeEventListener("abort", abort));
  controller.signal.addEventListener("abort", dispose, { once: true });
  for (const signal of signals) {
    if (signal.aborted) { controller.abort(); break; }
    signal.addEventListener("abort", abort, { once: true });
  }
  return { signal: controller.signal, dispose };
}
