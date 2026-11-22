// S7: rename, delete and retention (spec §7.10). Own Miniflare instance, same harness as api.test.mjs.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { build } from 'esbuild';
import { Miniflare } from 'miniflare';
import { applyMigrations } from '../db/migrate.mjs';

let mf;
const token = 'isolated-test-worker-token-not-for-production';
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=', 'base64');
const owner = 'test-owner@example.invalid';
const stranger = 'someone-else@example.invalid';
const manifest = (name = 'Delete fixture') => ({ name, images: Array.from({ length: 12 }, (_, i) => ({ name: `frame-${i}.png`, bytes: png.length, mime: 'image/png' })) });
async function request(path, method = 'GET', data, headers = {}) {
  return mf.dispatchFetch(`http://localhost/api/${path}`, { method, headers: { 'oai-authenticated-user-email': owner, ...(Buffer.isBuffer(data) ? { 'content-length': String(data.length) } : {}), ...headers }, body: data && (Buffer.isBuffer(data) ? data : JSON.stringify(data)) });
}
async function worker(path, method, data, lease) {
  return request(`worker/${path}`, method, data, { authorization: `Bearer ${token}`, ...(lease ? { 'x-job-lease': lease } : {}) });
}
let script;
before(async () => {
  const result = await build({ stdin: { contents: `import {handleApi, handleScheduled, purgeDeletedCaptures, sweepOrphanedPrefixes} from "./worker/api.ts";
    // "x-test-hold-put: 1" pauses this request's R2 put until /__test/release (an R2 write that completes
    // late); /__test/reached says whether the put has been called. Shared flags polled with timers, since
    // a promise cannot be resolved from another request.
    let gate = null;
    const holding = bucket => new Proxy(bucket, { get: (t, key) => key === 'put' ? async (...args) => {
      const mine = gate;
      mine.reached = true;
      while (!mine.released) await new Promise(resolve => setTimeout(resolve, 5));
      return t.put(...args);
    } : t[key].bind(t) });
    // Test-only: "x-test-r2-page: N" (or ?page=N) makes R2 list return at most N keys per page, so a
    // capture of a few hundred objects needs more calls than one request or cron run may make.
    const paged = (bucket, n) => new Proxy(bucket, { get: (target, key) => key === 'list' ? options => target.list({ ...options, limit: Math.min(options?.limit ?? 1000, n) }) : target[key].bind(target) });
    // Counts every D1 and R2 call (each is a subrequest).
    const counting = (env, ops) => {
      const count = fn => (...args) => { ops.count++; return fn(...args); };
      const statement = stmt => ({ raw: stmt, bind: (...args) => statement(stmt.bind(...args)), first: count((...args) => stmt.first(...args)), all: count(() => stmt.all()), run: count(() => stmt.run()) });
      return { ...env,
        DB: { prepare: sql => statement(env.DB.prepare(sql)), batch: count(statements => env.DB.batch(statements.map(s => s.raw))) },
        BUCKET: { list: count(options => env.BUCKET.list(options)), delete: count(keys => env.BUCKET.delete(keys)) } };
    };
    // "x-test-fail: batch,delete" makes this request's D1 batches and/or R2 deletes throw.
    const broken = (target, method, what) => new Proxy(target, { get: (t, key) => key === method ? async () => { throw new Error('test: ' + what + ' failed'); } : t[key].bind(t) });
    export default {fetch(request, env, ctx) {
      const url = new URL(request.url);
      const page = Number(request.headers.get('x-test-r2-page') || url.searchParams.get('page') || 0);
      const fail = (request.headers.get('x-test-fail') || '').split(',');
      let scoped = page ? { ...env, BUCKET: paged(env.BUCKET, page) } : env;
      if (fail.includes('batch')) scoped = { ...scoped, DB: broken(scoped.DB, 'batch', 'D1 batch') };
      if (fail.includes('delete')) scoped = { ...scoped, BUCKET: broken(scoped.BUCKET, 'delete', 'R2 delete') };
      if (request.headers.has('x-test-hold-put')) { gate = { reached: false, released: false }; scoped = { ...scoped, BUCKET: holding(scoped.BUCKET) }; }
      if (url.pathname === '/__test/reached') return new Response(String(gate?.reached ?? false));
      if (url.pathname === '/__test/release') { gate.released = true; return new Response('released'); }
      // ?start= positions the sweep's listing; ?age= shifts its clock forward (ms) to age the objects.
      if (url.pathname === '/__test/sweep') {
        const ops = { count: 0 };
        const options = { start: url.searchParams.get('start') ?? undefined, now: Date.now() + Number(url.searchParams.get('age') || 0) };
        return sweepOrphanedPrefixes(counting(scoped, ops), options).then(deleted => Response.json({ deleted, ops: ops.count }));
      }
      if (url.pathname === '/__test/purge') {
        const ops = { count: 0 };
        return purgeDeletedCaptures(counting(scoped, ops)).then(removed => Response.json({ removed, ops: ops.count }));
      }
      return handleApi(request, scoped, ctx);
    }, scheduled(controller, env, ctx) { ctx.waitUntil(handleScheduled(env)); }}`, resolveDir: process.cwd() }, bundle: true, write: false, format: 'esm', platform: 'browser' });
  script = result.outputFiles[0].text;
  mf = new Miniflare({ modules: true, script, compatibilityDate: '2026-01-01', d1Databases: ['DB'], r2Buckets: ['BUCKET'], bindings: { WORKER_TOKEN: token } });
  await applyMigrations(await mf.getD1Database('DB'));
});
after(async () => { await mf?.dispose(); });

