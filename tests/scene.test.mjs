import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';

let scene;
before(async () => {
  const result = await build({ entryPoints: ['lib/scene.ts'], bundle: true, write: false, format: 'esm', platform: 'neutral' });
  scene = await import(`data:text/javascript;base64,${Buffer.from(result.outputFiles[0].text).toString('base64')}`);
});

/** A response whose body yields `chunks`, then ends or (with `fail`) errors like a dropped connection. */
function respond(chunks, { headers = {}, status = 200, fail = null } = {}) {
  const body = new ReadableStream({
    async pull(controller) {
      await new Promise(resolve => setImmediate(resolve));
      if (chunks.length) controller.enqueue(new Uint8Array(chunks.shift()));
      else if (fail) controller.error(fail);
      else controller.close();
    },
  });
  return new Response(body, { status, headers });
}
async function drain(stream) {
  const reader = stream.getReader();
  let bytes = 0;
  for (;;) {
    const { done, value } = await reader.read(); // never rejects: Spark's worker would hang on an error
    if (done) return bytes;
    bytes += value.byteLength;
  }
}

test('the scene is streamed to Spark with byte progress, its length and a file name for the decoder (H1)', async () => {
  const progress = [];
  let init;
  const fetcher = async (url, options) => { init = options; return respond([[1, 2, 3], [4, 5], [6]], { headers: { 'content-length': '6', 'x-splat-format': 'spz' } }); };
  const signal = new AbortController().signal;
  const opened = await scene.openScene('/api/captures/c/scene?v=1', signal, (...p) => progress.push(p), fetcher);
  assert.equal(init.signal, signal, 'the fetch is abortable');
  assert.deepEqual([opened.streamLength, opened.fileName], [6, 'scene.spz']);
  assert.equal(await drain(opened.stream), 6);
  assert.deepEqual(progress, [[3, 6, false], [5, 6, false], [6, 6, false], [6, 6, true]]);
  assert.equal(opened.download.failure, null);

  // Without the header the URL's extension names the format; an encoded body has no usable length.
  const ply = await scene.openScene('/api/captures/c/result.ply', signal, () => {}, async () => respond([[1]], { headers: { 'content-length': '1', 'content-encoding': 'gzip' } }));
  assert.deepEqual([ply.streamLength, ply.fileName], [undefined, 'scene.ply']);
  const sample = await scene.openScene('https://sparkjs.dev/assets/splats/butterfly.SPZ', signal, () => {}, async () => respond([]));
  assert.equal(sample.fileName, 'scene.spz');
});

test('a broken download ends the stream cleanly and is recorded, so it is never mistaken for a bad file (C1, H1)', async () => {
  const signal = new AbortController().signal;
  const dropped = await scene.openScene('/s.spz', signal, () => {}, async () => respond([[1, 2]], { headers: { 'content-length': '9' }, fail: new TypeError('network error') }));
  assert.equal(await drain(dropped.stream), 2);
  assert.match(String(dropped.download.failure), /network error/);

  const short = await scene.openScene('/s.spz', signal, () => {}, async () => respond([[1, 2]], { headers: { 'content-length': '9' } }));
  assert.equal(await drain(short.stream), 2);
  assert.match(String(short.download.failure), /ended at 2 of 9 bytes/);

  // More bytes than announced (a proxy lied): progress drops the total instead of passing 100%.
  const progress = [];
  const long = await scene.openScene('/s.spz', signal, (...p) => progress.push(p), async () => respond([[1, 2], [3, 4]], { headers: { 'content-length': '3' } }));
  await drain(long.stream);
  assert.deepEqual(progress.slice(0, 2), [[2, 3, false], [4, 0, false]]);

  for (const status of [404, 503]) {
    await assert.rejects(scene.openScene('/s.spz', signal, () => {}, async () => respond([], { status })), error => error instanceof scene.DownloadError && error.message === `HTTP ${status}`);
  }
  await assert.rejects(scene.openScene('/s.spz', signal, () => {}, async () => { throw new TypeError('offline'); }), scene.DownloadError);
});

