"use client";
/**
 * S6 review item 3: while the dropzone is disabled (photos being added or uploaded), its own drag
 * handlers do not run, so a file dropped on the page would make the browser open it in place of
 * the app and lose the selection. While `active`, this cancels file drags anywhere in the window
 * and reports each blocked drop to `onBlocked`.
 */
import { useEffect, useRef } from "react";

const carriesFiles = (event: DragEvent) => !!event.dataTransfer && Array.from(event.dataTransfer.types).includes("Files");

export function useDropGuard(active: boolean, onBlocked: () => void): void {
  const callback = useRef(onBlocked);
  useEffect(() => { callback.current = onBlocked; });
  useEffect(() => {
    if (!active) return;
    const over = (event: DragEvent) => { if (carriesFiles(event)) event.preventDefault(); };
    const drop = (event: DragEvent) => {
      if (!carriesFiles(event)) return;
      event.preventDefault();
      callback.current();
    };
    // Capture phase on window: runs first, whatever element is under the pointer.
    window.addEventListener("dragover", over, true);
    window.addEventListener("drop", drop, true);
    return () => {
      window.removeEventListener("dragover", over, true);
      window.removeEventListener("drop", drop, true);
    };
  }, [active]);
}
