// Round-trips gpu-worker/spz.py through an independent decoder: Spark's own WASM splat
// decoder (the one the viewer runs). A synthetic Gaussian PLY is decoded directly and via
// its SPZ conversion; every splat must agree within the SPZ quantisation step.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test, { after } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { gunzipSync } from "node:zlib";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const python = process.env.PYTHON ?? "python3";
const hasNumpy = spawnSync(python, ["-c", "import numpy"]).status === 0;
const skip = !hasNumpy && "python3 with numpy is not available";
const dir = mkdtempSync(join(tmpdir(), "spz-roundtrip-"));
after(() => rmSync(dir, { recursive: true, force: true }));

/** Spark's bundle with the WASM decoder entry points exported, importable from plain Node. */
async function loadSpark() {
  const three = pathToFileURL(join(root, "node_modules/three/build/three.module.js")).href;
  const pass = pathToFileURL(join(root, "node_modules/three/examples/jsm/postprocessing/Pass.js")).href;
  const source = readFileSync(join(root, "node_modules/@sparkjsdev/spark/dist/spark.module.js"), "utf8")
    .replace('from "three/addons/postprocessing/Pass.js"', `from ${JSON.stringify(pass)}`)
    .replaceAll('from "three"', `from ${JSON.stringify(three)}`) +
    "\nexport { decode_to_gsplatarray as __decode, initialization as __init, decodeExtSplat as __decodeExt };\n";
  const file = join(dir, "spark.mjs");
  writeFileSync(file, source);
  const spark = await import(pathToFileURL(file).href);
  await spark.__init;
  return spark;
}

function random(seed) {
  let state = seed >>> 0;
  return (min, max) => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return min + (state / 2 ** 32) * (max - min);
  };
}

/** A Brush-style PLY: SH degree 2 (24 f_rest), properties sorted alphabetically, plus normals. */
function gaussianPly(count) {
  const rest = Array.from({ length: 24 }, (_, i) => `f_rest_${i}`);
  const names = ["f_dc_0", "f_dc_1", "f_dc_2", ...rest, "nx", "ny", "nz", "opacity",
    "rot_0", "rot_1", "rot_2", "rot_3", "scale_0", "scale_1", "scale_2", "x", "y", "z"].sort();
  const next = random(7);
  const rows = [];
  for (let i = 0; i < count; i++) {
    const quat = [next(-1, 1), next(-1, 1), next(-1, 1), next(-1, 1)];
    const value = name => {
      if (/^[xyz]$/.test(name)) return next(-6, 6);
      if (name.startsWith("f_dc_")) return next(-1.6, 1.6);
      if (name.startsWith("f_rest_")) return next(-0.45, 0.45);
      if (name === "opacity") return next(-5, 5);
      if (name.startsWith("scale_")) return next(-7, -0.5);
      if (name.startsWith("rot_")) return quat[Number(name[4])];
      return 0;
    };
    rows.push(Object.fromEntries(names.map(name => [name, value(name)])));
  }
  const header = `ply\nformat binary_little_endian 1.0\ncomment synthetic\nelement vertex ${count}\n` +
    names.map(name => `property float ${name}\n`).join("") + "end_header\n";
  const body = new Float32Array(rows.flatMap(row => names.map(name => row[name])));
  return Buffer.concat([Buffer.from(header, "ascii"), Buffer.from(body.buffer)]);
}

/** Columns of a float-only PLY, keyed by property name. */
function plyColumns(ply) {
  const end = ply.indexOf("end_header\n") + "end_header\n".length;
  const names = [...ply.subarray(0, end).toString("ascii").matchAll(/property float (\S+)/g)].map(match => match[1]);
  const floats = new Float32Array(ply.buffer.slice(ply.byteOffset + end, ply.byteOffset + ply.length));
  const rows = floats.length / names.length;
  return Object.fromEntries(names.map((name, k) => [name, Array.from({ length: rows }, (_, i) => floats[i * names.length + k])]));
}

function decode(spark, bytes) {
  // No file type and an extension-less path, exactly as the viewer's /scene URL: Spark sniffs.
  const decoder = spark.__decode(undefined, "/api/captures/c/scene?v=1");
  decoder.push(new Uint8Array(bytes));
  const splats = decoder.finish();
  const ext = splats.to_extsplats();
  const read = index => {
    const s = spark.__decodeExt([ext.ext0, ext.ext1], index);
    return {
      center: [s.center.x, s.center.y, s.center.z],
      color: [s.color.r, s.color.g, s.color.b],
      opacity: s.opacity,
      scales: [s.scales.x, s.scales.y, s.scales.z],
      quaternion: [s.quaternion.x, s.quaternion.y, s.quaternion.z, s.quaternion.w],
    };
  };
  return { count: splats.numSplats, shDegree: splats.maxShDegree, read };
}

