"use client";
/* Local object URLs must stay in the browser; Next image optimization cannot access them. */
/* eslint-disable @next/next/no-img-element */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ArrowUpRight, ArrowRight, Plus, Scan, Images, X, Check, ChevronRight, CircleHelp, Box, LoaderCircle, Cloud, LockKeyhole, RotateCcw, Download, Camera, Footprints, Sun, Layers, AlertCircle } from "lucide-react";
import SplatViewer, { type SceneSource } from "./SplatViewer";
import { type Capture, stages, statusLabels } from "../lib/types";
import { MAX_IMAGE_BYTES, MAX_IMAGES, MAX_TOTAL_BYTES, MIN_IMAGES } from "../lib/validation";

const sample: SceneSource = { url: "https://sparkjs.dev/assets/splats/butterfly.spz", name: "The butterfly", sample: true };
type Selected = { file: File; url: string };
type ManifestImage = { id: string; name: string; bytes: number; mime: string; uploaded?: number };
const formatBytes = (n: number) => n < 1024 * 1024 ? `${Math.round(n / 1024)} KB` : `${(n / 1024 / 1024).toFixed(1)} MB`;
async function api<T = unknown>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`/api/${path}`, init);
  const data = await response.json().catch(() => ({ error: "The server could not be reached. Please try again." })) as T & { error?: string };
  if (!response.ok) throw new Error(data.error ?? "Request failed.");
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
  const fileInput = useRef<HTMLInputElement>(null);
  const splatInput = useRef<HTMLInputElement>(null);
  const guideRef = useRef<HTMLDialogElement>(null);
  const active = captures.find(c => c.id === activeId);
  const totalBytes = files.reduce((sum, item) => sum + item.file.size, 0);
  const refresh = useCallback(async () => {
    try {
      const [list, health] = await Promise.all([api<{ captures: Capture[] }>("captures"), api<{ processor: boolean }>("health")]);
      setCaptures(list.captures); setProcessor(health.processor); setServerError("");
    } catch (e) { setServerError((e as Error).message); }
  }, []);
  // Initial asynchronous fetch and subsequent polling synchronize server-owned state.
  // eslint-disable-next-line react-hooks/set-state-in-effect
  useEffect(() => { refresh(); const timer = setInterval(refresh, 5000); return () => clearInterval(timer); }, [refresh]);
  useEffect(() => { filesRef.current = files; }, [files]);
  useEffect(() => () => filesRef.current.forEach(item => URL.revokeObjectURL(item.url)), []);
  useEffect(() => { if (guide) guideRef.current?.showModal(); else guideRef.current?.close(); }, [guide]);
  const activeStatus = active?.status;
  const activeName = active?.name;
  const readyId = active?.id;
  const displaySource = useMemo(() => activeStatus === "ready" ? { name: activeName!, url: `/api/captures/${readyId}/result.ply` } : source, [readyId, activeStatus, activeName, source]);
  useEffect(() => {
    const prevent = (e: BeforeUnloadEvent) => { e.preventDefault(); };
    if (busy) window.addEventListener("beforeunload", prevent);
    return () => window.removeEventListener("beforeunload", prevent);
  }, [busy]);

  async function addFiles(incoming: FileList | File[]) {
    if (busy) return;
    const accepted: Selected[] = []; const errors: string[] = []; let bytes = totalBytes;
    const existing = new Set(files.map(x => `${x.file.name}:${x.file.size}`));
    for (const file of Array.from(incoming)) {
      const key = `${file.name}:${file.size}`;
      if (existing.has(key)) continue;
      if (!["image/jpeg", "image/png"].includes(file.type)) { errors.push("Only JPG and PNG photos are supported. Convert HEIC first."); continue; }
      if (file.size > MAX_IMAGE_BYTES || file.size === 0) { errors.push("Each photo must be between 1 byte and 20 MB."); continue; }
      if (files.length + accepted.length >= MAX_IMAGES || bytes + file.size > MAX_TOTAL_BYTES) { errors.push("Limit: 200 photos and 1 GB per capture."); break; }
      try { const bitmap = await createImageBitmap(file); bitmap.close(); }
      catch { errors.push(`Could not read ${file.name}. Choose a valid image.`); continue; }
      accepted.push({ file, url: URL.createObjectURL(file) }); bytes += file.size; existing.add(key);
    }
    setFiles(current => [...current, ...accepted]); setError([...new Set(errors)].join(" "));
  }
  function clear() {
    files.forEach(item => URL.revokeObjectURL(item.url));
    setFiles([]); setName(""); setError(""); setResume(null); setActiveId(null); setProgress(0);
  }
  async function upload() {
    if (!name.trim() || files.length < MIN_IMAGES || busy) return;
    setBusy(true); setError(""); setProgress(0);
    try {
      const manifest = resume ?? await api<{ id: string; images: ManifestImage[] }>("captures", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name, images: files.map(({ file }) => ({ name: file.name, bytes: file.size, mime: file.type })) }) });
      setResume(manifest); setActiveId(manifest.id);
      const latest = await api<{ images: ManifestImage[] }>(`captures/${manifest.id}`);
      let done = latest.images.filter((image: ManifestImage) => image.uploaded).length;
      setProgress(Math.round(done / manifest.images.length * 100));
      for (const image of latest.images as ManifestImage[]) {
        if (image.uploaded) continue;
        const selected = files.find(({ file }) => file.name === image.name && file.size === image.bytes);
        if (!selected) throw new Error(`Reselect the original photo: ${image.name}`);
        await api(`captures/${manifest.id}/images/${image.id}`, { method: "PUT", body: selected.file, headers: { "Content-Type": image.mime } });
        done++; setProgress(Math.round(done / manifest.images.length * 100));
      }
      await api(`captures/${manifest.id}/submit`, { method: "POST" }); await refresh();
      files.forEach(item => URL.revokeObjectURL(item.url)); setFiles([]); setResume(null);
    } catch (e) { setError((e as Error).message); await refresh(); }
    finally { setBusy(false); }
  }
  async function openCapture(capture: Capture) {
    clear(); setActiveId(capture.id); setTab("studio");
    if (capture.status === "uploading") {
      try { const detail = await api<{ images: ManifestImage[] }>(`captures/${capture.id}`); setResume({ id: capture.id, images: detail.images }); setName(capture.name); }
      catch (e) { setError((e as Error).message); }
    }
  }
  async function retry() {
    if (!active) return; setBusy(true); setError("");
    try { await api(`captures/${active.id}/submit`, { method: "POST" }); await refresh(); }
    catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  }
  const processing = active && active.status !== "uploading" && !busy;
  return <>
    <header className="header">
      <button className="brand" onClick={() => setTab("studio")} aria-label="Spatial Camera home"><span className="brand-mark"><Scan size={22} /></span><span>spatial<span className="brand-light">camera</span></span><span className="beta">LAB</span></button>
      <nav aria-label="Main navigation"><button className={tab === "studio" ? "nav-active" : ""} onClick={() => setTab("studio")}>Studio</button><button className={tab === "library" ? "nav-active" : ""} onClick={() => setTab("library")}>My captures {captures.length > 0 && <span className="nav-count">{captures.length}</span>}</button></nav>
      <button className="guide-link" onClick={() => setGuide(true)}><CircleHelp size={16} /><span>Capture guide</span><ArrowUpRight size={14} /></button>
    </header>
    <main>
      <section className="intro"><div><div className="eyebrow"><span className="orange-dot" /> FROM PHOTOGRAPHS TO PRESENCE</div><h1>{tab === "studio" ? <>Places worth <em>keeping.</em></> : <>Your little <em>worlds.</em></>}</h1></div><p>{tab === "studio" ? <>Turn a set of photos into a world you can explore.<br />Capture the details. Keep the feeling.</> : <>Every capture, in one place.<br />Return whenever you like.</>}</p></section>
      {serverError && <div className="notice error" role="alert"><AlertCircle size={16} />{serverError}<button onClick={refresh}>Try again</button></div>}
      {tab === "studio" ? <div className="studio-grid">
        <section className="capture-panel" aria-label="Create a capture">
          <div className="panel-heading"><span className="step-number">01</span><h2>{processing ? "Your capture" : resume ? "Resume your upload" : "Start with your photos"}</h2>{(files.length > 0 || active) && !busy && <button className="icon-button" aria-label="Start a new capture" title="Start a new capture" onClick={clear}><Plus size={18} /></button>}</div>
          {processing ? <div className="job-panel">
            <div className={`job-symbol ${active.status === "ready" ? "success" : ""}`}>{active.status === "ready" ? <Check size={28} /> : active.status === "failed" ? <AlertCircle size={28} /> : <Layers size={28} />}</div>
            <h3>{active.name}</h3><p>{active.image_count} photos · {statusLabels[active.status]}</p>
            {active.status === "failed" ? <div className="notice error">{active.error}</div> : <ol className="stage-list">{stages.map((stage, i) => {
              const current = stages.indexOf(active.status as typeof stages[number]);
              return <li key={stage} className={i < current ? "complete" : i === current ? "current" : ""}><span>{i < current || active.status === "ready" ? <Check size={12} /> : i + 1}</span><div>{statusLabels[stage]}{stage === "queued" && current === 0 && <small>{processor ? "Your capture is in the queue." : "Photos saved. Processing begins when a GPU worker connects."}</small>}</div></li>;
            })}</ol>}
            {error && <div className="notice error" role="alert">{error}</div>}
            {active.status === "failed" && <button className="primary" onClick={retry}><RotateCcw size={16} /> Retry reconstruction</button>}
            {active.status === "ready" && <a className="primary" href={`/api/captures/${active.id}/result.ply?download`}><Download size={16} /> Download splat</a>}
            <button className="text-button" onClick={clear}>Start another capture <ArrowRight size={15} /></button>
          </div> : <>
            <p className="panel-description">One place, from different angles.<br />We’ll put the pieces together.</p>
            {resume && <div className="notice">Reselect the original photos. Uploaded files will be skipped.</div>}
            <input ref={fileInput} type="file" accept="image/jpeg,image/png" multiple className="sr-only" aria-label="Choose capture photos" disabled={busy} onChange={e => { if (e.target.files) void addFiles(e.target.files); e.target.value = ""; }} />
            <button disabled={busy} className={`dropzone ${dragging ? "dragging" : ""} ${files.length ? "compact" : ""}`} onClick={() => fileInput.current?.click()} onDragOver={e => { e.preventDefault(); setDragging(true); }} onDragLeave={() => setDragging(false)} onDrop={e => { e.preventDefault(); setDragging(false); void addFiles(e.dataTransfer.files); }}><span className="photo-stack"><Images size={29} strokeWidth={1.3} /></span><strong>{files.length ? "Add more photos" : "Drop your photos here"}</strong><span>or <u>browse files</u></span><small>JPG or PNG · 12–200 photos · Up to 20 MB each</small></button>
            {files.length > 0 && <div className="selected-files"><div className="file-summary"><span>{files.length} photos <span>· {formatBytes(totalBytes)}</span></span><button disabled={busy} onClick={() => { files.forEach(item => URL.revokeObjectURL(item.url)); setFiles([]); }}>Clear</button></div><div className="thumbnails">{files.slice(0, 8).map((item, i) => <div key={item.url}><img src={item.url} alt={item.file.name} /><button aria-label={`Remove ${item.file.name}`} disabled={busy || !!resume} onClick={() => { URL.revokeObjectURL(item.url); setFiles(files.filter((_, index) => index !== i)); }}><X size={11} /></button>{i === 7 && files.length > 8 && <span className="extra-count">+{files.length - 8}</span>}</div>)}</div>{files.length < MIN_IMAGES && <small className="validation-hint">Add {MIN_IMAGES - files.length} more photos to get started.</small>}</div>}
            <label className="field-label" htmlFor="capture-name">Name your capture <span>Something to remember it by</span></label><input id="capture-name" className="name-input" placeholder="e.g. A quiet corner of home" maxLength={80} value={name} disabled={busy || !!resume} onChange={e => setName(e.target.value)} />
            {error && <div className="notice error" role="alert"><AlertCircle size={16} />{error}</div>}
            <button className="primary" disabled={busy || files.length < MIN_IMAGES || !name.trim() || !!serverError} onClick={upload}>{busy ? <><LoaderCircle size={16} className="spin" /> Uploading photos · {progress}%</> : <><Box size={17} />{resume ? "Resume & create splat" : "Create 3D splat"}<ArrowRight size={17} /></>}</button>
            {busy && <progress value={progress} max={100} aria-label="Upload progress" />}<p className="privacy-note"><LockKeyhole size={12} /> Your captures stay private.</p>
          </>}
          <div className="processor-note"><span className={`status-dot ${processor ? "online" : ""}`} /><div>{processor ? "Processor connected" : "Processor not connected"}<small>{processor ? "Captures are processed on the server." : "You can save photos now and process them later."}</small></div></div>
        </section>
        <section className="preview-panel" aria-label="3D scene preview"><SplatViewer source={displaySource} /><div className="preview-caption"><div><span className="step-number">02</span><span>{displaySource.sample ? "A photograph you can move around." : "A new way to revisit your capture."}</span></div><button className="text-button" onClick={() => splatInput.current?.click()}>Open a splat <ArrowUpRight size={15} /></button></div>
          <input ref={splatInput} type="file" accept=".ply,.spz,.splat,.ksplat" className="sr-only" aria-label="Open an existing splat" onChange={e => { const file = e.target.files?.[0]; if (file) { if (file.size > 100 * 1024 * 1024) setError("Choose a splat smaller than 100 MB for this prototype."); else { setActiveId(null); setSource({ file, name: file.name.replace(/\.[^.]+$/, "") }); setError(""); } } e.target.value = ""; }} />
          <div className="capture-tip"><span className="tip-icon"><Footprints size={20} strokeWidth={1.4} /></span><div><strong>A little movement makes all the difference.</strong><p>Walk around your subject. Keep photos sharp, overlapping, and taken in consistent light.</p></div><button aria-label="Read capture tips" onClick={() => setGuide(true)}><ArrowUpRight size={19} /></button></div>
        </section>
      </div> : <section className="library"><div className="library-heading"><h2>{captures.length} {captures.length === 1 ? "capture" : "captures"}</h2><button className="primary small" onClick={() => { clear(); setTab("studio"); }}><Plus size={16} /> New capture</button></div>{captures.length === 0 ? <div className="empty-library"><Scan size={36} strokeWidth={1} /><h3>Your first world starts here.</h3><p>Capture a favorite place. We’ll keep it here for you.</p><button className="text-button" onClick={() => setTab("studio")}>Create your first capture <ArrowRight size={16} /></button></div> : <div className="capture-list">{captures.map(c => <button key={c.id} className="capture-row" onClick={() => void openCapture(c)}><span className={`capture-icon ${c.status === "ready" ? "ready" : ""}`}><Box size={23} strokeWidth={1.4} /></span><span className="capture-info"><strong>{c.name}</strong><small>{c.image_count} photos · {new Date(c.created_at).toLocaleDateString(undefined, { month: "short", day: "numeric" })}</small></span><span className={`status-pill ${c.status}`}>{statusLabels[c.status]}</span><ChevronRight size={17} /></button>)}</div>}</section>}
      <footer><span><Scan size={14} /> CAPTURE SOMETHING REAL.</span><span>Photos in. A little world out.<span className="footer-dot">·</span>Spatial Camera Lab</span></footer>
    </main>
    <dialog ref={guideRef} onCancel={() => setGuide(false)} onClick={e => { if (e.target === e.currentTarget) setGuide(false); }}><div className="guide"><button className="dialog-close icon-button" aria-label="Close capture guide" onClick={() => setGuide(false)}><X size={20} /></button><div className="eyebrow">A BETTER CAPTURE, A BETTER WORLD</div><h2>Take the long way <em>around.</em></h2><p>A good splat starts with photos that tell the whole story.</p><div className="guide-steps">{[
      { icon: Footprints, title: "Move around, not just left and right.", text: "Walk an arc around an object or slowly through a small space. Changing your position reveals depth; rotating from one spot does not." },
      { icon: Camera, title: "Give each photo a familiar neighbor.", text: "Aim for 60–80% overlap. Start with 30–80 sharp photos. Include different heights and keep your subject in frame." },
      { icon: Sun, title: "Keep the world still.", text: "Use even light. Avoid people moving through the scene, mirrors, glass, and featureless walls. Keep zoom and exposure consistent." },
      { icon: Cloud, title: "Upload once. Come back to explore.", text: "Photos are stored privately. A connected GPU worker estimates camera positions and trains your splat. Timing depends on scene size and hardware." },
    ].map(({ icon: Icon, title, text }) => <div key={title}><span><Icon size={21} /></span><section><h3>{title}</h3><p>{text}</p></section></div>)}</div><div className="notice">Time-lapse capture works when you move between photos. For a place changing over days, create a separate capture for each visit.</div><button className="primary" onClick={() => setGuide(false)}>Ready to capture <ArrowRight size={16} /></button></div></dialog>
  </>;
}
