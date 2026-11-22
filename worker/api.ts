import { isGaussianPly, isImage, parseWorkerMetrics, validateManifest, MAX_IMAGE_BYTES } from "../lib/validation";

export interface ApiEnv {
  DB: D1Database;
  BUCKET: R2Bucket;
  WORKER_TOKEN?: string;
  LOCAL_DEV?: string;
}
type Job = {
  id: string; owner: string; status: string; lease: string | null; image_count: number; updated_at: number;
  result_key: string | null;
};
type ImageRow = { id: string; name: string; bytes: number; mime: string; uploaded: number; object_key: string | null };
const active = ["aligning", "training", "exporting"];
/** A job whose `updated_at` is older than this in an active state has lost its lease (spec §1). */
export const LEASE_TTL_MS = 10 * 60_000;
// Transient upload/storage failures are 503 so clients retry; 400 means the payload itself is wrong.
const RETRY_UPLOAD = "The upload was interrupted or could not be stored. Please retry.";
const STALE_ERROR = "The processor stopped responding. Retry this capture when it reconnects.";
// Everything the owner may see. Never includes lease, result_key or R2 object keys.
const publicFields = ["id", "name", "status", "created_at", "updated_at", "image_count", "uploaded_count", "error", "result_bytes",
  "queued_at", "aligning_at", "training_at", "exporting_at", "ready_at", "failed_at", "alignment_ratio"] as const;
const publicColumns = publicFields.join(",");
// Past `uploading` every manifest image is uploaded (I2) and frozen (I5), so `uploaded_count` is
// `image_count`. Reading it that way keeps rows created before the counter existed correct without a
// data backfill; while `uploading`, every image PUT recounts it (§7.2).
const toPublic = (row: Record<string, unknown>) => Object.fromEntries(publicFields.map(field =>
  [field, (field === "uploaded_count" && row.status !== "uploading" ? row.image_count : row[field]) ?? null]));
const json = (value: unknown, status = 200) => Response.json(value, { status, headers: { "Cache-Control": "no-store" } });
class ApiError extends Error { constructor(message: string, public status = 400) { super(message); } }
function fail(message: string, status = 400): never { throw new ApiError(message, status); }

const isStale = (row: { status?: unknown; updated_at?: unknown }, now: number) =>
  active.includes(String(row.status)) && Number(row.updated_at) < now - LEASE_TTL_MS;
/**
 * Expired worker leases become actionable failures, never fabricated progress.
 * Runs from the Cron Trigger (worker/index.ts `scheduled`), on every claim, and from the owner list only
 * when it returned a stale row — never unconditionally per request.
 */
export async function sweepStaleLeases(db: D1Database, now = Date.now()) {
  const [expired] = await db.batch([
    db.prepare("UPDATE captures SET status='failed',error=?,lease=NULL,failed_at=?,updated_at=? WHERE status IN ('aligning','training','exporting') AND updated_at < ?")
      .bind(STALE_ERROR, now, now, now - LEASE_TTL_MS),
    // I1 repair: before S2 a worker-reported `failed` kept its lease (`ready` always cleared it).
    // Clears those rows in bounded batches over the status index instead of a migration backfill.
    db.prepare("UPDATE captures SET lease=NULL WHERE id IN (SELECT id FROM captures WHERE status='failed' AND lease IS NOT NULL LIMIT 100)"),
  ]);
  return expired.meta.changes;
}
/** Same as the sweep, for one capture already read and found stale (keeps reads write-free otherwise). */
async function expireCapture(db: D1Database, id: string, now: number) {
  await db.prepare("UPDATE captures SET status='failed',error=?,lease=NULL,failed_at=?,updated_at=? WHERE id=? AND status IN ('aligning','training','exporting') AND updated_at < ?")
    .bind(STALE_ERROR, now, now, id, now - LEASE_TTL_MS).run();
}
export async function handleScheduled(env: Pick<ApiEnv, "DB">) {
  if (env.DB) await sweepStaleLeases(env.DB);
}
/** Leases are bearer secrets, so R2 keys carry a digest of the lease rather than the lease itself. */
async function resultKeyFor(id: string, lease: string) {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(lease)));
  const attempt = Array.from(digest.slice(0, 16), b => b.toString(16).padStart(2, "0")).join("");
  return `${id}/attempts/${attempt}/result.ply`;
}
const legacyResultKey = (id: string) => `${id}/result.ply`;
const imageKey = (captureId: string, image: ImageRow) => image.object_key ?? `${captureId}/images/${image.id}`;

