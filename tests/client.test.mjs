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

const replies = (...list) => {
  const calls = [];
  return { calls, fetcher: async (url, init) => {
    calls.push([url, init.method, init.headers['Content-Type']]);
    const next = list.shift();
    if (next instanceof Error) throw next;
    return new Response(JSON.stringify(next.body ?? {}), { status: next.status, headers: next.headers ?? {} });
  } };
};

test('a photo PUT retries network errors and 5xx with jittered, growing waits, but not client errors', async () => {
  const waits = [];
  const wait = async ms => { waits.push(ms); };
  const flaky = replies(new TypeError('network down'), { status: 503, body: { error: 'Storage is busy.' } }, { status: 200 });
  await client.putWithRetry('/api/captures/c/images/i', new Blob(['x']), 'image/png', { fetcher: flaky.fetcher, wait, random: () => 0.5 });
  assert.equal(flaky.calls.length, 3);
  assert.deepEqual(flaky.calls[0], ['/api/captures/c/images/i', 'PUT', 'image/png']);
  assert.deepEqual(waits, client.UPLOAD_RETRY_DELAYS.slice(0, 2), 'random()=0.5 is the unjittered base');
  assert.ok(client.UPLOAD_RETRY_DELAYS.reduce((a, b) => a + b) >= 30_000, 'retries ride out at least ~30 s of outage');

  // Jitter spreads each wait over 50-150% of its base, so a pool of failures does not retry in lockstep.
  for (const [r, factor] of [[0, 0.5], [0.999, 1.499]]) {
    waits.length = 0;
    const flake = replies({ status: 500 }, { status: 200 });
    await client.putWithRetry('/u', new Blob(['x']), 'image/png', { fetcher: flake.fetcher, wait, random: () => r });
    assert.deepEqual(waits, [Math.round(client.UPLOAD_RETRY_DELAYS[0] * factor)]);
  }

  const rejected = replies({ status: 400, body: { error: 'The file is not the declared image type.' } });
  await assert.rejects(client.putWithRetry('/u', new Blob(['x']), 'image/png', { fetcher: rejected.fetcher, wait, label: 'IMG_0007.jpg' }),
    /^Error: Could not upload IMG_0007\.jpg\. The file is not the declared image type\.$/, 'the error names the photo');
  assert.equal(rejected.calls.length, 1);

  const down = replies(...Array.from({ length: 9 }, () => ({ status: 502 })));
  await assert.rejects(client.putWithRetry('/u', new Blob(['x']), 'image/png', { fetcher: down.fetcher, wait, label: 'IMG_0042.heic' }), /Could not upload IMG_0042\.heic\. Check your connection/);
  assert.equal(down.calls.length, 1 + client.UPLOAD_RETRY_DELAYS.length);
});

test('a 429 or 503 Retry-After is honoured (seconds or HTTP date), capped at a minute', async () => {
  const now = Date.parse('2026-11-23T12:00:00Z');
  assert.equal(client.retryAfterMs('7', now), 7000);
  assert.equal(client.retryAfterMs('Mon, 23 Nov 2026 12:00:30 GMT', now), 30_000);
  assert.equal(client.retryAfterMs('Mon, 23 Nov 2026 11:00:00 GMT', now), 0, 'a past date means now');
  for (const bad of [null, '', ' ', 'soon', '-3']) assert.equal(client.retryAfterMs(bad, now), null, String(bad));

  const waits = [];
  const wait = async ms => { waits.push(ms); };
  const limited = replies({ status: 429, headers: { 'retry-after': '12' } }, { status: 503, headers: { 'retry-after': '600' } }, { status: 429, headers: { 'retry-after': '0' } }, { status: 200 });
  await client.putWithRetry('/u', new Blob(['x']), 'image/png', { fetcher: limited.fetcher, wait, random: () => 0.5 });
  const [d0, , d2] = client.UPLOAD_RETRY_DELAYS;
  assert.deepEqual(waits, [Math.max(12_000, d0), client.MAX_RETRY_AFTER_MS, d2], 'the longer of Retry-After and the backoff, at most a minute');
  waits.length = 0;
  const ignored = replies({ status: 500, headers: { 'retry-after': '30' } }, { status: 200 });
  await client.putWithRetry('/u', new Blob(['x']), 'image/png', { fetcher: ignored.fetcher, wait, random: () => 0.5 });
  assert.deepEqual(waits, [d0], 'Retry-After only means something on 429 and 503');
});

