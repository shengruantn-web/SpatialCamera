// S8 (ADR-0010, spec §7.9): share links and embeds, against a real D1 + R2 in Miniflare.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { build } from 'esbuild';
import { Miniflare } from 'miniflare';
import { applyMigrations } from '../db/migrate.mjs';

const owner = 'share-owner@example.invalid';
const other = 'someone-else@example.invalid';
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=', 'base64');
const plyBytes = Buffer.from('ply\nformat binary_little_endian 1.0\nelement vertex 0\nend_header\n');
const spzBytes = Buffer.from('fake-spz-bytes-for-tests');
const sha256 = text => createHash('sha256').update(text).digest('hex');

let script, mf, db, bucket;
// Mirrors worker/index.ts: /api/* → handleApi; /s/* → handleSharePublic, whose page renderer stands in
// for the vinext app route (it says which page it rendered and sets a header the handler must override).
const newMiniflare = bindings => new Miniflare({ modules: true, script, compatibilityDate: '2026-01-01', d1Databases: ['DB'], r2Buckets: ['BUCKET'], bindings });
before(async () => {
  const result = await build({ stdin: { contents: `import { handleApi } from "./worker/api.ts";
    import { handleSharePublic, isSharePath, newShareToken } from "./worker/share.ts";
    const renderPage = async request => new Response('<!doctype html><title>rendered</title>' + new URL(request.url).pathname,
      { headers: { 'Content-Type': 'text/html; charset=utf-8', 'X-Frame-Options': 'SAMEORIGIN', 'Cache-Control': 'public, max-age=600' } });
    export default { fetch(request, env, ctx) {
      const url = new URL(request.url);
      if (url.pathname === '/__test/is-share-path') return Response.json(JSON.parse(url.searchParams.get('paths')).map(isSharePath));
      if (url.pathname === '/__test/tokens') return Response.json(Array.from({ length: 50 }, newShareToken));
      if (url.pathname.startsWith('/api/')) return handleApi(request, env, ctx);
      if (isSharePath(url.pathname)) return handleSharePublic(request, env, renderPage);
      return new Response('app', { status: 200 });
    } };`, resolveDir: process.cwd() }, bundle: true, write: false, format: 'esm', platform: 'browser' });
  script = result.outputFiles[0].text;
  mf = newMiniflare({ SHARE_RATE_LIMIT: '100000' });
  db = await mf.getD1Database('DB');
  bucket = await mf.getR2Bucket('BUCKET');
  await applyMigrations(db);
});
after(async () => { await mf?.dispose(); });

const api = (path, { method = 'GET', body, as = owner, headers = {} } = {}) => mf.dispatchFetch(`http://localhost/api/${path}`, {
  method, headers: { 'oai-authenticated-user-email': as, ...(body ? { 'content-type': 'application/json' } : {}), ...headers }, body: body && JSON.stringify(body),
});
const pub = (path, init = {}) => mf.dispatchFetch(`http://localhost${path}`, init);

/** A finished capture, written straight to D1 and R2 (the upload/worker flow is covered by api.test.mjs). */
async function readyCapture({ spz = true, as = owner, status = 'ready' } = {}) {
  const id = randomUUID();
  const resultKey = `${id}/attempts/a1/result.ply`;
  const spzKey = spz ? `${id}/attempts/a1/result.spz` : null;
  await db.prepare('INSERT INTO captures (id,owner,name,status,created_at,updated_at,image_count,uploaded_count,result_key,result_bytes,spz_key,spz_bytes) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)')
    .bind(id, as, 'Garden <wall>', status, Date.now(), Date.now(), 1, 1, resultKey, plyBytes.length, spzKey, spz ? spzBytes.length : null).run();
  await db.prepare("INSERT INTO images (id,capture_id,name,bytes,mime,uploaded,object_key) VALUES (?,?,?,?,?,1,?)").bind(`${id}-img`, id, 'secret-photo.png', png.length, 'image/png', `${id}/images/${id}-img`).run();
  await bucket.put(resultKey, plyBytes);
  if (spzKey) await bucket.put(spzKey, spzBytes);
  await bucket.put(`${id}/images/${id}-img`, png);
  return id;
}
async function createShare(id, body = {}, as = owner) {
  const response = await api(`captures/${id}/shares`, { method: 'POST', body, as });
  assert.equal(response.status, 201);
  return response.json();
}
const viewsOf = async shareId => (await db.prepare('SELECT views FROM shares WHERE id=?').bind(shareId).first()).views;

