/**
 * Pure logic for phone camera capture (S9, PRD R1.4, spec §8.3). No DOM access here, so every rule
 * is unit-tested in Node (tests/camera.test.mjs); components/useCamera.ts and CameraCapture.tsx
 * hold the browser side.
 */
import { MAX_IMAGE_BYTES, MAX_IMAGES, MAX_TOTAL_BYTES, MIN_IMAGES } from "../validation";
import { RECOMMENDED_MIN_PHOTOS } from "../capture-prep/metrics";

// ── Shot-count guidance ──────────────────────────────────────────────────────────────────────
/** The count the guided mode aims for: comfortably above the 30-usable recommendation (§8.2),
 * because a few shots usually come out blurred or as near-copies. */
export const SHOT_GOAL = 40;

export type ShotStage = "empty" | "below-minimum" | "below-recommended" | "below-goal" | "goal" | "full";
export type ShotGuidance = {
  stage: ShotStage;
  /** Photos in the selection, including those picked before the camera opened. */
  total: number;
  /** Photos still needed for the next milestone (0 at the goal and beyond). */
  remaining: number;
  /** 0–1 progress toward the goal, for the counter's bar. */
  progress: number;
  /** One short sentence for the counter. */
  message: string;
  /** False once the 200-photo limit is reached. */
  canShoot: boolean;
};

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

export function shotGuidance(total: number, limits = { min: MIN_IMAGES, recommended: RECOMMENDED_MIN_PHOTOS, goal: SHOT_GOAL, max: MAX_IMAGES }): ShotGuidance {
  const n = Math.max(0, Math.floor(total));
  const progress = Math.min(1, n / limits.goal);
  const base = { total: n, progress, canShoot: n < limits.max };
  if (n >= limits.max) return { ...base, stage: "full", remaining: 0, message: `That’s the limit of ${limits.max} photos for one capture.` };
  if (n === 0) return { ...base, stage: "empty", remaining: limits.min, message: "Start anywhere. Take your first photo." };
  if (n < limits.min) return { ...base, stage: "below-minimum", remaining: limits.min - n, message: `${plural(limits.min - n, "more photo")} to reach the minimum of ${limits.min}.` };
  if (n < limits.recommended) return { ...base, stage: "below-recommended", remaining: limits.recommended - n, message: `Minimum reached. ${limits.recommended}+ sharp photos work better.` };
  if (n < limits.goal) return { ...base, stage: "below-goal", remaining: limits.goal - n, message: `Good. ${plural(limits.goal - n, "more photo")} for full coverage (${limits.goal}).` };
  return { ...base, stage: "goal", remaining: 0, message: "Great coverage. Keep going for detail, or finish." };
}

/** What the live region says after a shot. */
export function shotAnnouncement(total: number): string {
  const g = shotGuidance(total);
  return `Photo ${g.total} taken. ${g.message}`;
}

/** The overlap hint under the counter: always visible, with the ghost of the last shot when it is on. */
export function overlapHint(shots: number, ghost: boolean): string {
  if (shots === 0) return "Hold steady. After each photo, take one small step and shoot again.";
  return ghost
    ? "Take a small step, then shoot when about two-thirds of the faded last photo still lines up (60–70% overlap)."
    : "Take a small step to the side, keeping about two-thirds of the last photo in view (60–70% overlap).";
}

