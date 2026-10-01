import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { Miniflare } from 'miniflare';

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
before(async () => {
  const result = await build({ stdin: { contents: 'import {handleApi} from "./worker/api.ts"; export default {fetch:handleApi}', resolveDir: process.cwd() }, bundle: true, write: false, format: 'esm', platform: 'browser' });
  mf = new Miniflare({ modules: true, script: result.outputFiles[0].text, compatibilityDate: '2026-01-01', d1Databases: ['DB'], r2Buckets: ['BUCKET'], bindings: { WORKER_TOKEN: token } });
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
