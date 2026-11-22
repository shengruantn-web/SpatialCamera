import {
  isGaussianPly, isGzip, isImage, parseSpzHeader, parseWorkerMetrics, validateManifest, validateName, MAX_IMAGE_BYTES, MAX_PLY_BYTES, MAX_SPZ_BYTES,
} from "../lib/validation";

export interface ApiEnv {
  DB: D1Database;
  BUCKET: R2Bucket;
  WORKER_TOKEN?: string;
  LOCAL_DEV?: string;
}
type Job = {
  id: string; owner: string; status: string; lease: string | null; image_count: number; updated_at: number;
  result_key: string | null; spz_key: string | null; spz_bytes: number | null; ready_at: number | null;
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
  "spz_bytes", "queued_at", "aligning_at", "training_at", "exporting_at", "ready_at", "failed_at", "alignment_ratio"] as const;
const publicColumns = publicFields.join(",");
// Past `uploading` every manifest image is uploaded (I2) and frozen (I5), so `uploaded_count` is
// `image_count`. Reading it that way keeps rows created before the counter existed correct without a
// data backfill; while `uploading`, every image PUT recounts it (§7.2).
// `spz_bytes` is recorded by the attempt's SPZ PUT while it is still exporting, but describes a scene only
// once that attempt publishes, so it reads as null before `ready`.
const toPublic = (row: Record<string, unknown>) => Object.fromEntries(publicFields.map(field =>
  [field, (field === "uploaded_count" && row.status !== "uploading" ? row.image_count
    : field === "spz_bytes" && row.status !== "ready" ? null : row[field]) ?? null]));
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
    db.prepare("UPDATE captures SET status='failed',error=?,lease=NULL,spz_key=NULL,spz_bytes=NULL,failed_at=?,updated_at=? WHERE status IN ('aligning','training','exporting') AND updated_at < ?")
      .bind(STALE_ERROR, now, now, now - LEASE_TTL_MS),
    // I1 repair: before S2 a worker-reported `failed` kept its lease (`ready` always cleared it).
    // Clears those rows in bounded batches over the status index instead of a migration backfill.
    db.prepare("UPDATE captures SET lease=NULL WHERE id IN (SELECT id FROM captures WHERE status='failed' AND lease IS NOT NULL LIMIT 100)"),
  ]);
  return expired.meta.changes;
}
/** Same as the sweep, for one capture already read and found stale (keeps reads write-free otherwise). */
async function expireCapture(db: D1Database, id: string, now: number) {
  await db.prepare("UPDATE captures SET status='failed',error=?,lease=NULL,spz_key=NULL,spz_bytes=NULL,failed_at=?,updated_at=? WHERE id=? AND status IN ('aligning','training','exporting') AND updated_at < ?")
    .bind(STALE_ERROR, now, now, id, now - LEASE_TTL_MS).run();
}
export async function handleScheduled(env: Pick<ApiEnv, "DB" | "BUCKET">) {
  if (!env.DB) return;
  await sweepStaleLeases(env.DB);
  if (!env.BUCKET) return;
  // S7: deletions first, within their own share of the run's subrequests; the attempt collection gets
  // the rest, so the run as a whole still makes at most 1 + GC_SUBREQUESTS_PER_RUN calls.
  const purge = { left: PURGE_SUBREQUESTS_PER_RUN };
  await purgeDeletedCaptures(env, { budget: purge }).catch(error => console.error("Capture deletion run failed", error));
  await collectAttemptGarbage(env, { budget: { left: GC_SUBREQUESTS_PER_RUN - (PURGE_SUBREQUESTS_PER_RUN - purge.left) } });
}

/** Leases are bearer secrets, so R2 keys carry a digest of the lease rather than the lease itself. */
async function attemptDirFor(id: string, lease: string) {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(lease)));
  const attempt = Array.from(digest.slice(0, 16), b => b.toString(16).padStart(2, "0")).join("");
  return `${id}/attempts/${attempt}`;
}
/**
 * Every result PUT writes a key of its own (`{attempt}/result.{nonce}.ply|spz`) that nothing reads until a
 * conditional UPDATE records it, so no request can change bytes that are already published (C2): a late
 * or duplicate PUT can only create an unreferenced object, which it then deletes.
 */
