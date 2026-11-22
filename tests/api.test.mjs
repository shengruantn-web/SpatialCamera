import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { Miniflare } from 'miniflare';
import { gzipSync } from 'node:zlib';
import { applyMigrations, migrate, readMigrations } from '../db/migrate.mjs';

let mf;
const token = 'isolated-test-worker-token-not-for-production';
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=', 'base64');
const owner = 'test-owner@example.invalid';
const manifest = () => ({ name: 'Integration fixture', images: Array.from({ length: 12 }, (_, i) => ({ name: `frame-${i}.png`, bytes: png.length, mime: 'image/png' })) });
async function request(path, method = 'GET', data, headers = {}) {
  return mf.dispatchFetch(`http://localhost/api/${path}`, { method, headers: { 'oai-authenticated-user-email': owner, ...(Buffer.isBuffer(data) ? { 'content-length': String(data.length) } : {}), ...headers }, body: data && (Buffer.isBuffer(data) ? data : JSON.stringify(data)) });
}
async function worker(path, method, data, lease) {
  return request(`worker/${path}`, method, data, { authorization: `Bearer ${token}`, ...(lease ? { 'x-job-lease': lease } : {}) });
}
// Mirrors worker/index.ts: fetch → handleApi, scheduled (Cron Trigger) → handleScheduled.
let script;
const newMiniflare = () => new Miniflare({ modules: true, script, compatibilityDate: '2026-01-01', d1Databases: ['DB'], r2Buckets: ['BUCKET'], bindings: { WORKER_TOKEN: token } });
before(async () => {
  const result = await build({ stdin: { contents: `import {handleApi, handleScheduled} from "./worker/api.ts";
    // Test-only fault injection: "x-test-r2-put" makes BUCKET.put fail like a transient R2 error.
    const failingPut = bucket => new Proxy(bucket, { get: (target, key) => key === 'put' ? async () => { throw new Error('R2 unavailable'); } : target[key].bind(target) });
    export default {fetch(request, env, ctx) { return handleApi(request, request.headers.has('x-test-r2-put') ? { ...env, BUCKET: failingPut(env.BUCKET) } : env, ctx); }, scheduled(controller, env, ctx) { ctx.waitUntil(handleScheduled(env)); }}`, resolveDir: process.cwd() }, bundle: true, write: false, format: 'esm', platform: 'browser' });
  script = result.outputFiles[0].text;
  mf = newMiniflare();
  // The API never creates tables; the schema comes only from drizzle/ migrations.
  await applyMigrations(await mf.getD1Database('DB'));
});
after(async () => { await mf?.dispose(); });

test('authentication, validation, resumable uploads, worker lease, export and ownership', async () => {
  assert.equal((await mf.dispatchFetch('http://localhost/api/captures')).status, 401);
  assert.equal((await request('captures', 'POST', manifest(), { origin: 'https://evil.invalid' })).status, 403);
  assert.equal((await request('captures', 'POST', { ...manifest(), images: [] })).status, 400);
  assert.equal((await request('captures', 'POST', { ...manifest(), images: manifest().images.map(i => ({ ...i, bytes: 30_000_000 })) })).status, 400);
  const created = await request('captures', 'POST', manifest());
  assert.equal(created.status, 201);
  const capture = await created.json();
  assert.equal((await request(`captures/${capture.id}/submit`, 'POST')).status, 409);
  assert.equal((await request(`captures/${capture.id}`, 'GET', null, { 'oai-authenticated-user-email': 'other@example.invalid' })).status, 404);
  assert.equal((await request(`captures/${capture.id}/images/${capture.images[0].id}`, 'PUT', Buffer.alloc(png.length))).status, 400);
  for (const image of capture.images) assert.equal((await request(`captures/${capture.id}/images/${image.id}`, 'PUT', png)).status, 200);
  // Re-uploading a file is safe and does not increase uploaded_count.
  assert.equal((await request(`captures/${capture.id}/images/${capture.images[0].id}`, 'PUT', png)).status, 200);
  const detail = await (await request(`captures/${capture.id}`)).json();
  assert.equal(detail.capture.uploaded_count, 12);
  assert.equal(detail.images.filter(i => i.uploaded).length, 12);
  assert.equal((await request(`captures/${capture.id}/submit`, 'POST')).status, 200);
  assert.equal((await request(`captures/${capture.id}/images/${capture.images[0].id}`, 'PUT', png)).status, 409);
  assert.equal((await request('worker/claim', 'POST', {})).status, 401);
  const claims = await Promise.all([worker('claim', 'POST', {}), worker('claim', 'POST', {})]);
  const claimed = await Promise.all(claims.map(c => c.json()));
  assert.equal(claimed.filter(c => c.job).length, 1);
  const job = claimed.find(c => c.job).job;
  assert.equal(job.id, capture.id);
  assert.equal((await worker(`${job.id}/status`, 'PATCH', { status: 'training' }, 'wrong-lease')).status, 409);
  assert.equal((await worker(`${job.id}/status`, 'PATCH', { status: 'exporting' }, job.lease)).status, 400);
  assert.equal((await worker(`${job.id}/images/${job.images[0].id}`, 'GET', null, job.lease)).status, 200);
  for (const status of ['training', 'exporting']) assert.equal((await worker(`${job.id}/status`, 'PATCH', { status }, job.lease)).status, 200);
  assert.equal((await worker(`${job.id}/result`, 'PUT', Buffer.from('not a splat'), job.lease)).status, 400);
  const properties = ['x','y','z','opacity','scale_0','scale_1','scale_2','rot_0','rot_1','rot_2','rot_3','f_dc_0','f_dc_1','f_dc_2'];
  const ply = Buffer.from(`ply\nformat ascii 1.0\nelement vertex 1\n${properties.map(p => `property float ${p}\n`).join('')}end_header\n0 0 0 1 -2 -2 -2 1 0 0 0 0 0 0\n`);
  assert.equal((await worker(`${job.id}/result`, 'PUT', ply, job.lease)).status, 200);
  const complete = await (await request(`captures/${job.id}`)).json();
  assert.equal(complete.capture.status, 'ready');
  assert.equal('lease' in complete.capture, false);
  const result = await request(`captures/${job.id}/result.ply?download`);
  assert.equal(result.status, 200);
  assert.deepEqual(Buffer.from(await result.arrayBuffer()), ply);
  assert.equal((await request(`captures/${job.id}/result.ply`, 'GET', null, { 'oai-authenticated-user-email': 'other@example.invalid' })).status, 404);
  assert.equal((await worker(`${job.id}/status`, 'PATCH', { status: 'failed' }, job.lease)).status, 409);
});

test('stalled jobs become retryable failures without inventing results', async () => {
  const db = await mf.getD1Database('DB');
  await db.prepare("INSERT INTO captures (id,owner,name,status,created_at,updated_at,image_count,lease) VALUES (?,?,?,'training',?,?,12,'expired')").bind('stalled', owner, 'Stalled test', Date.now(), Date.now() - 700000).run();
  const response = await request('captures/stalled');
  const { capture } = await response.json();
  assert.equal(capture.status, 'failed');
  assert.match(capture.error, /stopped responding/);
  assert.equal((await request('captures/stalled/result.ply')).status, 409);
});

