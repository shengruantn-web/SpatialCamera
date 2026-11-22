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
import { cameraAppFileName, problemMessages, showCameraEntry, type NamedFile } from "../lib/camera/camera";
import CameraCapture from "./CameraCapture";
import { liveCameraAvailability } from "./useCamera";

type Props = {
  /** The photos in Studio's selection: names to keep unique, and the guided mode's budget. */
  selection: readonly File[];
  /** Studio is busy or adding photos. The buttons stay focusable (aria-disabled), so focus that
   * returns to them after the guided mode is not lost while the new photos are checked. */
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
const keyOf = (file: NamedFile) => `${file.name}:${file.size}`;
const stemOf = (name: string) => name.replace(/\.[^.]*$/, "");

export default function CameraEntry({ selection, disabled, onAdd }: Props) {
  const touch = useSyncExternalStore(subscribe, touchSnapshot, serverSnapshot);
  const [open, setOpen] = useState(false);
  const [notice, setNotice] = useState("");
  /** Photos handed to the queue that Studio has not taken in yet. */
  const [pending, setPending] = useState<File[]>([]);
  /** Names (without extension, so a HEIC converted to JPEG still counts) of photos that resume
   * after a reload cannot match: guided shots, which exist only in this tab, and camera-app photos
   * renamed to avoid a clash. The note under the buttons says so while the selection holds one. */
  const [unrecoverable] = useState(() => new Set<string>());
  const input = useRef<HTMLInputElement>(null);
  const guidedButton = useRef<HTMLButtonElement>(null);
  const queue = useRef<Promise<void>>(Promise.resolve());

  // The selection as Studio will hold it once the queue drains (Studio drops name + size repeats).
  const known = [...new Map([...selection, ...pending].map(file => [keyOf(file), file])).values()];
  const budget = { count: known.length, bytes: known.reduce((sum, file) => sum + file.size, 0) };
  const holdsUnrecoverable = known.some(file => unrecoverable.has(stemOf(file.name)));

  // Studio takes one add at a time and reads its selection from a ref updated after render, so each
  // add waits for the previous one and a tick.
  const enqueue = useCallback((files: File[]) => {
    if (!files.length) return;
    setPending(current => [...current, ...files]);
    queue.current = queue.current
      .then(() => onAdd(files))
      .catch(() => {})
      .then(() => new Promise<void>(resolve => setTimeout(resolve, 0)))
      .then(() => setPending(current => current.filter(file => !files.includes(file))));
  }, [onAdd]);

  function openCameraApp() { input.current?.click(); }
  function openGuided() {
    if (disabled) return;
    const availability = liveCameraAvailability();
    if (availability !== "ok") { setNotice(problemMessages[availability]); openCameraApp(); return; }
    setNotice("");
    setOpen(true);
  }
  function returnFocus() { requestAnimationFrame(() => guidedButton.current?.focus()); }
  function addGuided(shots: File[]) { shots.forEach(shot => unrecoverable.add(stemOf(shot.name))); enqueue(shots); }

  if (!touch) return null;
  return <div className="camera-entry">
    <input ref={input} type="file" accept="image/*" capture="environment" multiple className="sr-only" tabIndex={-1} aria-hidden="true" disabled={disabled}
      onChange={e => {
        const picked = Array.from(e.target.files ?? []);
        e.target.value = "";
        // Original names stay (the resume matcher pairs files by name + size); only a name a
        // different photo already uses (iOS: every photo is image.jpg) gets a deterministic suffix.
        const taken: NamedFile[] = [...known];
        enqueue(picked.map(file => {
          const name = cameraAppFileName(file, taken);
          taken.push({ name, size: file.size, lastModified: file.lastModified });
          if (name === file.name) return file;
          unrecoverable.add(stemOf(name));
          return new File([file], name, { type: file.type, lastModified: file.lastModified });
        }));
      }} />
    <button ref={guidedButton} type="button" className="camera-entry-button main" aria-disabled={disabled || undefined} onClick={openGuided}><Aperture size={18} /><span className="camera-entry-label"><strong>Take photos</strong><small>guided camera</small></span></button>
    <button type="button" className="camera-entry-button" aria-disabled={disabled || undefined} onClick={() => { if (!disabled) openCameraApp(); }}><Camera size={17} /> Camera app</button>
    {notice && <p className="camera-entry-notice" role="status">{notice}</p>}
    {holdsUnrecoverable && <p className="camera-entry-note">Guided-camera photos, and camera photos renamed because the name was taken, can’t be recovered after a reload. Upload before you close this tab.</p>}
    {open && <CameraCapture selection={budget}
      onClose={shots => { setOpen(false); addGuided(shots); returnFocus(); }}
      onUseCameraApp={shots => { openCameraApp(); setOpen(false); addGuided(shots); }} />}
  </div>;
}