const properties = ['x','y','z','opacity','scale_0','scale_1','scale_2','rot_0','rot_1','rot_2','rot_3','f_dc_0','f_dc_1','f_dc_2'];
const splat = (x = 0) => Buffer.from(`ply\nformat ascii 1.0\nelement vertex 1\n${properties.map(p => `property float ${p}\n`).join('')}end_header\n${x} 0 0 1 -2 -2 -2 1 0 0 0 0 0 0\n`);
const settle = () => new Promise(resolve => setTimeout(resolve, 400));
const cron = async () => (await mf.getWorker()).scheduled({ cron: '*/5 * * * *' });
const purgeRun = async page => (await mf.dispatchFetch(`http://localhost/__test/purge?page=${page}`)).json();
const listKeys = async prefix => (await (await mf.getR2Bucket('BUCKET')).list({ prefix })).objects.map(o => o.key);
const db = () => mf.getD1Database('DB');
const rows = async id => {
  const d = await db();
  return {
    capture: (await d.prepare('SELECT COUNT(*) AS n FROM captures WHERE id=?').bind(id).first()).n,
    images: (await d.prepare('SELECT COUNT(*) AS n FROM images WHERE capture_id=?').bind(id).first()).n,
  };
};
const status = async id => (await (await db()).prepare('SELECT status FROM captures WHERE id=?').bind(id).first())?.status;
const makeStale = async id => (await db()).prepare('UPDATE captures SET updated_at=? WHERE id=?').bind(Date.now() - 11 * 60_000, id).run();
/** A deleted capture is kept as a hidden tombstone: status `deleting`, no image rows. */
const tombstone = async id => {
  assert.equal(await status(id), 'deleting');
  assert.equal((await rows(id)).images, 0);
};
/** Moves a tombstone's deletion time back past PURGE_GRACE_MS (1 hour). */
const pastGrace = async id => (await db()).prepare("UPDATE captures SET updated_at=? WHERE id=? AND status='deleting'").bind(Date.now() - 61 * 60_000, id).run();
async function createCapture(name) { return (await request('captures', 'POST', manifest(name))).json(); }
async function uploadedCapture(name) {
  const capture = await createCapture(name);
  for (const image of capture.images) assert.equal((await request(`captures/${capture.id}/images/${image.id}`, 'PUT', png)).status, 200);
  return capture;
}
async function claim(expectedId) {
  const { job } = await (await worker('claim', 'POST', {})).json();
  assert.equal(job?.id, expectedId);
  return job;
}
async function queuedAndClaimed(name) {
  const capture = await uploadedCapture(name);
  assert.equal((await request(`captures/${capture.id}/submit`, 'POST')).status, 200);
  return { capture, job: await claim(capture.id) };
}
async function toExporting(job) {
  for (const next of ['training', 'exporting']) assert.equal((await worker(`${job.id}/status`, 'PATCH', { status: next }, job.lease)).status, 200);
}
async function readyCapture(name) {
  const { capture, job } = await queuedAndClaimed(name);
  await toExporting(job);
  assert.equal((await worker(`${job.id}/result`, 'PUT', splat(1), job.lease)).status, 200);
  return { capture, job };
}
/** Objects nothing references (stand-ins for attempt leftovers and pre-S2 layouts), `count` of them. */
async function strays(id, count) {
  const bucket = await mf.getR2Bucket('BUCKET');
  for (let i = 0; i < count; i += 50) {
    await Promise.all(Array.from({ length: Math.min(50, count - i) }, (_, j) => bucket.put(`${id}/attempts/${String(i + j).padStart(32, '0')}/result.x.ply`, 'stray')));
  }
}
function heldRequest(path, headers, length, method = 'PUT') {
  let controller;
  const body = new ReadableStream({ start(c) { controller = c; } });
  const response = mf.dispatchFetch(`http://localhost/api/${path}`, { method, headers: { 'content-length': String(length), ...headers }, body, duplex: 'half' });
  return { response, send: bytes => controller.enqueue(new Uint8Array(bytes)), end: () => controller.close() };
}