test('aborting (unmount, new scene) stops the download mid-body (H1)', async () => {
  const controller = new AbortController();
  // A real fetch-like body that errors once the request's signal aborts, as browsers do.
  const fetcher = async (url, { signal }) => new Response(new ReadableStream({
    start(c) { c.enqueue(new Uint8Array([1, 2, 3])); signal.addEventListener('abort', () => c.error(signal.reason)); },
  }), { headers: { 'content-length': '100' } });
  const opened = await scene.openScene('/s.spz', controller.signal, () => {}, fetcher);
  const reader = opened.stream.getReader();
  assert.equal((await reader.read()).value.byteLength, 3);
  const next = reader.read();
  controller.abort();
  assert.equal((await next).done, true, 'the stream ends rather than erroring into Spark');
  assert.equal(opened.download.failure.name, 'AbortError');
  const early = new AbortController(); early.abort();
  await assert.rejects(scene.openScene('/s.spz', early.signal, () => {}, (url, init) => fetch('http://127.0.0.1:9/', init)), scene.DownloadError);
});

test('an SPZ that downloads whole but will not decode falls back to the PLY once; a broken download does not (C1)', () => {
  const spz = '/api/captures/c/scene?v=1', ply = '/api/captures/c/result.ply';
  const bad = new Error('invalid SPZ');
  assert.equal(scene.sceneOutcome({ failure: null, decodeError: null, url: spz, fallbackUrl: ply }), 'show');
  assert.equal(scene.sceneOutcome({ failure: null, decodeError: bad, url: spz, fallbackUrl: ply }), 'fallback');
  assert.equal(scene.sceneOutcome({ failure: null, decodeError: bad, url: ply, fallbackUrl: ply }), 'decode-error', 'the PLY failing too ends it');
  assert.equal(scene.sceneOutcome({ failure: null, decodeError: bad, url: spz }), 'decode-error', 'no PLY to fall back to');
  assert.equal(scene.sceneOutcome({ failure: new TypeError('network'), decodeError: bad, url: spz, fallbackUrl: ply }), 'download-error', 'a connection problem, not a bad file');
  assert.equal(scene.sceneOutcome({ failure: new TypeError('network'), decodeError: null, url: spz, fallbackUrl: ply }), 'download-error', 'never show a partial scene');
});

test('a failed attempt is aborted on its own before the PLY fallback; unmount still aborts every attempt (round 3, item 1)', async () => {
  const outer = new AbortController();
  // A fetch-like body that errors when its request's signal aborts, as browsers do.
  const fetcher = async (url, { signal }) => new Response(new ReadableStream({
    start(c) { c.enqueue(new Uint8Array(4)); signal.addEventListener('abort', () => c.error(signal.reason)); },
  }), { headers: { 'content-length': '1000', 'x-splat-format': url.endsWith('.ply') ? 'ply' : 'spz' } });
  const spzAttempt = scene.attemptController(outer.signal);
  const spz = await scene.openScene('/scene?v=1', spzAttempt.signal, () => {}, fetcher);
  const spzReader = spz.stream.getReader(); // Spark holds this lock; the viewer cannot cancel the stream itself
  await spzReader.read();
  const pending = spzReader.read();
  spzAttempt.abort();                        // what the viewer does when the SPZ will not decode
  assert.equal((await pending).done, true, "the SPZ's connection is closed");
  assert.equal(outer.signal.aborted, false, 'the scene effect itself carries on');

  const plyAttempt = scene.attemptController(outer.signal);
  const ply = await scene.openScene('/result.ply', plyAttempt.signal, () => {}, fetcher);
  assert.equal(plyAttempt.signal.aborted, false, 'the fallback starts with a live signal');
  const plyReader = ply.stream.getReader();
  await plyReader.read();
  const next = plyReader.read();
  outer.abort(new DOMException('unmounted', 'AbortError'));
  assert.equal((await next).done, true, 'unmount stops the fallback download too');
  assert.equal(plyAttempt.signal.reason.message, 'unmounted');
  assert.equal(scene.attemptController(outer.signal).signal.aborted, true, 'an attempt started after unmount is born aborted');
});

test('a failure is described by where it came from, not by its message (round 3, item 4)', () => {
  const download = scene.describeFailure(new scene.DownloadError('HTTP 503'), true);
  assert.deepEqual([download.retry, /could not be downloaded/.test(download.error)], [true, true]);
  const engine = scene.describeFailure(new scene.EngineError('Error creating context'), true);
  assert.deepEqual([engine.retry, /WebGL2/.test(engine.error)], [false, true]);
  // A decoder message that mentions WebGL is still a decode failure.
  assert.match(scene.describeFailure(new Error('WebGL texture too large for this SPZ'), true).error, /Neither the compact SPZ nor the full PLY/);
  assert.match(scene.describeFailure(new Error('bad file'), false).error, /could not be decoded/);
});
