"use client";
/* Local object URLs must stay in the browser; Next image optimization cannot access them. */
/* eslint-disable @next/next/no-img-element */
import { type FormEvent /* S7 */, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ArrowUpRight, ArrowRight, Plus, Scan, Images, X, Check, ChevronRight, CircleHelp, Box, LoaderCircle, Cloud, LockKeyhole, RotateCcw, Download, Camera, Footprints, Sun, Layers, AlertCircle, Pencil, Trash2 /* S7 */ } from "lucide-react";
import SplatViewer, { type SceneSource } from "./SplatViewer";
import { type Capture, stages, statusLabels } from "../lib/types";
import { MAX_IMAGE_BYTES, MAX_IMAGES, MAX_TOTAL_BYTES, MIN_IMAGES, MAX_NAME_LENGTH, validateName /* S7 */ } from "../lib/validation";
import { createPoller, hasActiveCapture, latestOnly, pollSignature, putWithRetry, runPool, UPLOAD_CONCURRENCY } from "../lib/client";
import PrepWarnings from "./PrepWarnings"; // S6 capture prep
import { useCapturePrep } from "./useCapturePrep"; // S6 capture prep
import { useDropGuard } from "./useDropGuard"; // S6 capture prep
import SharePanel from "./SharePanel"; // S8 share links
import CameraEntry from "./CameraEntry"; // S9 phone camera
import VideoUpload from "./VideoUpload"; // S10 video captures