test('tokens are 128-bit base64url values and only their SHA-256 is stored', async () => {
  const tokens = await (await pub('/__test/tokens')).json();
  assert.equal(new Set(tokens).size, tokens.length);
  for (const token of tokens) assert.match(token, /^[A-Za-z0-9_-]{22}$/);
  assert.ok(tokens.every(t => Buffer.from(t, 'base64url').length === 16));

  const id = await readyCapture();
  const { token, share, path } = await createShare(id);
  assert.equal(path, `/s/${token}`);
  const row = await db.prepare('SELECT * FROM shares WHERE id=?').bind(share.id).first();
  assert.equal(row.token_hash, sha256(token));
  assert.equal(row.capture_id, id);
  assert.equal(row.views, 0);
  assert.equal(row.allow_download, 0);
  assert.equal(row.revoked_at, null);
  for (const value of Object.values(row)) assert.ok(!String(value).includes(token), 'the token is never stored in clear');
  // The lookup uses the unique hash index.
  const plan = await db.prepare('EXPLAIN QUERY PLAN SELECT id FROM shares WHERE token_hash=?').bind('x').all();
  assert.ok(plan.results.some(r => /shares_token_hash_idx/.test(r.detail)), JSON.stringify(plan.results));
  await assert.rejects(db.prepare('INSERT INTO shares (id,capture_id,token_hash,created_at) VALUES (?,?,?,?)').bind('dup', id, row.token_hash, 1).run(), /UNIQUE/);
});

test('owner create, list, PATCH and revoke; the token is returned only once', async () => {
  const id = await readyCapture();
  const first = await createShare(id);
  const second = await createShare(id, { allow_download: true });
  assert.equal(first.share.allow_download, false);
  assert.equal(second.share.allow_download, true);
  const listed = await (await api(`captures/${id}/shares`)).json();
  assert.deepEqual(listed.shares.map(s => s.id).sort(), [first.share.id, second.share.id].sort());
  const listText = JSON.stringify(listed);
  for (const created of [first, second]) {
    assert.ok(!listText.includes(created.token), 'the list never contains a token');
    assert.ok(!listText.includes(sha256(created.token)), 'nor its hash');
  }
  assert.deepEqual(Object.keys(listed.shares[0]).sort(), ['allow_download', 'created_at', 'id', 'revoked_at', 'views']);

  assert.equal((await api(`captures/${id}/shares`, { method: 'POST', body: { allow_download: 'yes' } })).status, 400);
  assert.equal((await api(`captures/${id}/shares/${first.share.id}`, { method: 'PATCH', body: {} })).status, 400);
  assert.equal((await api(`captures/${id}/shares/no-such-link`, { method: 'PATCH', body: { allow_download: true } })).status, 404);
  const patched = await api(`captures/${id}/shares/${first.share.id}`, { method: 'PATCH', body: { allow_download: true } });
  assert.equal(patched.status, 200);
  assert.equal((await patched.json()).share.allow_download, true);

  const revoked = await api(`captures/${id}/shares/${first.share.id}/revoke`, { method: 'POST' });
  assert.equal(revoked.status, 200);
  const revokedAt = (await revoked.json()).share.revoked_at;
  assert.ok(revokedAt > 0);
  // Idempotent, and the first revocation time is kept.
  const again = await (await api(`captures/${id}/shares/${first.share.id}/revoke`, { method: 'POST' })).json();
  assert.equal(again.share.revoked_at, revokedAt);
  assert.equal((await api(`captures/${id}/shares/${first.share.id}`, { method: 'PATCH', body: { allow_download: false } })).status, 409);
  assert.equal((await api(`captures/${id}/shares/no-such-link/revoke`, { method: 'POST' })).status, 404);
  assert.equal((await api(`captures/${id}/shares/${first.share.id}`, { method: 'DELETE' })).status, 404);
  // Cross-site mutations are refused like every other owner mutation.
  assert.equal((await api(`captures/${id}/shares`, { method: 'POST', body: {}, headers: { origin: 'https://evil.invalid' } })).status, 403);
});

