"use client";
import { useEffect, useRef, useState } from "react";
import { Expand, RotateCcw, Pause, Play, Move, LoaderCircle, AlertCircle } from "lucide-react";
export type SceneSource = { url?: string; file?: File; name: string; sample?: boolean };

export default function SplatViewer({ source }: { source: SceneSource }) {
  const container = useRef<HTMLDivElement>(null);
  const frame = useRef<HTMLDivElement>(null);
  const controls = useRef<{ reset: () => void; rotate: (value: boolean) => void } | null>(null);
  const [state, setState] = useState({ loading: true, error: "", count: 0 });
  const [rotating, setRotating] = useState(false);
  useEffect(() => {
    const host = container.current!;
    let alive = true;
    let cleanup = () => {};
    // Reset the loading state when synchronizing a new external WebGL scene.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setState({ loading: true, error: "", count: 0 }); setRotating(false);
    async function load() {
      const [THREE, { SparkRenderer, SplatMesh }, { OrbitControls }] = await Promise.all([
        import("three"), import("@sparkjsdev/spark"), import("three/addons/controls/OrbitControls.js"),
      ]);
      const bytes = source.file ? await source.file.arrayBuffer() : undefined;
      if (!alive) return;
      const renderer = new THREE.WebGLRenderer({ antialias: false, alpha: true });
      renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.5)); renderer.setClearColor(0x000000, 0);
      host.appendChild(renderer.domElement);
      renderer.domElement.setAttribute("aria-label", `Interactive 3D scene: ${source.name}`);
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
      const mesh = new SplatMesh(bytes ? { fileBytes: bytes, fileName: source.file!.name } : { url: source.url });
      // Spark's example is camera-down; Nerfstudio exports Z-up.
      if (source.sample) mesh.rotation.x = Math.PI;
      else if (!source.file) mesh.rotation.x = -Math.PI / 2;
      scene.add(mesh);
      const resize = () => {
        if (!host.clientWidth || !host.clientHeight) return;
        renderer.setSize(host.clientWidth, host.clientHeight);
        camera.aspect = host.clientWidth / host.clientHeight; camera.updateProjectionMatrix(); requestRender();
      };
      const observer = new ResizeObserver(resize); observer.observe(host); resize();
      cleanup = () => {
        if (disposed) return; disposed = true;
        observer.disconnect(); cancelAnimationFrame(frameId); orbit.removeEventListener("change", requestRender); orbit.dispose();
        mesh.dispose(); spark.dispose(); renderer.dispose(); renderer.domElement.remove(); controls.current = null;
      };
      await mesh.initialized;
      if (!alive) { cleanup(); return; }
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
      setState({ loading: false, error: "", count: mesh.packedSplats?.numSplats ?? 0 });
    }
    load().catch(error => {
      cleanup();
      if (alive) setState({ loading: false, error: error instanceof Error && /WebGL/.test(error.message) ? "This browser could not start WebGL2. Try a browser with hardware acceleration enabled." : "This scene could not be loaded. Check your connection or try another splat file.", count: 0 });
    });
    return () => { alive = false; cleanup(); };
  }, [source]);
  return <div className="viewer" ref={frame}>
    <div className="viewer-top"><span><span className="live-dot" /> INTERACTIVE 3D</span><span>{source.sample ? "SAMPLE SCENE" : "GAUSSIAN SPLAT"}</span></div>
    <div className="viewer-canvas" ref={container} />
    <div className="crosshair tl" /><div className="crosshair tr" /><div className="crosshair bl" /><div className="crosshair br" />
    {state.loading && <div className="viewer-message" role="status"><LoaderCircle className="spin" size={24} /><span>Opening your scene…</span></div>}
    {state.error && <div className="viewer-message error" role="alert"><AlertCircle size={25} /><span>{state.error}</span></div>}
    <div className="viewer-bottom"><div><h3>{source.name}</h3><p>{source.sample ? <>Viewer sample by <a href="https://sparkjs.dev/" target="_blank" rel="noreferrer">Spark ↗</a></> : "Your captured world"}{state.count > 0 && <> · {(state.count / 1000).toFixed(0)}k splats</>}</p></div>
      <div className="viewer-tools"><button disabled={state.loading || !!state.error} title={rotating ? "Pause rotation" : "Rotate scene"} aria-label={rotating ? "Pause rotation" : "Rotate scene"} onClick={() => { controls.current?.rotate(!rotating); setRotating(!rotating); }}>{rotating ? <Pause size={16} /> : <Play size={16} />}</button><button disabled={state.loading || !!state.error} title="Reset view" aria-label="Reset view" onClick={() => controls.current?.reset()}><RotateCcw size={16} /></button><button title="Fullscreen" aria-label="Fullscreen" onClick={() => { const promise = document.fullscreenElement ? document.exitFullscreen() : frame.current?.requestFullscreen(); promise?.catch(() => {}); }}><Expand size={16} /></button></div>
    </div>
    {!state.loading && !state.error && <div className="viewer-hint"><Move size={13} /> Drag to orbit · Scroll to zoom · Right-drag to pan</div>}
  </div>;
}
