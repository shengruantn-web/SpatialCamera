/**
 * Pure image-quality metrics for pre-upload checks (PRD R1.6). No DOM access, so the
 * same code runs in the analysis Web Worker, in calibration scripts and in node tests.
 *
 * Thresholds were calibrated on real photos (COLMAP "south-building", 3072×2304, 64 photos)
 * measured through the browser path (createImageBitmap → OffscreenCanvas downscale with
 * imageSmoothingQuality "high" → these functions). Numbers are in docs/specs/capture-pipeline.md §8.
 */

/** Longest side of the grayscale copy the metrics run on. */
export const ANALYSIS_MAX_SIDE = 512;

/**
 * Absolute "blurry or low detail" floor: variance of the 4-neighbour Laplacian on the ≤512 px
 * grayscale copy. Calibration (south-building, 64 photos at 3072×2304): sharp originals 688–2602
 * (median 1390); the same photos with a full-resolution Gaussian blur of σ = 4 px scored 97–274 and
 * σ = 8 px 13–34. Sharp but featureless photos also score low (macOS "Mojave" desert photos: 24
 * and 63), so the floor sits just above the σ = 8 px band rather than higher; such photos are
 * also poor for camera alignment, which is why the warning says "blurry or low in detail".
 */
export const BLUR_VARIANCE_MIN = 50;

/**
 * Relative blur rule: a photo scoring below this fraction of the selection's median is flagged
 * even when above the absolute floor. Photos of one scene share texture, so a photo far below its
 * siblings is likely blurred. Calibration (south-building): sharp originals scored 0.50–1.87× the
 * set median; σ = 4 px blur 0.07–0.20×; σ = 2 px 0.26–0.71× (only partly caught: at 512 px a 2 px
 * full-resolution blur is a third of a pixel). 0.3 keeps a margin below the weakest sharp photo.
 */
export const BLUR_RELATIVE_FRACTION = 0.3;

/** The relative rule needs enough photos for a meaningful median. */
export const BLUR_RELATIVE_MIN_PHOTOS = 8;

/**
 * Near-duplicate threshold: maximum Hamming distance (of 64 bits) between dHashes.
 * Calibration (22 photos, south-building + macOS sample photos): the same photo resized to half
 * and re-encoded at JPEG quality 60 differed by 0–2 bits; shifted/zoomed by 1 % (hand-shake
 * burst) 0–6 bits; by 3 % 3–12 bits. Consecutive frames of the real walk-around capture, which
 * must NOT be flagged, differed by 12–43 bits, and no pair of its 64 distinct frames was closer
 * than 11 bits (2016 pairs). 6 catches re-encodes and bursts and leaves a 5-bit margin.
 */
export const NEAR_DUPLICATE_MAX_DISTANCE = 6;

/** PRD capture guidance: alignment is unreliable below ~30 usable photos (guide: "start with 30–80"). */
export const RECOMMENDED_MIN_PHOTOS = 30;

/** Scale (w, h) to fit within maxSide, never upscaling. */
export function fitWithin(width: number, height: number, maxSide = ANALYSIS_MAX_SIDE): { width: number; height: number } {
  const scale = Math.min(1, maxSide / Math.max(width, height));
  return { width: Math.max(1, Math.round(width * scale)), height: Math.max(1, Math.round(height * scale)) };
}

/** RGBA bytes → luma (Rec. 601), one float per pixel, 0–255. */
export function toGrayscale(rgba: ArrayLike<number>, width: number, height: number): Float32Array {
  const gray = new Float32Array(width * height);
  for (let i = 0, p = 0; i < gray.length; i++, p += 4) gray[i] = 0.299 * rgba[p] + 0.587 * rgba[p + 1] + 0.114 * rgba[p + 2];
  return gray;
}

/** Variance of the 4-neighbour Laplacian over interior pixels. Higher = more fine detail. */
export function laplacianVariance(gray: ArrayLike<number>, width: number, height: number): number {
  if (width < 3 || height < 3) return 0;
  let sum = 0, sumSq = 0, n = 0;
  for (let y = 1; y < height - 1; y++) {
    const row = y * width;
    for (let x = 1; x < width - 1; x++) {
      const i = row + x;
      const v = gray[i - width] + gray[i + width] + gray[i - 1] + gray[i + 1] - 4 * gray[i];
      sum += v; sumSq += v * v; n++;
    }
  }
  const mean = sum / n;
  return Math.max(0, sumSq / n - mean * mean);
}

/** Area-average resample (box filter) of a grayscale image to outW × outH. */
export function resizeArea(gray: ArrayLike<number>, width: number, height: number, outW: number, outH: number): Float64Array {
  const out = new Float64Array(outW * outH);
  const area = new Float64Array(outW * outH);
  for (let y = 0; y < height; y++) {
    // Each source pixel spans [y, y+1); distribute it over the output cells it overlaps.
    const y0 = y * outH / height, y1 = (y + 1) * outH / height;
    for (let x = 0; x < width; x++) {
      const x0 = x * outW / width, x1 = (x + 1) * outW / width;
      const v = gray[y * width + x];
      for (let oy = Math.floor(y0); oy < Math.min(outH, Math.ceil(y1)); oy++) {
        const wy = Math.min(y1, oy + 1) - Math.max(y0, oy);
        if (wy <= 0) continue;
        for (let ox = Math.floor(x0); ox < Math.min(outW, Math.ceil(x1)); ox++) {
          const wx = Math.min(x1, ox + 1) - Math.max(x0, ox);
          if (wx <= 0) continue;
          out[oy * outW + ox] += v * wx * wy; area[oy * outW + ox] += wx * wy;
        }
      }
    }
  }
  for (let i = 0; i < out.length; i++) out[i] = area[i] ? out[i] / area[i] : 0;
  return out;
}

