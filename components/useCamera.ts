"use client";
/**
 * The live camera for the guided shooting mode (S9, PRD R1.4, spec §8.3).
 *
 * Lifecycle: the media stream exists exactly while the state machine (lib/camera/camera.ts) is
 * starting, live or capturing. One effect owns it, so every way out (closing, an error, the page
 * being hidden, unmounting) stops every track and the camera light goes off. A stream that arrives
 * after the effect was cleaned up (the user closed the camera while the permission prompt was up)
 * is stopped at once.
 *
 * Shots: ImageCapture.takePhoto() where the browser has it (Chrome on Android: full sensor
 * resolution, with EXIF), else a frame drawn from the video track at its native size. The
 * takePhoto result is used only when it is a JPEG whose orientation matches the preview
 * (photoMatchesPreview); otherwise the session switches to video frames for good.
 */
import { useCallback, useEffect, useReducer, useRef, useState, type RefObject } from "react";
import { MAX_IMAGE_BYTES } from "../lib/validation";
import { JPEG_QUALITY, nextEncodeAttempt, type EncodeAttempt } from "../lib/capture-prep/heic";
import {
  VIDEO_CONSTRAINTS, cameraAvailability, cameraReducer, classifyCameraError, frameSize, initialCameraState,
  motionHint, photoMatchesPreview, rotationBetween, wantsStream, type CameraState, type Orientation,
} from "../lib/camera/camera";

/** ImageCapture is not in TypeScript's DOM lib (Chromium only). */
type ImageCaptureLike = { takePhoto(): Promise<Blob> };
type ImageCaptureCtor = new (track: MediaStreamTrack) => ImageCaptureLike;

const stopAll = (stream: MediaStream) => stream.getTracks().forEach(track => track.stop());

function liveAvailability() {
  return cameraAvailability({
    secureContext: typeof window !== "undefined" && window.isSecureContext,
    getUserMedia: typeof navigator !== "undefined" && typeof navigator.mediaDevices?.getUserMedia === "function",
  });
}
/** Whether the live viewfinder can even be tried here (secure page, getUserMedia present). */
export const liveCameraAvailability = liveAvailability;

function toBlob(canvas: HTMLCanvasElement, quality: number): Promise<Blob | null> {
  return new Promise(resolve => canvas.toBlob(resolve, "image/jpeg", quality));
}

/** A JPEG of the current video frame at its native size (within the canvas limit), stepped down in
 * quality, then size, until it fits the 20 MB per-photo limit (same ladder as HEIC conversion). */
async function grabFrame(video: HTMLVideoElement): Promise<Blob | null> {
  const size = frameSize({ width: video.videoWidth, height: video.videoHeight });
  if (!size) return null;
  let attempt: EncodeAttempt = { quality: JPEG_QUALITY, scale: 1 };
  const canvas = document.createElement("canvas");
  try {
    for (;;) {
      canvas.width = Math.max(1, Math.round(size.width * attempt.scale));
      canvas.height = Math.max(1, Math.round(size.height * attempt.scale));
      const context = canvas.getContext("2d");
      if (!context) return null;
      context.drawImage(video, 0, 0, canvas.width, canvas.height);
      const blob = await toBlob(canvas, attempt.quality);
      if (!blob) return null;
      const decision = nextEncodeAttempt({ ...attempt, bytes: blob.size }, MAX_IMAGE_BYTES);
      if (decision.kind === "done") return blob;
      if (decision.kind === "give-up") return null;
      attempt = decision.next;
    }
  } finally {
    canvas.width = canvas.height = 0; // free the backing store at once (matters on iOS)
  }
}

/** A small JPEG data URL of the current frame, for the "ghost" of the last shot. It is cut from the
 * preview itself, so it lines up with the viewfinder even when takePhoto's photo has another aspect. */
export const GHOST_MAX_SIDE = 480;
function grabPreview(video: HTMLVideoElement): string | null {
  const size = frameSize({ width: video.videoWidth, height: video.videoHeight });
  if (!size) return null;
  const scale = Math.min(1, GHOST_MAX_SIDE / Math.max(size.width, size.height));
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(size.width * scale)); canvas.height = Math.max(1, Math.round(size.height * scale));
  const context = canvas.getContext("2d");
  if (!context) return null;
  context.drawImage(video, 0, 0, canvas.width, canvas.height);
  try { return canvas.toDataURL("image/jpeg", 0.6); } catch { return null; }
}

export type Shot = { photo: Blob; preview: string | null };

export type Camera = {
  state: CameraState;
  /** Start the camera (also "try again" after an error, and "resume" after a pause). */
  open(): void;
  /** Stop the camera; tracks stop in the effect cleanup. */
  close(): void;
  /** Take one photo: a JPEG blob plus a small preview, or null if no photo could be taken. */
  capture(): Promise<Shot | null>;
};