const uploadKeyIn = (dir: string, extension: "ply" | "spz") => `${dir}/result.${crypto.randomUUID()}.${extension}`;
const inDir = (key: string | null | undefined, dir: string): key is string => Boolean(key?.startsWith(`${dir}/`));
/** Rows published before per-upload keys kept their SPZ beside a fixed `{attempt}/result.ply`. */
const legacySpzKeyFor = (resultKey: string) => resultKey.replace(/\/result\.ply$/, "/result.spz");
const legacyResultKey = (id: string) => `${id}/result.ply`;
type Published = Pick<Job, "status" | "result_key" | "spz_key" | "spz_bytes">;
/** The SPZ a ready capture serves, if any. */
const publishedSpzKey = (row: Published) => row.status !== "ready" || row.spz_bytes == null ? null
  : row.spz_key ?? (row.result_key && /\/result\.ply$/.test(row.result_key) ? legacySpzKeyFor(row.result_key) : null);
const GC_LIST_LIMIT = 100;
const GC_CAPTURES_PER_RUN = 10;
const GC_PAGES_PER_CAPTURE = 5;
/**
 * D1 and R2 calls one collection may make. Workers Free allows 50 subrequests per invocation: the cron
 * spends 1 on the lease sweep and at most 40 here; the inline collection after a publish, which already
 * made about 8, at most 12. Whatever is left over is picked up by the next cron tick.
 */
export const GC_SUBREQUESTS_PER_RUN = 40;
const GC_SUBREQUESTS_INLINE = 12;
/** Collecting a capture needs its row read, one list, one delete and the final mark update, plus one in reserve to record a failure. */
const GC_MIN_PER_CAPTURE = 5;
/**
 * `gc_pending` is 0 (clean) or 1 + the number of failed collections. A capture that fails is retried after
 * the others (the cron orders by it) and given up after GC_MAX_FAILURES, keeping a truthy mark for the logs.
 */
export const GC_MAX_FAILURES = 5;
type Budget = { left: number };
const spend = (budget: Budget) => { budget.left--; };
/** Lists keys under a prefix, a bounded number of pages, and deletes those not kept; true if more remain. */
async function deleteUnder(bucket: R2Bucket, prefix: string, keep: (object: R2Object) => boolean = () => false, pages = 1, budget: Budget = { left: Infinity }, reserve = 0) {
  let cursor: string | undefined;
  for (let page = 0; page < pages; page++) {
    if (budget.left < 2 + reserve) return true; // a list and a delete, keeping `reserve` for the caller
    spend(budget);
    const listing = await bucket.list({ prefix, limit: GC_LIST_LIMIT, ...(cursor ? { cursor } : {}) });
    const doomed = listing.objects.filter(object => !keep(object)).map(object => object.key);
    if (doomed.length) { spend(budget); await bucket.delete(doomed); }
    if (!listing.truncated) return false;
    cursor = listing.cursor;
  }
  return true;
}
/** Removes what an attempt that can no longer publish stored. Never called for the published attempt. */
const deleteAttempt = (bucket: R2Bucket, dir: string, why: string) =>
  deleteUnder(bucket, `${dir}/`).catch(error => console.error(`Could not delete ${why}`, dir, error));
/**
 * Attempt garbage collection (C3, spec §7.7). Every claim marks its capture `gc_pending`. Once the capture
 * is terminal, everything under `{id}/attempts/` except the published PLY and SPZ is garbage: an attempt
 * that died between its SPZ and its PLY, a superseded attempt, a duplicate PUT that lost. For a `failed`
 * capture, objects stored after it failed are left alone in case they belong to a newer attempt (the owner
 * may resubmit between this read and the listing); that attempt's own checks clean them up.
 * Returns true when the capture is clean and its mark was cleared; false when it is not terminal, changed
 * meanwhile, or has more to delete than this budget allowed (it stays marked for the next run).
 */
async function collectCapture(env: Pick<ApiEnv, "DB" | "BUCKET">, id: string, budget: Budget) {
  if (budget.left < GC_MIN_PER_CAPTURE) return false;
  spend(budget);
  const row = await env.DB.prepare("SELECT status,result_key,spz_key,spz_bytes,updated_at FROM captures WHERE id=?").bind(id)
    .first<Published & { updated_at: number }>();
  if (!row || (row.status !== "ready" && row.status !== "failed")) return false;
  const keep = new Set([row.status === "ready" ? row.result_key : null, publishedSpzKey(row)].filter(Boolean));
  // Two in reserve: the mark update below, and recording a failure should the next call throw.
  const more = await deleteUnder(env.BUCKET, `${id}/attempts/`,
    object => keep.has(object.key) || (row.status === "failed" && object.uploaded.getTime() > row.updated_at), GC_PAGES_PER_CAPTURE, budget, 2);
  if (more) return false;
  spend(budget);
  const cleared = await env.DB.prepare("UPDATE captures SET gc_pending=0 WHERE id=? AND status=? AND updated_at=?").bind(id, row.status, row.updated_at).run();
  return cleared.meta.changes > 0;
}
/** Right after a publish: this capture only, within what is left of the request's subrequests. */
const collectPublished = (env: Pick<ApiEnv, "DB" | "BUCKET">, id: string) => collectCapture(env, id, { left: GC_SUBREQUESTS_INLINE });
/**
 * Cron: terminal captures still marked, those that never failed first (oldest first), within a subrequest
 * budget shared across captures. A capture whose collection throws has its mark incremented so it sinks
 * behind the rest and cannot starve them; past GC_MAX_FAILURES it is no longer selected. Returns how many
 * captures were cleaned.
 */
