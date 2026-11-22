"use client";
import { useEffect, useRef, useState } from "react";
import { Expand, RotateCcw, Pause, Play, Move, LoaderCircle, AlertCircle } from "lucide-react";
import type { SplatMesh } from "@sparkjsdev/spark";
import type { WebGLRenderer } from "three";
import { attemptController, describeFailure, DownloadError, EngineError, openScene, sceneOutcome, type Download } from "../lib/scene";
/** `fallbackUrl`: loaded instead when `url` downloads but cannot be decoded (the PLY behind an SPZ). */
/** `caption` (S8): the line under the name; defaults to "Your captured world". */
export type SceneSource = { url?: string; fallbackUrl?: string; file?: File; name: string; sample?: boolean; caption?: string };

type EngineEvents = { onLost: () => void; onRestored: () => void };
/**
 * One WebGL context per engine: the renderer, Spark renderer, camera and controls are created once, and a
 * scene change only swaps (and disposes) the SplatMesh. Browsers cap live WebGL contexts, so recreating
 * the renderer per scene eventually loses the oldest one. After a context loss the component builds a
 * fresh engine (a new generation) rather than trusting Spark's GPU state to survive a restore.
 */
async function createEngine(host: HTMLDivElement, events: EngineEvents) {
  // A chunk that fails to load is a network problem: "Reload scene" rebuilds the engine and retries it.
  const modules: Modules = await Promise.all([
    import("three"), import("@sparkjsdev/spark"), import("three/addons/controls/OrbitControls.js"),
  ]).catch(error => { throw new DownloadError(`Could not load the 3D viewer: ${String(error)}`); });
  let renderer: WebGLRenderer;
  try { renderer = new modules[0].WebGLRenderer({ antialias: false, alpha: true }); }
  catch (error) { throw new EngineError(String(error)); }
  // Each build step registers its undo, so a failure part-way leaves no listener, observer, Spark renderer,
  // canvas or WebGL context behind.
  const undo: (() => void)[] = [];
  try { return buildEngine(host, events, modules, renderer, undo); }
  catch (error) {
    for (const step of undo.reverse()) { try { step(); } catch { /* keep releasing the rest */ } }
    try { renderer.dispose(); renderer.forceContextLoss(); } catch { /* already unusable */ }
    renderer.domElement.remove();
    throw new EngineError(String(error));
  }
}
type Modules = [typeof import("three"), typeof import("@sparkjsdev/spark"), typeof import("three/addons/controls/OrbitControls.js")];
function buildEngine(host: HTMLDivElement, { onLost, onRestored }: EngineEvents, [THREE, { SparkRenderer, SplatMesh }, { OrbitControls }]: Modules, renderer: WebGLRenderer, undo: (() => void)[]) {
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.5)); renderer.setClearColor(0x000000, 0);
  const canvas = renderer.domElement;
  canvas.setAttribute("role", "img");
  host.appendChild(canvas);
  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(45, 1, 0.01, 1000);
  camera.position.set(0, 0, 5);
  const orbit = new OrbitControls(camera, canvas);
  orbit.enableDamping = false; orbit.autoRotateSpeed = 0.65;
  let disposed = false;
  let lost = false;
  let frameId = 0;
  function requestRender() {
    if (disposed || lost || frameId) return;
    frameId = requestAnimationFrame(() => {
      frameId = 0;
      if (disposed || lost) return;
      orbit.update(); renderer.render(scene, camera);
      if (orbit.autoRotate) requestRender();
    });
  }
  // preventDefault tells the browser we can handle a restore; without it the context stays lost for good.
  const contextLost = (event: Event) => { event.preventDefault(); lost = true; cancelAnimationFrame(frameId); frameId = 0; onLost(); };
  const contextRestored = () => onRestored();
  undo.push(() => orbit.dispose());
  canvas.addEventListener("webglcontextlost", contextLost);
  canvas.addEventListener("webglcontextrestored", contextRestored);
  undo.push(() => { canvas.removeEventListener("webglcontextlost", contextLost); canvas.removeEventListener("webglcontextrestored", contextRestored); });
  orbit.addEventListener("change", requestRender);
  undo.push(() => { disposed = true; cancelAnimationFrame(frameId); orbit.removeEventListener("change", requestRender); });
  const spark = new SparkRenderer({ renderer, onDirty: requestRender }); scene.add(spark);
  undo.push(() => spark.dispose());
  const resize = () => {
    if (!host.clientWidth || !host.clientHeight) return;
    renderer.setSize(host.clientWidth, host.clientHeight);
    camera.aspect = host.clientWidth / host.clientHeight; camera.updateProjectionMatrix(); requestRender();
  };
  const observer = new ResizeObserver(resize); observer.observe(host);
  undo.push(() => observer.disconnect());
  resize();
  let shown: SplatMesh | null = null;
  /** Replaces the displayed mesh, disposing the previous one (its GPU textures and worker buffers). */
  function show(mesh: SplatMesh | null) {
    if (shown) { scene.remove(shown); shown.dispose(); }
    shown = mesh;
    if (mesh) scene.add(mesh);
    requestRender();
  }
  return {
    THREE, SplatMesh, renderer, scene, camera, orbit, requestRender, show,
    dispose() {
      if (disposed) return;
      show(null); disposed = true;
      // Our own forceContextLoss below must not read as a lost context.
      canvas.removeEventListener("webglcontextlost", contextLost); canvas.removeEventListener("webglcontextrestored", contextRestored);
      observer.disconnect(); cancelAnimationFrame(frameId); orbit.removeEventListener("change", requestRender); orbit.dispose();
      // Release the context now rather than at garbage collection (the viewer unmounts on tab changes).
      spark.dispose(); renderer.dispose(); renderer.forceContextLoss(); canvas.remove();
    },
  };
}
type Engine = Awaited<ReturnType<typeof createEngine>>;