async function boundedBody(request: Request, max: number) {
  if (Number(request.headers.get("content-length") || 0) > max) fail("File is too large.", 413);
  const reader = request.body?.getReader();
  if (!reader) fail("An upload is required.");
  const chunks: Uint8Array[] = [];
  let length = 0;
  while (true) {
    const { value, done } = await reader.read().catch(() => fail(RETRY_UPLOAD, 503));
    if (done) break;
    length += value.length;
    if (length > max) { await reader.cancel(); fail("File is too large.", 413); }
    chunks.push(value);
  }
  const result = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) { result.set(chunk, offset); offset += chunk.length; }
  return result;
}
async function readJson(request: Request) {
  try { return JSON.parse(new TextDecoder().decode(await boundedBody(request, 128 * 1024))); }
  catch (error) { if (error instanceof ApiError) throw error; fail("Invalid JSON."); }
}
async function storeSplat(request: Request, bucket: R2Bucket, key: string) {
  const length = Number(request.headers.get("content-length"));
  if (!Number.isSafeInteger(length) || length <= 0 || length > 90 * 1024 * 1024) fail("Supply a PLY with Content-Length between 1 byte and 90 MB.", 413);
  const reader = request.body?.getReader();
  if (!reader) fail("A PLY is required.");
  // Inspect only the header; stream the large result without duplicating it in Worker memory.
  const prefix: Uint8Array[] = [];
  let header = "";
  try {
    while (!header.includes("end_header") && header.length < 16384) {
      const next = await reader.read();
      if (next.done) break;
      prefix.push(next.value);
      header += new TextDecoder().decode(next.value.slice(0, 16384 - header.length));
    }
  } catch { fail(RETRY_UPLOAD, 503); }
  if (!isGaussianPly(header)) { await reader.cancel(); fail("Expected a Gaussian-splat PLY with scale, rotation, opacity and color properties."); }
  const stream = new FixedLengthStream(length);
  const writer = stream.writable.getWriter();
  const pump = async () => {
    try {
      for (const chunk of prefix) await writer.write(chunk);
      while (true) { const next = await reader.read(); if (next.done) break; await writer.write(next.value); }
      await writer.close();
    } catch (error) { await writer.abort(error).catch(() => {}); throw error; }
  };
  try { await Promise.all([pump(), bucket.put(key, stream.readable, { httpMetadata: { contentType: "application/octet-stream" } })]); }
  // A broken request stream, short body or R2 error is transient: 503 so the worker retries (400 is final).
  catch { await reader.cancel().catch(() => {}); fail(RETRY_UPLOAD, 503); }
  return length;
}
async function verifyWorker(request: Request, env: ApiEnv) {
  if (!env.WORKER_TOKEN || env.WORKER_TOKEN.length < 32) fail("GPU worker authentication is not configured.", 503);
  const supplied = request.headers.get("authorization")?.replace(/^Bearer /, "") ?? "";
  const digest = async (s: string) => new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s)));
  const [a, b] = await Promise.all([digest(supplied), digest(env.WORKER_TOKEN)]);
  let difference = 0;
  for (let i = 0; i < a.length; i++) difference |= a[i] ^ b[i];
  if (difference) fail("Unauthorized worker.", 401);
}
async function objectResponse(env: ApiEnv, key: string, mime: string, name?: string) {
  const object = await env.BUCKET.get(key);
  if (!object) fail("File not found.", 404);
  return new Response(object.body, { headers: {
    "Content-Type": mime, "Content-Length": String(object.size), "Cache-Control": "private, no-store",
    "X-Content-Type-Options": "nosniff",
    ...(name ? { "Content-Disposition": `attachment; filename="${name}"` } : {}),
  } });
}

