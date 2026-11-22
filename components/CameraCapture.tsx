"use client";
/* The ghost is a data URL of the viewfinder; Next image optimization does not apply. */
/* eslint-disable @next/next/no-img-element */
/**
 * Guided shooting mode (S9, PRD R1.4, spec §8.3): a full-screen viewfinder in a modal <dialog>
 * (focus stays inside, Escape and the Android back gesture close it), a shutter, a shot counter
 * against the 12–200 range with a goal of 40, and an overlap hint with a faded "ghost" of the last
 * shot. Closing, by any route, keeps the photos taken: they go to Studio's normal add path
 * (validation, prep checks, upload), exactly like picked files. The shots live only in memory, so
 * the shutter stops before a shot Studio could refuse (photo count or total bytes, `shotBudget`),
 * and Done hands over only what Studio accepts (`shotsThatFit`).
 */
import { useEffect, useRef, useState } from "react";
import { Check, Ghost, LoaderCircle, RefreshCw, Smartphone, Undo2, X } from "lucide-react";
import {
  SHOT_GOAL, cameraFileName, canRetry, overlapHint, problemMessages, shotAnnouncement, shotBudget, shotGuidance, shotsThatFit,
  type Selection,
} from "../lib/camera/camera";
import { MIN_IMAGES } from "../lib/validation";
import { useCamera, useMotionCue } from "./useCamera";

type Taken = { file: File; preview: string | null };
type Props = {
  /** Photos already in (or queued for) the selection: the counter, the file numbers and the
   * photo and byte budget continue from here. */
  selection: Selection;
  /** The mode is closing (done, close button, Escape, back gesture). */
  onClose(shots: File[]): void;
  /** "Use camera app" from an error: the parent opens the `capture` file input in this same tap. */
  onUseCameraApp(shots: File[]): void;
};