/** Disposes a mesh that never reached the screen, once its load settles (Spark finishes the worker call first). */
function discard(mesh: SplatMesh) {
  mesh.initialized.then(() => mesh.dispose(), () => mesh.dispose());
}
const megabytes = (n: number) => `${(n / 1024 / 1024).toFixed(1)} MB`;
type ViewState = { loading: boolean; error: string; retry: boolean; count: number; loaded: number; total: number; received: boolean; notice: string };
const opening: ViewState = { loading: true, error: "", retry: false, count: 0, loaded: 0, total: 0, received: false, notice: "" };
const FALLBACK_NOTICE = "The compact SPZ could not be decoded, so the full PLY is loading instead (a larger download).";

export default function SplatViewer({ source }: { source: SceneSource }) {
  const container = useRef<HTMLDivElement>(null);
  const frame = useRef<HTMLDivElement>(null);
  const engine = useRef<Promise<Engine> | null>(null);
  const controls = useRef<{ reset: () => void; rotate: (value: boolean) => void } | null>(null);
  const [state, setState] = useState(opening);
  const [rotating, setRotating] = useState(false);
  // Bumped to rebuild the engine and reload the scene: after a WebGL context restore, or on "Reload scene".
  const [generation, setGeneration] = useState(0);
  const [lost, setLost] = useState(false);
  const reload = () => { setLost(false); setGeneration(g => g + 1); };
  useEffect(() => {
    const created = createEngine(container.current!, {
      onLost: () => setLost(true),
      onRestored: () => { setLost(false); setGeneration(g => g + 1); },
    });
    engine.current = created;
    return () => {
      engine.current = null; controls.current = null;
      created.then(instance => instance.dispose(), () => {});
    };
  }, [generation]);
  useEffect(() => {
    let alive = true;
    let pending: SplatMesh | null = null;
    // Stops the scene download when the source changes, the engine is rebuilt, or the viewer unmounts.
    const abort = new AbortController();
    // Reset the loading state when synchronizing a new external WebGL scene.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setState(opening); setRotating(false); controls.current = null;
    async function load(created: Promise<Engine>, url = source.url): Promise<void> {
      const { THREE, SplatMesh, renderer, scene, camera, orbit, requestRender, show } = await created;
      if (!alive) return;
      orbit.autoRotate = false;
      show(null); // never leave the previous scene on screen under the new name
      renderer.domElement.setAttribute("aria-label", `Interactive 3D scene: ${source.name}`);
      const bytes = source.file ? await source.file.arrayBuffer() : undefined;
      if (!alive) return;
      // Real byte counts as Spark reads the stream (ADR-0005). Updates are coalesced to whole percents (or
      // 256 KB steps when the length is unknown) so a fast stream does not re-render per chunk.
      let step = -1;
      const onBytes = (loaded: number, total: number, done: boolean) => {
        const next = done ? Infinity : total ? Math.floor(loaded / total * 100) : Math.floor(loaded / 262144);
        if (!alive || next === step) return;
        step = next;
        setState(current => ({ ...current, loaded, total, received: done }));
      };
      let download: Download | null = null;
      let attempt: AbortController | null = null;
      let mesh: SplatMesh;
      if (bytes) mesh = new SplatMesh({ fileBytes: bytes, fileName: source.file!.name });
      else {
        if (!url) throw new Error("No scene to load.");
        attempt = attemptController(abort.signal);
        const opened = await openScene(url, attempt.signal, onBytes);
        if (!alive) { void opened.stream.cancel().catch(() => {}); return; }
        download = opened.download;
        mesh = new SplatMesh({ stream: opened.stream, streamLength: opened.streamLength, fileName: opened.fileName });
      }
      pending = mesh;
      // Spark's example is camera-down; Nerfstudio exports Z-up.
      if (source.sample) mesh.rotation.x = Math.PI;
      else if (!source.file) mesh.rotation.x = -Math.PI / 2;
      let decodeError: unknown = null;
      try { await mesh.initialized; } catch (error) { decodeError = error; }
      if (!alive) return; // the cleanup discards it
      const failure = (download as Download | null)?.failure;
      const outcome = sceneOutcome({ failure, decodeError, url, fallbackUrl: source.fallbackUrl });
      // Spark holds the stream locked, so close this attempt's connection through its own signal; the
      // PLY fallback below gets a fresh attempt.
      if (outcome !== "show") attempt?.abort();
      if (outcome === "download-error") throw new DownloadError(String(failure));
      if (outcome === "decode-error") throw decodeError;
      if (outcome === "fallback") {
        // An SPZ that arrived whole but will not decode: show the PLY archive instead, and say so.
        discard(mesh); pending = null;
        console.warn("SPZ decode failed; loading the PLY instead.", decodeError);
        setState({ ...opening, notice: FALLBACK_NOTICE });
        return load(created, source.fallbackUrl);
      }
      pending = null;
      show(mesh);
      scene.updateMatrixWorld(true);
      const box = mesh.getBoundingBox().applyMatrix4(mesh.matrixWorld);
      const center = box.getCenter(new THREE.Vector3());
      const size = box.getSize(new THREE.Vector3());
      const radius = Math.max(size.x, size.y, size.z, 0.1);
      const reset = () => {
        orbit.target.copy(center);
        camera.position.copy(center).add(new THREE.Vector3(radius * 0.1, radius * 0.08, radius * 1.65));
        camera.near = Math.max(radius / 1000, 0.001); camera.far = radius * 100; camera.updateProjectionMatrix();
        orbit.minDistance = radius * 0.03; orbit.maxDistance = radius * 10; orbit.update();
      };
      reset(); controls.current = { reset, rotate: value => { orbit.autoRotate = value; requestRender(); } };
      requestRender();
      setState(current => ({ ...opening, loading: false, count: mesh.packedSplats?.numSplats ?? 0, notice: current.notice }));
    }
    const created = engine.current;
    (created ? load(created) : Promise.reject(new Error("Viewer is not mounted."))).catch(error => {
      if (pending) { discard(pending); pending = null; }
      if (!alive) return;
      setState({ ...opening, loading: false, ...describeFailure(error, Boolean(source.fallbackUrl)) });
    });
    return () => {
      alive = false; controls.current = null;
      abort.abort();
      if (pending) { discard(pending); pending = null; }
    };
  }, [source, generation]);
  const downloading = state.loading && !source.file && state.loaded > 0;
  const decoding = downloading && state.received;
  const message = source.file ? "Reading your file…" : !downloading ? "Opening your scene…" : decoding ? "Preparing your scene…"
    : state.total ? `Downloading · ${megabytes(state.loaded)} of ${megabytes(state.total)}` : `Downloading · ${megabytes(state.loaded)}`;
  // What a screen reader hears: no byte counts (they would be re-announced constantly), quarters at most.
  const spoken = source.file ? "Reading your file" : !downloading ? "Opening your scene" : decoding ? "Preparing your scene"
    : state.total ? `Downloading your scene, ${Math.floor(state.loaded / state.total * 4) * 25}%` : "Downloading your scene";
  const blocked = state.loading || !!state.error || lost;
  return <div className="viewer" ref={frame}>
    <div className="viewer-top"><span><span className="live-dot" /> INTERACTIVE 3D</span><span>{source.sample ? "SAMPLE SCENE" : "GAUSSIAN SPLAT"}</span></div>
    <div className="viewer-canvas" ref={container} />
    <div className="crosshair tl" /><div className="crosshair tr" /><div className="crosshair bl" /><div className="crosshair br" />
    {lost ? <div className="viewer-message error" role="alert"><AlertCircle size={25} aria-hidden="true" /><span>The 3D view stopped because the graphics context was lost (the GPU was reset or the browser reclaimed it).</span><button type="button" onClick={reload}>Reload scene</button></div>
      : <>
        {state.loading && <div className="viewer-message"><LoaderCircle className="spin" size={24} aria-hidden="true" />
          <span role="status">{state.notice && <span className="viewer-notice">{state.notice} </span>}<span className="sr-only">{spoken}</span><span aria-hidden="true">{message}</span></span>
          {downloading && !decoding && state.total > 0 && <progress value={state.loaded} max={state.total} aria-label="Scene download progress" />}</div>}
        {state.error && <div className="viewer-message error" role="alert"><AlertCircle size={25} aria-hidden="true" /><span>{state.error}</span>{state.retry && <button type="button" onClick={reload}>Reload scene</button>}</div>}
      </>}
    <div className="viewer-bottom"><div><h3>{source.name}</h3><p>{source.sample ? <>Viewer sample by <a href="https://sparkjs.dev/" target="_blank" rel="noreferrer">Spark ↗</a></> : source.caption ?? "Your captured world"}{state.count > 0 && <> · {(state.count / 1000).toFixed(0)}k splats</>}{!state.loading && state.notice && <> · Showing the full PLY (the SPZ could not be decoded)</>}</p></div>
      <div className="viewer-tools"><button disabled={blocked} title={rotating ? "Pause rotation" : "Rotate scene"} aria-label={rotating ? "Pause rotation" : "Rotate scene"} onClick={() => { controls.current?.rotate(!rotating); setRotating(!rotating); }}>{rotating ? <Pause size={16} /> : <Play size={16} />}</button><button disabled={blocked} title="Reset view" aria-label="Reset view" onClick={() => controls.current?.reset()}><RotateCcw size={16} /></button><button title="Fullscreen" aria-label="Fullscreen" onClick={() => { const promise = document.fullscreenElement ? document.exitFullscreen() : frame.current?.requestFullscreen(); promise?.catch(() => {}); }}><Expand size={16} /></button></div>
    </div>
    {!blocked && <div className="viewer-hint"><Move size={13} /> Drag to orbit · Scroll to zoom · Right-drag to pan</div>}
  </div>;
}
