// Unit tests for the pure phone-camera logic (lib/camera/camera.ts, S9, PRD R1.4, spec §8.3):
// shot-count guidance, file names, the capture budget, frame sizes, the takePhoto orientation check, availability and
// error classification, the camera state machine, the touch-device check and the motion cue.
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';

let m;
before(async () => {
  const result = await build({
    stdin: { contents: `export * from "./lib/camera/camera.ts"; export { MIN_IMAGES, MAX_IMAGES, MAX_IMAGE_BYTES, MAX_TOTAL_BYTES } from "./lib/validation.ts";`, resolveDir: process.cwd(), loader: 'ts' },
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

test('cameraAppFileName keeps the original name unless another photo in the selection uses it', () => {
  const T = 1700000000123;
  const photo = (name, size, lastModified = T, type = 'image/jpeg') => ({ name, size, lastModified, type });
  const had = (name, size, lastModified = T) => ({ name, size, lastModified });
  // No clash: the name the resume matcher will look for stays exactly as picked.
  assert.equal(m.cameraAppFileName(photo('IMG_20261123_101530.jpg', 5000), []), 'IMG_20261123_101530.jpg');
  assert.equal(m.cameraAppFileName(photo('image.jpg', 5000), [had('other.jpg', 5000)]), 'image.jpg');
  assert.equal(m.cameraAppFileName(photo('IMG_0001.HEIC', 9000, 1, ''), [had('IMG_0002.HEIC', 9000, 1)]), 'IMG_0001.HEIC');
  // Name, size and lastModified all equal: the same photo picked again; the name stays and Studio drops the repeat.
  assert.equal(m.cameraAppFileName(photo('image.jpg', 5000), [had('image.jpg', 5000)]), 'image.jpg');
  // iOS repeats image.jpg for a different photo: a suffix from the file's own time and size.
  assert.equal(m.cameraAppFileName(photo('image.jpg', 6000), [had('image.jpg', 5000)]), `image-${T}-6000.jpg`);
  assert.equal(m.cameraAppFileName(photo('IMG_0001.HEIC', 7000, 42, ''), [had('IMG_0001.HEIC', 1, 42)]), 'IMG_0001-42-7000.HEIC');
});

test('cameraAppFileName keeps two different photos with the same name and size (different lastModified)', () => {
  const first = { name: 'image.jpg', size: 5000, lastModified: 1700000000000, type: 'image/jpeg' };
  const second = { ...first, lastModified: 1700000009999 };
  const firstName = m.cameraAppFileName(first, []);
  const secondName = m.cameraAppFileName(second, [{ name: firstName, size: first.size, lastModified: first.lastModified }]);
  assert.equal(firstName, 'image.jpg');
  assert.equal(secondName, 'image-1700000009999-5000.jpg');
  // Studio's name + size key no longer collides, so it keeps both.
  assert.notEqual(`${firstName}:${first.size}`, `${secondName}:${second.size}`);
});

test('cameraAppFileName is deterministic, so picking the same photo again gives the same name', () => {
  const selection = [{ name: 'image.jpg', size: 5000, lastModified: 1 }];
  const again = { name: 'image.jpg', size: 6000, lastModified: 1700000000123, type: 'image/jpeg' };
  const first = m.cameraAppFileName(again, selection);
  assert.equal(m.cameraAppFileName(again, selection), first);
  // Once in the selection, picking it again (name, size, lastModified all equal) returns that name: Studio drops the repeat.
  assert.equal(m.cameraAppFileName(again, [...selection, { name: first, size: 6000, lastModified: again.lastModified }]), first);
  // The suffixed name itself taken by a different photo (even one of the same size): -2, -3, …
  assert.equal(m.cameraAppFileName(again, [...selection, { name: first, size: 1, lastModified: 1 }]), 'image-1700000000123-6000-2.jpg');
  assert.equal(m.cameraAppFileName(again, [...selection, { name: first, size: 6000, lastModified: 2 }, { name: 'image-1700000000123-6000-2.jpg', size: 2, lastModified: 2 }]), 'image-1700000000123-6000-3.jpg');
  // A missing name or extension falls back to the MIME type's.
  assert.equal(m.cameraAppFileName({ name: '', size: 10, lastModified: 0, type: 'image/png' }, []), 'image.png');
  assert.equal(m.cameraAppFileName({ name: '1700000000000', size: 10, lastModified: 5, type: 'image/png' }, [{ name: '1700000000000', size: 11, lastModified: 5 }]), '1700000000000-5-10.png');
});

// ── capture limits ───────────────────────────────────────────────────────────────────────────
const MiB = 1024 * 1024;
test('CAPTURE_LIMITS come from lib/validation (200 photos, 1 GB, 20 MB each)', () => {
  assert.equal(m.CAPTURE_LIMITS.maxImages, m.MAX_IMAGES);
  assert.equal(m.CAPTURE_LIMITS.maxTotalBytes, m.MAX_TOTAL_BYTES);
  assert.equal(m.CAPTURE_LIMITS.maxImageBytes, m.MAX_IMAGE_BYTES);
  assert.deepEqual([m.MAX_IMAGES, m.MAX_TOTAL_BYTES, m.MAX_IMAGE_BYTES], [200, 1024 * MiB, 20 * MiB]);
});

test('shotBudget stops the shutter before a shot could pass the photo limit', () => {
  assert.equal(m.shotBudget({ count: 0, bytes: 0 }, []).canShoot, true);
  assert.equal(m.shotBudget({ count: 199, bytes: 0 }, []).canShoot, true);
  const full = m.shotBudget({ count: 190, bytes: 0 }, Array(10).fill(1000));
  assert.equal(full.canShoot, false);
  assert.equal(full.limit, 'count');
  assert.match(full.message, /200 photos/);
  assert.equal(m.shotBudget({ count: 200, bytes: 0 }, []).limit, 'count');
});

test('shotBudget counts the selection, the real shot sizes and a worst-case next shot against 1 GB', () => {
  // The review case: 100 × 10 MiB selected leaves room for 1024 − 1000 = 24 MiB; a 20 MiB shot can still fit once.
  const selected = { count: 100, bytes: 100 * 10 * MiB };
  assert.equal(m.shotBudget(selected, []).canShoot, true);
  const after = m.shotBudget(selected, [10 * MiB]); // 14 MiB left < 20 MiB worst case
  assert.equal(after.canShoot, false);
  assert.equal(after.limit, 'bytes');
  assert.match(after.message, /1 GB limit \(14 MB left; one photo can take up to 20 MB\)/);
  // Small real shots keep the shutter going until the worst case no longer fits.
  assert.equal(m.shotBudget({ count: 0, bytes: 1004 * MiB }, []).canShoot, true);
  assert.equal(m.shotBudget({ count: 0, bytes: 1004 * MiB }, [1]).canShoot, false);
  // Custom limits work the same way.
  assert.deepEqual(m.shotBudget({ count: 0, bytes: 0 }, [3, 3], { maxImages: 10, maxTotalBytes: 10, maxImageBytes: 4 }).limit, null);
  assert.deepEqual(m.shotBudget({ count: 0, bytes: 0 }, [3, 4], { maxImages: 10, maxTotalBytes: 10, maxImageBytes: 4 }).limit, 'bytes');
});

test('shotsThatFit never hands Studio more than it accepts, by its own rules', () => {
  const shot = (size, id) => ({ size, id });
  const ids = list => list.map(s => s.id);
  // The review case without the shutter guard: of ten 10 MiB shots only two fit, and only those go.
  const ten = Array.from({ length: 10 }, (_, i) => shot(10 * MiB, i));
  assert.deepEqual(ids(m.shotsThatFit({ count: 100, bytes: 1000 * MiB }, ten)), [0, 1]);
  // The photo limit, then the stop at the first overflow (Studio breaks there too).
  assert.deepEqual(ids(m.shotsThatFit({ count: 198, bytes: 0 }, [shot(1, 'a'), shot(1, 'b'), shot(1, 'c')])), ['a', 'b']);
  assert.deepEqual(ids(m.shotsThatFit({ count: 0, bytes: 1020 * MiB }, [shot(5 * MiB, 'big'), shot(1, 'small')])), []);
  // Empty or oversized shots are skipped, as Studio skips them.
  assert.deepEqual(ids(m.shotsThatFit({ count: 0, bytes: 0 }, [shot(0, 'empty'), shot(21 * MiB, 'huge'), shot(5, 'ok')])), ['ok']);
  // Everything a budgeted session takes fits.
  const sizes = [];
  while (m.shotBudget({ count: 150, bytes: 900 * MiB }, sizes).canShoot) sizes.push(20 * MiB);
  assert.equal(sizes.length, 6);
  assert.equal(m.shotsThatFit({ count: 150, bytes: 900 * MiB }, sizes.map((size, id) => shot(size, id))).length, sizes.length);
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
