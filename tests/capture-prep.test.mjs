// Unit tests for client-side capture prep (lib/capture-prep): blur metric, perceptual hash,
// duplicate grouping, HEIC detection, JPEG size fallback and libheif decoding.
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { build } from 'esbuild';

let m;
before(async () => {
  const result = await build({
    stdin: { contents: `export * from "./lib/capture-prep/metrics.ts"; export * from "./lib/capture-prep/heic.ts"; export * from "./lib/capture-prep/heif-decode.ts"; export { MAX_IMAGE_BYTES } from "./lib/validation.ts";`, resolveDir: process.cwd(), loader: 'ts' },
    bundle: true, write: false, format: 'esm', platform: 'neutral',
  });
  m = await import(`data:text/javascript;base64,${Buffer.from(result.outputFiles[0].text).toString('base64')}`);
});

// ── helpers ──────────────────────────────────────────────────────────────────────────────
/** Deterministic PRNG (mulberry32). */
function rng(seed) {
  return () => { seed |= 0; seed = (seed + 0x6d2b79f5) | 0; let t = Math.imul(seed ^ (seed >>> 15), 1 | seed); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
/** A photo-like grayscale scene: overlapping shapes with edges plus fine texture. */
function scene(width, height, seed = 1) {
  const r = rng(seed), g = new Float32Array(width * height).fill(128);
  for (let k = 0; k < 120; k++) {
    const x0 = r() * width, y0 = r() * height, w = 4 + r() * width / 4, h = 4 + r() * height / 4, v = r() * 255;
    for (let y = Math.max(0, y0 | 0); y < Math.min(height, y0 + h); y++) for (let x = Math.max(0, x0 | 0); x < Math.min(width, x0 + w); x++) g[y * width + x] = v;
  }
  for (let i = 0; i < g.length; i++) g[i] = Math.min(255, Math.max(0, g[i] + (r() - 0.5) * 24));
  return g;
}
/** Separable Gaussian blur with clamped edges. */
function gaussian(gray, width, height, sigma) {
  const radius = Math.ceil(sigma * 3), kernel = [];
  for (let i = -radius; i <= radius; i++) kernel.push(Math.exp(-(i * i) / (2 * sigma * sigma)));
  const sum = kernel.reduce((a, b) => a + b, 0), k = kernel.map(v => v / sum);
  const pass = (src, horizontal) => {
    const out = new Float32Array(src.length);
    for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
      let acc = 0;
      for (let i = -radius; i <= radius; i++) {
        const xx = horizontal ? Math.min(width - 1, Math.max(0, x + i)) : x, yy = horizontal ? y : Math.min(height - 1, Math.max(0, y + i));
        acc += src[yy * width + xx] * k[i + radius];
      }
      out[y * width + x] = acc;
    }
    return out;
  };
  return pass(pass(gray, true), false);
}
const hashOf = (gray, w, h) => m.dHash(gray, w, h);

// ── blur metric ─────────────────────────────────────────────────────────────────────────
test('toGrayscale uses Rec. 601 luma weights', () => {
  const gray = m.toGrayscale(new Uint8ClampedArray([255, 0, 0, 255, 0, 255, 0, 255, 0, 0, 255, 255, 200, 200, 200, 255]), 4, 1);
  assert.deepEqual(Array.from(gray, v => Math.round(v * 1000) / 1000), [76.245, 149.685, 29.07, 200]);
});

test('laplacianVariance: flat is 0, checkerboard has the analytic value, tiny images are 0', () => {
  assert.equal(m.laplacianVariance(new Float32Array(36).fill(90), 6, 6), 0);
  const board = Float32Array.from({ length: 36 }, (_, i) => ((i % 6) + Math.floor(i / 6)) % 2 ? 255 : 0);
  // Every interior response is ±4·255 with equal counts, so the variance is (4·255)².
  assert.equal(m.laplacianVariance(board, 6, 6), 1020 * 1020);
  assert.equal(m.laplacianVariance(new Float32Array([1, 2, 3, 4]), 2, 2), 0);
});

test('blur metric separates a sharp scene from Gaussian-blurred copies (thresholds hold)', () => {
  const W = 512, H = 384, sharp = scene(W, H, 7);
  const s = m.laplacianVariance(sharp, W, H);
  const b1 = m.laplacianVariance(gaussian(sharp, W, H, 1), W, H);
  const b2 = m.laplacianVariance(gaussian(sharp, W, H, 2), W, H);
  assert.ok(s > m.BLUR_VARIANCE_MIN * 10, `sharp score ${s}`);
  // σ ≥ 1 px at analysis size (≈ σ 6 px on a 12 MP original) falls under the relative rule…
  assert.ok(b1 < s * m.BLUR_RELATIVE_FRACTION, `σ=1 ${b1} vs sharp ${s}`);
  // …and σ = 2 px under the absolute floor.
  assert.ok(b2 < m.BLUR_VARIANCE_MIN, `σ=2 ${b2}`);
  assert.ok(s > b1 && b1 > b2, 'monotonic in blur');
  // The rules flag exactly the blurred photos in a set of otherwise sharp photos of the scene.
  const sharpSet = Array.from({ length: 9 }, (_, i) => m.laplacianVariance(scene(W, H, 100 + i), W, H));
  assert.deepEqual(m.findBlurry([...sharpSet, b1, b2]), [9, 10]);
});

test('fitWithin downsizes to the analysis size and never upscales', () => {
  assert.deepEqual(m.fitWithin(4032, 3024), { width: 512, height: 384 });
  assert.deepEqual(m.fitWithin(3024, 4032), { width: 384, height: 512 });
  assert.deepEqual(m.fitWithin(300, 200), { width: 300, height: 200 });
});

// ── perceptual hash ─────────────────────────────────────────────────────────────────────
test('resizeArea averages exactly and preserves the mean for non-integer ratios', () => {
  const src = Float32Array.from([1, 3, 5, 7, 1, 3, 5, 7, 2, 2, 8, 8, 2, 2, 8, 8]);
  assert.deepEqual(Array.from(m.resizeArea(src, 4, 4, 2, 2)), [2, 6, 2, 8]);
  const g = scene(50, 30, 3), out = m.resizeArea(g, 50, 30, 9, 8);
  const mean = a => a.reduce((x, y) => x + y, 0) / a.length;
  assert.ok(Math.abs(mean(Array.from(out)) - mean(Array.from(g))) < 0.5);
});

test('dHash: gradients give all-ones / all-zeros; robust to brightness and resizing', () => {
  const W = 90, H = 80;
  const falling = Float32Array.from({ length: W * H }, (_, i) => 255 - (i % W) * 2);
  const rising = Float32Array.from({ length: W * H }, (_, i) => (i % W) * 2);
  assert.equal(hashOf(falling, W, H), 'ffffffffffffffff');
  assert.equal(hashOf(rising, W, H), '0000000000000000');
  const g = scene(256, 192, 11), h = hashOf(g, 256, 192);
  assert.match(h, /^[0-9a-f]{16}$/);
  assert.equal(hashOf(g.map(v => v * 0.8 + 20), 256, 192), h, 'brightness/contrast change');
  const half = m.resizeArea(g, 256, 192, 128, 96);
  assert.ok(m.hammingDistance(hashOf(half, 128, 96), h) <= 2, 'downscaled copy');
  assert.ok(m.hammingDistance(hashOf(scene(256, 192, 12), 256, 192), h) > m.NEAR_DUPLICATE_MAX_DISTANCE, 'different scene');
});

test('hammingDistance counts differing bits and rejects mismatched hashes', () => {
  assert.equal(m.hammingDistance('0123456789abcdef', '0123456789abcdef'), 0);
  assert.equal(m.hammingDistance('ffffffffffffffff', '0000000000000000'), 64);
  assert.equal(m.hammingDistance('8000000000000001', '0000000000000000'), 2);
  assert.equal(m.hammingDistance('00000000000000f0', '0000000000000000'), 4);
  assert.throws(() => m.hammingDistance('ff', 'ffff'));
});

test('groupNearDuplicates groups transitively, skips nulls and singletons, sorts output', () => {
  const a = '0000000000000000', b = '000000000000003f' /* 6 from a */, c = '0000000000000fff' /* 6 from b, 12 from a */, far = 'ffffffffffffffff';
  assert.deepEqual(m.groupNearDuplicates([far, c, null, a, b]), [[1, 3, 4]]);
  assert.deepEqual(m.groupNearDuplicates([a, b], 5), []);
  assert.deepEqual(m.groupNearDuplicates([a, far, a, far]), [[0, 2], [1, 3]]);
  assert.deepEqual(m.groupNearDuplicates([]), []);
});

// ── report ──────────────────────────────────────────────────────────────────────────────
test('findBlurry applies the absolute floor always and the relative rule from 8 photos', () => {
  assert.deepEqual(m.findBlurry([10, 900, null, 49, 50]), [0, 3]);
  // Relative floor = median 1000 × 0.3 = 300.
  const set = [1000, 1000, 1000, 1000, 1000, 1000, 1000, 290, 310];
  assert.deepEqual(m.findBlurry(set), [7]);
  assert.deepEqual(m.findBlurry(set.slice(0, 6).concat(290)), [], 'too few photos for the relative rule');
});

test('buildPrepReport keeps the sharpest duplicate and counts usable photos', () => {
  // 30 sharp photos without a hash (e.g. still being checked) never join a group.
  const distinct = Array.from({ length: 30 }, () => ({ blur: 1000, hash: null }));
  const items = [
    { blur: 800, hash: 'ffff0000ffff0000' }, { blur: 1200, hash: 'ffff0000ffff0001' }, { blur: 900, hash: 'ffff0000ffff0003' },
    { blur: 20, hash: '00ff00ff00ff00ff' }, ...distinct,
  ];
  const r = m.buildPrepReport(items);
  assert.deepEqual(r.duplicateGroups, [[0, 1, 2]]);
  assert.deepEqual(r.blurry, [3]);
  assert.deepEqual(r.redundant, [0, 2, 3]);
  assert.equal(r.usable, items.length - 3);
  assert.equal(r.fewPhotos, false);
  assert.equal(m.buildPrepReport(items.slice(0, 32)).fewPhotos, true);
});

// ── HEIC ────────────────────────────────────────────────────────────────────────────────
const ftyp = (major, ...compatible) => {
  const brands = [major, '\0\0\0\0', ...compatible];
  const size = 8 + brands.length * 4, bytes = new Uint8Array(size + 8);
  new DataView(bytes.buffer).setUint32(0, size);
  bytes.set(Buffer.from('ftyp' + brands.join(''), 'latin1'), 4);
  return bytes;
};

test('HEIC detection by extension, MIME type and leading bytes', () => {
  assert.ok(m.hasHeicExtension('IMG_0001.HEIC') && m.hasHeicExtension('a.heif') && m.hasHeicExtension('x.hif'));
  assert.ok(!m.hasHeicExtension('heic.jpg'));
  assert.ok(m.isHeicMime('image/HEIC') && m.isHeicMime('image/heif-sequence') && !m.isHeicMime('image/avif'));
  assert.equal(m.classifyByNameAndType('IMG_0001.HEIC', ''), 'heic', 'iPhone files often have no MIME type');
  assert.equal(m.classifyByNameAndType('photo', 'image/heic'), 'heic');
  assert.equal(m.classifyByNameAndType('a.jpg', 'image/jpeg'), 'not-heic');
  assert.equal(m.classifyByNameAndType('photo', ''), 'unknown');
  assert.equal(m.sniffHeic(ftyp('heic', 'mif1', 'heic')), true);
  assert.equal(m.sniffHeic(ftyp('mif1', 'mif1', 'heic')), true, 'generic major brand with HEVC compatible brand');
  assert.equal(m.sniffHeic(ftyp('mif1', 'mif1', 'avif')), false, 'AVIF is not HEIC');
  assert.equal(m.sniffHeic(ftyp('avif', 'mif1')), false);
  assert.equal(m.sniffHeic(new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 0, 0, 0, 0, 0, 0, 0])), false);
  assert.equal(m.sniffHeic(new Uint8Array(8)), false);
  assert.equal(m.sniffHeic(new Uint8Array(readFileSync('tests/fixtures/rotated-90cw.heic').subarray(0, 64))), true);
});