export async function collectAttemptGarbage(env: Pick<ApiEnv, "DB" | "BUCKET">, { limit = GC_CAPTURES_PER_RUN, budget = { left: GC_SUBREQUESTS_PER_RUN } }: { limit?: number; budget?: Budget } = {}) {
  spend(budget);
  const { results } = await env.DB.prepare("SELECT id,gc_pending FROM captures WHERE gc_pending BETWEEN 1 AND ? AND status IN ('ready','failed') ORDER BY gc_pending,updated_at LIMIT ?")
    .bind(GC_MAX_FAILURES, limit).all<{ id: string; gc_pending: number }>();
  let cleaned = 0;
  for (const { id, gc_pending: marked } of results) {
    if (budget.left < GC_MIN_PER_CAPTURE) break;
    try { if (await collectCapture(env, id, budget)) cleaned++; }
    catch (error) {
      console.error("Attempt garbage collection failed", id, error);
      try {
        spend(budget);
        // Stays truthy: only a successful collection (or a new claim, which resets it to 1) changes that.
        await env.DB.prepare("UPDATE captures SET gc_pending=gc_pending+1 WHERE id=? AND gc_pending>0").bind(id).run();
        if (marked >= GC_MAX_FAILURES) console.error(`Attempt garbage collection gave up after ${GC_MAX_FAILURES} failures; objects under ${id}/attempts/ need manual cleanup`);
      } catch (markError) { console.error("Could not record the collection failure", id, markError); }
    }
  }
  return cleaned;
}
// ---- S7: capture deletion (spec §7.9) -------------------------------------------------------------
/** R2 returns at most 1000 keys per list and deletes at most 1000 per call. */
const PURGE_LIST_LIMIT = 1000;
/**
 * Calls the DELETE request may spend purging (it has made at most 4 before this), and the cron's share
 * of its collection budget. A capture with more objects than that stays `deleting` for the next tick.
 */
export const PURGE_SUBREQUESTS_INLINE = 30;
export const PURGE_SUBREQUESTS_PER_RUN = 20;
const PURGE_CAPTURES_PER_RUN = 5;
/**
 * No request that stores an object may do so later than this after it started (image PUTs check before
 * storing, result PUTs before each chunk and before completing the stream), so a request admitted before
 * a capture turned `deleting` has stored whatever it will ever store within this time of the flip.
 */
export const REQUEST_DEADLINE_MS = 30 * 60_000;
/**
 * How long a deleted capture's row is kept as a tombstone after the status flip: longer than any admitted
 * request can live (REQUEST_DEADLINE_MS plus slack), so the final listing, taken after it, sees every
 * object a late writer stored, even one whose own cleanup failed (I7).
 */
export const PURGE_GRACE_MS = 60 * 60_000;
type PurgeOutcome = "more" | "emptied" | "removed";
/**
 * Removes every object under `{id}/` (uploads, legacy images, attempts, published and legacy results).
 * Runs only on a `deleting` row; `since` is its `updated_at` (the flip, or later). When a listing comes
 * back with nothing left over, the image rows go and the capture row stays as a tombstone with
 * `gc_pending=0` ("emptied"), unless that listing started after the grace window: then no request can
 * store under the prefix any more, the bucket is clean for good, and the capture row goes too ("removed").
 * "more" when the budget ran out first.
 */