test('an abort stops a photo mid-request or mid-wait, and the pool starts nothing more', async () => {
  // Mid-wait: the real sleep rejects with the abort reason at once.
  const controller = new AbortController();
  const failing = replies({ status: 503 }, { status: 503 });
  const started = Date.now();
  const put = client.putWithRetry('/u', new Blob(['x']), 'image/png', { fetcher: failing.fetcher, signal: controller.signal, random: () => 0.5 });
  await tick(); await tick();
  controller.abort(new DOMException('Upload cancelled.', 'AbortError'));
  await assert.rejects(put, error => error.name === 'AbortError' && error.message === 'Upload cancelled.');
  assert.ok(Date.now() - started < 500, 'the 1 s backoff was cut short');
  assert.equal(failing.calls.length, 1, 'no retry after the abort');

  // Mid-request: fetch rejects because of the signal; that is not retried either.
  const second = new AbortController();
  let calls = 0;
  const hanging = (url, init) => { calls++; return new Promise((_, reject) => init.signal.addEventListener('abort', () => reject(init.signal.reason))); };
  const waits = [];
  const request = client.putWithRetry('/u', new Blob(['x']), 'image/png', { fetcher: hanging, signal: second.signal, wait: async ms => { waits.push(ms); } });
  await tick();
  second.abort();
  await assert.rejects(request, error => error.name === 'AbortError');
  assert.deepEqual([calls, waits], [1, []]);

  // The pool: in-flight items see the signal; nothing new starts; the abort reason is thrown, not an item error.
  const pool = new AbortController();
  const begun = [];
  const run = client.runPool(Array.from({ length: 10 }, (_, i) => i), 4, async (item, signal) => {
    begun.push(item);
    assert.equal(signal, pool.signal);
    await new Promise((_, reject) => signal.addEventListener('abort', () => reject(new Error(`photo ${item} interrupted`))));
  }, pool.signal);
  await tick();
  pool.abort(new DOMException('Upload cancelled.', 'AbortError'));
  await assert.rejects(run, error => error.name === 'AbortError');
  assert.deepEqual(begun, [0, 1, 2, 3]);
  const already = new AbortController(); already.abort();
  await assert.rejects(client.runPool([1, 2], 2, async () => assert.fail('nothing starts after an abort'), already.signal), error => error.name === 'AbortError');
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

/** Fake timers and a poll whose responses the test releases one at a time. */
function pollerHarness({ hidden = () => false } = {}) {
  const timers = [];
  const pending = [];
  let polls = 0;
  const poller = client.createPoller(() => { polls++; return new Promise((resolve, reject) => pending.push({ resolve, reject })); }, {
    hidden,
    timers: { set: (callback, ms) => { const t = { callback, ms }; timers.push(t); return t; }, clear: t => { const i = timers.indexOf(t); if (i >= 0) timers.splice(i, 1); } },
  });
  return { poller, timers, pending, polls: () => polls, async reply(result) { pending.shift().resolve(result); await tick(); await tick(); }, async fail(error) { pending.shift().reject(error); await tick(); await tick(); } };
}

test('a wake during an in-flight poll re-polls right after it and ignores the stale result (H2)', async () => {
  const h = pollerHarness();
  void h.poller.wake();
  assert.equal(h.polls(), 1);
  void h.poller.wake();                       // e.g. the user submitted while the poll was in flight
  void h.poller.wake();
  assert.equal(h.polls(), 1, 'no overlapping polls');
  await h.reply({ signature: 'old', active: false });
  assert.equal(h.polls(), 2, 'the dirty flag re-runs the poll at once');
  assert.equal(h.timers.length, 0, 'the stale result (inactive) scheduled nothing');
  await h.reply({ signature: 'new', active: true });
  assert.equal(h.polls(), 2);
  assert.deepEqual(h.timers.map(t => t.ms), [client.POLL_MIN_MS], 'scheduled from the fresh result, which is active');
  h.poller.stop();
  assert.equal(h.timers.length, 0);
});

test('polling backs off while active, refreshes once a minute while idle, and never runs hidden (M4, LOW)', async () => {
  let hidden = false;
  const h = pollerHarness({ hidden: () => hidden });
  void h.poller.wake();
  await h.reply({ signature: 'a', active: true });
  assert.deepEqual(h.timers.map(t => t.ms), [2000]);
  h.timers.shift().callback();
  await h.reply({ signature: 'a', active: true });
  assert.deepEqual(h.timers.map(t => t.ms), [3200], 'unchanged: backs off');
  h.timers.shift().callback();
  await h.reply({ signature: 'b', active: false });
  assert.deepEqual(h.timers.map(t => t.ms), [client.IDLE_REFRESH_MS], 'nothing in flight: still refreshed (processor indicator) every minute');
  assert.equal(client.IDLE_REFRESH_MS, 60_000);
  hidden = true;
  h.timers.shift().callback();                // a timer that fires while hidden polls nothing and schedules nothing
  assert.equal(h.polls(), 3);
  assert.equal(h.timers.length, 0);
  void h.poller.wake();
  assert.equal(h.polls(), 3, 'tick checks document.hidden first');
  hidden = false;
  void h.poller.wake();                       // visibilitychange to visible
  assert.equal(h.polls(), 4);
  await h.reply({ signature: 'b', active: true });
  assert.deepEqual(h.timers.map(t => t.ms), [2000], 'a wake resets the backoff');
  hidden = true;
  h.timers.shift().callback();
  void h.poller.wake();
  assert.equal(h.polls(), 4);
  h.poller.stop();
  hidden = false;
  void h.poller.wake();
  assert.equal(h.polls(), 4, 'stopped for good (unmount)');
});

test('latestOnly drops a response that started before one already applied (H2)', () => {
  const order = client.latestOnly();
  const first = order.begin();                // the poll
  const second = order.begin();               // the direct refresh after a submit
  assert.equal(order.accept(second), true);
  assert.equal(order.accept(first), false, 'the older poll response arrives late and is dropped');
  const third = order.begin();
  assert.equal(order.accept(third), true);
  assert.equal(order.accept(third), false, 'applied once');
});

test('a poll that throws keeps polling at the fastest rate instead of stopping for good (round 3, item 2)', async () => {
  const h = pollerHarness();
  void h.poller.wake();
  await h.reply({ signature: 'a', active: false });
  assert.deepEqual(h.timers.map(t => t.ms), [client.IDLE_REFRESH_MS]);
  h.timers.shift().callback();
  await h.fail(new TypeError('Failed to fetch'));
  assert.deepEqual(h.timers.map(t => t.ms), [client.POLL_MIN_MS], 'rescheduled, treated as a changed, active result');
  h.timers.shift().callback();
  assert.equal(h.polls(), 3, 'the next tick polls again');
  await h.fail(new Error('still down'));
  assert.equal(h.timers.length, 1, 'still scheduled after repeated failures');
  // A throw during a dirty re-poll is handled the same way.
  h.timers.shift().callback();
  void h.poller.wake();
  await h.reply({ signature: 'b', active: true });
  await h.fail(new Error('flaky'));
  assert.deepEqual(h.timers.map(t => t.ms), [client.POLL_MIN_MS]);
  h.timers.shift();
  const woke = h.poller.wake();
  await h.fail(new Error('down again'));
  await woke; // resolves: a throwing poll never surfaces as an unhandled rejection from tick()
  h.poller.stop();
});