export async function handleApi(request: Request, env: ApiEnv): Promise<Response> {
  try {
    const url = new URL(request.url);
    const path = url.pathname.split("/").filter(Boolean);
    const isWorker = path[1] === "worker";
    if (!["GET", "HEAD"].includes(request.method) && !isWorker) {
      const origin = request.headers.get("origin");
      if (origin && origin !== url.origin) fail("Cross-origin requests are not allowed.", 403);
      if (request.headers.get("sec-fetch-site") === "cross-site") fail("Cross-site request rejected.", 403);
    }
    let owner = request.headers.get("oai-authenticated-user-email");
    if (!owner && env.LOCAL_DEV === "true" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)) owner = "local-developer";
    if (isWorker) await verifyWorker(request, env);
    else if (!owner) fail("Sign in to access your captures.", 401);
    if (!env.DB || !env.BUCKET) fail("Capture storage is not configured.", 503);
    // Schema comes from Drizzle migrations (drizzle/); no DDL or global sweep runs per request.
    const now = Date.now();

    if (isWorker) {
      await env.DB.prepare("INSERT INTO worker_health (id,last_seen) VALUES ('gpu',?) ON CONFLICT(id) DO UPDATE SET last_seen=excluded.last_seen").bind(now).run();
      if (path[2] === "claim" && request.method === "POST") {
        // Expire dead attempts first so their captures can be resubmitted.
        await sweepStaleLeases(env.DB, now);
        const lease = crypto.randomUUID();
        const job = await env.DB.prepare("UPDATE captures SET status='aligning',lease=?,aligning_at=?,updated_at=? WHERE id=(SELECT id FROM captures WHERE status='queued' ORDER BY created_at LIMIT 1) AND status='queued' RETURNING id,image_count").bind(lease, now, now).first();
        if (!job) return json({ job: null });
        const images = await env.DB.prepare("SELECT id,name,mime FROM images WHERE capture_id=? AND uploaded=1 ORDER BY id").bind(job.id).all();
        return json({ job: { ...job, lease, images: images.results } });
      }
      const job = await env.DB.prepare("SELECT * FROM captures WHERE id=?").bind(path[2] ?? "").first<Job>();
      const lease = request.headers.get("x-job-lease") ?? "";
      const isResultPut = path[3] === "result" && request.method === "PUT";
      // Idempotent finalisation: the attempt that published the result may repeat its PUT (e.g. the
      // response was lost) and gets 200 without rewriting. Recognised by its result key, so `ready`
      // rows still hold no lease (I1).
      if (isResultPut && job?.status === "ready" && lease && job.result_key === await resultKeyFor(job.id, lease)) {
        await request.body?.cancel().catch(() => {});
        return json({ ok: true });
      }
      if (!job || !active.includes(job.status) || !lease || job.lease !== lease) fail("Job lease expired or invalid.", 409);
      if (isStale(job, now)) { await expireCapture(env.DB, job.id, now); fail("Job lease expired or invalid.", 409); }
      if (path[3] === "images" && request.method === "GET") {
        const image = await env.DB.prepare("SELECT * FROM images WHERE id=? AND capture_id=? AND uploaded=1").bind(path[4] ?? "", job.id).first<ImageRow>();
        if (!image) fail("Photo not found.", 404);
        return objectResponse(env, imageKey(job.id, image), image.mime);
      }
      if (path[3] === "status" && request.method === "PATCH") {
        const input = await readJson(request);
        if (!input || typeof input !== "object") fail("Invalid processing transition.");
        const next = input.status;
        if (next !== "failed" && (!active.includes(next) || active.indexOf(next) < active.indexOf(job.status) || active.indexOf(next) > active.indexOf(job.status) + 1)) fail("Invalid processing transition.");
        let alignmentRatio: number | null;
        try { ({ alignmentRatio } = parseWorkerMetrics(input.metrics)); }
        catch (error) { fail(error instanceof Error ? error.message : "Invalid worker metrics."); }
        const error = next === "failed" ? String(input.error ?? "Reconstruction failed. Try a capture with more overlap.").slice(0, 400) : null;
        // Timestamp taken after the body is read, and updated_at only moves forward: a delayed
        // heartbeat must never make a live job look older than it is (the sweep would fail it).
        // The lease must still be fresh at this moment, so a late heartbeat cannot revive an expired one.
        const at = Date.now();
        // Stamp the stage's entry time only on a real transition, not on a same-stage heartbeat.
        // Column names come from the fixed whitelist above (active stages + failed).
        const stamp = next !== job.status ? `,${next}_at=?` : "";
        const clearLease = next === "failed" ? ",lease=NULL" : "";
        const result = await env.DB.prepare(`UPDATE captures SET status=?,error=?,updated_at=MAX(updated_at,?),alignment_ratio=COALESCE(?,alignment_ratio)${stamp}${clearLease} WHERE id=? AND lease=? AND status=? AND updated_at>=?`)
          .bind(next, error, at, alignmentRatio, ...(stamp ? [at] : []), job.id, job.lease, job.status, at - LEASE_TTL_MS).run();
        if (!result.meta.changes) fail("Job changed while updating.", 409);
        return json({ ok: true });
      }
      if (isResultPut) {
        if (job.status !== "exporting") fail("The capture is not ready for export.", 409);
        // Each attempt writes its own key; only the conditional UPDATE below publishes it (T2).
        const key = await resultKeyFor(job.id, lease);
        const bytes = await storeSplat(request, env.BUCKET, key);
        // The lease must still be fresh when the upload completes, not just when it started: an
        // attempt that stopped heartbeating mid-upload has expired even if no sweep has run yet.
        // (The worker heartbeats throughout the upload, so a live long upload stays fresh.)
        const done = Date.now();
        const result = await env.DB.prepare("UPDATE captures SET status='ready',result_key=?,result_bytes=?,ready_at=?,updated_at=MAX(updated_at,?),lease=NULL,error=NULL WHERE id=? AND lease=? AND status='exporting' AND updated_at>=?")
          .bind(key, bytes, done, done, job.id, lease, done - LEASE_TTL_MS).run();
        if (!result.meta.changes) {
          const current = await env.DB.prepare("SELECT status,result_key FROM captures WHERE id=?").bind(job.id).first<Pick<Job, "status" | "result_key">>();
          // A concurrent duplicate PUT from this same attempt published first: same key, so keep it.
          if (current?.status === "ready" && current.result_key === key) return json({ ok: true });
          await env.BUCKET.delete(key).catch(error => console.error("Could not delete unpublished result", key, error));
          await expireCapture(env.DB, job.id, done);
          fail("Job lease expired.", 409);
        }
        return json({ ok: true });
      }
      fail("Unknown worker endpoint.", 404);
    }

    if (path[1] === "health" && request.method === "GET") {
      const health = await env.DB.prepare("SELECT last_seen FROM worker_health WHERE id='gpu'").first<{ last_seen: number }>();
      return json({ storage: true, processor: Boolean(env.WORKER_TOKEN && health && now - health.last_seen < 90_000) });
    }
    if (path[1] !== "captures") fail("Not found.", 404);
    if (path.length === 2 && request.method === "GET") {
      const list = () => env.DB.prepare(`SELECT ${publicColumns} FROM captures WHERE owner=? ORDER BY created_at DESC LIMIT 100`).bind(owner).all<Record<string, unknown>>();
      let results = (await list()).results;
      // Staleness is checked lazily so polling stays write-free; the cron sweep catches the rest.
      if (results.some(row => isStale(row, now))) { await sweepStaleLeases(env.DB, now); results = (await list()).results; }
      return json({ captures: results });
    }
    if (path.length === 2 && request.method === "POST") {
      const input = validateManifest(await readJson(request));
      const id = crypto.randomUUID();
      const images = input.images.map((image, index) => ({ ...image, id: `${String(index).padStart(4, "0")}-${crypto.randomUUID()}` }));
      // D1 batch is transactional: a partial manifest cannot enter the queue.
      await env.DB.batch([
        env.DB.prepare("INSERT INTO captures (id,owner,name,status,created_at,updated_at,image_count) VALUES (?,?,?,'uploading',?,?,?)").bind(id, owner, input.name, now, now, images.length),
        ...images.map(image => env.DB.prepare("INSERT INTO images (id,capture_id,name,bytes,mime) VALUES (?,?,?,?,?)").bind(image.id, id, image.name, image.bytes, image.mime)),
      ]);
      return json({ id, images }, 201);
    }
    const id = path[2] ?? "";
    const loadOwned = () => env.DB.prepare("SELECT * FROM captures WHERE id=? AND owner=?").bind(id, owner).first<Job & Record<string, unknown>>();
    let job = await loadOwned();
    if (!job) fail("Capture not found.", 404);
    if (isStale(job, now)) {
      await expireCapture(env.DB, id, now);
      job = await loadOwned();
      if (!job) fail("Capture not found.", 404);
    }
    if (path.length === 3 && request.method === "GET") {
      const images = await env.DB.prepare("SELECT id,name,bytes,mime,uploaded FROM images WHERE capture_id=? ORDER BY id").bind(id).all();
      return json({ capture: toPublic(job), images: images.results });
    }
    if (path[3] === "images") {
      const image = await env.DB.prepare("SELECT * FROM images WHERE id=? AND capture_id=?").bind(path[4] ?? "", id).first<ImageRow>();
      if (!image) fail("Photo not found.", 404);
      if (request.method === "GET" && image.uploaded) return objectResponse(env, imageKey(id, image), image.mime);
      if (request.method === "PUT") {
        if (job.status !== "uploading") fail("This capture no longer accepts photos.", 409);
        const bytes = await boundedBody(request, MAX_IMAGE_BYTES);
        if (bytes.length !== image.bytes || !isImage(bytes, image.mime)) fail("Photo content does not match its upload manifest.");
        // Inputs are frozen at submit (T3). Every upload goes to a fresh key that nothing reads until
        // the conditional UPDATE below points the image at it, and that UPDATE only succeeds while the
        // capture is still `uploading`. A PUT that loses to submit deletes its object and gets 409, so
        // a queued/claimed capture's referenced bytes are never overwritten.
        const key = `${id}/uploads/${image.id}/${crypto.randomUUID()}`;
        await env.BUCKET.put(key, bytes, { httpMetadata: { contentType: image.mime } }).catch(() => fail(RETRY_UPLOAD, 503));
        const [marked] = await env.DB.batch([
          env.DB.prepare("UPDATE images SET uploaded=1,object_key=? WHERE id=? AND capture_id=? AND EXISTS (SELECT 1 FROM captures WHERE id=? AND status='uploading')").bind(key, image.id, id, id),
          env.DB.prepare("UPDATE captures SET uploaded_count=(SELECT COUNT(*) FROM images WHERE capture_id=? AND uploaded=1) WHERE id=? AND status='uploading'").bind(id, id),
        ]);
        if (!marked.meta.changes) {
          await env.BUCKET.delete(key).catch(error => console.error("Could not delete rejected upload", key, error));
          fail("This capture no longer accepts photos.", 409);
        }
        // A re-upload replaced an earlier object; nothing references it any more.
        if (image.uploaded) await env.BUCKET.delete(imageKey(id, image)).catch(error => console.error("Could not delete replaced upload", error));
        return json({ ok: true });
      }
    }
    if (path[3] === "submit" && request.method === "POST") {
      if (!["uploading", "failed"].includes(job.status)) return json({ status: job.status });
      // One conditional statement keeps I2 atomic. Per-attempt metrics reset so they describe this run.
      const result = await env.DB.prepare("UPDATE captures SET status='queued',error=NULL,lease=NULL,queued_at=?,aligning_at=NULL,training_at=NULL,exporting_at=NULL,failed_at=NULL,alignment_ratio=NULL,updated_at=? WHERE id=? AND status IN ('uploading','failed') AND image_count=(SELECT COUNT(*) FROM images WHERE capture_id=captures.id AND uploaded=1)")
        .bind(now, now, id).run();
      if (!result.meta.changes) {
        const current = await loadOwned();
        if (current && !["uploading", "failed"].includes(current.status)) return json({ status: current.status });
        fail("Upload all photos before starting reconstruction.", 409);
      }
      return json({ status: "queued" });
    }
    if (path[3] === "result.ply" && request.method === "GET") {
      if (job.status !== "ready") fail("The scene is not ready yet.", 409);
      return objectResponse(env, job.result_key ?? legacyResultKey(id), "application/octet-stream", url.searchParams.has("download") ? "spatial-capture.ply" : undefined);
    }
    fail("Not found.", 404);
  } catch (error) {
    if (error instanceof ApiError) return json({ error: error.message }, error.status);
    if (error instanceof Error && /Give your|Choose |Use JPG|photo|capture under|Invalid capture/.test(error.message)) return json({ error: error.message }, 400);
    console.error("Capture API error", error);
    return json({ error: "Something went wrong on the server. Your saved captures are safe; please try again." }, 500);
  }
}
