"use client";
import { useEffect, useRef, useState } from "react";
import { Expand, RotateCcw, Pause, Play, Move, LoaderCircle, AlertCircle } from "lucide-react";
import type { SplatMesh } from "@sparkjsdev/spark";
export type SceneSource = { url?: string; file?: File; name: string; sample?: boolean };

/**
 * One WebGL context for the component's lifetime: the renderer, Spark renderer, camera and controls are
 * created once, and a scene change only swaps (and disposes) the SplatMesh. Browsers cap live WebGL
 * contexts, so recreating the renderer per scene eventually loses the oldest one.
 */
async function createEngine(host: HTMLDivElement) {
  const [THREE, { SparkRenderer, SplatMesh }, { OrbitControls }] = await Promise.all([
    import("three"), import("@sparkjsdev/spark"), import("three/addons/controls/OrbitControls.js"),
  ]);
  const renderer = new THREE.WebGLRenderer({ antialias: false, alpha: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.5)); renderer.setClearColor(0x000000, 0);
  host.appendChild(renderer.domElement);
  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(45, 1, 0.01, 1000);
  camera.position.set(0, 0, 5);
  const orbit = new OrbitControls(camera, renderer.domElement);
  orbit.enableDamping = false; orbit.autoRotateSpeed = 0.65;
  let disposed = false;
  let frameId = 0;
  function requestRender() {
    if (disposed || frameId) return;
    frameId = requestAnimationFrame(() => {
      frameId = 0;
      if (disposed) return;
      orbit.update(); renderer.render(scene, camera);
      if (orbit.autoRotate) requestRender();
    });
  }
  orbit.addEventListener("change", requestRender);
  const spark = new SparkRenderer({ renderer, onDirty: requestRender }); scene.add(spark);
  const resize = () => {
    if (!host.clientWidth || !host.clientHeight) return;
    renderer.setSize(host.clientWidth, host.clientHeight);
    camera.aspect = host.clientWidth / host.clientHeight; camera.updateProjectionMatrix(); requestRender();
  };
  const observer = new ResizeObserver(resize); observer.observe(host); resize();
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
      observer.disconnect(); cancelAnimationFrame(frameId); orbit.removeEventListener("change", requestRender); orbit.dispose();
      // Release the context now rather than at garbage collection (the viewer unmounts on tab changes).
      spark.dispose(); renderer.dispose(); renderer.forceContextLoss(); renderer.domElement.remove();
    },
  };
}
type Engine = Awaited<ReturnType<typeof createEngine>>;

/** Disposes a mesh that never reached the screen, once its load settles (Spark finishes the worker call first). */
function discard(mesh: SplatMesh) {
  mesh.initialized.then(() => mesh.dispose(), () => mesh.dispose());
}
const megabytes = (n: number) => `${(n / 1024 / 1024).toFixed(1)} MB`;
type ViewState = { loading: boolean; error: string; count: number; loaded: number; total: number };
const opening: ViewState = { loading: true, error: "", count: 0, loaded: 0, total: 0 };

