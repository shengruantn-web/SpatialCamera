// Unit tests for the pure phone-camera logic (lib/camera/camera.ts, S9, PRD R1.4, spec §8.3):
// shot-count guidance, file names, frame sizes, the takePhoto orientation check, availability and
// error classification, the camera state machine, the touch-device check and the motion cue.
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';

let m;
before(async () => {
  const result = await build({
    stdin: { contents: `export * from "./lib/camera/camera.ts"; export { MIN_IMAGES, MAX_IMAGES, MAX_IMAGE_BYTES } from "./lib/validation.ts";`, resolveDir: process.cwd(), loader: 'ts' },
    bundle: true, write: false, format: 'esm', platform: 'neutral',
  });
  m = await import(`data:text/javascript;base64,${Buffer.from(result.outputFiles[0].text).toString('base64')}`);
});

// ── shot guidance ────────────────────────────────────────────────────────────────────────────
test('shotGuidance walks the stages from empty to the 200-photo limit', () => {
  const stages = [0, 1, 11, 12, 29, 30, 39, 40, 199, 200, 250].map(n => m.shotGuidance(n).stage);
  assert.deepEqual(stages, ['empty', 'below-minimum', 'below-minimum', 'below-recommended', 'below-recommended', 'below-goal', 'below-goal', 'goal', 'goal', 'full', 'full']);
  assert.equal(m.MIN_IMAGES, 12); assert.equal(m.MAX_IMAGES, 200); assert.equal(m.SHOT_GOAL, 40);
});

test('shotGuidance counts down to the next milestone and caps progress at the goal', () => {
  assert.equal(m.shotGuidance(0).remaining, 12);
  assert.equal(m.shotGuidance(5).remaining, 7);
  assert.equal(m.shotGuidance(5).message, '7 more photos to reach the minimum of 12.');
  assert.equal(m.shotGuidance(11).message, '1 more photo to reach the minimum of 12.');
  assert.equal(m.shotGuidance(12).message, 'Minimum reached. 30+ sharp photos work better.');
  assert.equal(m.shotGuidance(39).message, 'Good. 1 more photo for full coverage (40).');
  assert.equal(m.shotGuidance(20).progress, 0.5);
  assert.equal(m.shotGuidance(120).progress, 1);
  assert.equal(m.shotGuidance(120).remaining, 0);
});

test('shotGuidance blocks the shutter only at the limit, and tolerates odd input', () => {
  assert.equal(m.shotGuidance(199).canShoot, true);
  assert.equal(m.shotGuidance(200).canShoot, false);
  assert.match(m.shotGuidance(200).message, /limit of 200/);
  assert.equal(m.shotGuidance(-3).stage, 'empty');
  assert.equal(m.shotGuidance(4.7).total, 4);
});

test('shotAnnouncement says which photo was taken and what comes next', () => {
  assert.equal(m.shotAnnouncement(1), 'Photo 1 taken. 11 more photos to reach the minimum of 12.');
  assert.match(m.shotAnnouncement(40), /^Photo 40 taken\. Great coverage/);
});

test('overlapHint always names the 60–70% overlap once there is a last photo', () => {
  assert.doesNotMatch(m.overlapHint(0, true), /%/);
  assert.match(m.overlapHint(1, true), /60–70% overlap/);
  assert.match(m.overlapHint(1, true), /faded/);
  assert.match(m.overlapHint(3, false), /60–70% overlap/);
  assert.doesNotMatch(m.overlapHint(3, false), /faded/);
});

// ── file names ───────────────────────────────────────────────────────────────────────────────
test('cameraFileName is unique per session and position and sorts in shooting order', () => {
  const start = new Date(2026, 10, 23, 10, 15, 30);
  assert.equal(m.timestamp(start), '20261123-101530');
  assert.equal(m.cameraFileName(start, 14), 'camera-20261123-101530-014.jpg');
  assert.equal(m.cameraFileName(start, 1, 'png'), 'camera-20261123-101530-001.png');
  assert.equal(m.cameraFileName(start, 0), 'camera-20261123-101530-001.jpg');
  const names = [3, 1, 2, 10].map(n => m.cameraFileName(start, n)).sort();
  assert.deepEqual(names.map(n => n.slice(-7, -4)), ['001', '002', '003', '010']);
});