test('only a ready capture can be shared, and active links are capped', async () => {
  const queued = await readyCapture({ status: 'queued' });
  assert.equal((await api(`captures/${queued}/shares`, { method: 'POST', body: {} })).status, 409);
  const id = await readyCapture();
  const created = [];
  for (let i = 0; i < 20; i++) created.push(await createShare(id));
  assert.equal((await api(`captures/${id}/shares`, { method: 'POST', body: {} })).status, 409);
  await api(`captures/${id}/shares/${created[0].share.id}/revoke`, { method: 'POST' });
  assert.equal((await api(`captures/${id}/shares`, { method: 'POST', body: {} })).status, 201);
});

test('another owner cannot list, create, change or revoke links', async () => {
  const id = await readyCapture();
  const { share, token } = await createShare(id);
  assert.equal((await api(`captures/${id}/shares`, { as: other })).status, 404);
  assert.equal((await api(`captures/${id}/shares`, { method: 'POST', body: {}, as: other })).status, 404);
  assert.equal((await api(`captures/${id}/shares/${share.id}`, { method: 'PATCH', body: { allow_download: true }, as: other })).status, 404);
  assert.equal((await api(`captures/${id}/shares/${share.id}/revoke`, { method: 'POST', as: other })).status, 404);
  assert.equal((await db.prepare('SELECT revoked_at, allow_download FROM shares WHERE id=?').bind(share.id).first()).revoked_at, null);
  // A link id from one capture cannot be acted on through another capture of the same owner.
  const mine = await readyCapture();
  assert.equal((await api(`captures/${mine}/shares/${share.id}/revoke`, { method: 'POST' })).status, 404);
  assert.equal((await pub(`/s/${token}/info`)).status, 200);
  // Unauthenticated owner routes are 401.
  assert.equal((await mf.dispatchFetch(`http://localhost/api/captures/${id}/shares`)).status, 401);
});

test('public page and embed: framing, caching and headers', async () => {
  const id = await readyCapture();
  const { token } = await createShare(id);
  const page = await pub(`/s/${token}`);
  assert.equal(page.status, 200);
  assert.match(await page.text(), new RegExp(`rendered</title>/s/${token}$`));
  assert.equal(page.headers.get('content-security-policy'), "frame-ancestors 'none'");
  assert.equal(page.headers.get('x-frame-options'), 'DENY');
  assert.equal(page.headers.get('cache-control'), 'no-store');
  assert.equal(page.headers.get('referrer-policy'), 'no-referrer');
  assert.equal(page.headers.get('x-robots-tag'), 'noindex, nofollow');
  const embed = await pub(`/s/${token}/embed`);
  assert.equal(embed.status, 200);
  assert.equal(embed.headers.get('content-security-policy'), 'frame-ancestors *');
  assert.equal(embed.headers.get('x-frame-options'), null);
  assert.equal(embed.headers.get('cache-control'), 'no-store');
  // Data routes are never documents.
  const info = await pub(`/s/${token}/info`);
  assert.equal(info.headers.get('content-security-policy'), "default-src 'none'; frame-ancestors 'none'; sandbox");
  assert.equal(info.headers.get('cache-control'), 'no-store');
  assert.equal((await pub(`/s/${token}`, { method: 'POST' })).status, 405);
});