// ---- S2: API integrity + hot path -------------------------------------------------------------
const properties = ['x','y','z','opacity','scale_0','scale_1','scale_2','rot_0','rot_1','rot_2','rot_3','f_dc_0','f_dc_1','f_dc_2'];
const splat = (x = 0) => Buffer.from(`ply\nformat ascii 1.0\nelement vertex 1\n${properties.map(p => `property float ${p}\n`).join('')}end_header\n${x} 0 0 1 -2 -2 -2 1 0 0 0 0 0 0\n`);
const settle = () => new Promise(resolve => setTimeout(resolve, 400));
async function uploadedCapture() {
  const capture = await (await request('captures', 'POST', manifest())).json();
  for (const image of capture.images) assert.equal((await request(`captures/${capture.id}/images/${image.id}`, 'PUT', png)).status, 200);
  return capture;
}
async function claim(expectedId) {
  const { job } = await (await worker('claim', 'POST', {})).json();
  assert.equal(job?.id, expectedId);
  return job;
}
async function queuedAndClaimed() {
  const capture = await uploadedCapture();
  assert.equal((await request(`captures/${capture.id}/submit`, 'POST')).status, 200);
  return { capture, job: await claim(capture.id) };
}
async function toExporting(job) {
  for (const status of ['training', 'exporting']) assert.equal((await worker(`${job.id}/status`, 'PATCH', { status }, job.lease)).status, 200);
}
/** A request body the test feeds by hand, so a request can be held open across other API calls. */
function heldRequest(path, headers, length, method = 'PUT') {
  let controller;
  const body = new ReadableStream({ start(c) { controller = c; } });
  const response = mf.dispatchFetch(`http://localhost/api/${path}`, { method, headers: { 'content-length': String(length), ...headers }, body, duplex: 'half' });
  return { response, send: bytes => controller.enqueue(new Uint8Array(bytes)), end: () => controller.close(), abort: () => controller.error(new Error('connection reset')) };
}
const listKeys = async prefix => (await (await mf.getR2Bucket('BUCKET')).list({ prefix })).objects.map(o => o.key);

test('a stale attempt cannot overwrite the result published by a newer lease', async () => {
  const { capture, job: first } = await queuedAndClaimed();
  await toExporting(first);
  // Attempt A passes its lease check and starts streaming its PLY…
  const stale = splat(111);
  const a = heldRequest(`worker/${capture.id}/result`, { authorization: `Bearer ${token}`, 'x-job-lease': first.lease }, stale.length);
  a.send(stale.subarray(0, stale.length - 10));
  await settle();
  // …then stalls past the lease TTL, is swept by the cron, and the owner resubmits.
  const db = await mf.getD1Database('DB');
  await db.prepare('UPDATE captures SET updated_at=? WHERE id=?').bind(Date.now() - 11 * 60_000, capture.id).run();
  await (await mf.getWorker()).scheduled({ cron: '*/5 * * * *' });
  assert.equal((await (await request(`captures/${capture.id}`)).json()).capture.status, 'failed');
  assert.equal((await request(`captures/${capture.id}/submit`, 'POST')).status, 200);
  // Attempt B claims, finishes and publishes.
  const second = await claim(capture.id);
  assert.notEqual(second.lease, first.lease);
  await toExporting(second);
  const winner = splat(222);
  assert.equal((await worker(`${capture.id}/result`, 'PUT', winner, second.lease)).status, 200);
  // A finally completes its upload: it must lose and leave no object behind.
  a.send(stale.subarray(stale.length - 10));
  a.end();
  assert.equal((await a.response).status, 409);
  const published = await request(`captures/${capture.id}/result.ply`);
  assert.equal(published.status, 200);
  assert.deepEqual(Buffer.from(await published.arrayBuffer()), winner);
  const keys = await listKeys(`${capture.id}/`);
  assert.equal(keys.filter(k => k.endsWith('.ply')).length, 1);
  assert.match(keys.find(k => k.endsWith('.ply')), new RegExp(`^${capture.id}/attempts/[0-9a-f]{32}/result\\.[0-9a-f-]{36}\\.ply$`));
  assert.equal(keys.some(k => k.includes(first.lease) || k.includes(second.lease)), false, 'raw leases never appear in object keys');
});

test('a repeated result PUT from the publishing lease is idempotent', async () => {
  const { capture, job } = await queuedAndClaimed();
  await toExporting(job);
  const result = splat(1);
  // Concurrent duplicates from one attempt (a retry racing the original) both succeed.
  const responses = await Promise.all([worker(`${job.id}/result`, 'PUT', result, job.lease), worker(`${job.id}/result`, 'PUT', result, job.lease)]);
  assert.deepEqual(responses.map(r => r.status), [200, 200]);
  const before = (await (await request(`captures/${capture.id}`)).json()).capture;
  assert.equal(before.status, 'ready');
  // A later retry (e.g. the first response was lost) is acknowledged without rewriting anything.
  assert.equal((await worker(`${job.id}/result`, 'PUT', splat(999), job.lease)).status, 200);
  const after = (await (await request(`captures/${capture.id}`)).json()).capture;
  assert.deepEqual(after, before);
  assert.deepEqual(Buffer.from(await (await request(`captures/${capture.id}/result.ply`)).arrayBuffer()), result);
  // Any other lease is still rejected, and ready rows hold no lease (I1).
  assert.equal((await worker(`${job.id}/result`, 'PUT', result, 'some-other-lease')).status, 409);
  assert.equal((await worker(`${job.id}/result`, 'PUT', result)).status, 409);
  const row = await (await mf.getD1Database('DB')).prepare('SELECT lease FROM captures WHERE id=?').bind(capture.id).first();
  assert.equal(row.lease, null);
});

test('an image PUT that lands after submit is rejected and cannot change the frozen inputs', async () => {
  const capture = await uploadedCapture();
  const target = capture.images[0];
  // Same size and a valid PNG signature, different bytes.
  const altered = Buffer.from(png); altered[altered.length - 1] ^= 0xff;
  const late = heldRequest(`captures/${capture.id}/images/${target.id}`, { 'oai-authenticated-user-email': owner }, altered.length);
  late.send(altered.subarray(0, 10));
  await settle();
  assert.equal((await request(`captures/${capture.id}/submit`, 'POST')).status, 200);
  late.send(altered.subarray(10));
  late.end();
  assert.equal((await late.response).status, 409);
  const job = await claim(capture.id);
  const served = await worker(`${job.id}/images/${target.id}`, 'GET', null, job.lease);
  assert.equal(served.status, 200);
  assert.deepEqual(Buffer.from(await served.arrayBuffer()), png);
  assert.equal((await listKeys(`${capture.id}/uploads/${target.id}/`)).length, 1, 'the rejected upload is deleted');
  // A plain PUT after submit is rejected too.
  assert.equal((await request(`captures/${capture.id}/images/${target.id}`, 'PUT', altered)).status, 409);
  assert.equal((await worker(`${job.id}/status`, 'PATCH', { status: 'failed', error: 'test cleanup' }, job.lease)).status, 200);
});

test('re-uploading a photo before submit replaces it and keeps one object per image', async () => {
  const capture = await uploadedCapture();
  const target = capture.images[1];
  assert.equal((await request(`captures/${capture.id}/images/${target.id}`, 'PUT', png)).status, 200);
  assert.equal((await listKeys(`${capture.id}/uploads/${target.id}/`)).length, 1);
  const detail = await (await request(`captures/${capture.id}`)).json();
  assert.equal(detail.capture.uploaded_count, 12);
  assert.equal((await request(`captures/${capture.id}/images/${target.id}`)).status, 200);
});