test('capturedFileName replaces iOS "image.jpg" names but keeps the extension (HEIC stays detectable)', () => {
  const when = new Date(2026, 0, 2, 3, 4, 5);
  assert.equal(m.capturedFileName({ name: 'image.jpg', type: 'image/jpeg' }, when, 5), 'camera-20260102-030405-005.jpg');
  assert.equal(m.capturedFileName({ name: 'IMG_0001.HEIC', type: '' }, when, 6), 'camera-20260102-030405-006.heic');
  assert.equal(m.capturedFileName({ name: '1700000000000', type: 'image/png' }, when, 7), 'camera-20260102-030405-007.png');
  assert.equal(m.capturedFileName({ name: 'blob', type: '' }, when, 8), 'camera-20260102-030405-008.jpg');
  assert.notEqual(m.capturedFileName({ name: 'image.jpg', type: 'image/jpeg' }, when, 1), m.capturedFileName({ name: 'image.jpg', type: 'image/jpeg' }, when, 2));
});

// ── frame size and takePhoto check ───────────────────────────────────────────────────────────
test('frameSize keeps the native size and only scales down past the canvas limit', () => {
  assert.equal(m.frameSize({ width: 0, height: 480 }), null);
  assert.equal(m.frameSize({ width: 640, height: NaN }), null);
  assert.deepEqual(m.frameSize({ width: 1920, height: 1080 }), { width: 1920, height: 1080 });
  assert.deepEqual(m.frameSize({ width: 4096, height: 4096 }), { width: 4096, height: 4096 });
  const big = m.frameSize({ width: 8000, height: 6000 });
  assert.ok(big.width * big.height <= m.MAX_CANVAS_PIXELS);
  assert.ok(Math.abs(big.width / big.height - 4 / 3) < 0.01);
  assert.deepEqual(m.frameSize({ width: 100, height: 100 }, 2500), { width: 50, height: 50 });
});

test('photoMatchesPreview uses only an upright-matching JPEG within 20 MB from takePhoto', () => {
  const portrait = { width: 1080, height: 1920 }, landscape = { width: 1920, height: 1080 };
  const photo = (width, height, extra = {}) => ({ width, height, bytes: 3e6, type: 'image/jpeg', ...extra });
  assert.equal(m.photoMatchesPreview(photo(3024, 4032), portrait), true);
  assert.equal(m.photoMatchesPreview(photo(4032, 3024), portrait), false);
  assert.equal(m.photoMatchesPreview(photo(4032, 3024), landscape), true);
  assert.equal(m.photoMatchesPreview(photo(3000, 3000), portrait), true);
  assert.equal(m.photoMatchesPreview(photo(4032, 3024), { width: 720, height: 720 }), true);
  assert.equal(m.photoMatchesPreview(photo(3024, 4032, { type: 'image/webp' }), portrait), false);
  assert.equal(m.photoMatchesPreview(photo(3024, 4032, { type: 'image/png' }), portrait), false);
  assert.equal(m.photoMatchesPreview(photo(3024, 4032, { bytes: m.MAX_IMAGE_BYTES + 1 }), portrait), false);
  assert.equal(m.photoMatchesPreview(photo(3024, 4032, { bytes: 0 }), portrait), false);
  assert.equal(m.photoMatchesPreview(photo(3024, 4032, { bytes: m.MAX_IMAGE_BYTES }), portrait), true);
});

test('the guided mode asks for the back camera without hard constraints', () => {
  assert.deepEqual(m.VIDEO_CONSTRAINTS.facingMode, { ideal: 'environment' });
  for (const value of Object.values(m.VIDEO_CONSTRAINTS)) assert.ok('ideal' in value && !('exact' in value));
});

