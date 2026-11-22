"use client";
/**
 * S8 (ADR-0010): the public, read-only view of a shared capture, as a page (`/s/:token`) or as a
 * chrome-free embed (`/s/:token/embed`). Everything it loads is token-scoped and checked by the Worker on
 * every request (worker/share.ts): the scene, the optional PLY download and the small info document.
 */
import { useEffect, useMemo, useState } from "react";
import { AlertCircle, Download, LoaderCircle, Scan } from "lucide-react";
import SplatViewer, { type SceneSource } from "./SplatViewer";

type Info = { name: string; format: "spz" | "ply"; scene_bytes: number | null; download: boolean; download_bytes: number | null };
const formatBytes = (n: number) => n < 1024 * 1024 ? `${Math.max(1, Math.round(n / 1024))} KB` : `${(n / 1024 / 1024).toFixed(1)} MB`;

export default function SharedScene({ token, embed }: { token: string; embed: boolean }) {
  const base = `/s/${encodeURIComponent(token)}`;
  const [info, setInfo] = useState<Info | null>(null);
  const [error, setError] = useState("");
  useEffect(() => {
    const controller = new AbortController();
    fetch(`${base}/info`, { cache: "no-store", signal: controller.signal })
      .then(async response => {
        if (response.ok) return response.json() as Promise<Info>;
        throw new Error(response.status === 404 ? "This link is not available. It may have been revoked."
          : response.status === 429 ? "Too many requests from your network. Try again in a minute."
          : "The shared scene could not be opened. Please try again.");
      })
      .then(setInfo)
      .catch((e: Error) => {
        if (controller.signal.aborted) return;
        setError(e.name === "TypeError" ? "The server could not be reached. Please try again." : e.message);
      });
    return () => controller.abort();
  }, [base]);
  // Stable while the info is unchanged, so the viewer loads the scene once.
  const source = useMemo<SceneSource | null>(() => info && {
    url: `${base}/scene`, name: info.name, caption: "Shared scene · view only",
    // The full PLY is the decode fallback only when the owner allowed downloading it.
    fallbackUrl: info.format === "spz" && info.download ? `${base}/download` : undefined,
  }, [base, info]);

  const status = error
    ? <div className="notice error share-status" role="alert"><AlertCircle size={16} aria-hidden="true" />{error}</div>
    : !source
      ? <div className="share-status" role="status"><LoaderCircle className="spin" size={18} aria-hidden="true" /> Opening the shared scene…</div>
      : null;
  if (embed) return <main className="share-embed">{status ?? (source && <SplatViewer source={source} />)}</main>;
  return <div className="share-page">
    <header className="header">
      <span className="brand"><span className="brand-mark"><Scan size={22} aria-hidden="true" /></span><span>spatial<span className="brand-light">camera</span></span></span>
    </header>
    <main className="share-main">
      <h1 className="share-title">{info?.name ?? "Shared scene"}</h1>
      {status ?? (source && <>
        <SplatViewer source={source} />
        <div className="share-meta">
          <p>A read-only 3D scene shared from Spatial Camera. The photos it was made from are not shared.</p>
          {info?.download && <a className="primary" href={`${base}/download`} download>
            <Download size={16} aria-hidden="true" /> Download PLY{info.download_bytes ? ` · ${formatBytes(info.download_bytes)}` : ""}
          </a>}
        </div>
      </>)}
    </main>
  </div>;
}
