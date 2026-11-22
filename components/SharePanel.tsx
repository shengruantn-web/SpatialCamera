"use client";
/**
 * S8 (ADR-0010, spec §7.9): the owner's share links for one ready capture. Create a link (optionally with
 * the PLY download), copy the link or an <iframe> snippet, see views, toggle the download, revoke.
 * A link's token is shown only once, right after it is created: the server stores only its hash.
 */
import { useCallback, useId, useState } from "react";
import { Copy, Link2, LoaderCircle } from "lucide-react";

type Share = { id: string; created_at: number; revoked_at: number | null; views: number; allow_download: boolean };
type Created = { share: Share; token: string; path: string };

async function shareApi<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`/api/${path}`, { cache: "no-store", ...init });
  const data = await response.json().catch(() => ({ error: "The server could not be reached. Please try again." })) as T & { error?: string };
  if (!response.ok) throw new Error(data.error ?? "Request failed.");
  return data;
}
const jsonInit = (method: string, body: unknown): RequestInit => ({ method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
const escapeAttr = (s: string) => s.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const formatDate = (ms: number) => new Date(ms).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
/** Names a link in labels; the time tells apart links created the same day. */
const formatCreated = (ms: number) => new Date(ms).toLocaleString(undefined, { month: "short", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit" });

export default function SharePanel({ captureId, name }: { captureId: string; name: string }) {
  const ids = useId();
  const base = `captures/${encodeURIComponent(captureId)}/shares`;
  const [open, setOpen] = useState(false);
  const [shares, setShares] = useState<Share[] | null>(null);
  const [allowDownload, setAllowDownload] = useState(false);
  const [created, setCreated] = useState<Created | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [confirming, setConfirming] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [announce, setAnnounce] = useState("");

  const load = useCallback(async () => {
    try { setShares((await shareApi<{ shares: Share[] }>(base)).shares); setError(""); }
    catch (e) { setError((e as Error).message); }
  }, [base]);
  // Studio renders this with `key={captureId}`, so another capture starts fresh (no leftover token).
  // The list is fetched each time the panel is opened, so view counts are current.
  const toggle = () => { const next = !open; setOpen(next); if (next) void load(); };

  const origin = typeof window === "undefined" ? "" : window.location.origin;
  const link = created ? `${origin}${created.path}` : "";
  const snippet = created ? `<iframe src="${link}/embed" title="${escapeAttr(name)} (3D scene)" width="640" height="480" style="border:0" allow="fullscreen" allowfullscreen loading="lazy" referrerpolicy="no-referrer"></iframe>` : "";

  async function copy(text: string, what: string) {
    try { await navigator.clipboard.writeText(text); setAnnounce(`${what} copied to the clipboard.`); }
    catch { setAnnounce(`Copy failed. Select the ${what.toLowerCase()} and copy it manually.`); }
  }
  async function create() {
    setBusy("create"); setError("");
    try {
      const result = await shareApi<Created>(base, jsonInit("POST", { allow_download: allowDownload }));
      setCreated(result); setAnnounce("Share link created. Copy it now; it is shown only once.");
      await load();
    } catch (e) { setError((e as Error).message); }
    finally { setBusy(null); }
  }
  async function setDownload(share: Share, value: boolean) {
    setBusy(share.id); setError("");
    try {
      const { share: next } = await shareApi<{ share: Share }>(`${base}/${encodeURIComponent(share.id)}`, jsonInit("PATCH", { allow_download: value }));
      setShares(list => list?.map(s => s.id === next.id ? next : s) ?? null);
      setAnnounce(value ? "PLY download allowed for this link." : "PLY download turned off for this link.");
    } catch (e) { setError((e as Error).message); }
    finally { setBusy(null); }
  }
  async function revoke(share: Share) {
    setBusy(share.id); setError("");
    try {
      const { share: next } = await shareApi<{ share: Share }>(`${base}/${encodeURIComponent(share.id)}/revoke`, { method: "POST" });
      setShares(list => list?.map(s => s.id === next.id ? next : s) ?? null);
      if (created?.share.id === share.id) setCreated(null);
      setConfirming(null); setAnnounce("Link revoked. It no longer opens the scene.");
    } catch (e) { setError((e as Error).message); }
    finally { setBusy(null); }
  }

  const active = shares?.filter(s => !s.revoked_at) ?? [];
  return <section className="share-panel" aria-labelledby={`${ids}-title`}>
    <button type="button" className="share-toggle" aria-expanded={open} aria-controls={`${ids}-body`} onClick={toggle}>
      <Link2 size={16} aria-hidden="true" /> <span id={`${ids}-title`}>Share</span>
      {shares && active.length > 0 && <span className="share-count">{active.length} active</span>}
    </button>
    <p className="sr-only" role="status" aria-live="polite">{announce}</p>
    {open && <div id={`${ids}-body`} className="share-body">
      <p className="share-help">Anyone with a link can view this scene, read-only. Your photos are never shared. Revoke a link to turn it off.</p>
      <div className="share-create">
        <label className="share-check"><input type="checkbox" checked={allowDownload} onChange={e => setAllowDownload(e.target.checked)} /> Allow PLY download</label>
        <button type="button" className="primary small" disabled={busy !== null} onClick={() => void create()}>
          {busy === "create" ? <LoaderCircle className="spin" size={16} aria-hidden="true" /> : <Link2 size={16} aria-hidden="true" />} Create link
        </button>
      </div>
      {error && <div className="notice error" role="alert">{error}</div>}
      {created && <div className="share-created">
        <p className="share-once"><strong>Copy this link now.</strong> For your security it is shown only once.</p>
        <label className="field-label" htmlFor={`${ids}-link`}>Link</label>
        <div className="share-copy-row">
          <input id={`${ids}-link`} readOnly value={link} onFocus={e => e.currentTarget.select()} />
          <button type="button" className="share-copy" onClick={() => void copy(link, "Link")}><Copy size={14} aria-hidden="true" /> Copy</button>
        </div>
        <label className="field-label" htmlFor={`${ids}-embed`}>Embed code</label>
        <div className="share-copy-row">
          <textarea id={`${ids}-embed`} readOnly rows={3} value={snippet} onFocus={e => e.currentTarget.select()} />
          <button type="button" className="share-copy" onClick={() => void copy(snippet, "Embed code")}><Copy size={14} aria-hidden="true" /> Copy</button>
        </div>
        <button type="button" className="text-button" onClick={() => setCreated(null)}>Done</button>
      </div>}
      {shares === null ? !error && <p className="share-help" role="status">Loading links…</p>
        : shares.length === 0 ? <p className="share-help">No links yet.</p>
        : <ul className="share-list" aria-label="Share links">
          {shares.map(share => {
            const revoked = !!share.revoked_at;
            const label = `link created ${formatCreated(share.created_at)}`;
            return <li key={share.id} className={revoked ? "revoked" : ""}>
              <div className="share-line">
                <span><strong>Link created {formatCreated(share.created_at)}</strong><small>{share.views} {share.views === 1 ? "view" : "views"} · {revoked ? `revoked ${formatDate(share.revoked_at!)}` : "active"}</small></span>
                {revoked ? <span className="share-state">Revoked</span> : confirming === share.id
                  ? <span className="share-confirm" role="group" aria-label={`Confirm revoking the ${label}`}>
                    <button type="button" className="share-danger" disabled={busy !== null} onClick={() => void revoke(share)}>{busy === share.id ? "Revoking…" : "Revoke"}</button>
                    <button type="button" className="text-button" onClick={() => setConfirming(null)}>Cancel</button>
                  </span>
                  : <button type="button" className="text-button" disabled={busy !== null} aria-label={`Revoke the ${label}`} onClick={() => setConfirming(share.id)}>Revoke…</button>}
              </div>
              {!revoked && <label className="share-check"><input type="checkbox" aria-label={`Allow PLY download for the ${label}`} checked={share.allow_download} disabled={busy !== null} onChange={e => void setDownload(share, e.target.checked)} /> Allow PLY download</label>}
            </li>;
          })}
        </ul>}
    </div>}
  </section>;
}