async function purgeCapture(env: Pick<ApiEnv, "DB" | "BUCKET">, id: string, since: number, budget: Budget): Promise<PurgeOutcome> {
  // A page needs a list and a delete, and the final statement one more.
  while (budget.left >= 3) {
    const listedAt = Date.now();
    spend(budget);
    // No cursor: what this deletes is gone, so the next listing starts at what is left.
    const listing = await env.BUCKET.list({ prefix: `${id}/`, limit: PURGE_LIST_LIMIT });
    if (listing.objects.length) { spend(budget); await env.BUCKET.delete(listing.objects.map(object => object.key)); }
    if (listing.truncated) continue;
    spend(budget);
    const images = env.DB.prepare("DELETE FROM images WHERE capture_id=? AND EXISTS (SELECT 1 FROM captures WHERE id=? AND status='deleting')").bind(id, id);
    if (listedAt - since > PURGE_GRACE_MS) {
      await env.DB.batch([images, env.DB.prepare("DELETE FROM captures WHERE id=? AND status='deleting'").bind(id)]);
      return "removed";
    }
    await env.DB.batch([images, env.DB.prepare("UPDATE captures SET gc_pending=0 WHERE id=? AND status='deleting'").bind(id)]);
    return "emptied";
  }
  return "more";
}
/**
 * Cron: deleted captures that may still hold objects (`gc_pending` 1) and tombstones past the grace
 * window, oldest first; tombstones inside the window cost nothing. A capture whose purge throws has its
 * `updated_at` moved forward so it goes behind the others next time (which only lengthens its grace).
 * Returns how many capture rows were removed.
 */
export async function purgeDeletedCaptures(env: Pick<ApiEnv, "DB" | "BUCKET">, { budget = { left: PURGE_SUBREQUESTS_PER_RUN } }: { budget?: Budget } = {}) {
  spend(budget);
  const { results } = await env.DB.prepare("SELECT id,updated_at FROM captures WHERE status='deleting' AND (gc_pending>0 OR updated_at<?) ORDER BY updated_at LIMIT ?")
    .bind(Date.now() - PURGE_GRACE_MS, PURGE_CAPTURES_PER_RUN).all<{ id: string; updated_at: number }>();
  let removed = 0;
  for (const { id, updated_at: since } of results) {
    if (budget.left < 3) break;
    try { if (await purgeCapture(env, id, since, budget) === "removed") removed++; }
    catch (error) {
      console.error("Capture deletion failed; the next run retries it", id, error);
      if (budget.left < 1) break;
      spend(budget);
      await env.DB.prepare("UPDATE captures SET updated_at=? WHERE id=? AND status='deleting'").bind(Date.now(), id).run()
        .catch(markError => console.error("Could not reschedule the deletion", id, markError));
    }
  }
  return removed;
}
/** A writer stored `key` and now commits it: if the commit throws, the object goes with it (§7.9). */
async function committing<T>(bucket: R2Bucket, key: string, commit: () => Promise<T>) {
  try { return await commit(); }
  catch (error) {
    await bucket.delete(key).catch(cleanupError => console.error("Could not delete an uncommitted object", key, cleanupError));
    throw error;
  }
}
// ---- end S7 ---------------------------------------------------------------------------------------
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
/** Follows the whole upload after its first bytes were vetted; `false` from either call rejects it (400). */
type SplatCheck = { write(chunk: Uint8Array<ArrayBuffer>): Promise<boolean>; end(): Promise<boolean>; abort(): void };
type SplatFormat = {
  label: string; max: number; contentType: string; invalid: string;
  /** Vets the first bytes (at least 16 KB unless the file is shorter); null rejects before anything is stored. */
  inspect(prefix: Uint8Array<ArrayBuffer>, length: number): Promise<SplatCheck | null> | SplatCheck | null;
};
const HEADER_ONLY: SplatCheck = { write: async () => true, end: async () => true, abort: () => {} };
const PLY: SplatFormat = {
  label: "PLY", max: MAX_PLY_BYTES, contentType: "application/octet-stream",
  invalid: "Expected a Gaussian-splat PLY with scale, rotation, opacity and color properties.",
  inspect: prefix => isGaussianPly(new TextDecoder().decode(prefix.subarray(0, 16384))) ? HEADER_ONLY : null,
};
/**
 * Inflates the entire upload as it streams through (C1). A truncated, padded or corrupt gzip stream fails
 * in DecompressionStream (workerd rejects incomplete data, a bad CRC and any byte after the member), and
 * the decompressed size must be exactly what the header implies. Counting stops past that size, so the
 * header's point count is also the zip-bomb cap: decompressed bytes are only counted, never held.
 */