test('the scene is the SPZ (or the PLY only without one), revalidated by ETag; photos are unreachable', async () => {
  const id = await readyCapture();
  const { token, share } = await createShare(id);
  const info = await (await pub(`/s/${token}/info`)).json();
  assert.deepEqual(info, { name: 'Garden <wall>', format: 'spz', scene_bytes: spzBytes.length, download: false, download_bytes: null });
  const infoText = JSON.stringify(info);
  for (const secret of [id, owner, share.id, 'secret-photo', 'attempts']) assert.ok(!infoText.includes(secret), `info leaks ${secret}`);

  const scene = await pub(`/s/${token}/scene`);
  assert.equal(scene.status, 200);
  assert.deepEqual(Buffer.from(await scene.arrayBuffer()), spzBytes);
  assert.equal(scene.headers.get('x-splat-format'), 'spz');
  assert.equal(scene.headers.get('cache-control'), 'private, no-cache');
  const etag = scene.headers.get('etag');
  assert.ok(etag);
  const cached = await pub(`/s/${token}/scene`, { headers: { 'if-none-match': etag } });
  assert.equal(cached.status, 304);
  assert.equal((await cached.arrayBuffer()).byteLength, 0);

  // Nothing else is reachable through a link: not the photos, not the PLY by key, not owner routes.
  for (const path of [`/s/${token}/images`, `/s/${token}/images/${id}-img`, `/s/${token}/result.ply`, `/s/${token}/scene/x`, `/s/${token}/download`, `/s/${token}/embed/x`, `/s/${token}.rsc`, `/s/${token}/info.json`]) {
    const response = await pub(path);
    assert.equal(response.status, 404, path);
    const body = Buffer.from(await response.arrayBuffer());
    assert.ok(!body.equals(png) && !body.equals(plyBytes), `${path} served bytes`);
  }
});

test('the PLY download is served only with the owner opt-in', async () => {
  const id = await readyCapture();
  const { token, share } = await createShare(id);
  assert.equal((await pub(`/s/${token}/download`)).status, 404);
  await api(`captures/${id}/shares/${share.id}`, { method: 'PATCH', body: { allow_download: true } });
  const info = await (await pub(`/s/${token}/info`)).json();
  assert.equal(info.download, true);
  assert.equal(info.download_bytes, plyBytes.length);
  const download = await pub(`/s/${token}/download`);
  assert.equal(download.status, 200);
  assert.deepEqual(Buffer.from(await download.arrayBuffer()), plyBytes);
  assert.equal(download.headers.get('content-disposition'), 'attachment; filename="spatial-capture.ply"');
  assert.equal(download.headers.get('cache-control'), 'private, no-store');
  await api(`captures/${id}/shares/${share.id}`, { method: 'PATCH', body: { allow_download: false } });
  assert.equal((await pub(`/s/${token}/download`)).status, 404);

  // Without an SPZ the PLY is the scene itself, but the download route still needs the opt-in.
  const plyOnly = await readyCapture({ spz: false });
  const link = await createShare(plyOnly);
  const scene = await pub(`/s/${link.token}/scene`);
  assert.equal(scene.status, 200);
  assert.equal(scene.headers.get('x-splat-format'), 'ply');
  assert.deepEqual(Buffer.from(await scene.arrayBuffer()), plyBytes);
  assert.equal((await (await pub(`/s/${link.token}/info`)).json()).format, 'ply');
  assert.equal((await pub(`/s/${link.token}/download`)).status, 404);
});

test('revoked, unknown, malformed and non-ready links are 404 on every route, immediately', async () => {
  const id = await readyCapture();
  const { token, share } = await createShare(id, { allow_download: true });
  const etag = (await pub(`/s/${token}/scene`)).headers.get('etag');
  assert.equal((await pub(`/s/${token}`)).status, 200);
  await api(`captures/${id}/shares/${share.id}/revoke`, { method: 'POST' });
  const routes = t => [`/s/${t}`, `/s/${t}/embed`, `/s/${t}/info`, `/s/${t}/scene`, `/s/${t}/download`];
  for (const path of routes(token)) assert.equal((await pub(path)).status, 404, path);
  // A browser revalidating its cached copy is refused too.
  assert.equal((await pub(`/s/${token}/scene`, { headers: { 'if-none-match': etag } })).status, 404);
  const page = await pub(`/s/${token}`);
  assert.match(page.headers.get('content-type'), /text\/html/);
  assert.equal(page.headers.get('cache-control'), 'no-store');
  assert.doesNotMatch(await page.text(), /rendered/);

  const unknown = Buffer.alloc(16, 7).toString('base64url');
  for (const path of [...routes(unknown), '/s/not-a-token', '/s/', '/s', `/s/${token}x`]) assert.equal((await pub(path)).status, 404, path);

  // A capture that is not ready (resubmitted, failed, or being deleted) is not served, then is again.
  const other = await readyCapture();
  const live = await createShare(other, { allow_download: true });
  for (const status of ['queued', 'failed', 'deleting']) {
    await db.prepare('UPDATE captures SET status=? WHERE id=?').bind(status, other).run();
    for (const path of routes(live.token)) assert.equal((await pub(path)).status, 404, `${status} ${path}`);
  }
  await db.prepare("UPDATE captures SET status='ready' WHERE id=?").bind(other).run();
  assert.equal((await pub(`/s/${live.token}/scene`)).status, 200);
  assert.equal(await viewsOf(live.share.id), 0, 'refused page loads do not count');
});

