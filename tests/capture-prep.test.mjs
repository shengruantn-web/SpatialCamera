// Unit tests for client-side capture prep (lib/capture-prep): blur metric, perceptual hash,
// duplicate grouping, HEIC detection, JPEG size fallback, header size parsing, libheif decoding
// and the worker pool (with a fake Worker).
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { build } from 'esbuild';

let m;
before(async () => {
  const result = await build({
    stdin: { contents: `export * from "./lib/capture-prep/metrics.ts"; export * from "./lib/capture-prep/heic.ts"; export * from "./lib/capture-prep/heif-decode.ts"; export * from "./lib/capture-prep/dimensions.ts"; export { WorkerPool } from "./lib/capture-prep/pool.ts"; export { MAX_IMAGE_BYTES } from "./lib/validation.ts";`, resolveDir: process.cwd(), loader: 'ts' },
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

test('groupNearDuplicates uses complete linkage: every pair in a group is within the distance', () => {
  const a = '0000000000000000', b = '000000000000003f' /* 6 from a */, c = '0000000000000fff' /* 6 from b, 12 from a */, far = 'ffffffffffffffff';
  // b is close to both a and c, but a and c are 12 apart, so they never share a group (no chaining
  // through b). c comes first, so b joins c; a is left alone. Nulls and singletons are skipped.
  assert.deepEqual(m.groupNearDuplicates([far, c, null, a, b]), [[1, 4]]);
  assert.deepEqual(m.groupNearDuplicates([a, b, c]), [[0, 1]]);
  // A slow pan: each photo 4 bits from the next. Transitive grouping would merge all five.
  const pan = ['0000000000000000', '000000000000000f', '00000000000000ff', '0000000000000fff', '000000000000ffff'];
  assert.deepEqual(m.groupNearDuplicates(pan), [[0, 1], [2, 3]]);
  const groups = m.groupNearDuplicates(pan);
  for (const g of groups) for (const i of g) for (const j of g) assert.ok(m.hammingDistance(pan[i], pan[j]) <= m.NEAR_DUPLICATE_MAX_DISTANCE);
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
  assert.deepEqual(r.extraCopies, [0, 2], 'all but the sharpest (index 1) of the group');
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

test('jpegName keeps the original extension so it cannot clash with a real JPEG of the same stem', () => {
  assert.equal(m.jpegName('IMG_0001.HEIC'), 'IMG_0001.heic.jpg');
  assert.equal(m.jpegName('my.trip.heif'), 'my.trip.heif.jpg');
  assert.equal(m.jpegName('noext'), 'noext.jpg');
  assert.equal(m.jpegName('.heic'), 'photo.heic.jpg');
});

test('uniqueName / convertedNames: converted photos get distinct names; re-adding the same HEIC still de-duplicates', () => {
  // A HEIC plus a different-size JPEG of the same stem, in one batch and across adds.
  const heic = { name: m.jpegName('IMG_0001.HEIC'), size: 200, converted: true };
  const real = { name: 'IMG_0001.jpg', size: 100, converted: false };
  assert.deepEqual(m.convertedNames([], [real, heic]), ['IMG_0001.jpg', 'IMG_0001.heic.jpg']);
  assert.deepEqual(m.convertedNames([{ name: 'IMG_0001.jpg', size: 100 }], [heic]), ['IMG_0001.heic.jpg']);
  // Re-adding the same HEIC: same name and size as the selected copy, so Studio's name + size check drops it.
  const selected = [{ name: 'IMG_0001.jpg', size: 100 }, { name: 'IMG_0001.heic.jpg', size: 200 }];
  assert.deepEqual(m.convertedNames(selected, [heic]), ['IMG_0001.heic.jpg']);
  // A different photo already holds the name (e.g. IMG_0001.HEIC and IMG_0001.heic from two folders).
  const other = { name: 'IMG_0001.heic.jpg', size: 300, converted: true };
  assert.deepEqual(m.convertedNames(selected, [other]), ['IMG_0001.heic (2).jpg']);
  assert.deepEqual(m.convertedNames([], [heic, other, { ...other, size: 400 }]), ['IMG_0001.heic.jpg', 'IMG_0001.heic (2).jpg', 'IMG_0001.heic (3).jpg']);
  // A non-HEIC file anywhere in the batch counts as taken.
  assert.deepEqual(m.convertedNames([], [heic, { name: 'IMG_0001.heic.jpg', size: 5, converted: false }]), ['IMG_0001.heic (2).jpg', 'IMG_0001.heic.jpg']);
  // After Studio's name + size de-duplication, every remaining name is unique, so the upload and
  // resume matcher (name, size) maps each manifest row to exactly one file.
  const batch = [heic, other, real], names = m.convertedNames(selected, batch);
  const kept = new Map([...selected, ...batch.map((f, i) => ({ name: names[i], size: f.size }))].map(f => [`${f.name}:${f.size}`, f.name]));
  assert.deepEqual([...kept.values()].sort(), ['IMG_0001.heic (2).jpg', 'IMG_0001.heic.jpg', 'IMG_0001.jpg']);
  assert.equal(m.uniqueName('noext', 1, new Map([['noext', new Set([2])]])), 'noext (2)');
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

test('libheif (separate glue + .wasm, as shipped) decodes the HEIC fixture upright (irot + crop applied)', async () => {
  // The same two files the app ships: Emscripten glue plus the .wasm passed in as wasmBinary.
  const require = createRequire(import.meta.url);
  const factory = require('libheif-js/libheif-wasm/libheif.js');
  const lib = await factory({ wasmBinary: readFileSync(require.resolve('libheif-js/libheif-wasm/libheif.wasm')) });
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
  // Pixel cap: refused from libheif's reported size, before the RGBA buffer is allocated.
  await assert.rejects(m.decodeHeif(lib, new Uint8Array(readFileSync('tests/fixtures/rotated-90cw.heic')), 1000),
    e => e instanceof m.HeifTooLargeError && e.width * e.height === 48 * 64);
});

test('libheif-js private members used by decodeHeif still exist (fails on an upgrade that drops them)', async () => {
  // heif-decode.ts frees the native context itself via decoder.decoder + lib.heif_context_free,
  // neither of which is public libheif-js API. Keep the exact pin; re-check this test before bumping it.
  const require = createRequire(import.meta.url);
  assert.equal(JSON.parse(readFileSync('package.json', 'utf8')).dependencies['libheif-js'], '1.23.5', 'exact pin');
  assert.equal(require('libheif-js/package.json').version, '1.23.5');
  const lib = await require('libheif-js/libheif-wasm/libheif.js')({ wasmBinary: readFileSync(require.resolve('libheif-js/libheif-wasm/libheif.wasm')) });
  assert.equal(typeof lib.HeifDecoder, 'function');
  assert.equal(typeof lib.heif_context_free, 'function');
  const decoder = new lib.HeifDecoder();
  assert.ok(Object.hasOwn(decoder, 'decoder'), 'HeifDecoder#decoder');
  assert.equal(decoder.decoder, null);
  const fixture = new Uint8Array(readFileSync('tests/fixtures/rotated-90cw.heic'));
  const images = decoder.decode(fixture);
  assert.equal(images.length, 1);
  assert.ok(decoder.decoder !== null && typeof decoder.decoder === 'object', 'the embind-wrapped native heif_context');
  images.forEach(image => image.free());
  lib.heif_context_free(decoder.decoder);
  decoder.decoder = null;
  // With the field cleared, the next decode allocates a fresh context instead of freeing ours twice.
  const again = decoder.decode(fixture);
  assert.equal(again.length, 1);
  again.forEach(image => image.free());
  lib.heif_context_free(decoder.decoder);
});

// ── header sizes (dimensions.ts) ──────────────────────────────────────────────────────────
const be32 = v => [(v >>> 24) & 255, (v >>> 16) & 255, (v >>> 8) & 255, v & 255];
const le32 = v => be32(v).reverse();
const be16 = v => [(v >>> 8) & 255, v & 255];
const le16 = v => be16(v).reverse();
function png(width, height) {
  return new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, ...be32(13), ...Buffer.from('IHDR'), ...be32(width), ...be32(height), 8, 6, 0, 0, 0]);
}
/** A minimal JPEG header: SOI, optional APP1/EXIF with an orientation tag, SOF0, SOS. */
function jpeg(width, height, { orientation, little = false, fill = false, sof = 0xc0 } = {}) {
  const u16 = little ? le16 : be16, u32 = little ? le32 : be32;
  const parts = [0xff, 0xd8];
  if (fill) parts.push(0xff, 0xff); // fill bytes before a marker are legal
  if (orientation) {
    const tiff = [...Buffer.from(little ? 'II' : 'MM'), ...u16(42), ...u32(8), ...u16(1), ...u16(0x0112), ...u16(3), ...u32(1), ...u16(orientation), 0, 0, ...u32(0)];
    const payload = [...Buffer.from('Exif\0\0', 'latin1'), ...tiff];
    parts.push(0xff, 0xe1, ...be16(payload.length + 2), ...payload);
  }
  parts.push(0xff, 0xdb, ...be16(4), 0, 0); // a dummy DQT before the frame header
  parts.push(0xff, sof, ...be16(11), 8, ...be16(height), ...be16(width), 1, 1, 0x11, 0);
  parts.push(0xff, 0xda, ...be16(2));
  return new Uint8Array(parts);
}

test('pngSize reads IHDR; displaySize passes PNG through', () => {
  assert.deepEqual(m.pngSize(png(4032, 3024)), { width: 4032, height: 3024 });
  assert.deepEqual(m.displaySize(png(10, 20)), { width: 10, height: 20 });
  assert.equal(m.pngSize(png(4032, 3024).subarray(0, 20)), null, 'truncated');
  assert.equal(m.pngSize(new Uint8Array(32)), null);
});

test('jpegInfo reads the SOF size and EXIF orientation in both byte orders; displaySize swaps for 5–8', () => {
  assert.deepEqual(m.jpegInfo(jpeg(4032, 3024)), { width: 4032, height: 3024, orientation: 1 });
  assert.deepEqual(m.jpegInfo(jpeg(4032, 3024, { orientation: 6 })), { width: 4032, height: 3024, orientation: 6 });
  assert.deepEqual(m.jpegInfo(jpeg(4032, 3024, { orientation: 6, little: true })), { width: 4032, height: 3024, orientation: 6 });
  assert.deepEqual(m.jpegInfo(jpeg(800, 600, { orientation: 3, fill: true, sof: 0xc2 })), { width: 800, height: 600, orientation: 3 }, 'progressive, fill bytes');
  assert.deepEqual(m.displaySize(jpeg(4032, 3024, { orientation: 6 })), { width: 3024, height: 4032 });
  assert.deepEqual(m.displaySize(jpeg(4032, 3024, { orientation: 8, little: true })), { width: 3024, height: 4032 });
  assert.deepEqual(m.displaySize(jpeg(4032, 3024, { orientation: 3 })), { width: 4032, height: 3024 });
  // A real encoder's file (JFIF + big-endian EXIF, orientation 6, stored 64×48).
  const real = new Uint8Array(readFileSync('tests/fixtures/rotated-exif6.jpg'));
  assert.deepEqual(m.jpegInfo(real), { width: 64, height: 48, orientation: 6 });
  assert.deepEqual(m.displaySize(real), { width: 48, height: 64 });
});

test('header parsers return null for garbage, truncation and SOS before SOF', () => {
  const full = jpeg(4032, 3024, { orientation: 6 });
  assert.equal(m.jpegInfo(full.subarray(0, full.length - 20)), null, 'cut before the frame header');
  assert.equal(m.jpegInfo(new Uint8Array([0xff, 0xd8, 0xff, 0xda, 0, 2, 0xff, 0xc0, 0, 11, 8, 0, 10, 0, 10])), null);
  assert.equal(m.jpegInfo(new Uint8Array([0xff, 0xd8, 0x12, 0x34, 0, 0])), null, 'not a marker');
  const random = Uint8Array.from({ length: 4096 }, (_, i) => (i * 2654435761) >>> 24);
  for (const parse of [m.pngSize, m.jpegInfo, m.heicSize, m.displaySize]) {
    assert.equal(parse(random), null, parse.name);
    assert.equal(parse(new Uint8Array(0)), null, `${parse.name} empty`);
  }
});

test('heicSize reads the largest ispe box; megapixels rounds to 0.1', () => {
  // The fixture is coded 64×64, then cropped (clap) to 64×48 and rotated (irot). ispe is the coded
  // size, an upper bound on the decoded pixels, which is what the cap needs.
  assert.deepEqual(m.heicSize(new Uint8Array(readFileSync('tests/fixtures/rotated-90cw.heic'))), { width: 64, height: 64 });
  const ispe = (w, h) => [...be32(20), ...Buffer.from('ispe'), 0, 0, 0, 0, ...be32(w), ...be32(h)];
  // iPhone grid: 512×512 tiles plus the full 8064×6048 canvas.
  const grid = new Uint8Array([0, 0, 0, 0, ...ispe(512, 512), ...ispe(8064, 6048), ...ispe(512, 512)]);
  assert.deepEqual(m.heicSize(grid), { width: 8064, height: 6048 });
  assert.ok(8064 * 6048 <= m.MAX_DECODE_PIXELS, 'a 48 MP iPhone photo is allowed');
  assert.equal(m.megapixels({ width: 8064, height: 6048 }), 48.8);
  assert.equal(m.heicSize(new Uint8Array([0, 0, 0, 0, ...be32(99), ...Buffer.from('ispe'), 0, 0, 0, 0, ...be32(9e4), ...be32(9e4)])), null, 'wrong box size');
});

// ── worker pool ─────────────────────────────────────────────────────────────────────────────
/** A stand-in for Worker. `script(worker, message)` decides how it answers each posted job. */
class FakeWorker {
  constructor(script, { ready = true } = {}) {
    this.script = script; this.posted = []; this.terminated = false;
    // Real workers post "ready" once their module has loaded.
    if (ready) queueMicrotask(() => this.emit({ id: 0, type: 'ready' }));
  }
  postMessage(message) { this.posted.push(message); this.script?.(this, message); }
  terminate() { this.terminated = true; }
  emit(data) { if (!this.terminated) this.onmessage?.({ data }); }
  crash() { if (!this.terminated) this.onerror?.({ preventDefault() {} }); }
}
const MESSAGES = { crash: 'crashed', load: 'not loaded', timeout: 'timed out', cancelled: 'cancelled' };
function pool(script, { size = 1, timeoutMs = 1000, workerOptions, create } = {}) {
  const workers = [];
  const p = new m.WorkerPool(create ?? (() => { const w = new FakeWorker(script, workerOptions); workers.push(w); return w; }), { size, timeoutMs, idleMs: 5, messages: MESSAGES });
  return { p, workers };
}
const file = name => ({ name });
/** Answers after a macrotask: stage first, then done. */
const answer = (w, { id }) => setTimeout(() => { w.emit({ id, type: 'stage', stage: 'decoding' }); w.emit({ id, type: 'done', value: id }); }, 0);

test('WorkerPool: runs jobs, forwards stage messages, reuses idle workers and respects size', async () => {
  const { p, workers } = pool(answer, { size: 2 });
  const stages = [];
  const runs = [1, 2, 3].map(n => p.run(file(n), { onMessage: msg => stages.push(msg.stage) }));
  assert.deepEqual(p.stats, { idle: 0, running: 2, queued: 1 });
  const results = await Promise.all(runs);
  assert.deepEqual(results.map(r => r.type), ['done', 'done', 'done']);
  assert.deepEqual(stages, ['decoding', 'decoding', 'decoding']);
  assert.equal(workers.length, 2, 'the third job reused a worker');
  assert.deepEqual(p.stats, { idle: 2, running: 0, queued: 0 });
  p.terminate();
  assert.ok(workers.every(w => w.terminated));
});

test('WorkerPool.run never rejects when the Worker constructor or postMessage throws', async () => {
  const broken = pool(null, { size: 2, create: () => { throw new Error('blocked by CSP'); } }).p;
  const results = await Promise.all([1, 2, 3].map(n => broken.run(file(n))));
  for (const r of results) { assert.equal(r.type, 'error'); assert.equal(r.reason, 'load'); assert.match(r.message, /not loaded \(blocked by CSP\)/); }
  assert.deepEqual(broken.stats, { idle: 0, running: 0, queued: 0 });

  const { p, workers } = pool((w, msg) => { if (msg.file.name === 'bad') throw new Error('DataCloneError'); answer(w, msg); });
  const [bad, good] = await Promise.all([p.run(file('bad')), p.run(file('good'))]);
  assert.equal(bad.reason, 'load');
  assert.equal(good.type, 'done', 'the next photo still runs');
  assert.ok(workers[0].terminated, 'the worker that failed to accept the job is dropped');
  assert.deepEqual(p.stats, { idle: 1, running: 0, queued: 0 });
  p.terminate();
});

test('WorkerPool: the watchdog stops a hung job, frees the slot, and ignores its late answer', async () => {
  const { p, workers } = pool((w, msg) => { if (msg.file.name !== 'hang') answer(w, msg); }, { timeoutMs: 20 });
  const hung = p.run(file('hang')), next = p.run(file('ok'));
  const r = await hung;
  assert.deepEqual([r.type, r.reason, r.message], ['error', 'timeout', 'timed out']);
  assert.ok(workers[0].terminated);
  workers[0].onmessage?.({ data: { id: r.id, type: 'done' } }); // a late answer changes nothing
  assert.equal((await next).type, 'done');
  assert.equal(workers.length, 2, 'the queued job ran on a fresh worker');
  p.terminate();
});

test('WorkerPool: aborting drops a queued job, or terminates the worker of a running one', async () => {
  const { p, workers } = pool(() => {}); // never answers
  const running = new AbortController(), queued = new AbortController();
  const first = p.run(file(1), { signal: running.signal });
  const second = p.run(file(2), { signal: queued.signal });
  assert.deepEqual(p.stats, { idle: 0, running: 1, queued: 1 });
  queued.abort();
  assert.deepEqual(await second, { id: 2, type: 'error', message: 'cancelled', reason: 'cancelled' });
  assert.deepEqual(p.stats, { idle: 0, running: 1, queued: 0 });
  assert.equal(workers[0].terminated, false, 'cancelling a queued job leaves the running one alone');
  running.abort();
  assert.equal((await first).reason, 'cancelled');
  assert.ok(workers[0].terminated);
  assert.deepEqual(p.stats, { idle: 0, running: 0, queued: 0 });
  // Already aborted: resolves at once and never starts a worker.
  const done = new AbortController(); done.abort();
  assert.equal((await p.run(file(3), { signal: done.signal })).reason, 'cancelled');
  assert.equal(workers.length, 1);
  // Aborting after the result arrived is a no-op.
  const late = new AbortController();
  const { p: q } = pool(answer);
  assert.equal((await q.run(file(4), { signal: late.signal })).type, 'done');
  late.abort();
  assert.deepEqual(q.stats, { idle: 1, running: 0, queued: 0 });
  q.terminate(); p.terminate();
});

test('WorkerPool: tells a worker that never loaded from one that crashed, and drops crashed idle workers', async () => {
  // Errors before any message: the script never loaded.
  const unloaded = pool(w => setTimeout(() => w.crash(), 0), { workerOptions: { ready: false } }).p;
  const r1 = await unloaded.run(file(1));
  assert.deepEqual([r1.reason, r1.message], ['load', 'not loaded']);

  // Errors after "ready": a crash mid-job (typically out of memory).
  const crashing = pool(w => setTimeout(() => w.crash(), 0));
  const r2 = await crashing.p.run(file(2));
  assert.deepEqual([r2.reason, r2.message], ['crash', 'crashed']);
  assert.ok(crashing.workers[0].terminated);
  assert.deepEqual(crashing.p.stats, { idle: 0, running: 0, queued: 0 });

  // A worker that dies while idle is removed, so the next job gets a fresh one.
  const { p, workers } = pool(answer);
  assert.equal((await p.run(file(3))).type, 'done');
  assert.deepEqual(p.stats, { idle: 1, running: 0, queued: 0 });
  workers[0].crash();
  assert.deepEqual(p.stats, { idle: 0, running: 0, queued: 0 });
  assert.ok(workers[0].terminated);
  assert.equal((await p.run(file(4))).type, 'done');
  assert.equal(workers.length, 2);
  p.terminate(); unloaded.terminate(); crashing.p.terminate();
});