test('rename: trimmed, validated like the create name, owner-only, any visible state', async () => {
  const capture = await createCapture('Original name');
  const before = (await (await request(`captures/${capture.id}`)).json()).capture;
  const renamed = await request(`captures/${capture.id}`, 'PATCH', { name: '  Kitchen, morning light  ' });
  assert.equal(renamed.status, 200);
  assert.equal((await renamed.json()).capture.name, 'Kitchen, morning light');
  const after = (await (await request(`captures/${capture.id}`)).json()).capture;
  assert.equal(after.name, 'Kitchen, morning light');
  assert.equal(after.updated_at, before.updated_at, 'a rename is not progress: updated_at is the lease clock');
  assert.ok((await (await request('captures')).json()).captures.some(c => c.id === capture.id && c.name === 'Kitchen, morning light'));
  assert.equal((await request(`captures/${capture.id}`, 'PATCH', { name: 'x'.repeat(80) })).status, 200, '80 characters is the limit');

  for (const body of [{ name: '' }, { name: '   ' }, { name: 'x'.repeat(81) }, { name: 42 }, {}, ['name']]) {
    const response = await request(`captures/${capture.id}`, 'PATCH', body);
    assert.equal(response.status, 400, JSON.stringify(body));
    assert.ok((await response.json()).error);
  }
  assert.equal((await request(`captures/${capture.id}`, 'PATCH', Buffer.from('{not json'))).status, 400);
  assert.equal((await request(`captures/${capture.id}`, 'PATCH', { name: 'Theirs now' }, { 'oai-authenticated-user-email': stranger })).status, 404);
  assert.equal((await request(`captures/${capture.id}`, 'PATCH', { name: 'Theirs now' }, { 'oai-authenticated-user-email': '' })).status, 401);
  assert.equal((await request(`captures/${capture.id}`, 'PATCH', { name: 'Forged' }, { origin: 'https://attacker.example' })).status, 403);
  assert.equal((await request('captures/no-such-capture', 'PATCH', { name: 'Ghost' })).status, 404);
  assert.equal((await (await request(`captures/${capture.id}`)).json()).capture.name, 'x'.repeat(80), 'rejected renames change nothing');

  // A capture being processed may be renamed too; its lease and clock are untouched.
  const { capture: busy, job } = await queuedAndClaimed('Busy');
  assert.equal((await request(`captures/${busy.id}`, 'PATCH', { name: 'Busy, renamed' })).status, 200);
  assert.equal((await worker(`${job.id}/status`, 'PATCH', { status: 'training' }, job.lease)).status, 200, 'the lease still holds');
  assert.equal((await worker(`${job.id}/status`, 'PATCH', { status: 'failed', error: 'test cleanup' }, job.lease)).status, 200);
});

