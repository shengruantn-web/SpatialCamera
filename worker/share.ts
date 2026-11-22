/**
 * S8 (ADR-0010, PRD R5.4, spec §7.9): read-only share links and embeds.
 *
 * A link is a 128-bit random bearer token. The owner sees it once, when it is created; the database keeps
 * only its SHA-256 (`shares.token_hash`, unique index), so every public request hashes the presented token
 * and looks the link up by that index. A public request is served only while the link is not revoked and
 * its capture is `ready`, and that is checked on every request, scene bytes included, so revoking a link
 * (or deleting or resubmitting the capture) takes effect on the next request.
 */
import { legacyResultKey, publishedSpzKey, type ApiEnv } from "./api";

export interface ShareEnv extends ApiEnv {
  /** Public requests per client IP per minute, per isolate (default DEFAULT_SHARE_RATE_LIMIT). */
  SHARE_RATE_LIMIT?: string;
}

/** Active (unrevoked) links one capture may have at a time. */
export const MAX_ACTIVE_SHARES = 20;
/** 16 random bytes, base64url without padding. */
const TOKEN_PATTERN = /^[A-Za-z0-9_-]{22}$/;
const PUBLIC_ROUTE = /^\/s\/([^/]+)(?:\/(embed|info|scene|download))?$/;
const json = (value: unknown, status = 200, headers: Record<string, string> = {}) =>
  Response.json(value, { status, headers: { "Cache-Control": "no-store", ...headers } });

export function newShareToken() {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
/** Lowercase hex SHA-256: what `shares.token_hash` holds. */
export async function hashShareToken(token: string) {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token)));
  return Array.from(digest, b => b.toString(16).padStart(2, "0")).join("");
}

// ---------------------------------------------------------------------------------------------------
// Owner API: /api/captures/:id/shares[/:shareId[/revoke]]. Called by handleApi after it has loaded the
// capture for the signed-in owner and checked the request's origin, so `capture` is always the caller's.
// ---------------------------------------------------------------------------------------------------

type ShareRow = { id: string; created_at: number; revoked_at: number | null; views: number; allow_download: number };
const shareColumns = "id,created_at,revoked_at,views,allow_download";
/** What the owner sees. Never the token (it is not stored) or its hash. */
const toShare = (row: ShareRow) => ({
  id: row.id, created_at: row.created_at, revoked_at: row.revoked_at, views: row.views, allow_download: Boolean(row.allow_download),
});

async function smallJson(request: Request): Promise<Record<string, unknown> | null> {
  if (Number(request.headers.get("content-length") || 0) > 4096) return null;
  const text = await request.text().catch(() => null);
  if (text == null || text.length > 4096) return null;
  if (!text.trim()) return {};
  try {
    const value: unknown = JSON.parse(text);
    return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
  } catch { return null; }
}