export function useCamera(videoRef: RefObject<HTMLVideoElement | null>): Camera {
  const [state, dispatch] = useReducer(cameraReducer, initialCameraState);
  const stateRef = useRef(state);
  useEffect(() => { stateRef.current = state; }, [state]);
  const streamRef = useRef<MediaStream | null>(null);
  const imageCapture = useRef<ImageCaptureLike | null>(null);
  /** takePhoto failed or gave an unusable photo once: use the video frame for the rest of the session,
   * so the set does not mix two sources (resolutions, crops) for the shared camera model. */
  const photoBroken = useRef(false);
  const active = wantsStream(state);

  useEffect(() => {
    if (!active) return;
    let cancelled = false;
    let stream: MediaStream | null = null;
    const video = videoRef.current;
    const onEnded = () => { if (!cancelled) dispatch({ type: "ended" }); };
    navigator.mediaDevices.getUserMedia({ audio: false, video: VIDEO_CONSTRAINTS }).then(async acquired => {
      if (cancelled) { stopAll(acquired); return; }
      stream = acquired; streamRef.current = acquired;
      const track = acquired.getVideoTracks()[0];
      if (!track || !video) { dispatch({ type: "fail", problem: "no-camera" }); return; }
      track.addEventListener("ended", onEnded);
      const Ctor = (globalThis as { ImageCapture?: ImageCaptureCtor }).ImageCapture;
      imageCapture.current = Ctor && !photoBroken.current ? (() => { try { return new Ctor(track); } catch { return null; } })() : null;
      video.srcObject = acquired;
      if (video.readyState < HTMLMediaElement.HAVE_METADATA) await new Promise(resolve => video.addEventListener("loadedmetadata", resolve, { once: true }));
      await video.play().catch(() => {}); // autoplay of a muted inline video is allowed; a refusal still leaves a frame
      if (!cancelled) dispatch({ type: "ready" });
    }, error => {
      if (!cancelled) dispatch({ type: "fail", problem: classifyCameraError(error, window.isSecureContext) });
    });
    return () => {
      cancelled = true;
      if (stream) { stream.getVideoTracks().forEach(track => track.removeEventListener("ended", onEnded)); stopAll(stream); }
      if (streamRef.current === stream) streamRef.current = null;
      imageCapture.current = null;
      if (video && video.srcObject === stream) video.srcObject = null;
    };
  }, [active, videoRef]);

  // iOS stops the camera when the page is hidden; stop it ourselves (light off) and restart on return.
  useEffect(() => {
    const onVisibility = () => dispatch({ type: document.hidden ? "hide" : "show" });
    document.addEventListener("visibilitychange", onVisibility);
    return () => document.removeEventListener("visibilitychange", onVisibility);
  }, []);

  const open = useCallback(() => {
    const availability = liveAvailability();
    dispatch({ type: "open" });
    if (availability !== "ok") dispatch({ type: "fail", problem: availability });
  }, []);
  const close = useCallback(() => dispatch({ type: "close" }), []);

  const capture = useCallback(async (): Promise<Shot | null> => {
    const video = videoRef.current;
    if (stateRef.current.status !== "live" || !video) return null;
    stateRef.current = { status: "capturing" }; // a second tap before the re-render is ignored
    dispatch({ type: "shutter" });
    try {
      const preview = { width: video.videoWidth, height: video.videoHeight };
      const ghost = grabPreview(video); // the moment of the tap, before takePhoto's delay
      const photographer = imageCapture.current;
      if (photographer && !photoBroken.current) {
        try {
          const photo = await photographer.takePhoto();
          const bitmap = await createImageBitmap(photo);
          const size = { width: bitmap.width, height: bitmap.height };
          bitmap.close();
          if (photoMatchesPreview({ ...size, bytes: photo.size, type: photo.type }, preview)) return { photo, preview: ghost };
          photoBroken.current = true;
        } catch {
          photoBroken.current = true;
        }
      }
      const frame = await grabFrame(video);
      return frame ? { photo: frame, preview: ghost } : null;
    } catch {
      return null;
    } finally {
      dispatch({ type: "shot-done" });
    }
  }, [videoRef]);

  return { state, open, close, capture };
}

/**
 * Optional motion cue: how far the phone has turned since the last photo, from DeviceOrientation.
 * Used only where it needs no permission prompt (Android Chrome). iOS asks for motion access with a
 * separate prompt (`DeviceOrientationEvent.requestPermission`), which this mode does not add, so on
 * iOS (and on any device without the sensor) the cue is simply absent.
 */
export function useMotionCue(enabled: boolean, shots: number): string | null {
  const [hint, setHint] = useState<string | null>(null);
  const current = useRef<Orientation | null>(null);
  const reference = useRef<Orientation | null>(null);
  const shown = useRef<string | null>(null);
  const supported = typeof window !== "undefined" && "DeviceOrientationEvent" in window &&
    typeof (window.DeviceOrientationEvent as unknown as { requestPermission?: unknown }).requestPermission !== "function";
  const listening = enabled && supported;

  // A new photo becomes the reference for the next turn.
  // The next sensor event (they arrive many times a second) clears a hint the new photo answered.
  useEffect(() => { reference.current = current.current; }, [shots]);
  useEffect(() => {
    if (!listening) return;
    const onOrientation = (event: DeviceOrientationEvent) => {
      if (event.alpha === null || event.beta === null || event.gamma === null) return; // no sensor (desktop)
      current.current = { alpha: event.alpha, beta: event.beta, gamma: event.gamma };
      if (!reference.current) return;
      const next = motionHint(rotationBetween(reference.current, current.current));
      if (next !== shown.current) { shown.current = next; setHint(next); }
    };
    window.addEventListener("deviceorientation", onOrientation);
    return () => { window.removeEventListener("deviceorientation", onOrientation); current.current = reference.current = null; shown.current = null; };
  }, [listening]);
  return listening && shots > 0 ? hint : null;
}