function convert(ply, version) {
  const input = join(dir, `in-${version}.ply`);
  const output = join(dir, `out-${version}.spz`);
  writeFileSync(input, ply);
  const run = spawnSync(python, [join(root, "gpu-worker/spz.py"), input, output, String(version)], { encoding: "utf8" });
  assert.equal(run.status, 0, run.stderr);
  return { stats: JSON.parse(run.stdout), bytes: readFileSync(output) };
}

const close = (actual, expected, tolerance, label) => {
  for (let i = 0; i < expected.length; i++) {
    assert.ok(Math.abs(actual[i] - expected[i]) <= tolerance,
      `${label}[${i}]: ${actual[i]} vs ${expected[i]} (tolerance ${tolerance})`);
  }
};

for (const version of [3, 2]) {
  test(`spz.py v${version} round-trips through Spark's decoder within quantisation tolerance`, { skip }, async () => {
    const spark = await loadSpark();
    const count = 500;
    const ply = gaussianPly(count);
    const { stats, bytes } = convert(ply, version);
    assert.deepEqual([bytes[0], bytes[1]], [0x1f, 0x8b], "gzip container");
    assert.equal(stats.points, count);
    assert.equal(stats.sh_degree, 2);
    assert.ok(stats.spz_bytes < ply.length / 3, `SPZ ${stats.spz_bytes} B should be far smaller than PLY ${ply.length} B`);

    const reference = decode(spark, ply);
    const spz = decode(spark, bytes);
    assert.equal(reference.count, count);
    assert.equal(spz.count, count);
    assert.equal(reference.shDegree, 2);
    assert.equal(spz.shDegree, 2);

    let worstQuat = 1;
    for (let i = 0; i < count; i++) {
      const a = reference.read(i);
      const b = spz.read(i);
      // 24-bit fixed point with 12 fractional bits: half a step, plus float noise.
      close(b.center, a.center, 2 ** -12, `center ${i}`);
      // Colour byte step is 1/(0.15·255) in SH-DC units = 0.0074 in rgb; half-float storage adds ~0.001.
      close(b.color, a.color, 0.0055, `color ${i}`);
      close([b.opacity], [a.opacity], 0.004, `opacity ${i}`);
      // Log-scale byte step 1/16.
      close(b.scales.map(Math.log), a.scales.map(Math.log), 1 / 32 + 0.01, `log scale ${i}`);
      const dot = Math.abs(a.quaternion.reduce((sum, value, k) => sum + value * b.quaternion[k], 0));
      worstQuat = Math.min(worstQuat, dot);
    }
    // v3 smallest-three (9-bit) keeps every orientation within ~2°; v2 first-three (8-bit,
    // w rebuilt from x, y, z) is known to drift when w is near 0, which is why v3 is the default.
    assert.ok(worstQuat > (version === 3 ? 0.9995 : 0.995), `worst |q·q'| = ${worstQuat}`);

    // Spark keeps SH in its own lossy shared-exponent form (it clamps the PLY's own values
    // too), so SH is checked against the source floats straight from the SPZ payload:
    // per point, per coefficient, R G B bytes; value = (byte - 128) / 128.
    const payload = gunzipSync(bytes);
    const truth = plyColumns(ply);
    const shStart = 16 + count * (9 + 1 + 3 + 3 + (version === 3 ? 4 : 3));
    assert.equal(payload.length, shStart + count * 8 * 3);
    for (let i = 0; i < count; i++) {
      for (let j = 0; j < 8; j++) {
        for (let c = 0; c < 3; c++) {
          const stored = (payload[shStart + (i * 8 + j) * 3 + c] - 128) / 128;
          // Degree-1 coefficients keep 5 bits (bucket 8/128), degree 2 keeps 4 (16/128).
          const tolerance = (j < 3 ? 4 : 8) / 128 + 1 / 256;
          const expected = truth[`f_rest_${c * 8 + j}`][i];
          assert.ok(Math.abs(stored - expected) <= tolerance, `sh point ${i} coeff ${j} channel ${c}: ${stored} vs ${expected}`);
        }
      }
    }
  });
}

test("spz.py rejects a non-Gaussian PLY so the worker falls back to PLY-only delivery", { skip }, () => {
  const input = join(dir, "plain.ply");
  writeFileSync(input, Buffer.concat([
    Buffer.from("ply\nformat binary_little_endian 1.0\nelement vertex 1\nproperty float x\nproperty float y\nproperty float z\nend_header\n"),
    Buffer.from(new Float32Array([1, 2, 3]).buffer),
  ]));
  const run = spawnSync(python, [join(root, "gpu-worker/spz.py"), input, join(dir, "plain.spz")], { encoding: "utf8" });
  assert.notEqual(run.status, 0);
  assert.match(run.stderr, /not a Gaussian-splat PLY/);
});