const sample: SceneSource = { url: "https://sparkjs.dev/assets/splats/butterfly.spz", name: "The butterfly", sample: true };
type Selected = { file: File; url: string };
type ManifestImage = { id: string; name: string; bytes: number; mime: string; uploaded?: number };
const formatBytes = (n: number) => n < 1024 * 1024 ? `${Math.round(n / 1024)} KB` : `${(n / 1024 / 1024).toFixed(1)} MB`;
async function api<T = unknown>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`/api/${path}`, init);
  const data = await response.json().catch(() => ({ error: "The server could not be reached. Please try again." })) as T & { error?: string };
  if (!response.ok) throw Object.assign(new Error(data.error ?? "Request failed."), { status: response.status }); // S7: status, so a delete can treat 404 as done
  return data;
}
export default function Studio() {
  const [tab, setTab] = useState<"studio" | "library">("studio");
  const [guide, setGuide] = useState(false);
  const [files, setFiles] = useState<Selected[]>([]);
  const filesRef = useRef<Selected[]>([]);
  const [name, setName] = useState("");
  const [dragging, setDragging] = useState(false);
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState(0);
  const [error, setError] = useState("");
  const [serverError, setServerError] = useState("");
  const [captures, setCaptures] = useState<Capture[]>([]);
  const [processor, setProcessor] = useState(false);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [resume, setResume] = useState<{ id: string; images: ManifestImage[] } | null>(null);
  const [source, setSource] = useState<SceneSource>(sample);
  const [videoMode, setVideoMode] = useState(false); // S10
  const prep = useCapturePrep(files); // S6 capture prep: HEIC conversion + warn-only checks
  useDropGuard(busy || prep.converting, () => { setDragging(false); if (prep.converting) setError("Wait for the photos being added to finish."); }); // S6: no navigating away on a drop while the dropzone is disabled
  const fileInput = useRef<HTMLInputElement>(null);
  const splatInput = useRef<HTMLInputElement>(null);
  const guideRef = useRef<HTMLDialogElement>(null);
  const active = captures.find(c => c.id === activeId);
  const totalBytes = files.reduce((sum, item) => sum + item.file.size, 0);
  const wake = useRef<() => void>(() => {});
  const uploadAbort = useRef<AbortController | null>(null);
  const order = useRef(latestOnly());
  const shown = useRef("");
  // S7: a poll that started before a delete or rename finished must not bring back the row or the old name.
  const deletedIds = useRef(new Set<string>());
  const renamed = useRef(new Map<string, { name: string; at: number }>());
  // Every read of server state is numbered, so a slow response can never overwrite a newer one; and an
  // unchanged state skips the re-render (polls repeat every few seconds while a capture is in flight).
  const refresh = useCallback(async () => {
    const n = order.current.begin();
    const started = performance.now(); // S7
    try {
      const [list, health] = await Promise.all([api<{ captures: Capture[] }>("captures"), api<{ processor: boolean }>("health")]);
      // S7: drop rows this tab deleted; keep a confirmed new name until a poll that began after the rename answers.
      const captures = list.captures.filter(c => !deletedIds.current.has(c.id)).map(c => {
        const pending = renamed.current.get(c.id);
        if (!pending) return c;
        if (started > pending.at) { renamed.current.delete(c.id); return c; }
        return { ...c, name: pending.name };
      });
      const signature = pollSignature(captures, health.processor);
      if (order.current.accept(n)) {
        if (signature !== shown.current) { shown.current = signature; setCaptures(captures); setProcessor(health.processor); }
        setServerError("");
      }
      return { signature, active: hasActiveCapture(captures) };
    } catch (e) {
      if (order.current.accept(n)) setServerError((e as Error).message);
      return { signature: `error:${(e as Error).message}`, active: true }; // keep checking until the server answers
    }
  }, []);
  // Adaptive polling (lib/client.ts createPoller): fast after a change, backing off while nothing changes,
  // once a minute while idle (the processor indicator), never while the tab is hidden. `wake` (user
  // actions, the tab becoming visible) polls at once; during an in-flight poll it queues a fresh one.
  useEffect(() => {
    const poller = createPoller(refresh, { hidden: () => document.hidden });
    wake.current = () => { void poller.wake(); };
    const onVisible = () => { if (!document.hidden) wake.current(); };
    document.addEventListener("visibilitychange", onVisible);
    wake.current();
    return () => { poller.stop(); document.removeEventListener("visibilitychange", onVisible); wake.current = () => {}; };
  }, [refresh]);
  useEffect(() => () => uploadAbort.current?.abort(new DOMException("Upload cancelled.", "AbortError")), []);
  useEffect(() => { filesRef.current = files; }, [files]);
  useEffect(() => () => filesRef.current.forEach(item => URL.revokeObjectURL(item.url)), []);
  useEffect(() => { if (guide) guideRef.current?.showModal(); else guideRef.current?.close(); }, [guide]);
  const activeStatus = active?.status;
  const activeName = active?.name;
  const readyId = active?.id;
  const readyAt = active?.ready_at;
  const hasSpz = !!active?.spz_bytes;
  // The scene route serves the compact SPZ when the worker delivered one (else the PLY); `v` names the
  // published version, so the browser may cache it as immutable. If an SPZ will not decode, the viewer
  // falls back to the PLY archive.
  const displaySource = useMemo<SceneSource>(() => activeStatus === "ready" ? {
    name: activeName!, url: `/api/captures/${readyId}/scene?v=${readyAt}`,
    fallbackUrl: hasSpz ? `/api/captures/${readyId}/result.ply` : undefined,
  } : source, [readyId, readyAt, activeStatus, activeName, hasSpz, source]);
  useEffect(() => {
    const prevent = (e: BeforeUnloadEvent) => { e.preventDefault(); };
    if (busy) window.addEventListener("beforeunload", prevent);
    return () => window.removeEventListener("beforeunload", prevent);
  }, [busy]);

  async function addFiles(incoming: FileList | File[]) {
    // ── S6 capture prep (review H1/H2/L6): one add at a time, cancellable by Clear; HEIC/HEIF →
    // JPEG in a worker before validation (the server takes JPG/PNG only). The live selection is
    // re-read from filesRef after every await, so concurrent removes/clears are never undone.
    if (busy) return;
    const ticket = prep.beginAdd();
    if (!ticket) { setError("Wait for the photos being added to finish."); return; }
    try {
      incoming = await prep.convertHeic(Array.from(incoming), { signal: ticket.signal, slots: MAX_IMAGES - filesRef.current.length });
      if (ticket.signal.aborted) return;
      const keyOf = (file: File) => `${file.name}:${file.size}`;
      const accepted: Selected[] = []; const errors: string[] = [];
      for (const file of Array.from(incoming)) {
        const live = [...filesRef.current, ...accepted], key = keyOf(file);
        if (live.some(x => keyOf(x.file) === key)) continue;
        if (live.length >= MAX_IMAGES || live.reduce((sum, x) => sum + x.file.size, 0) + file.size > MAX_TOTAL_BYTES) { errors.push("Limit: 200 photos and 1 GB per capture."); break; }
        if (!["image/jpeg", "image/png"].includes(file.type)) { errors.push("Only JPG, PNG and HEIC photos are supported."); continue; }
        if (file.size > MAX_IMAGE_BYTES || file.size === 0) { errors.push("Each photo must be between 1 byte and 20 MB."); continue; }
        let readable = true;
        try { const bitmap = await createImageBitmap(file); bitmap.close(); } catch { readable = false; }
        if (ticket.signal.aborted) break; // S6 review item 2: Clear won while this photo was read
        if (!readable) { errors.push(`Could not read ${file.name}. Choose a valid image.`); continue; }
        accepted.push({ file, url: URL.createObjectURL(file) });
      }
      if (ticket.signal.aborted) { accepted.forEach(item => URL.revokeObjectURL(item.url)); return; }
      // Dedupe again against the state React actually holds (covers anything added since the last read).
      setFiles(current => { const have = new Set(current.map(x => keyOf(x.file))); return [...current, ...accepted.filter(x => !have.has(keyOf(x.file)))]; });
      setError([...new Set(errors)].join(" "));
    } finally { ticket.end(); }
    // ── end S6
  }
  function clear() {
    // Leaving an upload cancels it: its requests, retries and waits stop, and it changes no more state.
    // Photos already stored stay; reopening the capture from the library resumes it.
    uploadAbort.current?.abort(new DOMException("Upload cancelled.", "AbortError")); uploadAbort.current = null;
    prep.reset(); // S6: cancel conversions/checks in flight
    files.forEach(item => URL.revokeObjectURL(item.url));
    setFiles([]); setName(""); setError(""); setResume(null); setActiveId(null); setProgress(0); setBusy(false); setVideoMode(false);
  }
  async function upload() {
    if (!name.trim() || files.length < MIN_IMAGES || busy) return;
    const controller = new AbortController();
    const { signal } = controller;
    uploadAbort.current = controller;
    setBusy(true); setError(""); setProgress(0);
    try {
      const manifest = resume ?? await api<{ id: string; images: ManifestImage[] }>("captures", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name, images: files.map(({ file }) => ({ name: file.name, bytes: file.size, mime: file.type })) }), signal });
      signal.throwIfAborted();
      setResume(manifest); setActiveId(manifest.id);
      const latest = await api<{ images: ManifestImage[] }>(`captures/${manifest.id}`, { signal });
      signal.throwIfAborted();
      // Progress counts bytes of photos the server has confirmed, so it never runs ahead of storage.
      const total = latest.images.reduce((sum, image) => sum + image.bytes, 0) || 1;
      let done = latest.images.reduce((sum, image) => sum + (image.uploaded ? image.bytes : 0), 0);
      setProgress(Math.round(done / total * 100));
      const pending = latest.images.filter(image => !image.uploaded).map(image => {
        const selected = files.find(({ file }) => file.name === image.name && file.size === image.bytes);
        if (!selected) throw new Error(`Reselect the original photo: ${image.name}`);
        return { image, file: selected.file };
      });
      await runPool(pending, UPLOAD_CONCURRENCY, async ({ image, file }) => {
        await putWithRetry(`/api/captures/${manifest.id}/images/${image.id}`, file, image.mime, { signal, label: image.name });
        signal.throwIfAborted();
        done += image.bytes; setProgress(Math.round(done / total * 100));
      }, signal);
      await api(`captures/${manifest.id}/submit`, { method: "POST", signal });
      signal.throwIfAborted();
      wake.current();
      files.forEach(item => URL.revokeObjectURL(item.url)); setFiles([]); setResume(null);
    } catch (e) {
      if (signal.aborted) return; // cancelled by the user (clear) or by unmounting: nothing to report
      setError((e as Error).message); wake.current();
    } finally {
      if (uploadAbort.current === controller) { uploadAbort.current = null; setBusy(false); }
    }
  }
  async function openCapture(capture: Capture) {
    clear(); setActiveId(capture.id); setTab("studio"); wake.current();
    if (capture.status === "uploading" && capture.source_kind !== "video") { // S10: a video capture resumes in VideoUpload
      try { const detail = await api<{ images: ManifestImage[] }>(`captures/${capture.id}`); setResume({ id: capture.id, images: detail.images }); setName(capture.name); }
      catch (e) { setError((e as Error).message); }
    }
  }
  async function retry() {
    if (!active) return; setBusy(true); setError("");
    try { await api(`captures/${active.id}/submit`, { method: "POST" }); wake.current(); }
    catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  }
  // ── S7 rename/delete (spec §7.10). Both wait while a capture is processed (aligning, training and
  // exporting hold a worker lease, and the server refuses a delete then) and while this tab uploads it.
  const [manage, setManage] = useState<{ kind: "rename" | "delete"; capture: Capture } | null>(null);
  const [manageName, setManageName] = useState("");
  const [manageError, setManageError] = useState("");
  const [managing, setManaging] = useState(false);
  const [manageNotice, setManageNotice] = useState("");
  const manageRef = useRef<HTMLDialogElement>(null);
  const manageInput = useRef<HTMLInputElement>(null);
  const manageCancel = useRef<HTMLButtonElement>(null);
  const manageReturn = useRef<HTMLElement | null>(null);
  const libraryHeading = useRef<HTMLHeadingElement>(null);
  const backdropDown = useRef(false);
  useEffect(() => {
    const dialog = manageRef.current;
    if (!dialog) return;
    if (!manage) { if (dialog.open) dialog.close(); return; }
    if (!dialog.open) dialog.showModal();
    if (manage.kind === "rename") { manageInput.current?.focus(); manageInput.current?.select(); }
    else manageCancel.current?.focus(); // the safe choice is the default one
  }, [manage]);
  const lockReason = (c: Capture) => ["aligning", "training", "exporting"].includes(c.status) ? "Available once processing finishes"
    : busy && c.id === activeId ? "Available once the upload finishes" : "";
  function openManage(kind: "rename" | "delete", capture: Capture, trigger: HTMLElement) {
    if (lockReason(capture)) return;
    manageReturn.current = trigger;
    setManageName(capture.name); setManageError(""); setManageNotice(""); setManage({ kind, capture });
  }
  function closeManage() {
    if (managing) return;
    setManage(null); setManageError("");
    // Back to the button that opened the dialog, or to the list heading when its row is gone.
    requestAnimationFrame(() => { const back = manageReturn.current; (back?.isConnected ? back : libraryHeading.current)?.focus(); });
  }
  async function submitRename(e: FormEvent) {
    e.preventDefault();
    if (!manage || managing) return;
    let next: string;
    try { next = validateName(manageName); } catch (err) { setManageError((err as Error).message); manageInput.current?.focus(); return; }
    const { id } = manage.capture;
    setManaging(true); setManageError("");
    try {
      const { capture } = await api<{ capture: Capture }>(`captures/${id}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name: next }) });
      renamed.current.set(id, { name: capture.name, at: performance.now() });
      setCaptures(current => current.map(c => c.id === id ? { ...c, name: capture.name } : c));
      if (resume?.id === id) setName(capture.name);
      setManageNotice(`Renamed to “${capture.name}”.`);
      setManaging(false); setManage(null);
      requestAnimationFrame(() => manageReturn.current?.focus());
      wake.current();
    } catch (err) {
      setManageError((err as Error).message); setManageNotice(`Could not rename: ${(err as Error).message}`);
      setManaging(false); wake.current(); // the capture may have changed meanwhile (for example, processing began)
    }
  }
  async function confirmDelete() {
    if (!manage || managing) return;
    const { id, name: deletedName } = manage.capture;
    setManaging(true); setManageError("");
    try {
      // 200 when everything is gone; 202 when the cron finishes a large capture. Either way it is gone for the owner.
      // A 404 means it is already gone (another tab, or a retry after a lost response), which is the same outcome.
      try { await api(`captures/${id}`, { method: "DELETE" }); }
      catch (err) { if ((err as { status?: number }).status !== 404) throw err; }
      deletedIds.current.add(id);
      if (activeId === id) clear();
      setCaptures(current => current.filter(c => c.id !== id));
      setManageNotice(`Deleted “${deletedName}”.`);
      setManaging(false); setManage(null);
      requestAnimationFrame(() => libraryHeading.current?.focus());
      wake.current();
    } catch (err) {
      setManageError((err as Error).message); setManageNotice(`Could not delete: ${(err as Error).message}`);
      setManaging(false); wake.current();
    }
  }
  // The browser may close a modal dialog on a repeated Escape even when cancel is prevented. While a request
  // runs, reopen it so its outcome stays visible; otherwise treat the close as a cancel and sync the state.
  function onManageClose() {
    if (!manage) return;
    if (managing) { manageRef.current?.showModal(); (manage.kind === "rename" ? manageInput : manageCancel).current?.focus(); }
    else closeManage();
  }
  // ── end S7
  const processing = active && active.status !== "uploading" && !busy;
  const videoResume = active?.status === "uploading" && active.source_kind === "video" ? active : undefined; // S10
  const sourceLabel = (c: Capture) => c.source_kind === "video" ? "Video" : `${c.image_count} photos`; // S10
  return <>
    <header className="header">
      <button className="brand" onClick={() => setTab("studio")} aria-label="Spatial Camera home"><span className="brand-mark"><Scan size={22} /></span><span>spatial<span className="brand-light">camera</span></span><span className="beta">LAB</span></button>
      <nav aria-label="Main navigation"><button className={tab === "studio" ? "nav-active" : ""} onClick={() => setTab("studio")}>Studio</button><button className={tab === "library" ? "nav-active" : ""} onClick={() => setTab("library")}>My captures {captures.length > 0 && <span className="nav-count">{captures.length}</span>}</button></nav>
      <button className="guide-link" onClick={() => setGuide(true)}><CircleHelp size={16} /><span>Capture guide</span><ArrowUpRight size={14} /></button>
    </header>
    <main>
      <section className="intro"><div><div className="eyebrow"><span className="orange-dot" /> FROM PHOTOGRAPHS TO PRESENCE</div><h1>{tab === "studio" ? <>Places worth <em>keeping.</em></> : <>Your little <em>worlds.</em></>}</h1></div><p>{tab === "studio" ? <>Turn a set of photos into a world you can explore.<br />Capture the details. Keep the feeling.</> : <>Every capture, in one place.<br />Return whenever you like.</>}</p></section>
      {serverError && <div className="notice error" role="alert"><AlertCircle size={16} />{serverError}<button onClick={() => wake.current()}>Try again</button></div>}
      {tab === "studio" ? <div className="studio-grid">
        <section className="capture-panel" aria-label="Create a capture">
          <div className="panel-heading"><span className="step-number">01</span><h2>{processing ? "Your capture" : resume || videoResume ? "Resume your upload" : videoMode ? "Start with a video" : "Start with your photos"}</h2>{(files.length > 0 || active) && !busy && <button className="icon-button" aria-label="Start a new capture" title="Start a new capture" onClick={clear}><Plus size={18} /></button>}</div>
          {processing ? <div className="job-panel">
            <div className={`job-symbol ${active.status === "ready" ? "success" : ""}`}>{active.status === "ready" ? <Check size={28} /> : active.status === "failed" ? <AlertCircle size={28} /> : <Layers size={28} />}</div>
            <h3>{active.name}</h3><p>{sourceLabel(active)} · {statusLabels[active.status]}</p>
            {active.status === "failed" ? <div className="notice error">{active.error}</div> : <ol className="stage-list">{stages.map((stage, i) => {
              const current = stages.indexOf(active.status as typeof stages[number]);
              return <li key={stage} className={i < current ? "complete" : i === current ? "current" : ""}><span>{i < current || active.status === "ready" ? <Check size={12} /> : i + 1}</span><div>{statusLabels[stage]}{stage === "queued" && current === 0 && <small>{processor ? "Your capture is in the queue." : "Photos saved. Processing begins when a GPU worker connects."}</small>}</div></li>;
            })}</ol>}
            {error && <div className="notice error" role="alert">{error}</div>}
            {active.status === "failed" && <button className="primary" onClick={retry}><RotateCcw size={16} /> Retry reconstruction</button>}
            {active.status === "ready" && <a className="primary" href={`/api/captures/${active.id}/result.ply?download`}><Download size={16} /> Download PLY{active.result_bytes ? ` · ${formatBytes(active.result_bytes)}` : ""}</a>}
            {active.status === "ready" && active.spz_bytes ? <p className="privacy-note">The viewer streams a {formatBytes(active.spz_bytes)} SPZ; the PLY is the full-precision archive.</p> : null}
            {active.status === "ready" && <SharePanel key={active.id} captureId={active.id} name={active.name} /> /* S8 share links */}
            <button className="text-button" onClick={clear}>Start another capture <ArrowRight size={15} /></button>
          </div> : videoMode || videoResume ? <VideoUpload key={videoResume?.id ?? "new"} disabled={!!serverError} resume={videoResume && { id: videoResume.id, name: videoResume.name, bytes: videoResume.video_bytes ?? null, uploaded: !!videoResume.video_uploaded }} onCreated={id => { setActiveId(id); wake.current(); }} onSubmitted={id => { setActiveId(id); setVideoMode(false); wake.current(); }} onCancel={() => setVideoMode(false)} /> /* S10 */ : <>
            <p className="panel-description">One place, from different angles.<br />We’ll put the pieces together.</p>
            {resume && <div className="notice">Reselect the original photos. Uploaded files will be skipped.</div>}
            <input ref={fileInput} type="file" accept="image/jpeg,image/png,image/heic,image/heif,.heic,.heif" multiple className="sr-only" aria-label="Choose capture photos" disabled={busy || prep.converting /* S6 */} onChange={e => { if (e.target.files) void addFiles(e.target.files); e.target.value = ""; }} />
            <button disabled={busy || prep.converting /* S6 */} className={`dropzone ${dragging ? "dragging" : ""} ${files.length ? "compact" : ""}`} onClick={() => fileInput.current?.click()} onDragOver={e => { e.preventDefault(); setDragging(true); }} onDragLeave={() => setDragging(false)} onDrop={e => { e.preventDefault(); setDragging(false); void addFiles(e.dataTransfer.files); }}><span className="photo-stack"><Images size={29} strokeWidth={1.3} /></span><strong>{files.length ? "Add more photos" : "Drop your photos here"}</strong><span>or <u>browse files</u></span><small>JPG, PNG or HEIC · 12–200 photos · Up to 20 MB each</small></button>
            <CameraEntry selection={files.map(item => item.file)} disabled={busy || prep.converting || !!resume} onAdd={addFiles} />{/* S9 phone camera */}
            {files.length > 0 && <div className="selected-files"><div className="file-summary"><span>{files.length} photos <span>· {formatBytes(totalBytes)}</span></span><button disabled={busy} onClick={() => { prep.reset() /* S6 */; files.forEach(item => URL.revokeObjectURL(item.url)); setFiles([]); }}>Clear</button></div><div className="thumbnails">{files.slice(0, 8).map((item, i) => <div key={item.url}><img src={item.url} alt={item.file.name} /><button aria-label={`Remove ${item.file.name}`} disabled={busy || !!resume} onClick={() => { URL.revokeObjectURL(item.url); setFiles(current => current.filter(x => x !== item)) /* S6: functional, so a concurrent add is kept */; }}><X size={11} /></button>{i === 7 && files.length > 8 && <span className="extra-count">+{files.length - 8}</span>}</div>)}</div>{files.length < MIN_IMAGES && <small className="validation-hint">Add {MIN_IMAGES - files.length} more photos to get started.</small>}</div>}
            {/* S6 capture prep: conversion progress + warn-only checks */}
            <PrepWarnings prep={prep} files={files} minImages={MIN_IMAGES} disabled={busy || !!resume} onRemove={remove => { const gone = new Set(remove); files.forEach(item => { if (gone.has(item.file)) URL.revokeObjectURL(item.url); }); setFiles(current => current.filter(item => !gone.has(item.file))); }} />
            <label className="field-label" htmlFor="capture-name">Name your capture <span>Something to remember it by</span></label><input id="capture-name" className="name-input" placeholder="e.g. A quiet corner of home" maxLength={80} value={name} disabled={busy || !!resume} onChange={e => setName(e.target.value)} />
            {error && <div className="notice error" role="alert"><AlertCircle size={16} />{error}</div>}
            <button className="primary" disabled={busy || prep.converting || files.length < MIN_IMAGES || !name.trim() || !!serverError} onClick={upload}>{busy ? <><LoaderCircle size={16} className="spin" /> Uploading photos · {progress}%</> : <><Box size={17} />{resume ? "Resume & create splat" : "Create 3D splat"}<ArrowRight size={17} /></>}</button>
            {busy && <progress value={progress} max={100} aria-label="Upload progress" />}
            <p className="sr-only" aria-live="polite">{busy ? `Uploading photos, ${Math.floor(progress / 25) * 25}%` : ""}</p><p className="privacy-note"><LockKeyhole size={12} /> Your captures stay private.</p>
            {!files.length && !resume && !busy && <button className="text-button video-switch" onClick={() => setVideoMode(true)}>Or upload one video instead <ArrowRight size={15} /></button> /* S10 */}
          </>}
          <div className="processor-note"><span className={`status-dot ${processor ? "online" : ""}`} /><div>{processor ? "Processor connected" : "Processor not connected"}<small>{processor ? "Captures are processed on the server." : "You can save photos now and process them later."}</small></div></div>
        </section>
        <section className="preview-panel" aria-label="3D scene preview"><SplatViewer source={displaySource} /><div className="preview-caption"><div><span className="step-number">02</span><span>{displaySource.sample ? "A photograph you can move around." : "A new way to revisit your capture."}</span></div><button className="text-button" onClick={() => splatInput.current?.click()}>Open a splat <ArrowUpRight size={15} /></button></div>
          <input ref={splatInput} type="file" accept=".ply,.spz,.splat,.ksplat" className="sr-only" aria-label="Open an existing splat" onChange={e => { const file = e.target.files?.[0]; if (file) { if (file.size > 100 * 1024 * 1024) setError("Choose a splat smaller than 100 MB for this prototype."); else { setActiveId(null); setSource({ file, name: file.name.replace(/\.[^.]+$/, "") }); setError(""); } } e.target.value = ""; }} />
          <div className="capture-tip"><span className="tip-icon"><Footprints size={20} strokeWidth={1.4} /></span><div><strong>A little movement makes all the difference.</strong><p>Walk around your subject. Keep photos sharp, overlapping, and taken in consistent light.</p></div><button aria-label="Read capture tips" onClick={() => setGuide(true)}><ArrowUpRight size={19} /></button></div>
        </section>
      </div> : <section className="library"><div className="library-heading"><h2 ref={libraryHeading} tabIndex={-1} /* S7: focus lands here after a delete */>{captures.length} {captures.length === 1 ? "capture" : "captures"}</h2><button className="primary small" onClick={() => { clear(); setTab("studio"); }}><Plus size={16} /> New capture</button></div>
        <p className="sr-only" role="status">{manageNotice /* S7 */}</p>
        {captures.length === 0 ? <div className="empty-library"><Scan size={36} strokeWidth={1} /><h3>Your first world starts here.</h3><p>Capture a favorite place. We’ll keep it here for you.</p><button className="text-button" onClick={() => setTab("studio")}>Create your first capture <ArrowRight size={16} /></button></div> : <div className="capture-list">{captures.map(c => {
          const locked = lockReason(c); // S7
          return <div key={c.id} className="capture-item" /* S7: the row plus its rename/delete actions */>
            <button className="capture-row" onClick={() => void openCapture(c)}><span className={`capture-icon ${c.status === "ready" ? "ready" : ""}`}><Box size={23} strokeWidth={1.4} /></span><span className="capture-info"><strong>{c.name}</strong><small>{sourceLabel(c)} · {new Date(c.created_at).toLocaleDateString(undefined, { month: "short", day: "numeric" })}</small></span><span className={`status-pill ${c.status}`}>{statusLabels[c.status]}</span><ChevronRight size={17} /></button>
            {/* S7: aria-disabled rather than disabled keeps the buttons focusable, so the reason is announced. */}
            <div className="capture-actions">
              {locked && <small id={`lock-${c.id}`} className="capture-lock">{locked}</small>}
              <button className="icon-button" aria-label={`Rename ${c.name}`} title={locked || "Rename"} aria-disabled={locked ? true : undefined} aria-describedby={locked ? `lock-${c.id}` : undefined} onClick={e => openManage("rename", c, e.currentTarget)}><Pencil size={15} /></button>
              <button className="icon-button delete-button" aria-label={`Delete ${c.name}`} title={locked || "Delete"} aria-disabled={locked ? true : undefined} aria-describedby={locked ? `lock-${c.id}` : undefined} onClick={e => openManage("delete", c, e.currentTarget)}><Trash2 size={15} /></button>
            </div>
          </div>;
        })}</div>}</section>}
      <footer><span><Scan size={14} /> CAPTURE SOMETHING REAL.</span><span>Photos in. A little world out.<span className="footer-dot">·</span>Spatial Camera Lab<span className="footer-dot">·</span><a href="/third-party-notices.txt">Open-source notices</a>{/* S6: LGPL notice for the HEIC decoder */}</span></footer>
    </main>
    <dialog ref={guideRef} onCancel={() => setGuide(false)} onClick={e => { if (e.target === e.currentTarget) setGuide(false); }}><div className="guide"><button className="dialog-close icon-button" aria-label="Close capture guide" onClick={() => setGuide(false)}><X size={20} /></button><div className="eyebrow">A BETTER CAPTURE, A BETTER WORLD</div><h2>Take the long way <em>around.</em></h2><p>A good splat starts with photos that tell the whole story.</p><div className="guide-steps">{[
      { icon: Footprints, title: "Move around, not just left and right.", text: "Walk an arc around an object or slowly through a small space. Changing your position reveals depth; rotating from one spot does not." },
      { icon: Camera, title: "Give each photo a familiar neighbor.", text: "Aim for 60–80% overlap. Start with 30–80 sharp photos. Include different heights and keep your subject in frame." },
      { icon: Sun, title: "Keep the world still.", text: "Use even light. Avoid people moving through the scene, mirrors, glass, and featureless walls. Keep zoom and exposure consistent." },
      { icon: Cloud, title: "Upload once. Come back to explore.", text: "Photos are stored privately. A connected GPU worker estimates camera positions and trains your splat. Timing depends on scene size and hardware." },
    ].map(({ icon: Icon, title, text }) => <div key={title}><span><Icon size={21} /></span><section><h3>{title}</h3><p>{text}</p></section></div>)}</div><div className="notice">Time-lapse capture works when you move between photos. For a place changing over days, create a separate capture for each visit.</div><button className="primary" onClick={() => setGuide(false)}>Ready to capture <ArrowRight size={16} /></button></div></dialog>
    {/* ── S7 rename/delete dialog: Esc or a click on the backdrop cancels (not while a request runs). */}
    <dialog ref={manageRef} className="manage-dialog" aria-labelledby="manage-title" aria-describedby={manage?.kind === "delete" ? "manage-description" : undefined} onCancel={e => { e.preventDefault(); closeManage(); }} onClose={onManageClose}
      onPointerDown={e => { backdropDown.current = e.target === e.currentTarget; }}
      onClick={e => { const fromBackdrop = backdropDown.current; backdropDown.current = false; if (fromBackdrop && e.target === e.currentTarget) closeManage(); /* a drag from the input that ends on the backdrop is not a cancel */ }}>
      {manage && <div className="manage">
        {manage.kind === "rename" ? <form onSubmit={submitRename} noValidate>
          <h2 id="manage-title">Rename capture</h2>
          <label className="field-label" htmlFor="manage-name">Name <span>Up to {MAX_NAME_LENGTH} characters</span></label>
          <input ref={manageInput} id="manage-name" className="name-input" maxLength={MAX_NAME_LENGTH} value={manageName} readOnly={managing} aria-invalid={manageError ? true : undefined} aria-describedby={manageError ? "manage-error" : undefined} onChange={e => setManageName(e.target.value)} />
          {manageError && <div id="manage-error" className="notice error" role="alert"><AlertCircle size={16} />{manageError}</div>}
          <div className="manage-actions"><button type="button" className="secondary-button" onClick={closeManage}>Cancel</button><button type="submit" className="primary" aria-busy={managing || undefined}>{managing ? <><LoaderCircle size={16} className="spin" /> Saving</> : "Save name"}</button></div>
        </form> : <>
          <h2 id="manage-title">Delete “{manage.capture.name}”?</h2>
          <p id="manage-description">Its {manage.capture.source_kind === "video" ? "video" : `${manage.capture.image_count} photos`} and its 3D scene will be permanently deleted. This cannot be undone.</p>
          {manageError && <div className="notice error" role="alert"><AlertCircle size={16} />{manageError}</div>}
          <div className="manage-actions"><button ref={manageCancel} type="button" className="secondary-button" onClick={closeManage}>Cancel</button><button type="button" className="primary danger" aria-busy={managing || undefined} onClick={() => void confirmDelete()}>{managing ? <><LoaderCircle size={16} className="spin" /> Deleting</> : <><Trash2 size={16} /> Delete permanently</>}</button></div>
        </>}
      </div>}
    </dialog>
    {/* ── end S7 */}
  </>;
}