export default function SplatViewer({ source }: { source: SceneSource }) {
  const container = useRef<HTMLDivElement>(null);
  const frame = useRef<HTMLDivElement>(null);
  const engine = useRef<Promise<Engine> | null>(null);
  const controls = useRef<{ reset: () => void; rotate: (value: boolean) => void } | null>(null);
  const [state, setState] = useState(opening);
  const [rotating, setRotating] = useState(false);
  useEffect(() => {
    const created = createEngine(container.current!);
    engine.current = created;
    return () => {
      engine.current = null; controls.current = null;
      created.then(instance => instance.dispose(), () => {});
    };
  }, []);
  useEffect(() => {
    let alive = true;
    let pending: SplatMesh | null = null;
    // Reset the loading state when synchronizing a new external WebGL scene.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setState(opening); setRotating(false); controls.current = null;
    async function load(created: Promise<Engine>) {
      const { THREE, SplatMesh, renderer, scene, camera, orbit, requestRender, show } = await created;
      if (!alive) return;
      orbit.autoRotate = false;
      show(null); // never leave the previous scene on screen under the new name
      renderer.domElement.setAttribute("aria-label", `Interactive 3D scene: ${source.name}`);
      const bytes = source.file ? await source.file.arrayBuffer() : undefined;
      if (!alive) return;
      // Real byte counts from Spark's fetch (ADR-0005). Updates are coalesced to whole percents (or
      // 256 KB steps when the length is unknown) so a fast stream does not re-render per chunk.
      let step = -1;
      const onProgress = (event: ProgressEvent) => {
        const total = event.lengthComputable ? event.total : 0;
        const next = total ? Math.floor(event.loaded / total * 100) : Math.floor(event.loaded / 262144);
        if (!alive || next === step) return;
        step = next;
        setState(current => ({ ...current, loaded: event.loaded, total }));
      };
      const mesh = new SplatMesh(bytes ? { fileBytes: bytes, fileName: source.file!.name } : { url: source.url, onProgress });
      pending = mesh;
      // Spark's example is camera-down; Nerfstudio exports Z-up.
      if (source.sample) mesh.rotation.x = Math.PI;
      else if (!source.file) mesh.rotation.x = -Math.PI / 2;
      await mesh.initialized;
      if (!alive) return; // the cleanup discards it
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
      setState({ ...opening, loading: false, count: mesh.packedSplats?.numSplats ?? 0 });
    }
    const created = engine.current;
    (created ? load(created) : Promise.reject(new Error("Viewer is not mounted."))).catch(error => {
      if (pending) { discard(pending); pending = null; }
      if (alive) setState({ ...opening, loading: false, error: error instanceof Error && /WebGL/.test(error.message) ? "This browser could not start WebGL2. Try a browser with hardware acceleration enabled." : "This scene could not be loaded. Check your connection or try another splat file." });
    });
    return () => {
      alive = false; controls.current = null;
      if (pending) { discard(pending); pending = null; }
    };
  }, [source]);
  const downloading = state.loading && !source.file && state.loaded > 0;
  const decoding = downloading && state.total > 0 && state.loaded >= state.total;
  const message = source.file ? "Reading your file…" : !downloading ? "Opening your scene…" : decoding ? "Preparing your scene…"
    : state.total ? `Downloading · ${megabytes(state.loaded)} of ${megabytes(state.total)}` : `Downloading · ${megabytes(state.loaded)}`;
  return <div className="viewer" ref={frame}>
    <div className="viewer-top"><span><span className="live-dot" /> INTERACTIVE 3D</span><span>{source.sample ? "SAMPLE SCENE" : "GAUSSIAN SPLAT"}</span></div>
    <div className="viewer-canvas" ref={container} />
    <div className="crosshair tl" /><div className="crosshair tr" /><div className="crosshair bl" /><div className="crosshair br" />
    {state.loading && <div className="viewer-message" role="status"><LoaderCircle className="spin" size={24} /><span>{message}</span>
      {downloading && !decoding && state.total > 0 && <progress value={state.loaded} max={state.total} aria-label="Scene download progress" />}</div>}
    {state.error && <div className="viewer-message error" role="alert"><AlertCircle size={25} /><span>{state.error}</span></div>}
    <div className="viewer-bottom"><div><h3>{source.name}</h3><p>{source.sample ? <>Viewer sample by <a href="https://sparkjs.dev/" target="_blank" rel="noreferrer">Spark ↗</a></> : "Your captured world"}{state.count > 0 && <> · {(state.count / 1000).toFixed(0)}k splats</>}</p></div>
      <div className="viewer-tools"><button disabled={state.loading || !!state.error} title={rotating ? "Pause rotation" : "Rotate scene"} aria-label={rotating ? "Pause rotation" : "Rotate scene"} onClick={() => { controls.current?.rotate(!rotating); setRotating(!rotating); }}>{rotating ? <Pause size={16} /> : <Play size={16} />}</button><button disabled={state.loading || !!state.error} title="Reset view" aria-label="Reset view" onClick={() => controls.current?.reset()}><RotateCcw size={16} /></button><button title="Fullscreen" aria-label="Fullscreen" onClick={() => { const promise = document.fullscreenElement ? document.exitFullscreen() : frame.current?.requestFullscreen(); promise?.catch(() => {}); }}><Expand size={16} /></button></div>
    </div>
    {!state.loading && !state.error && <div className="viewer-hint"><Move size={13} /> Drag to orbit · Scroll to zoom · Right-drag to pan</div>}
  </div>;
}