test('delete removes the rows and every object under the capture, and only for its owner', async () => {
  const { capture } = await readyCapture('To delete');
  const bucket = await mf.getR2Bucket('BUCKET');
  // Every layout the bucket may hold for a capture: pre-S2 images and results, attempt leftovers.
  await bucket.put(`${capture.id}/images/legacy-image`, png);
  await bucket.put(`${capture.id}/result.ply`, splat(9));
  await bucket.put(`${capture.id}/attempts/${'f'.repeat(32)}/result.old.ply`, splat(8));
  const keys = await listKeys(`${capture.id}/`);
  assert.ok(keys.length >= 16, `fixture holds ${keys.length} objects`);
  const neighbour = await uploadedCapture('Neighbour');
  const neighbourKeys = await listKeys(`${neighbour.id}/`);

  assert.equal((await request(`captures/${capture.id}`, 'DELETE', undefined, { 'oai-authenticated-user-email': stranger })).status, 404);
  assert.equal((await request(`captures/${capture.id}`, 'DELETE', undefined, { origin: 'https://attacker.example' })).status, 403);
  assert.deepEqual(await listKeys(`${capture.id}/`), keys, 'a refused delete removes nothing');
  assert.equal(await status(capture.id), 'ready');

  const deleted = await request(`captures/${capture.id}`, 'DELETE');
  assert.equal(deleted.status, 200);
  assert.deepEqual(await deleted.json(), { deleted: true });
  assert.deepEqual(await listKeys(`${capture.id}/`), []);
  await tombstone(capture.id);
  assert.deepEqual(await listKeys(`${neighbour.id}/`), neighbourKeys, 'other captures are untouched');
  assert.equal((await rows(neighbour.id)).images, 12);
  assert.equal((await request(`captures/${capture.id}`)).status, 404);
  assert.equal((await request(`captures/${capture.id}`, 'DELETE')).status, 404, 'a second delete finds nothing');
  assert.equal((await (await request('captures')).json()).captures.some(c => c.id === capture.id), false);

  // Uploading and queued captures may be deleted too; a deleted queued capture is never claimed.
  assert.equal((await request(`captures/${neighbour.id}`, 'DELETE')).status, 200);
  assert.deepEqual(await listKeys(`${neighbour.id}/`), []);
  const queued = await uploadedCapture('Queued');
  assert.equal((await request(`captures/${queued.id}/submit`, 'POST')).status, 200);
  assert.equal((await request(`captures/${queued.id}`, 'DELETE')).status, 200);
  assert.equal((await (await worker('claim', 'POST', {})).json()).job, null);
  await tombstone(queued.id);

  // Tombstones are left alone inside the grace window and removed after it; live captures are untouched.
  const live = await uploadedCapture('Live');
  const liveKeys = await listKeys(`${live.id}/`);
  await cron();
  for (const id of [capture.id, neighbour.id, queued.id]) await tombstone(id);
  for (const id of [capture.id, neighbour.id, queued.id]) await pastGrace(id);
  await cron();
  for (const id of [capture.id, neighbour.id, queued.id]) assert.deepEqual(await rows(id), { capture: 0, images: 0 });
  assert.deepEqual(await rows(live.id), { capture: 1, images: 12 });
  assert.deepEqual(await listKeys(`${live.id}/`), liveKeys);
});

test('delete is refused while the capture is leased, and allowed once the lease has expired', async () => {
  const { capture, job } = await queuedAndClaimed('Leased');
  const keys = await listKeys(`${capture.id}/`);
  for (const stage of ['aligning', 'exporting']) {
    if (stage === 'exporting') await toExporting(job);
    const refused = await request(`captures/${capture.id}`, 'DELETE');
    assert.equal(refused.status, 409);
    assert.match((await refused.json()).error, /being processed/);
    assert.equal(await status(capture.id), stage);
    assert.deepEqual(await listKeys(`${capture.id}/`), keys);
  }
  assert.equal((await worker(`${job.id}/status`, 'PATCH', { status: 'exporting' }, job.lease)).status, 200, 'the attempt carries on');
  // A dead attempt never blocks a delete: its lease is expired on the way in.
  await makeStale(capture.id);
  assert.equal((await request(`captures/${capture.id}`, 'DELETE')).status, 200);
  await tombstone(capture.id);
  assert.deepEqual(await listKeys(`${capture.id}/`), []);
});