function exactInflation(expected: number): SplatCheck {
  const inflate = new DecompressionStream("gzip");
  const writer = inflate.writable.getWriter();
  const reader = inflate.readable.getReader();
  let total = 0;
  let ok = true;
  const drained = (async () => {
    while (true) {
      const next = await reader.read();
      if (next.done) return total === expected;
      total += next.value.length;
      if (total > expected) { await reader.cancel().catch(() => {}); return false; }
    }
  })().catch(() => false).then(result => { if (!result) ok = false; return result; });
  return {
    async write(chunk) {
      if (ok) await writer.write(chunk).catch(() => { ok = false; });
      return ok;
    },
    async end() {
      if (ok) await writer.close().catch(() => { ok = false; });
      else await writer.abort().catch(() => {});
      return (await drained) && ok;
    },
    /** Releases the decompressor when the upload fails for another reason (a broken stream, R2). */
    abort() {
      ok = false;
      writer.abort().catch(() => {});
      reader.cancel().catch(() => {});
    },
  };
}
const SPZ: SplatFormat = {
  label: "SPZ", max: MAX_SPZ_BYTES, contentType: "application/x-spz",
  invalid: "Expected a complete gzip SPZ (version 2 or 3) whose data matches its header.",
  async inspect(prefix, length) {
    if (!isGzip(prefix)) return null;
    // Inflate only the prefix, and only far enough to read the 16-byte header. A prefix cut mid-stream
    // ends in an "unexpected end of file" error, but only after the header bytes have been read.
    const inflate = new DecompressionStream("gzip");
    const reader = inflate.readable.getReader();
    const writer = inflate.writable.getWriter();
    writer.write(prefix).then(() => writer.close()).catch(() => {});
    const header = new Uint8Array(16);
    let filled = 0;
    try {
      while (filled < 16) {
        const next = await reader.read();
        if (next.done) break;
        const take = next.value.subarray(0, 16 - filled);
        header.set(take, filled);
        filled += take.length;
      }
    } catch { /* A corrupt stream, or a prefix cut before 16 output bytes; judged below. */ }
    await reader.cancel().catch(() => {});
    const parsed = filled === 16 ? parseSpzHeader(header, length) : null;
    return parsed ? exactInflation(parsed.rawBytes) : null;
  },
};
class InvalidSplat extends Error {}
async function storeSplat(request: Request, bucket: R2Bucket, key: string, format: SplatFormat = PLY, deadline = Infinity) {
  const late = () => { if (Date.now() > deadline) throw new Error("The upload outlived the request deadline."); }; // S7 (§7.9)
  const length = Number(request.headers.get("content-length"));
  if (!Number.isSafeInteger(length) || length <= 0 || length > format.max) fail(`Supply a ${format.label} with Content-Length between 1 byte and ${format.max / 1024 / 1024} MB.`, 413);
  const reader = request.body?.getReader();
  if (!reader) fail(`A ${format.label} is required.`);
  // Inspect the first bytes before storing anything; stream the rest without holding it in Worker memory.
  const prefix: Uint8Array<ArrayBuffer>[] = [];
  let read = 0;
  try {
    while (read < 16384) {
      const next = await reader.read();
      if (next.done) break;
      prefix.push(next.value);
      read += next.value.length;
    }
  } catch { fail(RETRY_UPLOAD, 503); }
  const head = new Uint8Array(read);
  prefix.reduce((offset, chunk) => { head.set(chunk, offset); return offset + chunk.length; }, 0);
  const check = await format.inspect(head, length);
  if (!check) { await reader.cancel(); fail(format.invalid); }
  const stream = new FixedLengthStream(length);
  const writer = stream.writable.getWriter();
  const pump = async () => {
    let received = 0;
    // Each chunk is checked before it is forwarded, and the stream is closed only after the whole check
    // passes, so a rejected upload aborts the R2 put instead of completing it.
    const forward = async (chunk: Uint8Array<ArrayBuffer>) => {
      late(); // S7
      received += chunk.length;
      if (received > length) throw new Error("Body longer than its Content-Length.");
      if (!(await check.write(chunk))) throw new InvalidSplat();
      await writer.write(chunk);
    };
    try {
      for (const chunk of prefix) await forward(chunk);
      while (true) { const next = await reader.read(); if (next.done) break; await forward(next.value); }
      // A short body is a broken connection (retryable), not a bad file: judged before the content.
      if (received !== length) throw new Error("Body shorter than its Content-Length.");
      if (!(await check.end())) throw new InvalidSplat();
      late(); // S7: closing the stream is what completes the object
      await writer.close();
    } catch (error) { check.abort(); await writer.abort(error).catch(() => {}); throw error; }
  };
  // If R2 gives up first, nothing reads the stream any more: abort it so the pump stops instead of hanging.
  const put = bucket.put(key, stream.readable, { httpMetadata: { contentType: format.contentType } })
    .catch(error => { writer.abort(error).catch(() => {}); throw error; });
  const [pumped, stored] = await Promise.allSettled([pump(), put]);
  if (pumped.status === "fulfilled" && stored.status === "fulfilled") return length;
  await reader.cancel().catch(() => {});
  if (pumped.status === "rejected" && pumped.reason instanceof InvalidSplat) {
    await bucket.delete(key).catch(() => {});
    fail(format.invalid);
  }
  // A broken request stream, short body or R2 error is transient: 503 so the worker retries (400 is final).
  fail(RETRY_UPLOAD, 503);
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
async function objectResponse(env: ApiEnv, key: string, mime: string, name?: string, headers: Record<string, string> = {}) {
  const object = await env.BUCKET.get(key);
  if (!object) fail("File not found.", 404);
  // Bytes are served exactly as stored (an SPZ is gzip data, not a gzip Content-Encoding).
  return new Response(object.body, { headers: {
    "Content-Type": mime, "Content-Length": String(object.size), "Cache-Control": "private, no-store",
    "X-Content-Type-Options": "nosniff",
    ...(name ? { "Content-Disposition": `attachment; filename="${name}"` } : {}),
    ...headers,
  } });
}

export async function handleApi(request: Request, env: ApiEnv): Promise<Response> {
  const deadline = Date.now() + REQUEST_DEADLINE_MS; // S7: stores after this are refused (§7.9)
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
        const job = await env.DB.prepare("UPDATE captures SET status='aligning',lease=?,spz_key=NULL,spz_bytes=NULL,gc_pending=1,aligning_at=?,updated_at=? WHERE id=(SELECT id FROM captures WHERE status='queued' ORDER BY created_at LIMIT 1) AND status='queued' RETURNING id,image_count").bind(lease, now, now).first();
        if (!job) return json({ job: null });
        const images = await env.DB.prepare("SELECT id,name,mime FROM images WHERE capture_id=? AND uploaded=1 ORDER BY id").bind(job.id).all();
        return json({ job: { ...job, lease, images: images.results } });
      }
      const job = await env.DB.prepare("SELECT * FROM captures WHERE id=?").bind(path[2] ?? "").first<Job>();
      const lease = request.headers.get("x-job-lease") ?? "";
      // `result.spz` stores and records the attempt's SPZ without publishing; `result` stores the PLY and
      // publishes the attempt in one conditional UPDATE. Workers that predate SPZ only ever send `result`.
      const isResultPut = (path[3] === "result" || path[3] === "result.spz") && request.method === "PUT";
      const attemptDir = isResultPut && job && lease ? await attemptDirFor(job.id, lease) : null;
      // Idempotent finalisation: the attempt that published may repeat its PUTs (e.g. the response was
      // lost) and gets 200 without writing anything. Recognised by its published key's attempt directory,
      // so `ready` rows still hold no lease (I1).
      if (attemptDir && job?.status === "ready" && inDir(job.result_key, attemptDir)) {
        await request.body?.cancel().catch(() => {});
        return json({ ok: true });
      }
      if (!job || !active.includes(job.status) || !lease || job.lease !== lease || isStale(job, now)) {
        if (job && isStale(job, now)) await expireCapture(env.DB, job.id, now);
        // A superseded attempt can never publish, so whatever it stored is garbage; the published
        // attempt returned above and is never reached here.
        if (attemptDir && !inDir(job?.result_key, attemptDir)) {
          await request.body?.cancel().catch(() => {});
          await deleteAttempt(env.BUCKET, attemptDir, "superseded attempt");
        }
        fail("Job lease expired or invalid.", 409);
      }
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
        const clearLease = next === "failed" ? ",lease=NULL,spz_key=NULL,spz_bytes=NULL" : "";
        const result = await env.DB.prepare(`UPDATE captures SET status=?,error=?,updated_at=MAX(updated_at,?),alignment_ratio=COALESCE(?,alignment_ratio)${stamp}${clearLease} WHERE id=? AND lease=? AND status=? AND updated_at>=?`)
          .bind(next, error, at, alignmentRatio, ...(stamp ? [at] : []), job.id, job.lease, job.status, at - LEASE_TTL_MS).run();
        if (!result.meta.changes) fail("Job changed while updating.", 409);
        return json({ ok: true });
      }
      if (attemptDir) {
        if (job.status !== "exporting") fail("The capture is not ready for export.", 409);
        const dir = attemptDir;
        // This request's object was stored but not recorded. If this attempt already published (a
        // duplicate PUT won), the published objects are other keys: drop only ours and acknowledge.
        // Otherwise the attempt has lost its lease and nothing it stored can ever be published.
        const unpublished = async (ownKey: string, at: number) => {
          // S7: our own key first, by name. deleteAttempt below lists one page, which need not include it
          // (many late PUTs of one attempt); what it misses is left to GC or the deletion tombstone sweep.
          await env.BUCKET.delete(ownKey).catch(error => console.error("Could not delete unrecorded result", ownKey, error));
          const current = await env.DB.prepare("SELECT status,result_key FROM captures WHERE id=?").bind(job.id).first<Pick<Job, "status" | "result_key">>();
          if (current?.status === "ready" && inDir(current.result_key, dir)) return json({ ok: true });
          await deleteAttempt(env.BUCKET, dir, "unpublished attempt");
          await expireCapture(env.DB, job.id, at);
          fail("Job lease expired.", 409);
        };
        if (path[3] === "result.spz") {
          const spzKey = uploadKeyIn(dir, "spz");
          const bytes = await storeSplat(request, env.BUCKET, spzKey, SPZ, deadline); // S7: deadline
          // Recorded on the row, not published: the attempt's PLY PUT publishes it. The UPDATE holds only
          // while this lease is live and still exporting, so a recorded SPZ can never replace a published
          // one, and an SPZ that loses that race was never referenced (C2). Same batch, same snapshot:
          // the SELECT names the SPZ this one replaces.
          const done = Date.now();
          // S7: committing() deletes the object if the batch throws.
          const [previous, recorded] = await committing(env.BUCKET, spzKey, () => env.DB.batch([
            env.DB.prepare("SELECT spz_key FROM captures WHERE id=?").bind(job.id),
            env.DB.prepare("UPDATE captures SET spz_key=?,spz_bytes=? WHERE id=? AND lease=? AND status='exporting' AND updated_at>=?")
              .bind(spzKey, bytes, job.id, lease, done - LEASE_TTL_MS),
          ]));
          if (!recorded.meta.changes) return await unpublished(spzKey, done);
          const replaced = (previous.results[0] as { spz_key: string | null } | undefined)?.spz_key;
          if (replaced && replaced !== spzKey) await env.BUCKET.delete(replaced).catch(error => console.error("Could not delete replaced SPZ", replaced, error));
          return json({ ok: true });
        }
        const key = uploadKeyIn(dir, "ply");
        const bytes = await storeSplat(request, env.BUCKET, key, PLY, deadline); // S7: deadline
        // The lease must still be fresh when the upload completes, not just when it started: an
        // attempt that stopped heartbeating mid-upload has expired even if no sweep has run yet.
        // (The worker heartbeats throughout the upload, so a live long upload stays fresh.)
        // The SPZ this attempt recorded (claim cleared any earlier one) publishes in the same statement,
        // so a capture is never ready with one format of one attempt and the other of another.
        const done = Date.now();
        const result = await committing(env.BUCKET, key, () => env.DB.prepare("UPDATE captures SET status='ready',result_key=?,result_bytes=?,ready_at=?,updated_at=MAX(updated_at,?),lease=NULL,error=NULL WHERE id=? AND lease=? AND status='exporting' AND updated_at>=?")
          .bind(key, bytes, done, done, job.id, lease, done - LEASE_TTL_MS).run()); // S7: committing()
        if (!result.meta.changes) return await unpublished(key, done);
        // Earlier attempts' leftovers go now; anything this misses stays marked for the cron (C3).
        await collectPublished(env, job.id).catch(error => console.error("Attempt garbage collection failed", job.id, error));
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
      // S7: a capture being deleted is hidden.
      const list = () => env.DB.prepare(`SELECT ${publicColumns} FROM captures WHERE owner=? AND status!='deleting' ORDER BY created_at DESC LIMIT 100`).bind(owner).all<Record<string, unknown>>();
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
    // S7: a capture being deleted is gone as far as its owner can tell (every route below 404s).
    const loadOwned = () => env.DB.prepare("SELECT * FROM captures WHERE id=? AND owner=? AND status!='deleting'").bind(id, owner).first<Job & Record<string, unknown>>();
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
    // S7: rename, in every visible state. updated_at is left alone: the lease checks and the attempt
    // collection read it as the attempt's clock, and a new name is not progress.
    if (path.length === 3 && request.method === "PATCH") {
      const input = await readJson(request);
      if (!input || typeof input !== "object") fail("Invalid capture.");
      const name = validateName((input as Record<string, unknown>).name);
      const renamed = await env.DB.prepare(`UPDATE captures SET name=? WHERE id=? AND owner=? AND status!='deleting' RETURNING ${publicColumns}`)
        .bind(name, id, owner).first<Record<string, unknown>>();
      if (!renamed) fail("Capture not found.", 404);
      return json({ capture: toPublic(renamed) });
    }
    // S7: delete (spec §7.9). One conditional UPDATE settles the race with a claim: it moves only a row
    // with no live lease, and a claim moves only a `queued` row, so exactly one of them wins. A lease that
    // went stale was expired just above, so a dead attempt never blocks a delete.
    if (path.length === 3 && request.method === "DELETE") {
      // For a `deleting` row, gc_pending=1 means objects may remain; updated_at starts the grace window.
      const started = await env.DB.prepare("UPDATE captures SET status='deleting',lease=NULL,gc_pending=1,updated_at=? WHERE id=? AND owner=? AND status IN ('uploading','queued','ready','failed')")
        .bind(now, id, owner).run();
      if (!started.meta.changes) {
        const current = await loadOwned();
        if (current && active.includes(current.status)) fail("This capture is being processed. You can delete it once it is ready or has failed.", 409);
        fail("Capture not found.", 404);
      }
      try {
        // Done for the owner once the prefix is empty; the tombstone row goes after the grace window.
        if (await purgeCapture(env, id, now, { left: PURGE_SUBREQUESTS_INLINE }) !== "more") return json({ deleted: true });
      } catch (error) { console.error("Capture deletion will be finished by the cron", id, error); }
      // Already hidden everywhere; the cron removes what is left within a few minutes.
      return json({ deleted: true, pending: true }, 202);
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
        if (Date.now() > deadline) fail(RETRY_UPLOAD, 503); // S7: never store past the request deadline (§7.9)
        await env.BUCKET.put(key, bytes, { httpMetadata: { contentType: image.mime } }).catch(() => fail(RETRY_UPLOAD, 503));
        // S7: committing() deletes the object if the batch throws.
        const [marked] = await committing(env.BUCKET, key, () => env.DB.batch([
          env.DB.prepare("UPDATE images SET uploaded=1,object_key=? WHERE id=? AND capture_id=? AND EXISTS (SELECT 1 FROM captures WHERE id=? AND status='uploading')").bind(key, image.id, id, id),
          env.DB.prepare("UPDATE captures SET uploaded_count=(SELECT COUNT(*) FROM images WHERE capture_id=? AND uploaded=1) WHERE id=? AND status='uploading'").bind(id, id),
        ]));
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
    // The PLY archive (the full-precision result) and download.
    if (path[3] === "result.ply" && request.method === "GET") {
      if (job.status !== "ready") fail("The scene is not ready yet.", 409);
      return objectResponse(env, job.result_key ?? legacyResultKey(id), "application/octet-stream", url.searchParams.has("download") ? "spatial-capture.ply" : undefined);
    }
    // What the viewer loads: the SPZ when the attempt published one, otherwise the PLY.
    if (path[3] === "scene" && request.method === "GET") {
      if (job.status !== "ready") fail("The scene is not ready yet.", 409);
      const spzKey = publishedSpzKey(job);
      const spz = spzKey != null;
      const key = spzKey ?? job.result_key ?? legacyResultKey(id);
      // `ready` is terminal and every published key was written by exactly one PUT and is never rewritten,
      // so the bytes behind `?v=<ready_at>` never change: the browser may keep them. Other URLs are not cached.
      const immutable = job.ready_at != null && url.searchParams.get("v") === String(job.ready_at);
      return objectResponse(env, key, spz ? "application/x-spz" : "application/octet-stream", undefined, {
        "Cache-Control": immutable ? "private, max-age=31536000, immutable" : "private, no-store",
        "X-Splat-Format": spz ? "spz" : "ply",
      });
    }
    fail("Not found.", 404);
  } catch (error) {
    if (error instanceof ApiError) return json({ error: error.message }, error.status);
    if (error instanceof Error && /Give your|Choose |Use JPG|photo|capture under|Invalid capture/.test(error.message)) return json({ error: error.message }, 400);
    console.error("Capture API error", error);
    return json({ error: "Something went wrong on the server. Your saved captures are safe; please try again." }, 500);
  }
}
