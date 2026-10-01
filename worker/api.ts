import { isGaussianPly, isImage, validateManifest, MAX_IMAGE_BYTES } from "../lib/validation";

export interface ApiEnv {
  DB: D1Database;
  BUCKET: R2Bucket;
  WORKER_TOKEN?: string;
  LOCAL_DEV?: string;
}
type Job = { id: string; owner: string; status: string; lease: string | null; image_count: number; updated_at: number };
type ImageRow = { id: string; name: string; bytes: number; mime: string; uploaded: number };
const active = ["aligning", "training", "exporting"];
const publicColumns = "c.id,c.name,c.status,c.created_at,c.updated_at,c.image_count,c.error,c.result_bytes,(SELECT COUNT(*) FROM images WHERE capture_id=c.id AND uploaded=1) AS uploaded_count";
const json = (value: unknown, status = 200) => Response.json(value, { status, headers: { "Cache-Control": "no-store" } });
class ApiError extends Error { constructor(message: string, public status = 400) { super(message); } }
function fail(message: string, status = 400): never { throw new ApiError(message, status); }

async function init(db: D1Database) {
  await db.batch([
    db.prepare("CREATE TABLE IF NOT EXISTS captures (id TEXT PRIMARY KEY,owner TEXT NOT NULL,name TEXT NOT NULL,status TEXT NOT NULL DEFAULT 'uploading',created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL,image_count INTEGER NOT NULL,error TEXT,lease TEXT,result_bytes INTEGER)"),
    db.prepare("CREATE TABLE IF NOT EXISTS images (id TEXT PRIMARY KEY,capture_id TEXT NOT NULL,name TEXT NOT NULL,bytes INTEGER NOT NULL,mime TEXT NOT NULL,uploaded INTEGER NOT NULL DEFAULT 0)"),
    db.prepare("CREATE TABLE IF NOT EXISTS worker_health (id TEXT PRIMARY KEY,last_seen INTEGER NOT NULL)"),
  ]);
}
async function boundedBody(request: Request, max: number) {
  if (Number(request.headers.get("content-length") || 0) > max) fail("File is too large.", 413);
  const reader = request.body?.getReader();
  if (!reader) fail("An upload is required.");
  const chunks: Uint8Array[] = [];
  let length = 0;
  while (true) {
    const { value, done } = await reader.read();
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
  while (!header.includes("end_header") && header.length < 16384) {
    const next = await reader.read();
    if (next.done) break;
    prefix.push(next.value);
    header += new TextDecoder().decode(next.value.slice(0, 16384 - header.length));
  }
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
  catch { await reader.cancel().catch(() => {}); fail("The result upload was incomplete. Please retry."); }
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
    await init(env.DB);
    const now = Date.now();

    // Expired worker leases become actionable failures, never fabricated progress.
    await env.DB.prepare("UPDATE captures SET status='failed',error='The processor stopped responding. Retry this capture when it reconnects.',lease=NULL,updated_at=? WHERE status IN ('aligning','training','exporting') AND updated_at < ?").bind(now, now - 10 * 60_000).run();

    if (isWorker) {
      await env.DB.prepare("INSERT INTO worker_health (id,last_seen) VALUES ('gpu',?) ON CONFLICT(id) DO UPDATE SET last_seen=excluded.last_seen").bind(now).run();
      if (path[2] === "claim" && request.method === "POST") {
        const lease = crypto.randomUUID();
        const job = await env.DB.prepare("UPDATE captures SET status='aligning',lease=?,updated_at=? WHERE id=(SELECT id FROM captures WHERE status='queued' ORDER BY created_at LIMIT 1) AND status='queued' RETURNING id,image_count").bind(lease, now).first();
        if (!job) return json({ job: null });
        const images = await env.DB.prepare("SELECT id,name,mime FROM images WHERE capture_id=? AND uploaded=1 ORDER BY id").bind(job.id).all();
        return json({ job: { ...job, lease, images: images.results } });
      }
      const job = await env.DB.prepare("SELECT * FROM captures WHERE id=?").bind(path[2] ?? "").first<Job>();
      if (!job || !active.includes(job.status) || job.lease !== request.headers.get("x-job-lease")) fail("Job lease expired or invalid.", 409);
      if (path[3] === "images" && request.method === "GET") {
        const image = await env.DB.prepare("SELECT * FROM images WHERE id=? AND capture_id=? AND uploaded=1").bind(path[4] ?? "", job.id).first<ImageRow>();
        if (!image) fail("Photo not found.", 404);
        return objectResponse(env, `${job.id}/images/${image.id}`, image.mime);
      }
      if (path[3] === "status" && request.method === "PATCH") {
        const input = await readJson(request);
        const next = input.status;
        if (next !== "failed" && (!active.includes(next) || active.indexOf(next) < active.indexOf(job.status) || active.indexOf(next) > active.indexOf(job.status) + 1)) fail("Invalid processing transition.");
        const error = next === "failed" ? String(input.error ?? "Reconstruction failed. Try a capture with more overlap.").slice(0, 400) : null;
        const result = await env.DB.prepare("UPDATE captures SET status=?,error=?,updated_at=? WHERE id=? AND lease=? AND status=?").bind(next, error, now, job.id, job.lease, job.status).run();
        if (!result.meta.changes) fail("Job changed while updating.", 409);
        return json({ ok: true });
      }
      if (path[3] === "result" && request.method === "PUT") {
        if (job.status !== "exporting") fail("The capture is not ready for export.", 409);
        const bytes = await storeSplat(request, env.BUCKET, `${job.id}/result.ply`);
        const result = await env.DB.prepare("UPDATE captures SET status='ready',result_bytes=?,updated_at=?,lease=NULL,error=NULL WHERE id=? AND lease=? AND status='exporting'").bind(bytes, now, job.id, job.lease).run();
        if (!result.meta.changes) fail("Job lease expired.", 409);
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
      const results = await env.DB.prepare(`SELECT ${publicColumns} FROM captures c WHERE owner=? ORDER BY created_at DESC LIMIT 100`).bind(owner).all();
      return json({ captures: results.results });
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
    const id = path[2];
    const job = await env.DB.prepare("SELECT * FROM captures WHERE id=? AND owner=?").bind(id ?? "", owner).first<Job>();
    if (!job) fail("Capture not found.", 404);
    if (path.length === 3 && request.method === "GET") {
      const capture = await env.DB.prepare(`SELECT ${publicColumns} FROM captures c WHERE id=?`).bind(id).first();
      const images = await env.DB.prepare("SELECT id,name,bytes,mime,uploaded FROM images WHERE capture_id=? ORDER BY id").bind(id).all();
      return json({ capture, images: images.results });
    }
    if (path[3] === "images") {
      const image = await env.DB.prepare("SELECT * FROM images WHERE id=? AND capture_id=?").bind(path[4] ?? "", id).first<ImageRow>();
      if (!image) fail("Photo not found.", 404);
      if (request.method === "GET" && image.uploaded) return objectResponse(env, `${id}/images/${image.id}`, image.mime);
      if (request.method === "PUT") {
        if (job.status !== "uploading") fail("This capture no longer accepts photos.", 409);
        const bytes = await boundedBody(request, MAX_IMAGE_BYTES);
        if (bytes.length !== image.bytes || !isImage(bytes, image.mime)) fail("Photo content does not match its upload manifest.");
        await env.BUCKET.put(`${id}/images/${image.id}`, bytes, { httpMetadata: { contentType: image.mime } });
        await env.DB.prepare("UPDATE images SET uploaded=1 WHERE id=?").bind(image.id).run();
        return json({ ok: true });
      }
    }
    if (path[3] === "submit" && request.method === "POST") {
      if (!["uploading", "failed"].includes(job.status)) return json({ status: job.status });
      const count = await env.DB.prepare("SELECT COUNT(*) AS count FROM images WHERE capture_id=? AND uploaded=1").bind(id).first<{ count: number }>();
      if (count?.count !== job.image_count) fail("Upload all photos before starting reconstruction.", 409);
      await env.DB.prepare("UPDATE captures SET status='queued',error=NULL,lease=NULL,updated_at=? WHERE id=? AND status IN ('uploading','failed')").bind(now, id).run();
      return json({ status: "queued" });
    }
    if (path[3] === "result.ply" && request.method === "GET") {
      if (job.status !== "ready") fail("The scene is not ready yet.", 409);
      return objectResponse(env, `${id}/result.ply`, "application/octet-stream", url.searchParams.has("download") ? "spatial-capture.ply" : undefined);
    }
    fail("Not found.", 404);
  } catch (error) {
    if (error instanceof ApiError) return json({ error: error.message }, error.status);
    if (error instanceof Error && /Give your|Choose |Use JPG|photo|capture under|Invalid capture/.test(error.message)) return json({ error: error.message }, 400);
    console.error("Capture API error", error);
    return json({ error: "Something went wrong on the server. Your saved captures are safe; please try again." }, 500);
  }
}
