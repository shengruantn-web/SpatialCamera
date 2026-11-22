// S10 (ADR-0009, spec §7.11): video captures through R2 multipart, against a real D1 + R2 in Miniflare.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { Miniflare } from 'miniflare';
import { applyMigrations } from '../db/migrate.mjs';

let mf, db, bucket;
const token = 'isolated-test-worker-token-not-for-production';
const owner = 'video-owner@example.invalid';
const stranger = 'someone-else@example.invalid';
const MiB = 1024 * 1024;
const PART = 8 * MiB;
/** An MP4-looking file: an `ftyp` atom, then filler. Distinct per seed so mixed-up parts are detectable. */
function videoBytes(length, seed = 1) {
  const bytes = Buffer.alloc(length);
  for (let i = 0; i < length; i += 4096) bytes[i] = (i / 4096 + seed) & 0xff;
  Buffer.from([0, 0, 0, 0x20]).copy(bytes, 0);
  Buffer.from('ftypisom').copy(bytes, 4);
  return bytes;
}
const properties = ['x', 'y', 'z', 'opacity', 'scale_0', 'scale_1', 'scale_2', 'rot_0', 'rot_1', 'rot_2', 'rot_3', 'f_dc_0', 'f_dc_1', 'f_dc_2'];
const splat = () => Buffer.from(`ply\nformat ascii 1.0\nelement vertex 1\n${properties.map(p => `property float ${p}\n`).join('')}end_header\n0 0 0 1 -2 -2 -2 1 0 0 0 0 0 0\n`);

async function request(path, method = 'GET', data, headers = {}) {
  return mf.dispatchFetch(`http://localhost/api/${path}`, { method, headers: { 'oai-authenticated-user-email': owner, ...(Buffer.isBuffer(data) ? { 'content-length': String(data.length) } : {}), ...headers }, body: data && (Buffer.isBuffer(data) ? data : JSON.stringify(data)) });
}
const as = who => ({ 'oai-authenticated-user-email': who });
const worker = (path, method, data, lease) => request(`worker/${path}`, method, data, { authorization: `Bearer ${token}`, ...(lease ? { 'x-job-lease': lease } : {}) });
const pub = path => mf.dispatchFetch(`http://localhost${path}`);
const listKeys = async prefix => (await bucket.list({ prefix })).objects.map(o => o.key);
const row = id => db.prepare('SELECT * FROM captures WHERE id=?').bind(id).first();
const detail = async id => (await (await request(`captures/${id}`)).json()).capture;

before(async () => {
  const result = await build({ stdin: { contents: `import { handleApi, purgeDeletedCaptures } from "./worker/api.ts";
    import { handleSharePublic, isSharePath } from "./worker/share.ts";
    // "x-test-fail: abort" makes this request's multipart aborts throw (an R2 outage during a delete).
    const failingAborts = bucket => new Proxy(bucket, { get: (t, key) => key === 'resumeMultipartUpload'
      ? (...args) => { const upload = t.resumeMultipartUpload(...args); return new Proxy(upload, { get: (u, k) => k === 'abort' ? async () => { throw new Error('test: abort failed'); } : (typeof u[k] === 'function' ? u[k].bind(u) : u[k]) }); }
      : (typeof t[key] === 'function' ? t[key].bind(t) : t[key]) });
    export default { fetch(request, env, ctx) {
      const url = new URL(request.url);
      const scoped = (request.headers.get('x-test-fail') || '').includes('abort') ? { ...env, BUCKET: failingAborts(env.BUCKET) } : env;
      if (url.pathname === '/__test/purge') return purgeDeletedCaptures(scoped).then(removed => Response.json(removed));
      if (url.pathname.startsWith('/api/')) return handleApi(request, scoped, ctx);
      if (isSharePath(url.pathname)) return handleSharePublic(request, scoped, async () => new Response('<!doctype html><title>page</title>', { headers: { 'Content-Type': 'text/html' } }));
      return new Response('not found', { status: 404 });
    } };`, resolveDir: process.cwd() }, bundle: true, write: false, format: 'esm', platform: 'browser' });
  mf = new Miniflare({ modules: true, script: result.outputFiles[0].text, compatibilityDate: '2026-01-01', d1Databases: ['DB'], r2Buckets: ['BUCKET'], bindings: { WORKER_TOKEN: token, SHARE_RATE_LIMIT: '100000' } });
  db = await mf.getD1Database('DB');
  bucket = await mf.getR2Bucket('BUCKET');
  await applyMigrations(db);
});
after(async () => { await mf?.dispose(); });