test('a capture with more objects than one request may delete is hidden at once and finished by the cron', async () => {
  const { capture, job } = await queuedAndClaimed('Large');
  await makeStale(capture.id);
  await strays(capture.id, 600);
  // 10 keys per page: the request's 30 calls delete ~150 objects, then it hands over to the cron.
  const deleted = await request(`captures/${capture.id}`, 'DELETE', undefined, { 'x-test-r2-page': '10' });
  assert.equal(deleted.status, 202);
  assert.deepEqual(await deleted.json(), { deleted: true, pending: true });
  assert.equal(await status(capture.id), 'deleting');
  const afterRequest = (await listKeys(`${capture.id}/`)).length;
  assert.ok(afterRequest > 0 && afterRequest < 612, `partly deleted: ${afterRequest} objects left`);

  // Hidden from its owner, and nothing can revive it.
  assert.equal((await (await request('captures')).json()).captures.some(c => c.id === capture.id), false);
  for (const [path, method, body] of [[``, 'GET'], [``, 'PATCH', { name: 'Back' }], [``, 'DELETE'], ['/submit', 'POST'], ['/scene', 'GET'], ['/result.ply', 'GET'], [`/images/${job.images[0].id}`, 'GET'], [`/images/${job.images[0].id}`, 'PUT', png]]) {
    assert.equal((await request(`captures/${capture.id}${path}`, method, body)).status, 404, `${method} ${path || '/'}`);
  }
  assert.equal((await (await worker('claim', 'POST', {})).json()).job, null, 'never claimable');
  assert.equal((await worker(`${job.id}/status`, 'PATCH', { status: 'exporting' }, job.lease)).status, 409);
  assert.equal((await worker(`${job.id}/result`, 'PUT', splat(2), job.lease)).status, 409);
  assert.equal(await status(capture.id), 'deleting');

  // One run's share of the cron budget: bounded, and it makes progress.
  const run = await purgeRun(10);
  assert.ok(run.ops <= 20, `a purge run made ${run.ops} calls`);
  assert.equal(run.removed, 0);
  const afterRun = (await listKeys(`${capture.id}/`)).length;
  assert.ok(afterRun > 0 && afterRun < afterRequest, `${afterRun} objects left after a run`);
  assert.equal(await status(capture.id), 'deleting', 'the rows stay until the objects are gone');

  // The real cron (1000 keys per page) empties it; the capture row stays as a tombstone.
  await cron();
  assert.deepEqual(await listKeys(`${capture.id}/`), []);
  await tombstone(capture.id);
  assert.deepEqual(await purgeRun(1000), { removed: 0, ops: 1 }, 'a tombstone inside the grace window costs one query');
  // After the grace window: one final listing, then the row.
  await pastGrace(capture.id);
  assert.deepEqual(await purgeRun(1000), { removed: 1, ops: 3 });
  assert.deepEqual(await rows(capture.id), { capture: 0, images: 0 });
  assert.deepEqual(await purgeRun(1000), { removed: 0, ops: 1 }, 'nothing left to do: one query');
});

test('a worker PUT or heartbeat after a delete fails and leaves nothing behind', async () => {
  const { capture, job } = await queuedAndClaimed('Late worker');
  await toExporting(job);
  const result = splat(3);
  const late = heldRequest(`worker/${capture.id}/result`, { authorization: `Bearer ${token}`, 'x-job-lease': job.lease }, result.length);
  late.send(result.subarray(0, result.length - 10));
  await settle();
  // The attempt stalls past its lease; the owner deletes the capture.
  await makeStale(capture.id);
  assert.equal((await request(`captures/${capture.id}`, 'DELETE')).status, 200);
  await tombstone(capture.id);
  // The upload completes: it must lose, and remove the object it stored after the purge.
  late.send(result.subarray(result.length - 10));
  late.end();
  assert.equal((await late.response).status, 409);
  assert.equal((await worker(`${job.id}/status`, 'PATCH', { status: 'exporting' }, job.lease)).status, 409);
  assert.equal((await worker(`${job.id}/result.spz`, 'PUT', Buffer.from('spz'), job.lease)).status, 409);
  assert.equal((await worker(`${job.id}/result`, 'PUT', splat(4), job.lease)).status, 409);
  await settle();
  assert.deepEqual(await listKeys(`${capture.id}/`), []);
  await tombstone(capture.id); // nothing revived it or recreated an image row
  await pastGrace(capture.id);
  await cron();
  assert.deepEqual(await rows(capture.id), { capture: 0, images: 0 });
  // Once the row is gone there is no job to write under.
  assert.equal((await worker(`${job.id}/result`, 'PUT', splat(5), job.lease)).status, 409);
  assert.deepEqual(await listKeys(`${capture.id}/`), []);
});