export async function handleOwnerShares(request: Request, env: ApiEnv, capture: { id: string; status: string }, rest: string[], now: number): Promise<Response> {
  const db = env.DB;
  const id = capture.id;
  if (rest.length === 0 && request.method === "GET") {
    const { results } = await db.prepare(`SELECT ${shareColumns} FROM shares WHERE capture_id=? ORDER BY created_at DESC LIMIT 100`).bind(id).all<ShareRow>();
    return json({ shares: results.map(toShare) });
  }
  if (rest.length === 0 && request.method === "POST") {
    const body = await smallJson(request);
    if (!body || (body.allow_download !== undefined && typeof body.allow_download !== "boolean")) return json({ error: "Invalid share settings." }, 400);
    if (capture.status !== "ready") return json({ error: "Only a finished scene can be shared." }, 409);
    const active = await db.prepare("SELECT COUNT(*) AS n FROM shares WHERE capture_id=? AND revoked_at IS NULL").bind(id).first<{ n: number }>();
    if ((active?.n ?? 0) >= MAX_ACTIVE_SHARES) return json({ error: `A capture can have at most ${MAX_ACTIVE_SHARES} active links. Revoke one first.` }, 409);
    const token = newShareToken();
    const row: ShareRow = { id: crypto.randomUUID(), created_at: now, revoked_at: null, views: 0, allow_download: body.allow_download ? 1 : 0 };
    // Conditional on the capture still being ready, so a link is never created for one being deleted.
    const inserted = await db.prepare("INSERT INTO shares (id,capture_id,token_hash,created_at,allow_download) SELECT ?,?,?,?,? WHERE EXISTS (SELECT 1 FROM captures WHERE id=? AND status='ready')")
      .bind(row.id, id, await hashShareToken(token), now, row.allow_download, id).run();
    if (!inserted.meta.changes) return json({ error: "Only a finished scene can be shared." }, 409);
    // The only response that ever contains the token.
    return json({ share: toShare(row), token, path: `/s/${token}` }, 201);
  }
  const shareId = rest[0] ?? "";
  const load = () => db.prepare(`SELECT ${shareColumns} FROM shares WHERE id=? AND capture_id=?`).bind(shareId, id).first<ShareRow>();
  if (rest.length === 1 && request.method === "PATCH") {
    const body = await smallJson(request);
    if (!body || typeof body.allow_download !== "boolean") return json({ error: "Invalid share settings." }, 400);
    const updated = await db.prepare("UPDATE shares SET allow_download=? WHERE id=? AND capture_id=? AND revoked_at IS NULL").bind(body.allow_download ? 1 : 0, shareId, id).run();
    const row = await load();
    if (!row) return json({ error: "Link not found." }, 404);
    if (!updated.meta.changes) return json({ error: "This link was revoked." }, 409);
    return json({ share: toShare(row) });
  }
  if (rest.length === 2 && rest[1] === "revoke" && request.method === "POST") {
    // Idempotent: revoking a revoked link keeps its first revocation time.
    await db.prepare("UPDATE shares SET revoked_at=? WHERE id=? AND capture_id=? AND revoked_at IS NULL").bind(now, shareId, id).run();
    const row = await load();
    if (!row) return json({ error: "Link not found." }, 404);
    return json({ share: toShare(row) });
  }
  return json({ error: "Not found." }, 404);
}

// ---------------------------------------------------------------------------------------------------
// Best-effort rate limiter for the public routes.
//
// There is no rate-limiting binding in this deployment, so this is a fixed one-minute window per client
// IP (`CF-Connecting-IP`) held in module memory. Limits, stated plainly:
// - It is per isolate. Cloudflare runs many isolates across many locations, so the effective global limit
//   is the per-isolate limit times however many isolates a client's requests happen to reach; an isolate
//   that is evicted forgets its counts.
// - Clients behind one NAT share a budget; a client with many IPs gets many budgets.
// - Memory is bounded at MAX_TRACKED_CLIENTS windows; past that the oldest windows are forgotten early.
// It stops a single client hammering one isolate (scraping, accidental refresh loops) and keeps D1 and R2
// load per isolate bounded. Token guessing is not what it protects against: a 128-bit token cannot be
// guessed. Replace it with a Workers Rate Limiting binding or a WAF rule when one is available.
// ---------------------------------------------------------------------------------------------------

export const DEFAULT_SHARE_RATE_LIMIT = 120;
const RATE_WINDOW_MS = 60_000;
const MAX_TRACKED_CLIENTS = 10_000;
const windows = new Map<string, { start: number; count: number }>();

/** Counts one request; returns 0 when allowed, otherwise the seconds until the client's window resets. */
export function takeRateLimit(client: string, limit: number, now = Date.now()) {
  let entry = windows.get(client);
  if (!entry || now - entry.start >= RATE_WINDOW_MS) {
    windows.delete(client);
    // A window is (re)inserted when it starts, so iteration order is oldest window first.
    for (const key of windows.keys()) {
      if (windows.size < MAX_TRACKED_CLIENTS) break;
      windows.delete(key);
    }
    entry = { start: now, count: 0 };
    windows.set(client, entry);
  }
  if (entry.count >= limit) return Math.max(1, Math.ceil((entry.start + RATE_WINDOW_MS - now) / 1000));
  entry.count++;
  return 0;
}