test('requests never run DDL; the schema comes from migrations, which upgrade legacy databases', async () => {
  const fresh = newMiniflare();
  try {
    const response = await fresh.dispatchFetch('http://localhost/api/captures', { headers: { 'oai-authenticated-user-email': owner } });
    assert.equal(response.status, 500);
    const db = await fresh.getD1Database('DB');
    assert.equal((await db.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE type='table' AND name IN ('captures','images','worker_health')").first()).n, 0);

    // A database created by the old runtime DDL, holding a finished legacy capture, a fully uploaded
    // capture not yet submitted, and a worker-reported failure that kept its lease (pre-S2 behaviour).
    await db.batch([
      db.prepare("CREATE TABLE captures (id TEXT PRIMARY KEY,owner TEXT NOT NULL,name TEXT NOT NULL,status TEXT NOT NULL DEFAULT 'uploading',created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL,image_count INTEGER NOT NULL,error TEXT,lease TEXT,result_bytes INTEGER)"),
      db.prepare("CREATE TABLE images (id TEXT PRIMARY KEY,capture_id TEXT NOT NULL,name TEXT NOT NULL,bytes INTEGER NOT NULL,mime TEXT NOT NULL,uploaded INTEGER NOT NULL DEFAULT 0)"),
      db.prepare("CREATE TABLE worker_health (id TEXT PRIMARY KEY,last_seen INTEGER NOT NULL)"),
      db.prepare("INSERT INTO captures (id,owner,name,status,created_at,updated_at,image_count,result_bytes) VALUES ('legacy',?,'Legacy','ready',1,1,1,?)").bind(owner, splat(7).length),
      db.prepare("INSERT INTO images (id,capture_id,name,bytes,mime,uploaded) VALUES ('img','legacy','a.png',?,'image/png',1)").bind(png.length),
      db.prepare("INSERT INTO captures (id,owner,name,status,created_at,updated_at,image_count) VALUES ('legacy-up',?,'Uploaded','uploading',2,2,2)").bind(owner),
      db.prepare("INSERT INTO images (id,capture_id,name,bytes,mime,uploaded) VALUES ('up-0','legacy-up','a.png',?,'image/png',1),('up-1','legacy-up','b.png',?,'image/png',1)").bind(png.length, png.length),
      db.prepare("INSERT INTO captures (id,owner,name,status,created_at,updated_at,image_count,error,lease) VALUES ('legacy-failed',?,'Failed','failed',3,3,1,'COLMAP failed','old-lease')").bind(owner),
    ]);
    const bucket = await fresh.getR2Bucket('BUCKET');
    await bucket.put('legacy/result.ply', splat(7));
    await bucket.put('legacy/images/img', png);
    assert.deepEqual(await applyMigrations(db), ['0001_api_integrity_hot_path.sql', '0002_spz_result.sql', '0003_attempt_keys_gc.sql']);
    assert.deepEqual(await applyMigrations(db), []);
    const indexes = (await db.prepare("SELECT name FROM sqlite_master WHERE type='index' AND name NOT LIKE 'sqlite_%'").all()).results.map(r => r.name).sort();
    assert.deepEqual(indexes, ['captures_gc_pending_idx', 'captures_owner_created_idx', 'captures_status_created_idx', 'captures_status_updated_idx', 'images_capture_uploaded_idx']);
    // Migrations are schema-only: no data is backfilled, so legacy rows keep NULL result_key and a 0 counter.
    const raw = await db.prepare("SELECT result_key,uploaded_count,spz_bytes,spz_key,gc_pending FROM captures WHERE id='legacy'").first();
    assert.deepEqual({ ...raw }, { result_key: null, uploaded_count: 0, spz_bytes: null, spz_key: null, gc_pending: 0 });
    const get = (path, method = 'GET') => fresh.dispatchFetch(`http://localhost/api/${path}`, { method, headers: { 'oai-authenticated-user-email': owner } });
    const detail = await (await get('captures/legacy')).json();
    assert.equal(detail.capture.uploaded_count, 1, 'past uploading, uploaded_count reads as image_count');
    // A ready row with no result_key resolves to the legacy key.
    assert.deepEqual(Buffer.from(await (await get('captures/legacy/result.ply')).arrayBuffer()), splat(7));
    // The viewer's scene URL serves that PLY too; with no ready_at there is no immutable version to cache.
    const scene = await get('captures/legacy/scene?v=null');
    assert.deepEqual([scene.headers.get('x-splat-format'), scene.headers.get('cache-control')], ['ply', 'private, no-store']);
    assert.deepEqual(Buffer.from(await scene.arrayBuffer()), splat(7));
    assert.deepEqual(Buffer.from(await (await get('captures/legacy/images/img')).arrayBuffer()), png);
    // A legacy uploading capture with a stale 0 counter still submits: submit counts uploaded images itself.
    assert.equal((await get('captures/legacy-up/submit', 'POST')).status, 200);
    const submitted = (await (await get('captures/legacy-up')).json()).capture;
    assert.deepEqual([submitted.status, submitted.uploaded_count], ['queued', 2]);
    // The sweep (cron) clears the lease a pre-S2 worker-reported failure kept (I1).
    assert.equal((await db.prepare("SELECT lease FROM captures WHERE id='legacy-failed'").first()).lease, 'old-lease');
    await (await fresh.getWorker()).scheduled({ cron: '*/5 * * * *' });
    const repaired = await db.prepare("SELECT status,lease,error FROM captures WHERE id='legacy-failed'").first();
    assert.deepEqual({ ...repaired }, { status: 'failed', lease: null, error: 'COLMAP failed' });
  } finally {
    await fresh.dispose();
  }
});

test('the scheduled sweep fails stale jobs and leaves live ones alone; polling does not sweep', async () => {
  const db = await mf.getD1Database('DB');
  const now = Date.now();
  await db.batch([
    db.prepare("INSERT INTO captures (id,owner,name,status,created_at,updated_at,image_count,lease) VALUES ('sweep-stale',?,'Stale','exporting',?,?,12,'stale-lease')").bind('nobody@example.invalid', now, now - 11 * 60_000),
    db.prepare("INSERT INTO captures (id,owner,name,status,created_at,updated_at,image_count,lease) VALUES ('sweep-live',?,'Live','training',?,?,12,'live-lease')").bind('nobody@example.invalid', now, now - 60_000),
  ]);
  // Another owner's polling must not touch these rows any more.
  assert.equal((await request('captures')).status, 200);
  assert.equal((await request('health')).status, 200);
  assert.equal((await db.prepare("SELECT status FROM captures WHERE id='sweep-stale'").first()).status, 'exporting');
  await (await mf.getWorker()).scheduled({ cron: '*/5 * * * *' });
  const stale = await db.prepare("SELECT status,lease,failed_at,error FROM captures WHERE id='sweep-stale'").first();
  assert.equal(stale.status, 'failed');
  assert.equal(stale.lease, null);
  assert.ok(stale.failed_at >= now);
  assert.match(stale.error, /stopped responding/);
  const live = await db.prepare("SELECT status,lease,failed_at FROM captures WHERE id='sweep-live'").first();
  assert.deepEqual({ ...live }, { status: 'training', lease: 'live-lease', failed_at: null });
});

test('stage timestamps and the alignment ratio are recorded per attempt', async () => {
  const started = Date.now();
  const { capture, job } = await queuedAndClaimed();
  const path = `${job.id}/status`;
  assert.equal((await worker(path, 'PATCH', { status: 'training', metrics: { alignment_ratio: 1.5 } }, job.lease)).status, 400);
  assert.equal((await worker(path, 'PATCH', { status: 'training', metrics: { alignment_ratio: '0.9' } }, job.lease)).status, 400);
  assert.equal((await worker(path, 'PATCH', { status: 'training', metrics: 'fast' }, job.lease)).status, 400);
  assert.equal((await worker(path, 'PATCH', { status: 'aligning' }, job.lease)).status, 200);
  assert.equal((await worker(path, 'PATCH', { status: 'training', metrics: { alignment_ratio: 0.85, future_metric: 3 } }, job.lease)).status, 200);
  // A heartbeat neither moves training_at nor clears the ratio.
  const mid = (await (await request(`captures/${capture.id}`)).json()).capture;
  assert.equal((await worker(path, 'PATCH', { status: 'training' }, job.lease)).status, 200);
  const afterHeartbeat = (await (await request(`captures/${capture.id}`)).json()).capture;
  assert.equal(afterHeartbeat.training_at, mid.training_at);
  assert.equal(afterHeartbeat.alignment_ratio, 0.85);
  assert.equal((await worker(path, 'PATCH', { status: 'exporting' }, job.lease)).status, 200);
  assert.equal((await worker(`${job.id}/result`, 'PUT', splat(), job.lease)).status, 200);
  const done = (await (await request(`captures/${capture.id}`)).json()).capture;
  const order = ['queued_at', 'aligning_at', 'training_at', 'exporting_at', 'ready_at'];
  for (const field of order) assert.ok(done[field] >= started, `${field} set`);
  for (let i = 1; i < order.length; i++) assert.ok(done[order[i]] >= done[order[i - 1]], `${order[i]} after ${order[i - 1]}`);
  assert.equal(done.failed_at, null);
  assert.equal(done.alignment_ratio, 0.85);
  for (const hidden of ['lease', 'result_key', 'owner']) assert.equal(hidden in done, false);
  const listed = (await (await request('captures')).json()).captures.find(c => c.id === capture.id);
  assert.equal(listed.ready_at, done.ready_at);

  // A failed attempt records failed_at and clears its lease; resubmitting resets the attempt's metrics.
  const retry = await queuedAndClaimed();
  assert.equal((await worker(`${retry.job.id}/status`, 'PATCH', { status: 'failed', error: 'Too few frames registered', metrics: { alignment_ratio: 0.2 } }, retry.job.lease)).status, 200);
  const failed = await (await mf.getD1Database('DB')).prepare('SELECT status,lease,failed_at,alignment_ratio FROM captures WHERE id=?').bind(retry.capture.id).first();
  assert.equal(failed.status, 'failed');
  assert.equal(failed.lease, null);
  assert.ok(failed.failed_at >= started);
  assert.equal(failed.alignment_ratio, 0.2);
  assert.equal((await request(`captures/${retry.capture.id}/submit`, 'POST')).status, 200);
  const requeued = (await (await request(`captures/${retry.capture.id}`)).json()).capture;
  assert.equal(requeued.status, 'queued');
  assert.deepEqual([requeued.aligning_at, requeued.failed_at, requeued.alignment_ratio], [null, null, null]);
  assert.ok(requeued.queued_at >= failed.failed_at);
  const again = await claim(retry.capture.id);
  assert.equal((await worker(`${again.id}/status`, 'PATCH', { status: 'failed' }, again.lease)).status, 200);
});

test('an interrupted result upload leaves the job retryable, and the retry publishes', async () => {
  const { capture, job } = await queuedAndClaimed();
  await toExporting(job);
  const result = splat(5);
  // The connection drops mid-body. (A short body never reaches the worker: the client refuses to send it.)
  const cut = heldRequest(`worker/${job.id}/result`, { authorization: `Bearer ${token}`, 'x-job-lease': job.lease }, result.length);
  cut.send(result.subarray(0, 64));
  await settle();
  cut.abort();
  const outcome = await cut.response.catch(error => error);
  // If a response gets back to the client, it must be retryable (503), never a final 4xx.
  if (outcome instanceof Response) assert.equal(outcome.status, 503);
  await settle();
  assert.equal((await (await request(`captures/${capture.id}`)).json()).capture.status, 'exporting');
  assert.deepEqual(await listKeys(`${capture.id}/attempts/`), []);
  // A storage failure is reported as a retryable 503 (400 would make the worker give up).
  assert.equal((await request(`worker/${job.id}/result`, 'PUT', result, { authorization: `Bearer ${token}`, 'x-job-lease': job.lease, 'x-test-r2-put': '1' })).status, 503);
  assert.equal((await (await request(`captures/${capture.id}`)).json()).capture.status, 'exporting');
  assert.equal((await worker(`${job.id}/result`, 'PUT', result, job.lease)).status, 200);
  assert.deepEqual(Buffer.from(await (await request(`captures/${capture.id}/result.ply`)).arrayBuffer()), result);
});

test('a storage failure on image upload is a retryable 503 and leaves the image pending', async () => {
  const capture = await (await request('captures', 'POST', manifest())).json();
  const image = capture.images[0];
  assert.equal((await request(`captures/${capture.id}/images/${image.id}`, 'PUT', png, { 'x-test-r2-put': '1' })).status, 503);
  const detail = await (await request(`captures/${capture.id}`)).json();
  assert.equal(detail.capture.uploaded_count, 0);
  assert.equal((await request(`captures/${capture.id}/images/${image.id}`, 'PUT', png)).status, 200);
});

test('a legacy uploading capture heals its counter on the next image upload', async () => {
  const capture = await uploadedCapture();
  const db = await mf.getD1Database('DB');
  // As left by pre-S2 code: images uploaded, counter never maintained.
  await db.prepare('UPDATE captures SET uploaded_count=0 WHERE id=?').bind(capture.id).run();
  assert.equal((await (await request(`captures/${capture.id}`)).json()).capture.uploaded_count, 0);
  assert.equal((await request(`captures/${capture.id}/images/${capture.images[0].id}`, 'PUT', png)).status, 200);
  assert.equal((await (await request(`captures/${capture.id}`)).json()).capture.uploaded_count, 12);
});

test('a delayed heartbeat never moves updated_at backwards', async () => {
  const { capture, job } = await queuedAndClaimed();
  const db = await mf.getD1Database('DB');
  const updatedAt = async () => (await db.prepare('SELECT updated_at FROM captures WHERE id=?').bind(capture.id).first()).updated_at;
  // The heartbeat's timestamp is taken once its body has arrived, not when the request started.
  const body = Buffer.from(JSON.stringify({ status: 'aligning' }));
  const slow = heldRequest(`worker/${job.id}/status`, { authorization: `Bearer ${token}`, 'x-job-lease': job.lease }, body.length, 'PATCH');
  slow.send(body.subarray(0, 5));
  await settle();
  const bodyDone = Date.now();
  slow.send(body.subarray(5));
  slow.end();
  assert.equal((await slow.response).status, 200);
  assert.ok(await updatedAt() >= bodyDone, 'updated_at reflects when the heartbeat was applied');
  // A heartbeat applied with an older clock than the stored value leaves it alone (MAX in SQL).
  const ahead = Date.now() + 5 * 60_000;
  await db.prepare('UPDATE captures SET updated_at=? WHERE id=?').bind(ahead, capture.id).run();
  assert.equal((await worker(`${job.id}/status`, 'PATCH', { status: 'aligning' }, job.lease)).status, 200);
  assert.equal(await updatedAt(), ahead);
  assert.equal((await worker(`${job.id}/status`, 'PATCH', { status: 'training' }, job.lease)).status, 200);
  assert.equal(await updatedAt(), ahead);
  assert.equal((await worker(`${job.id}/status`, 'PATCH', { status: 'failed', error: 'test cleanup' }, job.lease)).status, 200);
});

test('a result upload whose lease expired mid-upload cannot publish, even before any sweep', async () => {
  const { capture, job } = await queuedAndClaimed();
  await toExporting(job);
  const result = splat(42);
  const upload = heldRequest(`worker/${job.id}/result`, { authorization: `Bearer ${token}`, 'x-job-lease': job.lease }, result.length);
  upload.send(result.subarray(0, result.length - 10));
  await settle();
  // No heartbeat for > 10 min while the body was in flight; no cron or claim has swept it.
  const db = await mf.getD1Database('DB');
  await db.prepare('UPDATE captures SET updated_at=? WHERE id=?').bind(Date.now() - 11 * 60_000, capture.id).run();
  upload.send(result.subarray(result.length - 10));
  upload.end();
  assert.equal((await upload.response).status, 409);
  const row = await db.prepare('SELECT status,lease,result_key,ready_at FROM captures WHERE id=?').bind(capture.id).first();
  assert.deepEqual({ ...row }, { status: 'failed', lease: null, result_key: null, ready_at: null });
  assert.deepEqual(await listKeys(`${capture.id}/attempts/`), [], 'the unpublished object is deleted');
  assert.equal((await request(`captures/${capture.id}/result.ply`)).status, 409);
});

test('a result upload kept fresh by heartbeats publishes with its completion time', async () => {
  const { capture, job } = await queuedAndClaimed();
  await toExporting(job);
  const result = splat(43);
  const upload = heldRequest(`worker/${job.id}/result`, { authorization: `Bearer ${token}`, 'x-job-lease': job.lease }, result.length);
  upload.send(result.subarray(0, 20));
  await settle();
  // The lease ages, but a heartbeat during the upload renews it.
  const db = await mf.getD1Database('DB');
  await db.prepare('UPDATE captures SET updated_at=? WHERE id=?').bind(Date.now() - 9 * 60_000, capture.id).run();
  assert.equal((await worker(`${job.id}/status`, 'PATCH', { status: 'exporting' }, job.lease)).status, 200);
  const beforeEnd = Date.now();
  upload.send(result.subarray(20));
  upload.end();
  assert.equal((await upload.response).status, 200);
  const done = (await (await request(`captures/${capture.id}`)).json()).capture;
  assert.equal(done.status, 'ready');
  assert.ok(done.ready_at >= beforeEnd && done.updated_at >= done.ready_at);
});

test('the migration runner records schema that is already present and refuses a partial one', async () => {
  const migrations = await readMigrations();
  const run = async (db, statements) => { for (const s of statements) await db.prepare(s).run(); };
  const fresh = newMiniflare();
  try {
    // Both migrations run by hand (e.g. `wrangler d1 execute --file`), so no d1_migrations rows.
    const db = await fresh.getD1Database('DB');
    for (const m of migrations) await run(db, m.statements);
    assert.deepEqual(await migrate(db), { applied: [], adopted: migrations.map(m => m.name) });
    assert.deepEqual(await migrate(db), { applied: [], adopted: [] });
    const ledger = (await db.prepare('SELECT name FROM d1_migrations ORDER BY id').all()).results.map(r => r.name);
    assert.deepEqual(ledger, migrations.map(m => m.name));
  } finally {
    await fresh.dispose();
  }
  const partial = newMiniflare();
  try {
    // 0000 complete, and only the first statement of 0001.
    const db = await partial.getD1Database('DB');
    await run(db, migrations[0].statements);
    await run(db, migrations[1].statements.slice(0, 1));
    await assert.rejects(migrate(db), error =>
      /0001_api_integrity_hot_path\.sql is partially applied/.test(error.message) &&
      /Already present: column captures\.uploaded_count/.test(error.message) &&
      /Missing: column captures\.result_key/.test(error.message));
    // 0000 was adopted before the failure; nothing of 0001 was recorded.
    const ledger = (await db.prepare('SELECT name FROM d1_migrations').all()).results.map(r => r.name);
    assert.deepEqual(ledger, [migrations[0].name]);
  } finally {
    await partial.dispose();
  }
});

test('the sweep clears leases left on failed rows and leaves active leases alone', async () => {
  const db = await mf.getD1Database('DB');
  const now = Date.now();
  await db.batch([
    db.prepare("INSERT INTO captures (id,owner,name,status,created_at,updated_at,image_count,error,lease) VALUES ('kept-lease',?,'Kept','failed',?,?,12,'Reconstruction failed.','pre-s2-lease')").bind('nobody@example.invalid', now, now),
    db.prepare("INSERT INTO captures (id,owner,name,status,created_at,updated_at,image_count,lease) VALUES ('live-lease',?,'Live','exporting',?,?,12,'live')").bind('nobody@example.invalid', now, now),
  ]);
  await (await mf.getWorker()).scheduled({ cron: '*/5 * * * *' });
  const rows = (await db.prepare("SELECT id,status,lease,error FROM captures WHERE id IN ('kept-lease','live-lease') ORDER BY id").all()).results;
  assert.deepEqual(rows.map(r => ({ ...r })), [
    { id: 'kept-lease', status: 'failed', lease: null, error: 'Reconstruction failed.' },
    { id: 'live-lease', status: 'exporting', lease: 'live', error: null },
  ]);
  await db.prepare("DELETE FROM captures WHERE id IN ('kept-lease','live-lease')").run();
});

// ---- S5: SPZ delivery -------------------------------------------------------------------------
const SH_DIMS = [0, 3, 8, 15];
/** A gzip SPZ whose 16-byte header is real and whose payload (pseudo-random) has the size it implies. */
function spzFixture(points = 2000, { version = 3, shDegree = 1, magic = 0x5053474e, flags = 0, seed = 1, declared = points, patch } = {}) {
  const raw = Buffer.alloc(16 + points * (9 + 1 + 3 + 3 + (version >= 3 ? 4 : 3) + SH_DIMS[shDegree] * 3));
  raw.writeUInt32LE(magic, 0); raw.writeUInt32LE(version, 4); raw.writeUInt32LE(declared, 8);
  raw[12] = shDegree; raw[13] = 12; raw[14] = flags;
  let state = seed;
  for (let i = 16; i < raw.length; i++) { state = (Math.imul(state, 1664525) + 1013904223) >>> 0; raw[i] = state >>> 24; }
  patch?.(raw);
  return gzipSync(raw);
}
const MAX_SPZ_BYTES = 48 * 1024 * 1024;

test('an attempt publishes its SPZ with its PLY; the viewer gets the SPZ, the archive stays the PLY', async () => {
  const { capture, job } = await queuedAndClaimed();
  await toExporting(job);
  const spz = spzFixture();
  assert.ok(spz.length > 16384, 'larger than the inspected prefix, so the header is read from a cut gzip stream');
  assert.equal((await worker(`${job.id}/result.spz`, 'PUT', spz, job.lease)).status, 200);
  // Stored, not published: the capture is still exporting and nothing is served.
  const pending = (await (await request(`captures/${capture.id}`)).json()).capture;
  assert.deepEqual([pending.status, pending.spz_bytes], ['exporting', null]);
  assert.equal((await request(`captures/${capture.id}/scene`)).status, 409);
  const ply = splat(3);
  assert.equal((await worker(`${job.id}/result`, 'PUT', ply, job.lease)).status, 200);
  const ready = (await (await request(`captures/${capture.id}`)).json()).capture;
  assert.deepEqual([ready.status, ready.result_bytes, ready.spz_bytes], ['ready', ply.length, spz.length]);
  const keys = await listKeys(`${capture.id}/attempts/`);
  assert.equal(keys.length, 2);
  assert.deepEqual(keys.map(k => k.replace(/^.*\./, '')).sort(), ['ply', 'spz']);
  assert.equal(new Set(keys.map(k => k.replace(/\/[^/]+$/, ''))).size, 1, 'both formats live under one attempt');

  const scene = await request(`captures/${capture.id}/scene?v=${ready.ready_at}`);
  assert.equal(scene.status, 200);
  assert.equal(scene.headers.get('content-type'), 'application/x-spz');
  assert.equal(scene.headers.get('x-splat-format'), 'spz');
  assert.equal(scene.headers.get('cache-control'), 'private, max-age=31536000, immutable');
  assert.equal(scene.headers.get('content-length'), String(spz.length));
  assert.equal(scene.headers.get('content-encoding'), null, 'SPZ bytes are gzip data, never a transfer encoding');
  assert.equal(scene.headers.get('x-content-type-options'), 'nosniff');
  assert.deepEqual(Buffer.from(await scene.arrayBuffer()), spz);
  // Only the exact published version is cacheable.
  for (const query of ['', '?v=1', `?v=${ready.ready_at + 1}`]) {
    const other = await request(`captures/${capture.id}/scene${query}`);
    assert.equal(other.headers.get('cache-control'), 'private, no-store', query);
    await other.arrayBuffer();
  }
  // The full-precision PLY stays available as the archive download.
  const archive = await request(`captures/${capture.id}/result.ply?download`);
  assert.equal(archive.headers.get('content-disposition'), 'attachment; filename="spatial-capture.ply"');
  assert.deepEqual(Buffer.from(await archive.arrayBuffer()), ply);
  assert.equal((await request(`captures/${capture.id}/scene`, 'GET', null, { 'oai-authenticated-user-email': 'other@example.invalid' })).status, 404);

  // Repeats from the publishing attempt are acknowledged and rewrite nothing (published bytes are immutable).
  assert.equal((await worker(`${job.id}/result.spz`, 'PUT', spzFixture(2000, { seed: 9 }), job.lease)).status, 200);
  assert.equal((await worker(`${job.id}/result`, 'PUT', splat(4), job.lease)).status, 200);
  assert.deepEqual((await (await request(`captures/${capture.id}`)).json()).capture, ready);
  assert.deepEqual(Buffer.from(await (await request(`captures/${capture.id}/scene`)).arrayBuffer()), spz);
  // Another lease still gets 409, and its attempt cleanup never touches the published objects.
  assert.equal((await worker(`${job.id}/result.spz`, 'PUT', spz, 'some-other-lease')).status, 409);
  assert.deepEqual((await listKeys(`${capture.id}/attempts/`)).sort(), keys.sort());
});

test('a PLY-only worker still publishes, and the viewer then gets the PLY', async () => {
  const { capture, job } = await queuedAndClaimed();
  await toExporting(job);
  const ply = splat(6);
  assert.equal((await worker(`${job.id}/result`, 'PUT', ply, job.lease)).status, 200);
  const ready = (await (await request(`captures/${capture.id}`)).json()).capture;
  assert.deepEqual([ready.status, ready.spz_bytes], ['ready', null]);
  const scene = await request(`captures/${capture.id}/scene?v=${ready.ready_at}`);
  assert.equal(scene.headers.get('content-type'), 'application/octet-stream');
  assert.equal(scene.headers.get('x-splat-format'), 'ply');
  assert.equal(scene.headers.get('cache-control'), 'private, max-age=31536000, immutable');
  assert.deepEqual(Buffer.from(await scene.arrayBuffer()), ply);
});

test('an invalid or oversized SPZ is rejected before storage and the PLY still publishes', async () => {
  const { capture, job } = await queuedAndClaimed();
  await toExporting(job);
  const gzipOf = bytes => gzipSync(Buffer.from(bytes));
  const invalid = {
    'not gzip': splat(1),
    'wrong magic': spzFixture(50, { magic: 0x12345678 }),
    'zstd-era version': spzFixture(50, { version: 4 }),
    'unknown flags': spzFixture(50, { flags: 2 }),
    'SH degree 4': spzFixture(50, { shDegree: 0, patch: raw => { raw[12] = 4; } }),
    'reserved byte set': spzFixture(50, { patch: raw => { raw[15] = 1; } }),
    'count larger than the payload': spzFixture(50, { declared: 5_000_000 }),
    'zero points': spzFixture(50, { declared: 0 }),
    'header cut short': gzipOf([0x4e, 0x47, 0x53, 0x50, 3, 0, 0, 0]),
    'corrupt deflate': Buffer.concat([spzFixture(50).subarray(0, 10), Buffer.alloc(200, 0xff)]),
  };
  for (const [name, body] of Object.entries(invalid)) {
    assert.equal((await worker(`${job.id}/result.spz`, 'PUT', body, job.lease)).status, 400, name);
  }
  // Refused on its declared length, before any of it is read or stored.
  assert.equal((await worker(`${job.id}/result.spz`, 'PUT', Buffer.alloc(MAX_SPZ_BYTES + 1), job.lease)).status, 413);
  assert.deepEqual(await listKeys(`${capture.id}/attempts/`), [], 'nothing was stored');
  // The worker falls back to PLY-only delivery after a rejected SPZ.
  assert.equal((await worker(`${job.id}/result`, 'PUT', splat(8), job.lease)).status, 200);
  const ready = (await (await request(`captures/${capture.id}`)).json()).capture;
  assert.deepEqual([ready.status, ready.spz_bytes], ['ready', null]);
  assert.equal((await request(`captures/${capture.id}/scene`)).headers.get('x-splat-format'), 'ply');
});

test("a stale attempt's SPZ is never published, and is deleted once the attempt is seen to be superseded", async () => {
  const { capture, job: first } = await queuedAndClaimed();
  await toExporting(first);
  assert.equal((await worker(`${capture.id}/result.spz`, 'PUT', spzFixture(), first.lease)).status, 200);
  // A stalls before its PLY, is swept, and the owner resubmits; B claims and publishes a PLY only.
  const db = await mf.getD1Database('DB');
  await db.prepare('UPDATE captures SET updated_at=? WHERE id=?').bind(Date.now() - 11 * 60_000, capture.id).run();
  await (await mf.getWorker()).scheduled({ cron: '*/5 * * * *' });
  assert.equal((await request(`captures/${capture.id}/submit`, 'POST')).status, 200);
  const second = await claim(capture.id);
  await toExporting(second);
  const winner = splat(222);
  assert.equal((await worker(`${capture.id}/result`, 'PUT', winner, second.lease)).status, 200);
  const ready = (await (await request(`captures/${capture.id}`)).json()).capture;
  assert.deepEqual([ready.status, ready.spz_bytes], ['ready', null], "A's SPZ is not B's");
  const scene = await request(`captures/${capture.id}/scene?v=${ready.ready_at}`);
  assert.equal(scene.headers.get('x-splat-format'), 'ply');
  assert.deepEqual(Buffer.from(await scene.arrayBuffer()), winner);
  // B's publish already removed A's orphaned SPZ (C3); A's late SPZ and PLY are refused and leave nothing.
  assert.deepEqual((await listKeys(`${capture.id}/attempts/`)).filter(k => k.endsWith('.spz')), []);
  assert.equal((await worker(`${capture.id}/result.spz`, 'PUT', spzFixture(), first.lease)).status, 409);
  assert.equal((await worker(`${capture.id}/result`, 'PUT', splat(111), first.lease)).status, 409);
  const keys = await listKeys(`${capture.id}/attempts/`);
  assert.equal(keys.length, 1);
  assert.match(keys[0], /\/result\.[0-9a-f-]{36}\.ply$/);
  assert.deepEqual((await (await request(`captures/${capture.id}`)).json()).capture, ready);
});

test('an SPZ upload whose lease lapses mid-upload is deleted, and a lost publish deletes both formats', async () => {
  const db = await mf.getD1Database('DB');
  const age = id => db.prepare('UPDATE captures SET updated_at=? WHERE id=?').bind(Date.now() - 11 * 60_000, id).run();
  // 1. The lease lapses (no sweep yet) while the SPZ body is in flight.
  {
    const { capture, job } = await queuedAndClaimed();
    await toExporting(job);
    const spz = spzFixture();
    const upload = heldRequest(`worker/${job.id}/result.spz`, { authorization: `Bearer ${token}`, 'x-job-lease': job.lease }, spz.length);
    upload.send(spz.subarray(0, spz.length - 10));
    await settle();
    await age(capture.id);
    upload.send(spz.subarray(spz.length - 10));
    upload.end();
    assert.equal((await upload.response).status, 409);
    assert.deepEqual(await listKeys(`${capture.id}/attempts/`), []);
    assert.equal((await (await request(`captures/${capture.id}`)).json()).capture.status, 'failed');
  }
  // 2. The SPZ landed, then the lease lapses while the publishing PLY is in flight.
  {
    const { capture, job } = await queuedAndClaimed();
    await toExporting(job);
    assert.equal((await worker(`${job.id}/result.spz`, 'PUT', spzFixture(), job.lease)).status, 200);
    const ply = splat(9);
    const upload = heldRequest(`worker/${job.id}/result`, { authorization: `Bearer ${token}`, 'x-job-lease': job.lease }, ply.length);
    upload.send(ply.subarray(0, ply.length - 10));
    await settle();
    await age(capture.id);
    upload.send(ply.subarray(ply.length - 10));
    upload.end();
    assert.equal((await upload.response).status, 409);
    const row = await db.prepare('SELECT status,result_key,spz_bytes FROM captures WHERE id=?').bind(capture.id).first();
    assert.deepEqual({ ...row }, { status: 'failed', result_key: null, spz_bytes: null });
    assert.deepEqual(await listKeys(`${capture.id}/attempts/`), [], 'both unpublished objects are deleted');
  }
});

// ---- S5 review fixes: C1 full SPZ validation, C2 immutable published SPZ, C3 attempt garbage --------
const workerAuth = lease => ({ authorization: `Bearer ${token}`, 'x-job-lease': lease });
test('an SPZ is inflated in full: truncated, short, long, padded or corrupt streams are rejected (C1)', async () => {
  const { capture, job } = await queuedAndClaimed();
  await toExporting(job);
  const good = spzFixture();
  const crc = Buffer.from(good); crc[crc.length - 6] ^= 0xff;
  // A header for 200k points (5.8 MB inflated) in front of 100 MB of zeros: it compresses to ~100 KB, so
  // its header and compressed size agree, and only counting the inflated bytes catches it.
  const bomb = Buffer.alloc(16 + 200_000 * 29 + 100 * 1024 * 1024);
  bomb.writeUInt32LE(0x5053474e, 0); bomb.writeUInt32LE(3, 4); bomb.writeUInt32LE(200_000, 8); bomb[12] = 1; bomb[13] = 12;
  const invalid = {
    // Each of these has a valid header that agrees with its compressed size, so header-only checks passed it.
    'truncated gzip stream': good.subarray(0, good.length - 200),
    'gzip cut before its trailer': good.subarray(0, good.length - 4),
    'data shorter than the declared count': spzFixture(2000, { declared: 2010 }),
    'data longer than the declared count': spzFixture(2000, { declared: 1990 }),
    'bytes after the gzip member': Buffer.concat([good, Buffer.alloc(16)]),
    'a second gzip member': Buffer.concat([good, gzipSync(Buffer.from('more'))]),
    'bad CRC': crc,
    'decompresses far past its header (zip-bomb cap)': gzipSync(bomb, { level: 1 }),
  };
  for (const [name, body] of Object.entries(invalid)) {
    assert.equal((await worker(`${job.id}/result.spz`, 'PUT', body, job.lease)).status, 400, name);
  }
  assert.deepEqual(await listKeys(`${capture.id}/attempts/`), [], 'nothing rejected is stored');
  const row = await (await mf.getD1Database('DB')).prepare('SELECT spz_key,spz_bytes FROM captures WHERE id=?').bind(capture.id).first();
  assert.deepEqual({ ...row }, { spz_key: null, spz_bytes: null }, 'nothing rejected is recorded');
  // The exact stream is accepted, and a body cut by the network is still a retryable 503, not a 400.
  const cut = heldRequest(`worker/${job.id}/result.spz`, workerAuth(job.lease), good.length);
  cut.send(good.subarray(0, 20000));
  await settle();
  cut.abort();
  const outcome = await cut.response.catch(error => error);
  if (outcome instanceof Response) assert.equal(outcome.status, 503);
  assert.equal((await worker(`${job.id}/result.spz`, 'PUT', good, job.lease)).status, 200);
  assert.equal((await worker(`${job.id}/result`, 'PUT', splat(2), job.lease)).status, 200);
  const scene = await request(`captures/${capture.id}/scene`);
  assert.equal(scene.headers.get('x-splat-format'), 'spz');
  assert.deepEqual(Buffer.from(await scene.arrayBuffer()), good);
});

test('an SPZ PUT still in flight when its attempt publishes can never change the published scene (C2)', async () => {
  const db = await mf.getD1Database('DB');
  // 1. Two SPZ PUTs before publishing: the later one is recorded and the earlier object deleted.
  //    Then a third (a retry whose response was lost, with different bytes) is mid-body when the PLY publishes.
  {
    const { capture, job } = await queuedAndClaimed();
    await toExporting(job);
    assert.equal((await worker(`${job.id}/result.spz`, 'PUT', spzFixture(1500, { seed: 3 }), job.lease)).status, 200);
    const published = spzFixture(2000, { seed: 4 });
    assert.equal((await worker(`${job.id}/result.spz`, 'PUT', published, job.lease)).status, 200);
    assert.equal((await listKeys(`${capture.id}/attempts/`)).length, 1, 'the replaced SPZ is deleted');
    const late = spzFixture(3000, { seed: 5 });
    const upload = heldRequest(`worker/${job.id}/result.spz`, workerAuth(job.lease), late.length);
    upload.send(late.subarray(0, late.length - 10));
    await settle();
    const ply = splat(12);
    assert.equal((await worker(`${job.id}/result`, 'PUT', ply, job.lease)).status, 200);
    const ready = (await (await request(`captures/${capture.id}`)).json()).capture;
    assert.deepEqual([ready.status, ready.spz_bytes], ['ready', published.length]);
    const before = await listKeys(`${capture.id}/attempts/`);
    upload.send(late.subarray(late.length - 10));
    upload.end();
    assert.equal((await upload.response).status, 200, 'same attempt, already published: acknowledged, nothing changes');
    assert.deepEqual((await (await request(`captures/${capture.id}`)).json()).capture, ready);
    const scene = await request(`captures/${capture.id}/scene?v=${ready.ready_at}`);
    assert.equal(scene.headers.get('cache-control'), 'private, max-age=31536000, immutable');
    assert.deepEqual(Buffer.from(await scene.arrayBuffer()), published, 'the immutable URL still serves the published bytes');
    assert.deepEqual((await listKeys(`${capture.id}/attempts/`)).sort(), before.sort(), "the late PUT's object is deleted");
    const row = await db.prepare('SELECT spz_key,result_key FROM captures WHERE id=?').bind(capture.id).first();
    assert.deepEqual([row.result_key, row.spz_key].sort(), before.sort());
  }
  // 2. No SPZ yet: one is mid-body when a PLY-only publish lands. The scene stays the PLY.
  {
    const { capture, job } = await queuedAndClaimed();
    await toExporting(job);
    const late = spzFixture();
    const upload = heldRequest(`worker/${job.id}/result.spz`, workerAuth(job.lease), late.length);
    upload.send(late.subarray(0, late.length - 10));
    await settle();
    const ply = splat(13);
    assert.equal((await worker(`${job.id}/result`, 'PUT', ply, job.lease)).status, 200);
    upload.send(late.subarray(late.length - 10));
    upload.end();
    assert.equal((await upload.response).status, 200);
    const ready = (await (await request(`captures/${capture.id}`)).json()).capture;
    assert.equal(ready.spz_bytes, null);
    const scene = await request(`captures/${capture.id}/scene?v=${ready.ready_at}`);
    assert.equal(scene.headers.get('x-splat-format'), 'ply');
    assert.deepEqual(Buffer.from(await scene.arrayBuffer()), ply);
    const keys = await listKeys(`${capture.id}/attempts/`);
    assert.equal(keys.length, 1);
    assert.match(keys[0], /\.ply$/);
  }
  // 3. A duplicate PLY PUT from the publishing attempt cannot rewrite the published PLY either.
  {
    const { capture, job } = await queuedAndClaimed();
    await toExporting(job);
    const duplicate = splat(15);
    const upload = heldRequest(`worker/${job.id}/result`, workerAuth(job.lease), duplicate.length);
    upload.send(duplicate.subarray(0, duplicate.length - 10));
    await settle();
    const winner = splat(14);
    assert.equal((await worker(`${job.id}/result`, 'PUT', winner, job.lease)).status, 200);
    upload.send(duplicate.subarray(duplicate.length - 10));
    upload.end();
    assert.equal((await upload.response).status, 200);
    assert.deepEqual(Buffer.from(await (await request(`captures/${capture.id}/result.ply`)).arrayBuffer()), winner);
    assert.equal((await listKeys(`${capture.id}/attempts/`)).length, 1);
  }
});

test('attempt garbage is collected on publish and by the cron, never the published objects (C3)', async () => {
  const db = await mf.getD1Database('DB');
  const bucket = await mf.getR2Bucket('BUCKET');
  const gc = id => db.prepare('SELECT status,gc_pending FROM captures WHERE id=?').bind(id).first();
  // Earlier tests leave other terminal captures marked; each run collects ten, so run until all are done.
  const cron = async () => { for (let run = 0; run < 6; run++) await (await mf.getWorker()).scheduled({ cron: '*/5 * * * *' }); };
  // 1. The worker dies after uploading its SPZ, before its PLY: the cron expires it and removes the SPZ.
  {
    const { capture, job } = await queuedAndClaimed();
    await toExporting(job);
    assert.equal((await worker(`${job.id}/result.spz`, 'PUT', spzFixture(), job.lease)).status, 200);
    assert.deepEqual({ ...(await gc(capture.id)) }, { status: 'exporting', gc_pending: 1 });
    await db.prepare('UPDATE captures SET updated_at=? WHERE id=?').bind(Date.now() - 11 * 60_000, capture.id).run();
    await cron();
    assert.deepEqual({ ...(await gc(capture.id)) }, { status: 'failed', gc_pending: 0 });
    assert.deepEqual(await listKeys(`${capture.id}/attempts/`), [], 'the orphaned SPZ is gone');
  }
  // 2. A ready capture with leftovers of other attempts (e.g. a publish-time cleanup that failed):
  //    the cron removes them and keeps exactly the published PLY and SPZ.
  {
    const { capture, job } = await queuedAndClaimed();
    await toExporting(job);
    const spz = spzFixture();
    assert.equal((await worker(`${job.id}/result.spz`, 'PUT', spz, job.lease)).status, 200);
    assert.equal((await worker(`${job.id}/result`, 'PUT', splat(21), job.lease)).status, 200);
    assert.deepEqual({ ...(await gc(capture.id)) }, { status: 'ready', gc_pending: 0 }, 'publish cleaned up at once');
    const published = (await listKeys(`${capture.id}/attempts/`)).sort();
    assert.equal(published.length, 2);
    const strays = [`${capture.id}/attempts/${'a'.repeat(32)}/result.spz`, `${capture.id}/attempts/${'b'.repeat(32)}/result.x.ply`];
    for (const key of strays) await bucket.put(key, 'stray');
    await db.prepare('UPDATE captures SET gc_pending=1 WHERE id=?').bind(capture.id).run();
    await cron();
    assert.deepEqual((await listKeys(`${capture.id}/attempts/`)).sort(), published);
    assert.equal((await gc(capture.id)).gc_pending, 0);
    const ready = (await (await request(`captures/${capture.id}`)).json()).capture;
    assert.deepEqual(Buffer.from(await (await request(`captures/${capture.id}/scene?v=${ready.ready_at}`)).arrayBuffer()), spz);
  }
  // 3. A failed capture: objects stored before it failed go; one stored after (a newer attempt that
  //    may already be running) is left alone.
  {
    const id = 'gc-failed';
    const failedAt = Date.now() - 60_000;
    await db.prepare("INSERT INTO captures (id,owner,name,status,created_at,updated_at,image_count,gc_pending) VALUES (?,?,'GC','failed',?,?,12,1)").bind(id, owner, failedAt, failedAt).run();
    await bucket.put(`${id}/attempts/${'c'.repeat(32)}/result.n.spz`, 'newer');
    await db.prepare('UPDATE captures SET updated_at=? WHERE id=?').bind(Date.now() + 60_000, id).run();
    await bucket.put(`${id}/attempts/${'d'.repeat(32)}/result.n.spz`, 'even newer');
    await cron();
    assert.deepEqual(await listKeys(`${id}/attempts/`), [], 'both predate the (moved) failure time');
    await db.prepare('UPDATE captures SET updated_at=?,gc_pending=1 WHERE id=?').bind(Date.now() - 60_000, id).run();
    await bucket.put(`${id}/attempts/${'e'.repeat(32)}/result.n.spz`, 'after the failure');
    await cron();
    assert.deepEqual(await listKeys(`${id}/attempts/`), [`${id}/attempts/${'e'.repeat(32)}/result.n.spz`]);
    await db.prepare('DELETE FROM captures WHERE id=?').bind(id).run();
  }
});