const manifest = (bytes, extra = {}) => ({ name: 'Garden walk', source: 'video', video: { name: 'IMG_0001.MOV', bytes, mime: 'video/quicktime' }, ...extra });
async function createVideo(bytes, extra) {
  const response = await request('captures', 'POST', manifest(bytes, extra));
  assert.equal(response.status, 201);
  return response.json();
}
async function start(id, headers) {
  const response = await request(`captures/${id}/video/upload`, 'POST', undefined, headers);
  assert.equal(response.status, 201);
  return (await response.json()).upload;
}
const putPart = (id, upload, n, bytes, headers) => request(`captures/${id}/video/parts/${n}?upload=${encodeURIComponent(upload)}`, 'PUT', bytes, headers);
// A refusal that comes before the body is read may close the connection while the client is still
// sending an 8 MiB part, which fetch reports as EPIPE/ECONNRESET (as for the oversized SPZ in api.test.mjs).
const refusal = promise => promise.then(response => response.status, error => error?.cause?.code ?? error?.code ?? String(error));
const refused = (status, got) => [status, 'ECONNRESET', 'EPIPE', 'UND_ERR_SOCKET'].includes(got);
const tiny = Buffer.alloc(16); // for refusals that do not depend on the body
const complete = (id, upload, parts, headers) => request(`captures/${id}/video/complete?upload=${encodeURIComponent(upload)}`, 'POST', { parts }, headers);
/** Creates, uploads every part and completes; returns the capture id and the file. */
async function uploadedVideo(length = PART + MiB, extra = {}, seed = 1) {
  const file = videoBytes(length, seed);
  const { id } = await createVideo(length, extra);
  const upload = await start(id);
  const parts = [];
  for (let n = 1; (n - 1) * PART < length; n++) {
    const response = await putPart(id, upload, n, file.subarray((n - 1) * PART, n * PART));
    assert.equal(response.status, 200, `part ${n}`);
    parts.push(await response.json());
  }
  const completed = await complete(id, upload, parts);
  assert.equal(completed.status, 200, await completed.clone().text());
  return { id, file };
}
async function claimed(id) {
  assert.equal((await request(`captures/${id}/submit`, 'POST')).status, 200);
  const { job } = await (await worker('claim', 'POST', {})).json();
  assert.equal(job?.id, id);
  return job;
}
async function publish(job) {
  for (const next of ['training', 'exporting']) assert.equal((await worker(`${job.id}/status`, 'PATCH', { status: next }, job.lease)).status, 200);
  assert.equal((await worker(`${job.id}/result`, 'PUT', splat(), job.lease)).status, 200);
}