// ---------------------------------------------------------------------------------------------------
// Public routes (worker/index.ts sends every /s/* request here; no gateway identity is read):
//   GET /s/:token            share page (vinext app route app/s/[token]); counts a view
//   GET /s/:token/embed      chrome-free page for <iframe>; counts a view; embeddable by any site
//   GET /s/:token/info       {name, format, scene_bytes, download, download_bytes} for those pages
//   GET /s/:token/scene      the SPZ, or the PLY when the capture has no SPZ
//   GET /s/:token/download   the PLY as an attachment, only when the owner allowed downloads
// Anything else under /s/ is 404. A revoked, unknown or malformed token, or a capture that is not
// `ready`, gets the same 404 on every route, so a response never tells those cases apart.
// ---------------------------------------------------------------------------------------------------

type SharedCapture = {
  share_id: string; allow_download: number; name: string; status: string; capture_id: string;
  result_key: string | null; result_bytes: number | null; spz_key: string | null; spz_bytes: number | null;
};
/** Only the columns serving needs: never the owner, photos, lease, error or other ids. */
const SHARED_SELECT = `SELECT s.id AS share_id,s.allow_download,c.id AS capture_id,c.name,c.status,c.result_key,c.result_bytes,c.spz_key,c.spz_bytes
  FROM shares s JOIN captures c ON c.id=s.capture_id WHERE s.token_hash=? AND s.revoked_at IS NULL AND c.status='ready'`;

/** Every public response: no token in Referer headers sent onward, not indexed, no sniffing. */
const BASE_HEADERS = { "Referrer-Policy": "no-referrer", "X-Robots-Tag": "noindex, nofollow", "X-Content-Type-Options": "nosniff" };
/** Data responses (JSON, scene bytes) are never documents: no scripts, no framing. */
const DATA_CSP = "default-src 'none'; frame-ancestors 'none'; sandbox";
const PAGE_FRAMING = {
  page: { "Content-Security-Policy": "frame-ancestors 'none'", "X-Frame-Options": "DENY" },
  // The embed is the one response any site may frame. No X-Frame-Options: it would override nothing in
  // modern browsers but block older ones.
  embed: { "Content-Security-Policy": "frame-ancestors *" },
} as const;

function notFound(page: boolean) {
  const headers = { ...BASE_HEADERS, "Cache-Control": "no-store" };
  if (!page) return json({ error: "This link is not available." }, 404, { ...headers, "Content-Security-Policy": DATA_CSP });
  return new Response("<!doctype html><meta charset=\"utf-8\"><meta name=\"viewport\" content=\"width=device-width\"><title>Link not available</title><body style=\"font-family:system-ui,sans-serif;padding:2rem;max-width:36rem\"><h1>This link is not available</h1><p>It may have been revoked, or the scene is no longer shared.</p></body>",
    { status: 404, headers: { ...headers, "Content-Type": "text/html; charset=utf-8", "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors *" } });
}

/**
 * Scene bytes: `private, no-cache` with the object's ETag. The browser may keep the bytes but must ask
 * again before every use; each such request runs the full token check, and an unchanged scene answers
 * 304 without resending the body. A revoked link therefore stops working on the next view, while repeat
 * views of a live link cost no download. Shared caches never store it (`private`).
 */
async function objectResponse(env: ShareEnv, request: Request, key: string, mime: string, headers: Record<string, string>, conditional: boolean) {
  const object = await env.BUCKET.get(key, conditional ? { onlyIf: request.headers } : {});
  if (!object) return notFound(false);
  const common = { ...BASE_HEADERS, "Content-Security-Policy": DATA_CSP, ETag: object.httpEtag, ...headers };
  if (!("body" in object)) return new Response(null, { status: 304, headers: common });
  return new Response(request.method === "HEAD" ? null : object.body, { headers: { "Content-Type": mime, "Content-Length": String(object.size), ...common } });
}

/**
 * True for /s and /s/*, however the first segment is spelled or percent-encoded. worker/index.ts sends all
 * of these here, so a spelling the app router would decode or fold to /s/ (`/%73/…`, `/S/…`, `//s/…`)
 * can never render the share page without the token check.
 */
export function isSharePath(pathname: string) {
  let decoded = pathname;
  try { decoded = decodeURIComponent(pathname); } catch { /* malformed: test the raw path */ }
  return /^\/+s(\/|$)/i.test(decoded) || /^\/+s(\/|$)/i.test(pathname);
}