/**
 * 64-bit difference hash: shrink to 9×8, set bit when a cell is brighter than its right
 * neighbour. Returned as 16 lowercase hex characters.
 */
export function dHash(gray: ArrayLike<number>, width: number, height: number): string {
  const small = resizeArea(gray, width, height, 9, 8);
  let hex = "";
  for (let y = 0; y < 8; y++) {
    let byte = 0;
    for (let x = 0; x < 8; x++) byte = (byte << 1) | (small[y * 9 + x] > small[y * 9 + x + 1] ? 1 : 0);
    hex += byte.toString(16).padStart(2, "0");
  }
  return hex;
}

function popcount32(v: number): number {
  v = v - ((v >>> 1) & 0x55555555);
  v = (v & 0x33333333) + ((v >>> 2) & 0x33333333);
  return (((v + (v >>> 4)) & 0x0f0f0f0f) * 0x01010101) >>> 24;
}

/** Hamming distance between two equal-length hex hashes. */
export function hammingDistance(a: string, b: string): number {
  if (a.length !== b.length || a.length % 8 !== 0) throw new Error("Hashes must be equal-length hex in 32-bit words.");
  let d = 0;
  for (let i = 0; i < a.length; i += 8) d += popcount32((parseInt(a.slice(i, i + 8), 16) ^ parseInt(b.slice(i, i + 8), 16)) >>> 0);
  return d;
}

/**
 * Group near-identical photos with complete linkage: a photo joins a group only if it is within
 * maxDistance of EVERY member, so a slow pan (a≈b, b≈c, a≉c) cannot chain distinct views into one
 * group, and whichever member is kept is a near copy of each one removed. Greedy in index order
 * (deterministic). Only groups with ≥2 members are returned; each group is sorted, groups ordered
 * by first index. Entries with a null hash (not analysed / failed) never group.
 */
export function groupNearDuplicates(hashes: readonly (string | null)[], maxDistance = NEAR_DUPLICATE_MAX_DISTANCE): number[][] {
  const groups: number[][] = [];
  hashes.forEach((hash, i) => {
    if (!hash) return;
    const home = groups.find(group => group.every(j => hammingDistance(hash, hashes[j]!) <= maxDistance));
    if (home) home.push(i); else groups.push([i]);
  });
  return groups.filter(g => g.length > 1);
}

function median(values: readonly number[]): number {
  const s = [...values].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

/** Indices of likely-blurry photos. null scores (not analysed) are skipped. */
export function findBlurry(scores: readonly (number | null)[], opts: { min?: number; fraction?: number; minPhotos?: number } = {}): number[] {
  const { min = BLUR_VARIANCE_MIN, fraction = BLUR_RELATIVE_FRACTION, minPhotos = BLUR_RELATIVE_MIN_PHOTOS } = opts;
  const known = scores.filter((s): s is number => s !== null);
  const relativeFloor = known.length >= minPhotos ? median(known) * fraction : 0;
  const floor = Math.max(min, relativeFloor);
  return scores.flatMap((s, i) => s !== null && s < floor ? [i] : []);
}

export type PrepReport = {
  /** Indices flagged as blurry. */
  blurry: number[];
  /** Groups of near-identical photos (indices). */
  duplicateGroups: number[][];
  /** Per group, all but the sharpest member: the photos "remove extra copies" takes out. */
  extraCopies: number[];
  /** Indices that add nothing beyond another photo: blurry ones, plus all but the sharpest of each duplicate group. */
  redundant: number[];
  /** Photos left after setting aside `redundant`. */
  usable: number;
  /** True when usable < RECOMMENDED_MIN_PHOTOS. */
  fewPhotos: boolean;
};

/** Combine per-photo measurements into warnings. Pure; order of `items` is preserved in indices. */
export function buildPrepReport(items: readonly { blur: number | null; hash: string | null }[]): PrepReport {
  const blurry = findBlurry(items.map(i => i.blur));
  const duplicateGroups = groupNearDuplicates(items.map(i => i.hash));
  const extraCopies: number[] = [];
  for (const group of duplicateGroups) {
    // Keep the sharpest member of each group; the others are extra copies.
    const keep = group.reduce((best, i) => (items[i].blur ?? 0) > (items[best].blur ?? 0) ? i : best, group[0]);
    group.forEach(i => { if (i !== keep) extraCopies.push(i); });
  }
  extraCopies.sort((a, b) => a - b);
  const redundant = new Set([...blurry, ...extraCopies]);
  const usable = items.length - redundant.size;
  return { blurry, duplicateGroups, extraCopies, redundant: [...redundant].sort((a, b) => a - b), usable, fewPhotos: usable < RECOMMENDED_MIN_PHOTOS };
}
