"use client";
/**
 * S10 (ADR-0009, spec §7.11): a capture from one phone video. The video goes to R2 in 8 MiB parts
 * (multipart), then the capture is submitted; the GPU worker extracts 100–200 sharp frames from it. The
 * original is deleted once the scene is published unless the owner keeps it.
 */
import { useEffect, useId, useRef, useState } from "react";
import { AlertCircle, ArrowRight, Box, Film, LoaderCircle, LockKeyhole } from "lucide-react";
import { MAX_NAME_LENGTH, MAX_VIDEO_BYTES } from "../lib/validation";
import { uploadVideoCapture, VIDEO_ACCEPT, videoMime, videoPanel, type VideoResume } from "../lib/video-upload";
import type { Capture } from "../lib/types";

const formatBytes = (n: number) => n < 1024 * 1024 * 1024 ? `${(n / 1024 / 1024).toFixed(1)} MB` : `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`;
export type { VideoResume };

type Handlers = { disabled?: boolean; onCreated: (id: string) => void; onSubmitted: (id: string) => void; onCancel: () => void };

/**
 * The Studio's video panel: a new video (videoMode) or the unfinished video capture that is active. A new upload
 * keeps one VideoUpload for its whole life, even once the poll reveals its capture (review P1: a remount would
 * cancel the upload and drop the chosen file); see `videoPanel`.
 */
export function VideoPanel({ videoMode, capture, ...handlers }: Handlers & { videoMode: boolean; capture?: Capture }) {
  const panel = videoPanel(videoMode, capture?.id);
  if (!panel) return null;
  const resume = panel.resume && capture ? { id: capture.id, name: capture.name, bytes: capture.video_bytes ?? null, uploaded: !!capture.video_uploaded } : undefined;
  return <VideoUpload key={panel.key} resume={resume} {...handlers} />;
}

export default function VideoUpload({ resume, disabled, onCreated, onSubmitted, onCancel }: Handlers & { resume?: VideoResume }) {
  const ids = useId();
  const [file, setFile] = useState<File | null>(null);
  const [name, setName] = useState(resume?.name ?? "");
  const [keepVideo, setKeepVideo] = useState(false);
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState(0);
  const [error, setError] = useState("");
  const [submitted, setSubmitted] = useState(false); // until the poll swaps this panel for the job panel
  const input = useRef<HTMLInputElement>(null);
  const abort = useRef<AbortController | null>(null);
  const createdId = useRef<string | undefined>(resume?.id);
  // Leaving (Start a new capture, unmounting) cancels the upload; reopening the capture resumes it.
  useEffect(() => () => abort.current?.abort(new DOMException("Upload cancelled.", "AbortError")), []);
  useEffect(() => {
    const prevent = (e: BeforeUnloadEvent) => { e.preventDefault(); };
    if (busy) window.addEventListener("beforeunload", prevent);
    return () => window.removeEventListener("beforeunload", prevent);
  }, [busy]);

  function choose(files: FileList | null) {
    const chosen = files?.[0];
    setError("");
    if (!chosen) return;
    if (!videoMime(chosen)) { setError("Choose an MP4 or MOV video."); return; }
    if (chosen.size > MAX_VIDEO_BYTES) { setError("Keep the video under 1 GB. Trim it to a slow 20–90 second walk around the subject."); return; }
    if (resume?.bytes && chosen.size !== resume.bytes) { setError("Choose the same video this capture was started with."); return; }
    setFile(chosen);
  }
  async function start() {
    if (busy) return;
    const controller = new AbortController();
    abort.current = controller;
    setBusy(true); setError(""); setProgress(0);
    try {
      let id = createdId.current;
      if (resume?.uploaded && id) {
        const response = await fetch(`/api/captures/${id}/submit`, { method: "POST", signal: controller.signal });
        if (!response.ok) throw new Error(((await response.json().catch(() => ({}))) as { error?: string }).error ?? "Request failed.");
      } else {
        if (!file) return;
        id = await uploadVideoCapture({ name: name.trim(), file, keepVideo, resumeId: createdId.current, signal: controller.signal,
          onCreated: created => { createdId.current = created; onCreated(created); },
          onProgress: fraction => setProgress(Math.round(fraction * 100)) });
      }
      controller.signal.throwIfAborted();
      setSubmitted(true);
      onSubmitted(id!);
    } catch (e) {
      if (controller.signal.aborted) return;
      setError((e as Error).message);
    } finally {
      if (abort.current === controller) { abort.current = null; setBusy(false); }
    }
  }

  const ready = resume?.uploaded || (!!file && !!name.trim());
  return <div className="video-upload">
    <p className="panel-description">One slow walk around your subject, filmed on your phone.<br />We’ll pick the sharpest frames.</p>
    {resume && <div className="notice">{resume.uploaded ? "The video is uploaded. Start the reconstruction when you are ready." : "Choose the same video again to finish uploading it."}</div>}
    {!resume?.uploaded && <>
      <input ref={input} id={`${ids}-file`} type="file" accept={VIDEO_ACCEPT} className="sr-only" aria-label="Choose a capture video" disabled={busy || disabled} onChange={e => { choose(e.target.files); e.target.value = ""; }} />
      <button type="button" disabled={busy || disabled} className={`dropzone ${file ? "compact" : ""}`} onClick={() => input.current?.click()}>
        <span className="photo-stack"><Film size={29} strokeWidth={1.3} /></span>
        <strong>{file ? file.name : "Choose a video"}</strong>
        <span>{file ? formatBytes(file.size) : <>or <u>browse files</u></>}</span>
        <small>MP4 or MOV · one video · up to 1 GB · 20–90 seconds works best</small>
      </button>
    </>}
    {!resume && <>
      <label className="field-label" htmlFor={`${ids}-name`}>Name your capture <span>Something to remember it by</span></label>
      <input id={`${ids}-name`} className="name-input" placeholder="e.g. A quiet corner of home" maxLength={MAX_NAME_LENGTH} value={name} disabled={busy} onChange={e => setName(e.target.value)} />
      <label className="video-keep"><input type="checkbox" checked={keepVideo} disabled={busy} onChange={e => setKeepVideo(e.target.checked)} /><span>Keep the original video<small>Otherwise it is deleted once your scene is ready. Share links never include it.</small></span></label>
    </>}
    {error && <div className="notice error" role="alert"><AlertCircle size={16} />{error}</div>}
    <button className="primary" disabled={busy || submitted || disabled || !ready} onClick={() => void start()}>{busy || submitted ? <><LoaderCircle size={16} className="spin" /> {resume?.uploaded || submitted ? "Starting" : `Uploading video · ${progress}%`}</> : <><Box size={17} />{resume ? "Resume & create splat" : "Create 3D splat"}<ArrowRight size={17} /></>}</button>
    {busy && !resume?.uploaded && <progress value={progress} max={100} aria-label="Video upload progress" />}
    <p className="sr-only" aria-live="polite">{busy ? `Uploading video, ${Math.floor(progress / 25) * 25}%` : ""}</p>
    {!resume && <button type="button" className="text-button video-switch" disabled={busy} onClick={onCancel}>Use photos instead <ArrowRight size={15} /></button>}
    <p className="privacy-note"><LockKeyhole size={12} /> Your captures stay private.</p>
  </div>;
}