const isPrefetch = (request: Request) => {
  const purpose = request.headers.get("sec-purpose") ?? request.headers.get("purpose") ?? "";
  return /prefetch|prerender/i.test(purpose);
};

/**
 * `renderPage` renders the vinext app route for the request (the share page or the embed). It is only
 * called after the token was checked, so the page itself never sees a link that is not live.
 */
export async function handleSharePublic(request: Request, env: ShareEnv, renderPage: (request: Request) => Promise<Response>): Promise<Response> {
  const url = new URL(request.url);
  const match = PUBLIC_ROUTE.exec(url.pathname);
  const route = match ? (match[2] ?? "page") as "page" | "embed" | "info" | "scene" | "download" : null;
  const isPage = route === "page" || route === "embed" || route === null;
  if (request.method !== "GET" && request.method !== "HEAD") {
    return json({ error: "Method not allowed." }, 405, { ...BASE_HEADERS, Allow: "GET, HEAD", "Content-Security-Policy": DATA_CSP });
  }
  const limit = Math.floor(Number(env.SHARE_RATE_LIMIT)) > 0 ? Math.floor(Number(env.SHARE_RATE_LIMIT)) : DEFAULT_SHARE_RATE_LIMIT;
  const retryAfter = takeRateLimit(request.headers.get("cf-connecting-ip") ?? "unknown", limit);
  if (retryAfter) {
    return json({ error: "Too many requests. Try again shortly." }, 429, { ...BASE_HEADERS, "Retry-After": String(retryAfter), "Content-Security-Policy": DATA_CSP });
  }
  const token = match?.[1] ?? "";
  if (!route || !TOKEN_PATTERN.test(token)) return notFound(isPage);
  if (!env.DB || !env.BUCKET) return json({ error: "Sharing is not available right now." }, 503, { ...BASE_HEADERS, "Content-Security-Policy": DATA_CSP });
  const hash = await hashShareToken(token);

  if (route === "page" || route === "embed") {
    // One statement checks the link and counts the view. HEAD and prefetches are checked, not counted.
    const counted = request.method === "GET" && !isPrefetch(request);
    const live = counted
      ? await env.DB.prepare("UPDATE shares SET views=views+1 WHERE token_hash=? AND revoked_at IS NULL AND EXISTS (SELECT 1 FROM captures WHERE id=shares.capture_id AND status='ready') RETURNING id").bind(hash).first()
      : await env.DB.prepare(SHARED_SELECT).bind(hash).first();
    if (!live) return notFound(true);
    const rendered = await renderPage(request);
    const response = new Response(rendered.body, rendered);
    for (const [name, value] of Object.entries({ ...BASE_HEADERS, ...PAGE_FRAMING[route], "Cache-Control": "no-store" })) response.headers.set(name, value);
    if (route === "embed") response.headers.delete("X-Frame-Options");
    return response;
  }

  const shared = await env.DB.prepare(SHARED_SELECT).bind(hash).first<SharedCapture>();
  if (!shared) return notFound(false);
  const spzKey = publishedSpzKey({ status: shared.status, result_key: shared.result_key, spz_key: shared.spz_key, spz_bytes: shared.spz_bytes });
  const plyKey = shared.result_key ?? legacyResultKey(shared.capture_id);
  const download = Boolean(shared.allow_download);
  if (route === "info") {
    return json({
      name: shared.name, format: spzKey ? "spz" : "ply", scene_bytes: spzKey ? shared.spz_bytes : shared.result_bytes,
      download, download_bytes: download ? shared.result_bytes : null,
    }, 200, { ...BASE_HEADERS, "Content-Security-Policy": DATA_CSP });
  }
  if (route === "scene") {
    // The PLY is served here only when the capture has no SPZ: it is then the only scene there is.
    return objectResponse(env, request, spzKey ?? plyKey, spzKey ? "application/x-spz" : "application/octet-stream", {
      "Cache-Control": "private, no-cache", "X-Splat-Format": spzKey ? "spz" : "ply",
    }, true);
  }
  // route === "download": the full-precision PLY, only with the owner's opt-in.
  if (!download) return notFound(false);
  return objectResponse(env, request, plyKey, "application/octet-stream", {
    "Cache-Control": "private, no-store", "Content-Disposition": 'attachment; filename="spatial-capture.ply"',
  }, false);
}