test('create: one MP4 or MOV under the cap; the 12–200 photo rule is the photo path\'s only', async () => {
  assert.equal((await request('captures', 'POST', manifest(PART), as(''))).status, 401, 'owner-authenticated');
  for (const [body, why] of [
    [manifest(PART, { video: { name: 'clip.webm', bytes: PART, mime: 'video/webm' } }), 'type'],
    [manifest(PART, { video: { name: 'clip.mp4', bytes: 1024 ** 3 + 1, mime: 'video/mp4' } }), 'over 1 GiB'],
    [manifest(PART, { video: { name: 'clip.mp4', bytes: 0, mime: 'video/mp4' } }), 'empty'],
    [manifest(PART, { video: { name: 'clip.mp4', bytes: 1.5, mime: 'video/mp4' } }), 'fractional size'],
    [manifest(PART, { video: { name: '', bytes: PART, mime: 'video/mp4' } }), 'filename'],
    [manifest(PART, { video: [{ name: 'a.mp4', bytes: PART, mime: 'video/mp4' }] }), 'more than one file'],
    [manifest(PART, { video: undefined }), 'missing video'],
    [manifest(PART, { keep_video: 'yes' }), 'keep_video type'],
    [manifest(PART, { name: '' }), 'name'],
    [manifest(PART, { video: { name: 'clip.mp4', bytes: PART, mime: 'toString' } }), 'prototype key as type'],
  ]) {
    const response = await request('captures', 'POST', body);
    assert.equal(response.status, 400, why);
    assert.ok((await response.json()).error, why);
  }
  // The photo path still requires 12–200 photos.
  assert.equal((await request('captures', 'POST', { name: 'Few photos', images: [{ name: 'a.png', bytes: 10, mime: 'image/png' }] })).status, 400);

  const created = await request('captures', 'POST', manifest(1024 ** 3, { keep_video: true }));
  assert.equal(created.status, 201);
  const { id, video } = await created.json();
  assert.deepEqual(video, { part_bytes: PART, parts: 128 }, '1 GiB in 8 MiB parts');
  const capture = await detail(id);
  assert.equal(capture.source_kind, 'video');
  assert.equal(capture.image_count, 0);
  assert.equal(capture.video_bytes, 1024 ** 3);
  assert.equal(capture.keep_video, 1);
  assert.equal(capture.video_uploaded, 0);
  assert.equal(capture.video_stored, 0);
  const listed = (await (await request('captures')).json()).captures.find(c => c.id === id);
  assert.equal(listed.source_kind, 'video');
  assert.equal(listed.video_stored, 0);
  for (const text of [JSON.stringify(capture), JSON.stringify(listed)]) assert.ok(!/video_key|video_upload_id|\/video\//.test(text), 'no R2 key or upload id in owner reads');
  assert.equal((await request(`captures/${id}`, 'DELETE')).status, 200);
});

test('parts: owner-only, numbers bounded by the declared size, exact sizes, MP4/MOV content, current upload only', async () => {
  const length = PART + 3 * MiB;
  const file = videoBytes(length);
  const { id, video } = await createVideo(length);
  assert.equal(video.parts, 2);
  for (const route of [['video/upload', 'POST'], ['video/parts/1?upload=x', 'PUT'], ['video/complete?upload=x', 'POST'], ['video/upload?upload=x', 'DELETE'], ['video', 'GET']]) {
    assert.equal((await request(`captures/${id}/${route[0]}`, route[1], undefined, as(stranger))).status, 404, `stranger ${route.join(' ')}`);
    assert.equal((await request(`captures/${id}/${route[0]}`, route[1], undefined, as(''))).status, 401, `anonymous ${route.join(' ')}`);
  }
  assert.equal((await request(`captures/${id}/video/upload`, 'POST', undefined, { origin: 'https://attacker.example' })).status, 403);
  assert.equal((await putPart(id, "not-started", 1, tiny)).status, 409, "nothing started yet");
  const upload = await start(id);
  assert.ok(upload && !upload.includes('/'));
  assert.equal((await row(id)).video_key.startsWith(`${id}/video/`), true, 'objects live under {id}/ (S7 purge and orphan sweep)');

  for (const n of ['0', '3', '-1', '1.5', 'abc', '01', '9999999']) assert.equal((await putPart(id, upload, n, tiny)).status, 400, `part ${n}`);
  for (const [n, body, what] of [[1, file.subarray(0, PART - 1), 'part 1 one byte short'], [2, file.subarray(PART, length - 1), 'last part one byte short'], [2, Buffer.concat([file.subarray(PART), Buffer.alloc(1)]), 'last part one byte long'], [1, tiny, 'part 1 far too short']]) {
    const got = await refusal(putPart(id, upload, n, body));
    assert.ok(refused(400, got), `${what} (got ${got})`);
  }
  const notVideo = Buffer.alloc(PART, 7);
  assert.equal((await putPart(id, upload, 1, notVideo)).status, 400, 'part 1 must start like an MP4/MOV');
  assert.equal((await putPart(id, `${upload}x`, 1, tiny)).status, 409, 'another upload id');
  assert.equal((await putPart(id, upload, 1, tiny, as(stranger))).status, 404);

  // Parts may arrive in any order; complete needs exactly 1..N with their etags.
  const second = await (await putPart(id, upload, 2, file.subarray(PART))).json();
  const first = await (await putPart(id, upload, 1, file.subarray(0, PART))).json();
  assert.equal(first.part_number, 1);
  assert.equal(second.part_number, 2);
  assert.equal((await request(`captures/${id}/submit`, 'POST')).status, 409, 'submit waits for complete');
  for (const parts of [[first], [second, first], [first, second, second], [first, { part_number: 2, etag: '' }], [first, { part_number: 2 }], 'all']) {
    assert.equal((await complete(id, upload, parts)).status, 400, JSON.stringify(parts));
  }
  assert.equal((await complete(id, upload, [first, second], as(stranger))).status, 404);
  assert.equal((await complete(id, upload, [first, second])).status, 200);
  assert.equal((await complete(id, upload, [first, second])).status, 200, 'a retried complete is acknowledged');

  const capture = await detail(id);
  assert.equal(capture.video_uploaded, 1);
  assert.equal(capture.video_stored, 1);
  const keys = await listKeys(`${id}/video/`);
  assert.equal(keys.length, 1);
  assert.deepEqual(Buffer.from(await (await bucket.get(keys[0])).arrayBuffer()), file, 'the stored video is the file, byte for byte');
  assert.equal((await row(id)).video_upload_id, null);
  // Once complete the video is fixed: no new upload, part or abort.
  assert.equal((await request(`captures/${id}/video/upload`, 'POST')).status, 409);
  assert.equal((await putPart(id, upload, 1, tiny)).status, 409);
  assert.equal((await request(`captures/${id}/video/upload?upload=${upload}`, 'DELETE')).status, 409);
  const owned = await request(`captures/${id}/video?download`);
  assert.equal(owned.status, 200);
  assert.equal(owned.headers.get('content-type'), 'video/quicktime');
  assert.match(owned.headers.get('content-disposition'), /spatial-capture\.mov/);
  assert.equal(Buffer.from(await owned.arrayBuffer()).length, length);
  assert.equal((await request(`captures/${id}/images/x`, 'PUT', file.subarray(0, 100))).status, 404, 'a video capture takes no photos');
  assert.equal((await request(`captures/${id}`, 'DELETE')).status, 200);
});

test('restart and abort: a replaced upload is aborted and can no longer be used', async () => {
  const length = PART + MiB;
  const file = videoBytes(length);
  const { id } = await createVideo(length);
  const first = await start(id);
  const firstKey = (await row(id)).video_key;
  const part = await (await putPart(id, first, 1, file.subarray(0, PART))).json();
  const second = await start(id); // a reload, or another tab
  assert.notEqual(second, first);
  assert.notEqual((await row(id)).video_key, firstKey, 'every upload writes a key of its own');
  assert.equal((await putPart(id, first, 2, tiny)).status, 409);
  assert.equal((await complete(id, first, [part, { part_number: 2, etag: 'x' }])).status, 409);
  await assert.rejects(bucket.resumeMultipartUpload(firstKey, first).uploadPart(2, file.subarray(PART)), 'the replaced upload was aborted in R2');

  assert.equal((await request(`captures/${id}/video/upload?upload=${first}`, 'DELETE')).status, 409, 'only the current upload can be aborted');
  assert.equal((await request(`captures/${id}/video/upload?upload=${second}`, 'DELETE')).status, 200);
  const after = await row(id);
  assert.equal(after.video_upload_id, null);
  assert.equal(after.video_key, null);
  assert.equal((await putPart(id, second, 1, tiny)).status, 409);
  assert.deepEqual(await listKeys(`${id}/`), []);
  // A fresh start after an abort works.
  const third = await start(id);
  const p1 = await (await putPart(id, third, 1, file.subarray(0, PART))).json();
  const p2 = await (await putPart(id, third, 2, file.subarray(PART))).json();
  assert.equal((await complete(id, third, [p1, p2])).status, 200);
  assert.equal((await request(`captures/${id}`, 'DELETE')).status, 200);
});

test('a video job: claim hands the worker the video, publish deletes it, inputs are frozen after submit', async () => {
  const { id, file } = await uploadedVideo();
  const job = await claimed(id);
  assert.equal(job.source_kind, 'video');
  assert.deepEqual(job.images, []);
  assert.deepEqual(job.video, { bytes: file.length, mime: 'video/quicktime' });
  assert.equal(job.image_count, 0);
  // After submit nothing about the video can change.
  assert.equal((await request(`captures/${id}/video/upload`, 'POST')).status, 409);
  assert.equal((await putPart(id, 'any', 1, tiny)).status, 409);
  assert.equal((await complete(id, 'any', [])).status, 409);
  assert.equal((await request(`captures/${id}/video/upload?upload=any`, 'DELETE')).status, 409);

  assert.equal((await worker(`${id}/video`, 'GET', undefined, 'wrong-lease')).status, 409, 'the lease is required');
  assert.equal((await request(`worker/${id}/video`, 'GET', undefined, { 'x-job-lease': job.lease })).status, 401, 'the worker token is required');
  const download = await worker(`${id}/video`, 'GET', undefined, job.lease);
  assert.equal(download.status, 200);
  assert.equal(download.headers.get('content-type'), 'video/quicktime');
  assert.deepEqual(Buffer.from(await download.arrayBuffer()), file);
  assert.equal((await worker(`${id}/status`, 'PATCH', { status: 'training', metrics: { alignment_ratio: 0.9 } }, job.lease)).status, 200);
  assert.equal((await worker(`${id}/status`, 'PATCH', { status: 'exporting' }, job.lease)).status, 200);
  assert.equal((await listKeys(`${id}/video/`)).length, 1, 'kept until the result is published');
  assert.equal((await worker(`${id}/result`, 'PUT', splat(), job.lease)).status, 200);

  const capture = await detail(id);
  assert.equal(capture.status, 'ready');
  assert.deepEqual(await listKeys(`${id}/video/`), [], 'the inline collection after publish deleted the video');
  assert.equal(capture.video_stored, 0);
  assert.equal((await row(id)).video_key, null);
  assert.equal((await request(`captures/${id}/video`)).status, 404);
  assert.equal((await row(id)).gc_pending, 0);
  assert.equal((await request(`captures/${id}`, 'DELETE')).status, 200);
});

test('a failed video job keeps its video for the retry', async () => {
  const { id, file } = await uploadedVideo(PART + 2 * MiB, {}, 3);
  const job = await claimed(id);
  assert.equal((await worker(`${id}/status`, 'PATCH', { status: 'failed', error: 'test failure' }, job.lease)).status, 200);
  assert.equal((await listKeys(`${id}/video/`)).length, 1);
  const retry = await claimed(id);
  assert.notEqual(retry.lease, job.lease);
  assert.deepEqual(Buffer.from(await (await worker(`${id}/video`, 'GET', undefined, retry.lease)).arrayBuffer()), file);
  await publish(retry);
  assert.deepEqual(await listKeys(`${id}/video/`), []);
  assert.equal((await request(`captures/${id}`, 'DELETE')).status, 200);
});

test('keep video: the owner keeps the original after publishing, and share links never expose it', async () => {
  const { id, file } = await uploadedVideo(PART + MiB, { keep_video: true }, 5);
  const bucketPath = (await row(id)).video_key;
  // A stray from an upload that lost its commit is still removed.
  await bucket.put(`${id}/video/stray.mov`, 'stray');
  await publish(await claimed(id));
  assert.deepEqual(await listKeys(`${id}/video/`), [bucketPath]);
  const capture = await detail(id);
  assert.equal(capture.video_stored, 1);
  assert.equal(capture.keep_video, 1);
  assert.deepEqual(Buffer.from(await (await request(`captures/${id}/video`)).arrayBuffer()), file);
  assert.equal((await request(`captures/${id}/video`, 'GET', undefined, as(stranger))).status, 404);

  const share = await (await request(`captures/${id}/shares`, 'POST', { allow_download: true })).json();
  const base = `/s/${share.token}`;
  for (const suffix of ['', '/embed', '/info', '/scene', '/download', '/video', '/video.mov', '/source']) {
    const response = await pub(`${base}${suffix}`);
    const body = Buffer.from(await response.arrayBuffer());
    assert.ok(!body.subarray(0, 64).includes(Buffer.from('ftyp')), `${suffix || '/'} never serves the video`);
    assert.ok(!/video|\.mov/i.test(response.headers.get('content-type') ?? ''), `${suffix || '/'} content type`);
    assert.ok(!body.toString('latin1').includes(bucketPath), `${suffix || '/'} never names its key`);
    if (['/video', '/video.mov', '/source'].includes(suffix)) assert.equal(response.status, 404);
  }
  const info = await (await pub(`${base}/info`)).json();
  assert.deepEqual(Object.keys(info).sort(), ['download', 'download_bytes', 'format', 'name', 'scene_bytes']);
  assert.equal((await request(`captures/${id}`, 'DELETE')).status, 200);
  assert.deepEqual(await listKeys(`${id}/`), [], 'deleting the capture removes the kept video');
});

test('delete aborts an in-flight upload and removes a completed video', async () => {
  const length = PART + MiB;
  const file = videoBytes(length);
  // In flight: part 1 uploaded, never completed.
  const { id } = await createVideo(length);
  const upload = await start(id);
  const { video_key: key } = await row(id);
  assert.equal((await putPart(id, upload, 1, file.subarray(0, PART))).status, 200);
  assert.equal((await request(`captures/${id}`, 'DELETE', undefined, as(stranger))).status, 404);
  assert.equal((await request(`captures/${id}`, 'DELETE')).status, 200);
  await assert.rejects(bucket.resumeMultipartUpload(key, upload).uploadPart(2, file.subarray(PART)), 'the upload was aborted');
  assert.equal((await row(id)).video_upload_id, null);
  assert.equal((await putPart(id, upload, 2, tiny)).status, 404, 'the capture is gone for its owner');
  assert.equal((await complete(id, upload, [])).status, 404);
  assert.deepEqual(await listKeys(`${id}/`), []);

  // Completed but never submitted.
  const done = await uploadedVideo(length, {}, 7);
  assert.equal((await listKeys(`${done.id}/video/`)).length, 1);
  assert.equal((await request(`captures/${done.id}`, 'DELETE')).status, 200);
  assert.deepEqual(await listKeys(`${done.id}/`), []);

  // An abort that fails does not block the deletion (R2 expires the upload after seven days).
  const { id: third } = await createVideo(length);
  const thirdUpload = await start(third);
  assert.equal((await putPart(third, thirdUpload, 1, file.subarray(0, PART))).status, 200);
  const deleted = await request(`captures/${third}`, 'DELETE', undefined, { 'x-test-fail': 'abort' });
  assert.equal(deleted.status, 200);
  assert.equal((await row(third)).status, 'deleting');
  assert.equal((await row(third)).video_upload_id, null);
  assert.deepEqual(await listKeys(`${third}/`), []);
});

test('the cron purge aborts the upload of a deletion it finishes', async () => {
  const length = PART + MiB;
  const file = videoBytes(length);
  const { id } = await createVideo(length);
  const upload = await start(id);
  const { video_key: key } = await row(id);
  assert.equal((await putPart(id, upload, 1, file.subarray(0, PART))).status, 200);
  // Stand-in for a DELETE whose inline purge did not run (the request died after the flip).
  await db.prepare("UPDATE captures SET status='deleting',gc_pending=1,updated_at=? WHERE id=?").bind(Date.now(), id).run();
  await (await mf.dispatchFetch('http://localhost/__test/purge')).json();
  await assert.rejects(bucket.resumeMultipartUpload(key, upload).uploadPart(2, file.subarray(PART)));
  const after = await row(id);
  assert.equal(after.video_upload_id, null);
  assert.equal(after.gc_pending, 0);
});

test('the browser client: creates, uploads every part, completes and submits; a reopened capture resumes', async () => {
  const bundled = await build({ entryPoints: ['lib/video-upload.ts'], bundle: true, write: false, format: 'esm', platform: 'neutral' });
  const client = await import(`data:text/javascript;base64,${Buffer.from(bundled.outputFiles[0].text).toString('base64')}`);
  const seen = [];
  const fetcher = (url, init = {}) => { seen.push(`${init.method ?? 'GET'} ${url.split('?')[0]}`); return mf.dispatchFetch(`http://localhost${url}`, { ...init, headers: { ...init.headers, ...as(owner) } }); };
  const length = 2 * PART + 3 * MiB;
  const bytes = videoBytes(length, 7);
  const file = new File([bytes], 'IMG_0042.MOV', { type: '' }); // browsers can leave a .mov's type empty
  assert.equal(client.videoMime(file), 'video/quicktime');
  const progress = [];
  let created;
  const id = await client.uploadVideoCapture({ name: 'Porch', file, keepVideo: true, fetcher, onCreated: value => { created = value; }, onProgress: value => progress.push(value) });
  assert.equal(id, created);
  assert.equal(progress.at(-1), 1);
  assert.deepEqual(seen.filter(entry => !entry.startsWith('PUT')), ['POST /api/captures', `POST /api/captures/${id}/video/upload`, `POST /api/captures/${id}/video/complete`, `POST /api/captures/${id}/submit`]);
  assert.equal(seen.filter(entry => entry.startsWith('PUT')).length, 3);
  const capture = await detail(id);
  assert.equal(capture.status, 'queued');
  assert.equal(capture.source_kind, 'video');
  assert.equal(capture.keep_video, 1);
  const { video_key: key } = await row(id);
  assert.ok(Buffer.from(await (await bucket.get(key)).arrayBuffer()).equals(bytes), 'the parts were stitched in order');

  // Interrupted after the create: reopening the capture and choosing the same file finishes it.
  const controller = new AbortController();
  let interrupted;
  await assert.rejects(client.uploadVideoCapture({ name: 'Steps', file, keepVideo: false, fetcher, signal: controller.signal,
    onCreated: value => { interrupted = value; controller.abort(new Error('tab closed')); } }), /tab closed/);
  assert.equal((await detail(interrupted)).status, 'uploading');
  await assert.rejects(client.uploadVideoCapture({ name: 'Steps', file: new File([bytes.subarray(0, PART)], 'other.mp4', { type: 'video/mp4' }), keepVideo: false, fetcher, resumeId: interrupted }),
    /same file/);
  assert.equal(await client.uploadVideoCapture({ name: 'Steps', file, keepVideo: false, fetcher, resumeId: interrupted }), interrupted);
  assert.equal((await detail(interrupted)).status, 'queued');
  await assert.rejects(client.uploadVideoCapture({ name: 'x', file: new File([bytes], 'clip.avi', { type: 'video/x-msvideo' }), keepVideo: false, fetcher }), /MP4 or MOV/);
});