// ── availability and errors ──────────────────────────────────────────────────────────────────
test('cameraAvailability needs a secure context first, then getUserMedia', () => {
  assert.equal(m.cameraAvailability({ secureContext: true, getUserMedia: true }), 'ok');
  assert.equal(m.cameraAvailability({ secureContext: false, getUserMedia: true }), 'insecure');
  assert.equal(m.cameraAvailability({ secureContext: false, getUserMedia: false }), 'insecure');
  assert.equal(m.cameraAvailability({ secureContext: true, getUserMedia: false }), 'unsupported');
});

test('classifyCameraError maps getUserMedia errors to the problem shown', () => {
  const err = name => Object.assign(new Error(name), { name });
  const cases = {
    NotAllowedError: 'denied', PermissionDeniedError: 'denied', NotFoundError: 'no-camera', DevicesNotFoundError: 'no-camera',
    OverconstrainedError: 'no-camera', ConstraintNotSatisfiedError: 'no-camera', NotReadableError: 'busy', TrackStartError: 'busy',
    AbortError: 'busy', TypeError: 'failed', Whatever: 'failed',
  };
  for (const [name, problem] of Object.entries(cases)) assert.equal(m.classifyCameraError(err(name)), problem, name);
  assert.equal(m.classifyCameraError(err('SecurityError'), true), 'denied');
  assert.equal(m.classifyCameraError(err('SecurityError'), false), 'insecure');
  assert.equal(m.classifyCameraError('nope'), 'failed');
  assert.equal(m.classifyCameraError(null), 'failed');
});

test('every problem has a message; only insecure and unsupported cannot be retried', () => {
  for (const problem of ['insecure', 'unsupported', 'denied', 'no-camera', 'busy', 'interrupted', 'failed']) assert.ok(m.problemMessages[problem]?.length > 10, problem);
  assert.equal(m.canRetry('insecure'), false);
  assert.equal(m.canRetry('unsupported'), false);
  assert.equal(m.canRetry('denied'), true);
  assert.equal(m.canRetry('interrupted'), true);
  assert.match(m.problemMessages.insecure, /camera app/);
});

// ── state machine ────────────────────────────────────────────────────────────────────────────
test('cameraReducer: open, ready, shutter, shot-done, close', () => {
  const run = (events, state = m.initialCameraState) => events.reduce(m.cameraReducer, state);
  assert.deepEqual(run([{ type: 'open' }]), { status: 'starting' });
  assert.deepEqual(run([{ type: 'open' }, { type: 'ready' }]), { status: 'live' });
  assert.deepEqual(run([{ type: 'open' }, { type: 'ready' }, { type: 'shutter' }]), { status: 'capturing' });
  assert.deepEqual(run([{ type: 'open' }, { type: 'ready' }, { type: 'shutter' }, { type: 'shot-done' }]), { status: 'live' });
  assert.deepEqual(run([{ type: 'open' }, { type: 'ready' }, { type: 'close' }]), { status: 'closed' });
});

test('cameraReducer: failures, interruptions, pause and resume, retry', () => {
  const run = (events, state = m.initialCameraState) => events.reduce(m.cameraReducer, state);
  assert.deepEqual(run([{ type: 'open' }, { type: 'fail', problem: 'denied' }]), { status: 'error', problem: 'denied' });
  assert.deepEqual(run([{ type: 'open' }, { type: 'ready' }, { type: 'ended' }]), { status: 'error', problem: 'interrupted' });
  assert.deepEqual(run([{ type: 'open' }, { type: 'fail', problem: 'busy' }, { type: 'open' }]), { status: 'starting' });
  assert.deepEqual(run([{ type: 'open' }, { type: 'ready' }, { type: 'hide' }]), { status: 'paused' });
  assert.deepEqual(run([{ type: 'open' }, { type: 'ready' }, { type: 'hide' }, { type: 'show' }]), { status: 'starting' });
  assert.deepEqual(run([{ type: 'open' }, { type: 'ready' }, { type: 'hide' }, { type: 'open' }]), { status: 'starting' });
  assert.deepEqual(run([{ type: 'open' }, { type: 'fail', problem: 'denied' }, { type: 'close' }]), { status: 'closed' });
});