test('views count GET page and embed loads only', async () => {
  const id = await readyCapture();
  const { token, share } = await createShare(id);
  await pub(`/s/${token}`);
  await pub(`/s/${token}`);
  await pub(`/s/${token}/embed`);
  assert.equal(await viewsOf(share.id), 3);
  assert.equal((await pub(`/s/${token}`, { method: 'HEAD' })).status, 200);
  assert.equal((await pub(`/s/${token}`, { headers: { 'sec-purpose': 'prefetch' } })).status, 200);
  await pub(`/s/${token}/info`);
  await pub(`/s/${token}/scene`);
  assert.equal(await viewsOf(share.id), 3);
  const listed = await (await api(`captures/${id}/shares`)).json();
  assert.equal(listed.shares[0].views, 3);
});

test('deleting a capture cascades to its links (D1 enforces the foreign key)', async () => {
  const id = await readyCapture();
  const { token } = await createShare(id);
  await createShare(id);
  assert.equal((await db.prepare('SELECT COUNT(*) AS n FROM shares WHERE capture_id=?').bind(id).first()).n, 2);
  await assert.rejects(db.prepare('INSERT INTO shares (id,capture_id,token_hash,created_at) VALUES (?,?,?,?)').bind(randomUUID(), 'no-such-capture', sha256(randomUUID()), 1).run(), /FOREIGN KEY/);
  await db.prepare('DELETE FROM captures WHERE id=?').bind(id).run();
  assert.equal((await db.prepare('SELECT COUNT(*) AS n FROM shares WHERE capture_id=?').bind(id).first()).n, 0);
  assert.equal((await pub(`/s/${token}/info`)).status, 404);
});

test('every spelling of /s is routed through the token check', async () => {
  const paths = ['/s', '/s/', '/s/abc', '/S/abc', '/%73/abc', '/%53/abc', '//s/abc', '/s%2fabc', '/sx', '/studio', '/api/s', '/', '/%E0%A4%A'];
  const result = await (await pub(`/__test/is-share-path?paths=${encodeURIComponent(JSON.stringify(paths))}`)).json();
  assert.deepEqual(result, [true, true, true, true, true, true, true, true, false, false, false, false, false]);
  // Variants the app router could fold into /s/:token never render the page.
  const { token } = await createShare(await readyCapture());
  for (const path of [`/S/${token}`, `/%73/${token}`, `//s/${token}`]) assert.equal((await pub(path)).status, 404, path);
});

test('the public rate limiter trips per client, before any lookup', async () => {
  const limited = newMiniflare({ SHARE_RATE_LIMIT: '3' });
  try {
    await applyMigrations(await limited.getD1Database('DB'));
    const hit = ip => limited.dispatchFetch('http://localhost/s/unknown-token/info', { headers: { 'cf-connecting-ip': ip } });
    for (let i = 0; i < 3; i++) assert.equal((await hit('203.0.113.7')).status, 404);
    const tripped = await hit('203.0.113.7');
    assert.equal(tripped.status, 429);
    assert.ok(Number(tripped.headers.get('retry-after')) >= 1);
    assert.equal(tripped.headers.get('cache-control'), 'no-store');
    // Another client has its own budget.
    assert.equal((await hit('198.51.100.9')).status, 404);
  } finally { await limited.dispose(); }
});
