import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';

let client;
before(async () => {
  const result = await build({ entryPoints: ['lib/client.ts'], bundle: true, write: false, format: 'esm', platform: 'neutral' });
  client = await import(`data:text/javascript;base64,${Buffer.from(result.outputFiles[0].text).toString('base64')}`);
});
const tick = () => new Promise(resolve => setImmediate(resolve));

test('the upload pool keeps at most four uploads in flight and finishes every item', async () => {
  let inFlight = 0, peak = 0;
  const done = [];
  await client.runPool(Array.from({ length: 13 }, (_, i) => i), client.UPLOAD_CONCURRENCY, async item => {
    inFlight++; peak = Math.max(peak, inFlight);
    for (let i = 0; i < 1 + (item % 3); i++) await tick();
    inFlight--; done.push(item);
  });
  assert.equal(peak, 4);
  assert.deepEqual(done.sort((a, b) => a - b), Array.from({ length: 13 }, (_, i) => i));
  await client.runPool([], 4, async () => assert.fail('no items, no calls'));
});

test('after a failure the pool starts nothing new, lets in-flight items finish, and throws the first error', async () => {
  const started = [], finished = [];
  await assert.rejects(client.runPool(Array.from({ length: 10 }, (_, i) => i), 4, async item => {
    started.push(item);
    await tick();
    if (item === 1) throw new Error('photo 1 failed');
    if (item === 2) { await tick(); throw new Error('photo 2 failed later'); }
    await tick(); finished.push(item);
  }), /photo 1 failed/);
  assert.deepEqual(started, [0, 1, 2, 3]);
  assert.deepEqual(finished.sort(), [0, 3]);
});

test('a photo PUT retries network errors and 5xx, but not client errors', async () => {
  const waits = [];
  const wait = async ms => { waits.push(ms); };
  const replies = (...list) => { const calls = []; return { calls, fetcher: async (url, init) => { calls.push([url, init.method, init.headers['Content-Type']]); const next = list.shift(); if (next instanceof Error) throw next; return new Response(JSON.stringify(next.body ?? {}), { status: next.status }); } }; };

  const flaky = replies(new TypeError('network down'), { status: 503, body: { error: 'Storage is busy.' } }, { status: 200 });
  await client.putWithRetry('/api/captures/c/images/i', new Blob(['x']), 'image/png', { fetcher: flaky.fetcher, wait });
  assert.equal(flaky.calls.length, 3);
  assert.deepEqual(flaky.calls[0], ['/api/captures/c/images/i', 'PUT', 'image/png']);
  assert.deepEqual(waits, client.UPLOAD_RETRY_DELAYS);

  const rejected = replies({ status: 400, body: { error: 'The file is not the declared image type.' } });
  await assert.rejects(client.putWithRetry('/u', new Blob(['x']), 'image/png', { fetcher: rejected.fetcher, wait }), /not the declared image type/);
  assert.equal(rejected.calls.length, 1);

  const down = replies({ status: 502 }, { status: 502 }, { status: 502 }, { status: 200 });
  await assert.rejects(client.putWithRetry('/u', new Blob(['x']), 'image/png', { fetcher: down.fetcher, wait }), /could not be uploaded/);
  assert.equal(down.calls.length, 1 + client.UPLOAD_RETRY_DELAYS.length);
});

test('polling backs off from 2 s to a 20 s ceiling while nothing changes and resets on a change', () => {
  const delays = [client.POLL_MIN_MS];
  for (let i = 0; i < 8; i++) delays.push(client.nextPollDelay(delays.at(-1), false));
  assert.equal(delays[0], 2000);
  assert.ok(delays.every((d, i) => i === 0 || d >= delays[i - 1]), 'never speeds up without a change');
  assert.equal(delays.at(-1), client.POLL_MAX_MS);
  assert.ok(client.POLL_MAX_MS >= 15000 && client.POLL_MAX_MS <= 30000);
  assert.equal(client.nextPollDelay(client.POLL_MAX_MS, true), 2000);
});

test('polling stops at terminal states and ignores heartbeat-only changes', () => {
  const capture = (status, extra = {}) => ({ id: 'a', name: 'n', status, created_at: 1, updated_at: 1, image_count: 12, uploaded_count: 12, error: null, result_bytes: null, ...extra });
  for (const status of ['queued', 'aligning', 'training', 'exporting']) assert.equal(client.hasActiveCapture([capture('ready'), capture(status)]), true, status);
  for (const status of ['uploading', 'ready', 'failed']) assert.equal(client.hasActiveCapture([capture(status)]), false, status);
  const base = client.pollSignature([capture('training')], true);
  assert.equal(client.pollSignature([capture('training', { updated_at: 99 })], true), base, 'a heartbeat alone is not a change');
  assert.notEqual(client.pollSignature([capture('exporting')], true), base);
  assert.notEqual(client.pollSignature([capture('training', { alignment_ratio: 0.9 })], true), base);
  assert.notEqual(client.pollSignature([capture('training')], false), base, 'processor connectivity is shown, so it counts');
});