test('cameraReducer ignores events that do not apply (same object back)', () => {
  const states = [m.initialCameraState, { status: 'starting' }, { status: 'live' }, { status: 'capturing' }, { status: 'paused' }, { status: 'error', problem: 'denied' }];
  const allowed = {
    closed: ['open'], starting: ['ready', 'fail', 'hide', 'close'], live: ['shutter', 'hide', 'ended', 'close'],
    capturing: ['shot-done', 'hide', 'ended', 'close'], paused: ['open', 'show', 'close'], error: ['open', 'close'],
  };
  const events = [{ type: 'open' }, { type: 'ready' }, { type: 'fail', problem: 'busy' }, { type: 'shutter' }, { type: 'shot-done' }, { type: 'hide' }, { type: 'show' }, { type: 'ended' }, { type: 'close' }];
  for (const state of states) for (const event of events) {
    const next = m.cameraReducer(state, event);
    assert.equal(next !== state, allowed[state.status].includes(event.type), `${state.status} + ${event.type}`);
  }
  // A late "ready" or "fail" after closing (the stream arrived after the user left) changes nothing.
  assert.equal(m.cameraReducer(m.initialCameraState, { type: 'ready' }), m.initialCameraState);
  assert.equal(m.cameraReducer(m.initialCameraState, { type: 'fail', problem: 'denied' }), m.initialCameraState);
});

test('wantsStream: tracks run only while starting, live or capturing', () => {
  assert.deepEqual(['closed', 'starting', 'live', 'capturing', 'paused', 'error'].map(status => m.wantsStream({ status })), [false, true, true, true, false, false]);
});

// ── entry point ──────────────────────────────────────────────────────────────────────────────
test('showCameraEntry: phones and tablets yes, mouse-driven desktops no', () => {
  assert.equal(m.showCameraEntry({ coarsePointer: true, hoverNone: true, maxTouchPoints: 5 }), true); // phone
  assert.equal(m.showCameraEntry({ coarsePointer: false, hoverNone: true, maxTouchPoints: 5 }), true); // stylus tablet
  assert.equal(m.showCameraEntry({ coarsePointer: false, hoverNone: false, maxTouchPoints: 10 }), false); // touch laptop with a trackpad
  assert.equal(m.showCameraEntry({ coarsePointer: false, hoverNone: true, maxTouchPoints: 0 }), false);
  assert.equal(m.showCameraEntry({ coarsePointer: false, hoverNone: false, maxTouchPoints: 0 }), false); // desktop
});

// ── motion cue ───────────────────────────────────────────────────────────────────────────────
test('rotationBetween measures the turn between two device orientations', () => {
  const o = (alpha, beta, gamma) => ({ alpha, beta, gamma });
  const close = (a, b) => assert.ok(Math.abs(a - b) < 1e-6, `${a} ≈ ${b}`);
  close(m.rotationBetween(o(0, 90, 0), o(0, 90, 0)), 0);
  close(m.rotationBetween(o(10, 90, 0), o(40, 90, 0)), 30); // turning on the spot (compass heading)
  close(m.rotationBetween(o(0, 60, 0), o(0, 90, 0)), 30); // tilting up
  close(m.rotationBetween(o(0, 90, 0), o(0, 90, 20)), 20); // rolling
  close(m.rotationBetween(o(350, 90, 0), o(10, 90, 0)), 20); // across north
  close(m.rotationBetween(o(0, 0, 0), o(360, 0, 0)), 0);
  close(m.rotationBetween(o(0, 0, 0), o(180, 0, 0)), 180);
});

test('motionHint warns only past a big turn, and is silent without data', () => {
  assert.equal(m.motionHint(null), null);
  assert.equal(m.motionHint(NaN), null);
  assert.equal(m.motionHint(10), null);
  assert.equal(m.motionHint(m.BIG_TURN_DEGREES), null);
  assert.match(m.motionHint(40), /Turn back a little/);
});