test('jpegName swaps the extension', () => {
  assert.equal(m.jpegName('IMG_0001.HEIC'), 'IMG_0001.jpg');
  assert.equal(m.jpegName('my.trip.heif'), 'my.trip.jpg');
  assert.equal(m.jpegName('noext'), 'noext.jpg');
  assert.equal(m.jpegName('.heic'), 'photo.jpg');
});

test('nextEncodeAttempt walks the quality ladder, then downscales, then gives up', () => {
  const L = m.MAX_IMAGE_BYTES;
  assert.equal(m.JPEG_QUALITY, 0.92);
  assert.deepEqual(m.nextEncodeAttempt({ quality: 0.92, scale: 1, bytes: L }), { kind: 'done' });
  assert.deepEqual(m.nextEncodeAttempt({ quality: 0.92, scale: 1, bytes: L + 1 }), { kind: 'retry', next: { quality: 0.85, scale: 1 } });
  assert.deepEqual(m.nextEncodeAttempt({ quality: 0.75, scale: 1, bytes: L + 1 }), { kind: 'retry', next: { quality: 0.65, scale: 1 } });
  const d = m.nextEncodeAttempt({ quality: 0.65, scale: 1, bytes: 2 * L });
  assert.equal(d.kind, 'retry'); assert.equal(d.next.quality, 0.65);
  assert.ok(Math.abs(d.next.scale - Math.sqrt(0.5) * 0.95) < 1e-9);
  assert.ok(m.nextEncodeAttempt({ quality: 0.65, scale: 1, bytes: L * 1.05 }).next.scale <= 0.9, 'each downscale is at least 10%');
  assert.deepEqual(m.nextEncodeAttempt({ quality: 0.65, scale: 0.3, bytes: 3 * L }), { kind: 'give-up' });
  // Simulated encoder (size ∝ pixels × quality factor): a huge photo converges under the limit.
  const size = ({ quality, scale }) => 60e6 * scale * scale * (quality / 0.92) ** 3;
  let attempt = { quality: 0.92, scale: 1 }, steps = 0, decision;
  while ((decision = m.nextEncodeAttempt({ ...attempt, bytes: size(attempt) })).kind === 'retry') { attempt = decision.next; steps++; }
  assert.equal(decision.kind, 'done'); assert.ok(size(attempt) <= L && steps < 10 && attempt.scale >= m.MIN_DOWNSCALE);
});

test('libheif decodes the HEIC fixture upright (irot + crop applied)', async () => {
  const { default: factory } = await import('libheif-js/libheif-wasm/libheif-bundle.mjs');
  const lib = await factory();
  // Stored 64×48 with "rotate 90° clockwise to display": upright it is 48×64 with red top-left,
  // green top-right and blue bottom-left.
  const { data, width, height } = await m.decodeHeif(lib, new Uint8Array(readFileSync('tests/fixtures/rotated-90cw.heic')));
  assert.deepEqual([width, height], [48, 64]);
  const px = (x, y) => Array.from(data.subarray((y * width + x) * 4, (y * width + x) * 4 + 3));
  const near = (a, b) => a.every((v, i) => Math.abs(v - b[i]) <= 12);
  assert.ok(near(px(2, 2), [220, 0, 0]), `top-left ${px(2, 2)}`);
  assert.ok(near(px(45, 2), [0, 200, 0]), `top-right ${px(45, 2)}`);
  assert.ok(near(px(2, 61), [0, 0, 255]), `bottom-left ${px(2, 61)}`);
  await assert.rejects(m.decodeHeif(lib, new Uint8Array(64)), m.HeifDecodeError);
});