export default function CameraCapture({ selection, onClose, onUseCameraApp }: Props) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const shutterRef = useRef<HTMLButtonElement>(null);
  const errorActionRef = useRef<HTMLButtonElement>(null);
  const camera = useCamera(videoRef);
  const { state, open, close } = camera;
  const [sessionStart] = useState(() => new Date());
  const [shots, setShots] = useState<Taken[]>([]);
  const shotsRef = useRef<Taken[]>([]);
  const [ghostOn, setGhostOn] = useState(true);
  const [announcement, setAnnouncement] = useState("");
  const [flash, setFlash] = useState(0);
  const [shotError, setShotError] = useState("");
  const finished = useRef(false);

  const total = selection.count + shots.length;
  const guidance = shotGuidance(total);
  const budget = shotBudget(selection, shots.map(shot => shot.file.size));
  const motion = useMotionCue(state.status === "live" || state.status === "capturing", shots.length);
  const last = shots.at(-1);
  const busy = state.status === "capturing";
  const shutterBlocked = state.status !== "live" || !budget.canShoot;
  /** What Done hands Studio: every shot, as the budget holds the shutter; never more than it accepts. */
  const keep = () => shotsThatFit(selection, shotsRef.current.map(shot => shot.file));

  // Open as a modal (top layer, inert page behind) and start the camera; the camera stops in
  // useCamera's cleanup when this unmounts. Not closed in the cleanup: StrictMode re-runs effects.
  useEffect(() => {
    const dialog = dialogRef.current;
    if (dialog && !dialog.open) dialog.showModal();
    shutterRef.current?.focus();
    open();
    return () => close();
  }, [open, close]);

  // Focus follows the state: an error's first action takes it; when the error clears (try again),
  // focus that would otherwise be lost goes back to the shutter.
  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    if (state.status === "error") { errorActionRef.current?.focus(); return; }
    const focused = document.activeElement;
    if (!focused || focused === document.body || focused === dialog || !dialog.contains(focused)) shutterRef.current?.focus();
  }, [state.status]);

  function finish() {
    if (finished.current) return;
    finished.current = true;
    close();
    onClose(keep());
  }
  function switchToCameraApp() {
    if (finished.current) return;
    finished.current = true;
    close();
    dialogRef.current?.close();
    onUseCameraApp(keep()); // synchronously, inside this tap
  }

  async function shoot() {
    if (shutterBlocked) return; // aria-disabled, not disabled, so focus stays on the shutter
    setShotError("");
    const shot = await camera.capture();
    if (finished.current) return; // closed while the photo was being taken
    if (!shot) { setShotError("That photo could not be taken. Try again."); setAnnouncement("That photo could not be taken. Try again."); return; }
    const position = selection.count + shotsRef.current.length + 1;
    // Always a JPEG of at most MAX_IMAGE_BYTES: useCamera uses takePhoto only when it returns one,
    // else a JPEG video frame encoded under the limit.
    const file = new File([shot.photo], cameraFileName(sessionStart, position), { type: "image/jpeg", lastModified: Date.now() });
    if (shotsThatFit(selection, [...shotsRef.current.map(s => s.file), file]).length <= shotsRef.current.length) {
      // Cannot happen while the budget holds the shutter; never keep a photo Done would drop.
      setShotError("That photo would pass the capture limit, so it was not kept.");
      return;
    }
    shotsRef.current = [...shotsRef.current, { file, preview: shot.preview }];
    setShots(shotsRef.current);
    const next = shotBudget(selection, shotsRef.current.map(s => s.file.size));
    setAnnouncement(next.canShoot ? shotAnnouncement(position) : `Photo ${position} taken. ${next.message}`);
    setFlash(n => n + 1);
    try { navigator.vibrate?.(15); } catch { /* not on iOS; harmless elsewhere */ }
  }
  function undo() {
    if (!shotsRef.current.length) return;
    shotsRef.current = shotsRef.current.slice(0, -1);
    setShots(shotsRef.current);
    const remaining = selection.count + shotsRef.current.length;
    setAnnouncement(`Last photo deleted. ${remaining} ${remaining === 1 ? "photo" : "photos"}.`);
  }

  const problem = state.status === "error" ? state.problem : null;
  return <dialog ref={dialogRef} className="camera" aria-labelledby="camera-title" aria-describedby="camera-guidance"
    onCancel={e => { e.preventDefault(); finish(); }} onClose={finish}>
    <div className="camera-layout">
      <div className="camera-top">
        <button type="button" className="camera-round" aria-label={shots.length ? `Close camera and keep ${shots.length} ${shots.length === 1 ? "photo" : "photos"}` : "Close camera"} onClick={finish}><X size={20} /></button>
        <h2 id="camera-title" className="sr-only">Camera</h2>
        <div className="camera-counter" aria-hidden="true">
          <span><strong>{guidance.total}</strong> {guidance.total === 1 ? "photo" : "photos"}</span>
          <span className="camera-goal">min {MIN_IMAGES} · goal {SHOT_GOAL}+</span>
          <span className="camera-meter"><span style={{ width: `${Math.round(guidance.progress * 100)}%` }} className={guidance.total >= MIN_IMAGES ? "met" : ""} /></span>
        </div>
        <button type="button" className={`camera-round ${ghostOn ? "on" : ""}`} aria-pressed={ghostOn} aria-label="Show the last photo faded over the viewfinder" title="Ghost of the last photo" onClick={() => setGhostOn(v => !v)}><Ghost size={19} /></button>
      </div>

      <div className="camera-stage">
        <video ref={videoRef} muted playsInline autoPlay aria-label="Camera viewfinder" />
        {ghostOn && last?.preview && state.status !== "error" && <img className="camera-ghost" src={last.preview} alt="" aria-hidden="true" />}
        {flash > 0 && <span key={flash} className="camera-flash" aria-hidden="true" />}
        {state.status === "starting" && <p className="camera-status"><LoaderCircle size={18} className="spin" /> Starting the camera…</p>}
        {state.status === "paused" && <div className="camera-panel"><p>The camera paused while the page was hidden.</p><button type="button" className="camera-action" onClick={open}><RefreshCw size={16} /> Resume</button></div>}
        {problem && <div className="camera-panel" role="alert">
          <p>{problemMessages[problem]}</p>
          <div className="camera-panel-actions">
            {canRetry(problem) && <button ref={errorActionRef} type="button" className="camera-action" onClick={open}><RefreshCw size={16} /> Try again</button>}
            <button ref={canRetry(problem) ? undefined : errorActionRef} type="button" className="camera-action secondary" onClick={switchToCameraApp}><Smartphone size={16} /> Use camera app</button>
          </div>
          {shots.length > 0 && <small>Your {shots.length} {shots.length === 1 ? "photo is" : "photos are"} kept.</small>}
        </div>}
      </div>

      <div className="camera-hints" id="camera-guidance">
        <p className={budget.canShoot ? "camera-message" : "camera-message camera-warning"}>{budget.message ?? guidance.message}</p>
        {budget.canShoot && <p className={motion ? "camera-warning" : ""}>{motion ?? overlapHint(shots.length, ghostOn)}</p>}
        {shotError && <p className="camera-warning" role="alert">{shotError}</p>}
        {shots.length > 0 && <p className="camera-note">These photos are kept only in this tab. Upload them before you close or reload it.</p>}
      </div>

      <div className="camera-controls">
        <button type="button" className="camera-round" aria-label="Delete the last photo" title="Delete the last photo" disabled={!shots.length || busy} onClick={undo}><Undo2 size={19} /></button>
        <button ref={shutterRef} type="button" className="camera-shutter" aria-disabled={shutterBlocked || undefined} aria-busy={busy || undefined}
          aria-label={budget.canShoot ? `Take photo, ${guidance.total} taken` : `Capture limit reached, ${guidance.total} taken`} onClick={() => void shoot()}>
          <span>{busy && <LoaderCircle size={22} className="spin" />}</span>
        </button>
        <button type="button" className="camera-done" onClick={finish} aria-label={shots.length ? `Done, add ${shots.length} ${shots.length === 1 ? "photo" : "photos"}` : "Done"}>
          {last?.preview ? <img src={last.preview} alt="" aria-hidden="true" /> : <Check size={18} />}
          <span>Done</span>
        </button>
      </div>
      <p className="sr-only" aria-live="polite">{announcement}</p>
    </div>
  </dialog>;
}