test('an image PUT racing a delete leaves nothing behind', async () => {
  for (const pending of [false, true]) {
    const capture = await createCapture(pending ? 'Racing, pending' : 'Racing');
    for (const image of capture.images.slice(0, 6)) assert.equal((await request(`captures/${capture.id}/images/${image.id}`, 'PUT', png)).status, 200);
    if (pending) await strays(capture.id, 400);
    const target = capture.images[6];
    const racing = heldRequest(`captures/${capture.id}/images/${target.id}`, { 'oai-authenticated-user-email': owner }, png.length);
    racing.send(png.subarray(0, 10));
    await settle();
    // With 10 keys per page the purge cannot finish in the request, so the PUT lands while the row is
    // still `deleting`; otherwise it lands after the rows are gone.
    const deleted = await request(`captures/${capture.id}`, 'DELETE', undefined, pending ? { 'x-test-r2-page': '10' } : {});
    assert.equal(deleted.status, pending ? 202 : 200);
    racing.send(png.subarray(10));
    racing.end();
    assert.equal((await racing.response).status, 409);
    assert.equal((await listKeys(`${capture.id}/uploads/${target.id}/`)).length, 0, 'the racing upload removed its own object');
    if (pending) await cron();
    assert.deepEqual(await listKeys(`${capture.id}/`), []);
    await tombstone(capture.id);
  }
});

test('an object stored after the purge whose commit and cleanup both fail is removed by the tombstone sweep (I7)', async () => {
  for (const failures of ['batch', 'batch,delete']) {
    const capture = await createCapture(`Late writer, ${failures}`);
    const target = capture.images[0];
    // Admitted while uploading, paused before storing.
    const late = heldRequest(`captures/${capture.id}/images/${target.id}`, { 'oai-authenticated-user-email': owner, 'x-test-fail': failures }, png.length);
    late.send(png.subarray(0, 10));
    await settle();
    const deleted = await request(`captures/${capture.id}`, 'DELETE');
    assert.equal(deleted.status, 200, 'the purge finished and the owner is told so');
    await tombstone(capture.id);
    // The PUT now stores, and its D1 batch throws.
    late.send(png.subarray(10));
    late.end();
    assert.equal((await late.response).status, 500);
    const stored = await listKeys(`${capture.id}/uploads/${target.id}/`);
    if (failures === 'batch') {
      assert.deepEqual(stored, [], 'a commit that throws deletes the object it stored');
      continue;
    }
    // Its cleanup failed too: the object exists, but the tombstone still names the prefix.
    assert.equal(stored.length, 1);
    await cron();
    assert.equal(stored.length, (await listKeys(`${capture.id}/uploads/${target.id}/`)).length, 'left alone inside the grace window');
    await tombstone(capture.id);
    await pastGrace(capture.id);
    await cron();
    assert.deepEqual(await listKeys(`${capture.id}/`), [], 'the final sweep found and removed it');
    assert.deepEqual(await rows(capture.id), { capture: 0, images: 0 });
  }
});

test('a rejected result PUT deletes its own object even when its attempt holds more than one page of keys', async () => {
  const { capture, job } = await queuedAndClaimed('Crowded attempt');
  await toExporting(job);
  const dir = `${capture.id}/attempts/${createHash('sha256').update(job.lease).digest('hex').slice(0, 32)}`;
  // 150 keys that sort before `result.*`: one 100-key page of the attempt is all strays.
  const bucket = await mf.getR2Bucket('BUCKET');
  await Promise.all(Array.from({ length: 150 }, (_, i) => bucket.put(`${dir}/a${String(i).padStart(3, '0')}`, 'stray')));
  const result = splat(6);
  const late = heldRequest(`worker/${capture.id}/result`, { authorization: `Bearer ${token}`, 'x-job-lease': job.lease }, result.length);
  late.send(result.subarray(0, result.length - 10));
  await settle();
  await makeStale(capture.id);
  late.send(result.subarray(result.length - 10));
  late.end();
  assert.equal((await late.response).status, 409);
  assert.deepEqual((await listKeys(`${dir}/`)).filter(key => key.startsWith(`${dir}/result.`)), [], 'its own object went by name');
  assert.equal(await status(capture.id), 'failed');
});

// S7 round 3: the orphan sweep (spec §7.10), the backstop that makes I7 hold whatever R2's write latency.
const sweep = async (start, age = 0) => (await mf.dispatchFetch(`http://localhost/__test/sweep?start=${encodeURIComponent(start)}&age=${age}`)).json();
const OLD = 61 * 60_000; // past ORPHAN_MIN_AGE_MS (1 hour)
const SWEEP_BUDGET = 5; // ORPHAN_SWEEP_SUBREQUESTS

