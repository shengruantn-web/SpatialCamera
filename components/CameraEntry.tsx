"use client";
/**
 * Phone camera entry (S9, PRD R1.4, spec §8.3). Shown on touch devices only, below the dropzone:
 *  - "Guided camera" opens the in-page viewfinder (CameraCapture) with a shot counter and an
 *    overlap hint;
 *  - "Camera app" opens the system camera through `<input capture="environment">`. iOS ignores
 *    `multiple` together with `capture`, so it returns one photo per trip; every trip adds to the
 *    same selection.
 * Where the live camera cannot run (an http page, no getUserMedia) the guided button explains why
 * and opens the camera app instead, in the same tap. Every photo goes through Studio's normal add
 * path (`onAdd`), so validation, the prep checks and the upload are unchanged.
 */
import { useCallback, useRef, useState, useSyncExternalStore } from "react";
import { Aperture, Camera } from "lucide-react";
import { capturedFileName, problemMessages, showCameraEntry } from "../lib/camera/camera";
import CameraCapture from "./CameraCapture";
import { liveCameraAvailability } from "./useCamera";

type Props = {
  /** Photos already selected: numbering of the new files continues from here. */
  existingCount: number;
  disabled: boolean;
  /** Studio's add path. One add runs at a time, so calls are queued here. */
  onAdd(files: File[]): Promise<void> | void;
};

const QUERIES = ["(pointer: coarse)", "(hover: none)"];
function subscribe(onChange: () => void) {
  const lists = QUERIES.map(query => window.matchMedia(query));
  lists.forEach(list => list.addEventListener("change", onChange));
  return () => lists.forEach(list => list.removeEventListener("change", onChange));
}
const touchSnapshot = () => showCameraEntry({
  coarsePointer: window.matchMedia(QUERIES[0]).matches,
  hoverNone: window.matchMedia(QUERIES[1]).matches,
  maxTouchPoints: navigator.maxTouchPoints ?? 0,
});
const serverSnapshot = () => false;

export default function CameraEntry({ existingCount, disabled, onAdd }: Props) {
  const touch = useSyncExternalStore(subscribe, touchSnapshot, serverSnapshot);
  const [open, setOpen] = useState(false);
  const [notice, setNotice] = useState("");
  const input = useRef<HTMLInputElement>(null);
  const guidedButton = useRef<HTMLButtonElement>(null);
  const queue = useRef<Promise<void>>(Promise.resolve());

  // Studio takes one add at a time and reads its selection from a ref updated after render, so each
  // add waits for the previous one and a tick.
  const enqueue = useCallback((files: File[]) => {
    if (!files.length) return;
    queue.current = queue.current
      .then(() => onAdd(files))
      .catch(() => {})
      .then(() => new Promise<void>(resolve => setTimeout(resolve, 0)));
  }, [onAdd]);

  function openCameraApp() { input.current?.click(); }
  function openGuided() {
    const availability = liveCameraAvailability();
    if (availability !== "ok") { setNotice(problemMessages[availability]); openCameraApp(); return; }
    setNotice("");
    setOpen(true);
  }
  function returnFocus() { requestAnimationFrame(() => guidedButton.current?.focus()); }

  if (!touch) return null;
  return <div className="camera-entry">
    <input ref={input} type="file" accept="image/*" capture="environment" multiple className="sr-only" tabIndex={-1} aria-hidden="true" disabled={disabled}
      onChange={e => {
        const picked = Array.from(e.target.files ?? []);
        e.target.value = "";
        const now = new Date();
        enqueue(picked.map((file, i) => new File([file], capturedFileName(file, file.lastModified ? new Date(file.lastModified) : now, existingCount + i + 1), { type: file.type, lastModified: file.lastModified })));
      }} />
    <button ref={guidedButton} type="button" className="camera-entry-button main" disabled={disabled} onClick={openGuided}><Aperture size={18} /><span className="camera-entry-label"><strong>Take photos</strong><small>guided camera</small></span></button>
    <button type="button" className="camera-entry-button" disabled={disabled} onClick={openCameraApp}><Camera size={17} /> Camera app</button>
    {notice && <p className="camera-entry-notice" role="status">{notice}</p>}
    {open && <CameraCapture existingCount={existingCount}
      onClose={shots => { setOpen(false); enqueue(shots); returnFocus(); }}
      onUseCameraApp={shots => { openCameraApp(); setOpen(false); enqueue(shots); }} />}
  </div>;
}