// ── File names ───────────────────────────────────────────────────────────────────────────────
const pad = (n: number, width = 2) => String(n).padStart(width, "0");
/** `20261123-101530` in local time. */
export function timestamp(date: Date): string {
  return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`;
}

/**
 * The name of a photo taken in the guided mode: `camera-20261123-101530-014.jpg`, where the
 * timestamp is when the camera session started and the number is the photo's position in the
 * selection (1-based). Names stay unique across sessions and sort in shooting order, and Studio's
 * name + size duplicate check and the resume matcher (§8.1) see one file per row.
 */
export function cameraFileName(sessionStart: Date, position: number, extension = "jpg"): string {
  return `camera-${timestamp(sessionStart)}-${pad(Math.max(1, Math.floor(position)), 3)}.${extension}`;
}

const KNOWN_EXTENSIONS: Record<string, string> = { "image/jpeg": "jpg", "image/png": "png", "image/heic": "heic", "image/heif": "heif" };
export type NamedFile = { name: string; size: number };
/**
 * The name a photo from the `capture` file input (the camera app) joins the selection under. The
 * original name is kept whenever it can be: the resume-after-reload matcher (§8.1) pairs reselected
 * files with the manifest by exact name and size, so `IMG_20261123_101530.jpg` must stay that. Only
 * a name already used in the selection by a *different* photo (iOS calls every camera photo
 * `image.jpg`) is made unique, as `<stem>-<lastModified>-<size>.<ext>` (with `-2`, `-3`, … if even
 * that is taken). The result depends only on the file and the selection, so picking the same file
 * again gives the same name, and Studio's name + size check drops the repeat. A photo with the same
 * name *and* size as one in the selection keeps its name for the same reason.
 */
export function cameraAppFileName(file: NamedFile & { type: string; lastModified: number }, existing: readonly NamedFile[]): string {
  const match = /\.([a-z0-9]{2,5})$/i.exec(file.name);
  const extension = match ? match[1] : KNOWN_EXTENSIONS[file.type.toLowerCase()] ?? "jpg";
  const name = file.name || `image.${extension}`;
  const clash = (candidate: string) => existing.some(other => other.name === candidate && other.size !== file.size);
  if (!clash(name)) return name;
  const stem = match ? name.slice(0, -match[0].length) : name;
  const base = `${stem}-${Math.max(0, Math.floor(file.lastModified || 0))}-${file.size}`;
  for (let n = 1; ; n++) {
    const candidate = `${base}${n === 1 ? "" : `-${n}`}.${extension}`;
    if (!clash(candidate)) return candidate;
  }
}

// ── Capture limits (what Studio accepts) ─────────────────────────────────────────────────────
/** The per-capture limits Studio and the server enforce, from lib/validation.ts. */
export const CAPTURE_LIMITS = { maxImages: MAX_IMAGES, maxTotalBytes: MAX_TOTAL_BYTES, maxImageBytes: MAX_IMAGE_BYTES };
export type CaptureLimits = typeof CAPTURE_LIMITS;
/** The photos already in the selection (or queued for it) when the guided mode opens. */
export type Selection = { count: number; bytes: number };
export type ShotBudget = { canShoot: true; limit: null; message: null } | { canShoot: false; limit: "count" | "bytes"; message: string };

const wholeMegabytes = (bytes: number) => Math.max(0, Math.floor(bytes / (1024 * 1024)));
const sizeLabel = (bytes: number) => (bytes >= 1024 ** 3 && bytes % 1024 ** 3 === 0 ? `${bytes / 1024 ** 3} GB` : `${wholeMegabytes(bytes)} MB`);

/**
 * Whether the guided mode may take another photo. Guided shots exist only in memory, so a shot
 * Studio would refuse at Done is a photo lost: the shutter stops as soon as the next shot *could*
 * break a limit, counting the selection, the real sizes of the shots taken so far and the largest
 * photo the camera can produce (`maxImageBytes`; useCamera drops larger takePhoto results and
 * re-encodes video frames under it). The same bound caps what the dialog holds in memory.
 */
export function shotBudget(selection: Selection, shotSizes: readonly number[], limits: CaptureLimits = CAPTURE_LIMITS): ShotBudget {
  const count = selection.count + shotSizes.length;
  const bytes = selection.bytes + shotSizes.reduce((sum, size) => sum + size, 0);
  if (count >= limits.maxImages) {
    return { canShoot: false, limit: "count", message: `That’s the limit of ${limits.maxImages} photos for one capture. Tap Done to add them.` };
  }
  if (bytes + limits.maxImageBytes > limits.maxTotalBytes) {
    return {
      canShoot: false,
      limit: "bytes",
      message: `This capture is near its ${sizeLabel(limits.maxTotalBytes)} limit (${wholeMegabytes(limits.maxTotalBytes - bytes)} MB left; one photo can take up to ${sizeLabel(limits.maxImageBytes)}). Tap Done to add your photos.`,
    };
  }
  return { canShoot: true, limit: null, message: null };
}

/**
 * The shots Studio's add path accepts on top of the selection, by its rules: it stops at the first
 * photo that would pass the photo or byte limit and skips an empty or oversized one. With the
 * shutter held by `shotBudget` that is every shot; Done never hands Studio more than this.
 */
export function shotsThatFit<T extends { size: number }>(selection: Selection, shots: readonly T[], limits: CaptureLimits = CAPTURE_LIMITS): T[] {
  const kept: T[] = [];
  let count = selection.count;
  let bytes = selection.bytes;
  for (const shot of shots) {
    if (count >= limits.maxImages || bytes + shot.size > limits.maxTotalBytes) break;
    if (shot.size <= 0 || shot.size > limits.maxImageBytes) continue;
    kept.push(shot);
    count += 1;
    bytes += shot.size;
  }
  return kept;
}

// ── Frame size and encoding ──────────────────────────────────────────────────────────────────
/** What the guided mode asks getUserMedia for: the back camera, as large as the device offers.
 * `ideal` never fails the request; the browser picks the closest mode it has. 4:3 matches the
 * phone's photo format, so the frame is not a cropped 16:9 video strip. */
export const VIDEO_CONSTRAINTS = {
  facingMode: { ideal: "environment" },
  width: { ideal: 4032 },
  height: { ideal: 3024 },
} as const;

/** iOS Safari refuses canvases over 16,777,216 pixels (4096 × 4096), and draws nothing into them. */
export const MAX_CANVAS_PIXELS = 4096 * 4096;

export type Size = { width: number; height: number };
/** The canvas size for a frame grabbed from the video track: its native size, scaled down (aspect
 * kept, whole pixels) only when it is over the canvas limit. */
export function frameSize(video: Size, maxPixels = MAX_CANVAS_PIXELS): Size | null {
  const { width, height } = video;
  if (!(width > 0 && height > 0)) return null; // metadata not loaded yet
  if (width * height <= maxPixels) return { width: Math.round(width), height: Math.round(height) };
  const scale = Math.sqrt(maxPixels / (width * height));
  return { width: Math.max(1, Math.floor(width * scale)), height: Math.max(1, Math.floor(height * scale)) };
}

export const isPortrait = ({ width, height }: Size) => height > width;
/**
 * Whether a full-resolution photo from ImageCapture.takePhoto can be used as is. Some Android
 * builds return the sensor's landscape image while the phone (and the preview) is upright; mixing
 * that into a set would break the shared camera model, so the frame from the video track is used
 * instead. Square frames match either way. Only a JPEG within the server's 20 MB limit is used:
 * Chrome's fake and some virtual cameras answer with a lossless PNG (no EXIF, several times the
 * size), which the JPEG frame from the video beats for an upload of up to 200 photos.
 */
export function photoMatchesPreview(photo: Size & { bytes: number; type: string }, preview: Size, limit = MAX_IMAGE_BYTES): boolean {
  if (photo.type !== "image/jpeg" || photo.bytes <= 0 || photo.bytes > limit) return false;
  if (photo.width === photo.height || preview.width === preview.height) return true;
  return isPortrait(photo) === isPortrait(preview);
}

// ── Availability and errors ──────────────────────────────────────────────────────────────────
export type CameraProblem = "insecure" | "unsupported" | "denied" | "no-camera" | "busy" | "interrupted" | "failed";

/** Whether getUserMedia can even be tried. Browsers hide `navigator.mediaDevices` on plain-HTTP
 * pages (anything but localhost), so an insecure context is named first. */
export function cameraAvailability(env: { secureContext: boolean; getUserMedia: boolean }): "ok" | "insecure" | "unsupported" {
  if (!env.secureContext) return "insecure";
  return env.getUserMedia ? "ok" : "unsupported";
}

/** Maps a getUserMedia rejection (a DOMException, by name) to what the user is told. */
export function classifyCameraError(error: unknown, secureContext = true): CameraProblem {
  const name = typeof error === "object" && error && "name" in error ? String((error as { name: unknown }).name) : "";
  switch (name) {
    case "NotAllowedError": case "PermissionDeniedError": return "denied";
    case "SecurityError": return secureContext ? "denied" : "insecure";
    case "NotFoundError": case "DevicesNotFoundError": case "OverconstrainedError": case "ConstraintNotSatisfiedError": return "no-camera";
    case "NotReadableError": case "TrackStartError": case "AbortError": return "busy";
    default: return "failed";
  }
}

export const problemMessages: Record<CameraProblem, string> = {
  insecure: "The live camera needs a secure (https) page. You can still take photos with your camera app.",
  unsupported: "This browser cannot show a live camera here. You can still take photos with your camera app.",
  denied: "Camera access is blocked for this site. Allow it in your browser’s site settings and try again, or use your camera app.",
  "no-camera": "No camera was found on this device.",
  busy: "The camera is being used by another app. Close that app and try again.",
  interrupted: "The camera stopped. Try again to continue where you left off.",
  failed: "The camera could not start. Try again, or use your camera app.",
};
/** Whether "Try again" makes sense (a denied permission needs the settings first; an insecure or
 * unsupported page never changes). */
export const canRetry = (problem: CameraProblem) => !["insecure", "unsupported"].includes(problem);

// ── State machine ────────────────────────────────────────────────────────────────────────────
export type CameraState =
  | { status: "closed" }
  | { status: "starting" }
  | { status: "live" }
  | { status: "capturing" }
  | { status: "paused" } // the page was hidden: the tracks are stopped and restart on return
  | { status: "error"; problem: CameraProblem };

export type CameraEvent =
  | { type: "open" } // also "try again" after an error
  | { type: "ready" }
  | { type: "fail"; problem: CameraProblem }
  | { type: "shutter" }
  | { type: "shot-done" } // a photo was taken or failed: back to the viewfinder
  | { type: "hide" }
  | { type: "show" } // the page is visible again: a paused camera restarts
  | { type: "ended" } // the track ended on its own (another app took the camera, the OS stopped it)
  | { type: "close" };

export const initialCameraState: CameraState = { status: "closed" };

/**
 * Transitions for the guided mode. Events that do not apply to the current state are ignored and
 * return the same object, so a late "ready" after the user closed the camera, or a second shutter
 * press while a photo is being taken, changes nothing.
 */
export function cameraReducer(state: CameraState, event: CameraEvent): CameraState {
  switch (event.type) {
    case "close": return state.status === "closed" ? state : initialCameraState;
    case "open": return ["closed", "paused", "error"].includes(state.status) ? { status: "starting" } : state;
    case "ready": return state.status === "starting" ? { status: "live" } : state;
    case "fail": return state.status === "starting" ? { status: "error", problem: event.problem } : state;
    case "shutter": return state.status === "live" ? { status: "capturing" } : state;
    case "shot-done": return state.status === "capturing" ? { status: "live" } : state;
    case "show": return state.status === "paused" ? { status: "starting" } : state;
    case "hide": return ["starting", "live", "capturing"].includes(state.status) ? { status: "paused" } : state;
    case "ended": return ["live", "capturing"].includes(state.status) ? { status: "error", problem: "interrupted" } : state;
  }
}

/** The tracks should be running in these states, and stopped in every other. */
export const wantsStream = (state: CameraState) => state.status === "starting" || state.status === "live" || state.status === "capturing";

// ── Entry point ──────────────────────────────────────────────────────────────────────────────
/** The "Take photos" entry shows on touch-first devices (phones, tablets), where the camera faces
 * the scene. Desktops keep drag and drop; a laptop webcam is no tool for a walk-around. */
export function showCameraEntry(env: { coarsePointer: boolean; hoverNone: boolean; maxTouchPoints: number }): boolean {
  return env.coarsePointer || (env.hoverNone && env.maxTouchPoints > 0);
}

// ── Motion cue (DeviceOrientation, optional) ─────────────────────────────────────────────────
export type Orientation = { alpha: number; beta: number; gamma: number };
/**
 * The rotation in degrees between two device orientations (W3C DeviceOrientation Euler angles,
 * Z-X'-Y'' intrinsic), via unit quaternions: angle = 2·acos(|q1·q2|).
 */
export function rotationBetween(a: Orientation, b: Orientation): number {
  const q = (o: Orientation) => {
    const [z, x, y] = [o.alpha, o.beta, o.gamma].map(d => d * Math.PI / 360); // half angles
    const [cz, sz, cx, sx, cy, sy] = [Math.cos(z), Math.sin(z), Math.cos(x), Math.sin(x), Math.cos(y), Math.sin(y)];
    return [ // q = qz(alpha) · qx(beta) · qy(gamma)
      cz * cx * cy - sz * sx * sy,
      cz * sx * cy - sz * cx * sy,
      cz * cx * sy + sz * sx * cy,
      sz * cx * cy + cz * sx * sy,
    ];
  };
  const [p, r] = [q(a), q(b)];
  const dot = Math.min(1, Math.abs(p[0] * r[0] + p[1] * r[1] + p[2] * r[2] + p[3] * r[3]));
  return 2 * Math.acos(dot) * 180 / Math.PI;
}

/** Above this turn since the last photo, the two photos probably share too little of the scene. */
export const BIG_TURN_DEGREES = 25;
export function motionHint(degreesSinceLastShot: number | null): string | null {
  if (degreesSinceLastShot === null || !Number.isFinite(degreesSinceLastShot)) return null;
  return degreesSinceLastShot > BIG_TURN_DEGREES ? "Big turn since the last photo. Turn back a little so the photos overlap." : null;
}