test('the orphan sweep deletes old objects under prefixes with no capture row, and nothing else', async () => {
  const bucket = await mf.getR2Bucket('BUCKET');
  // Ids at the top of the key space, so a listing that starts after "fffffff0" reaches them first.
  const orphans = [1, 2].map(n => `fffffff0-0000-4000-8000-00000000000${n}`);
  for (const id of orphans) await Promise.all([bucket.put(`${id}/uploads/a/1`, 'x'), bucket.put(`${id}/attempts/b/result.c.ply`, 'x')]);
  // Prefixes whose rows exist are never touched, in any state: a ready capture, and a tombstone that
  // (like a late writer's leftovers) still has an object.
  const { capture: ready } = await readyCapture('Kept, ready');
  const readyKeys = await listKeys(`${ready.id}/`);
  assert.ok(readyKeys.length > 0);
  const gone = await createCapture('Kept, tombstone');
  assert.equal((await request(`captures/${gone.id}`, 'DELETE')).status, 200);
  await bucket.put(`${gone.id}/uploads/late/1`, 'x');

  // Younger than the safety age: kept. Listing, wrap-around listing, lookup, then the first orphan's
  // listing; the budget leaves no room to list the second.
  assert.deepEqual(await sweep('fffffff0'), { deleted: 0, ops: 4 });
  for (const id of orphans) assert.equal((await listKeys(`${id}/`)).length, 2);

  // Old enough: one orphan per run within the budget of 5 calls; the next run takes the next one.
  assert.deepEqual(await sweep('fffffff0', OLD), { deleted: 2, ops: SWEEP_BUDGET });
  assert.deepEqual(await listKeys(`${orphans[0]}/`), []);
  assert.equal((await listKeys(`${orphans[1]}/`)).length, 2, 'the budget stopped the run after one orphan');
  assert.deepEqual(await sweep('fffffff0', OLD), { deleted: 2, ops: SWEEP_BUDGET });
  assert.deepEqual(await listKeys(`${orphans[1]}/`), []);

  // A run from anywhere in the key space wraps around and stays within budget; rows keep their objects.
  for (const start of ['0', '8', 'fffffff0', crypto.randomUUID()]) assert.ok((await sweep(start, OLD)).ops <= SWEEP_BUDGET);
  assert.deepEqual(await listKeys(`${ready.id}/`), readyKeys);
  assert.deepEqual(await listKeys(`${gone.id}/`), [`${gone.id}/uploads/late/1`]);
  await tombstone(gone.id);
  // The cron as a whole stays within its budget with the sweep in it (1 lease sweep + 40).
  await cron();
});

test('a writer whose R2 put completes after the tombstone was removed is cleaned up by the orphan sweep (I7)', async () => {
  const capture = await createCapture('Very late writer');
  const target = capture.images[0];
  // Admitted while uploading; its R2 put is called and then takes longer than the whole grace window.
  const late = request(`captures/${capture.id}/images/${target.id}`, 'PUT', png, { 'x-test-hold-put': '1', 'x-test-fail': 'batch,delete' });
  while (await (await mf.dispatchFetch('http://localhost/__test/reached')).text() !== 'true') await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal((await request(`captures/${capture.id}`, 'DELETE')).status, 200);
  await pastGrace(capture.id);
  await purgeRun(1000);
  assert.deepEqual(await rows(capture.id), { capture: 0, images: 0 }, 'the tombstone is gone');
  // Now R2 completes the write; the commit and the writer's own cleanup both fail.
  await (await mf.dispatchFetch('http://localhost/__test/release')).text();
  assert.equal((await late).status, 500);
  assert.equal((await listKeys(`${capture.id}/`)).length, 1, 'an object with no row');
  // Starting the listing at the id makes `{id}/` the first prefix it reaches.
  assert.equal((await sweep(capture.id)).deleted, 0, 'kept until it is older than the safety age');
  assert.equal((await listKeys(`${capture.id}/`)).length, 1);
  assert.equal((await sweep(capture.id, OLD)).deleted, 1);
  assert.deepEqual(await listKeys(`${capture.id}/`), []);
});
