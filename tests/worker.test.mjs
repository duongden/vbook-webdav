import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pbkdf2Sync } from 'node:crypto';
import { build } from 'esbuild';
import { Miniflare, Log, LogLevel } from 'miniflare';

let mf, bucket, kv, directory, scriptPath;
const pin = 'test-only-admin-secret';
const password = 'mật khẩu:a:b';
const config = () => ({
  modules: true, scriptPath, modulesRoot: directory, compatibilityDate: '2026-05-20',
  bindings: { ADMIN_PIN: pin }, kvNamespaces: ['USER_KV'], r2Buckets: ['STORAGE_R2'],
  durableObjects: { USER_STORAGE: { className: 'UserStorage', useSQLite: true } },
  log: new Log(LogLevel.ERROR),
});
before(async () => {
  directory = await mkdtemp(join(tmpdir(), 'vbook-tests-'));
  scriptPath = join(directory, 'worker.mjs');
  await build({ entryPoints: ['src/index.ts'], bundle: true, format: 'esm', platform: 'browser', outfile: scriptPath });
  mf = new Miniflare(config());
  bucket = await mf.getR2Bucket('STORAGE_R2');
  kv = await mf.getKVNamespace('USER_KV');
});
after(async () => {
  await mf?.dispose();
  if (directory) await rm(directory, { recursive: true, force: true });
});
async function user(name, quota = 1, maxFile = 1) {
  const salt = '00'.repeat(16);
  await kv.put(`user:${name}`, JSON.stringify({
    password_hash: pbkdf2Sync(password, salt, 1000, 32, 'sha256').toString('base64'), salt,
    quota_mb: quota, max_file_size_mb: maxFile, status: 'active',
  }));
  return name;
}
function request(username, path, method = 'GET', body, headers = {}) {
  if (method === 'PUT' && (typeof body === 'string' || body instanceof Uint8Array)) {
    headers = { 'Content-Length': String(typeof body === 'string' ? Buffer.byteLength(body) : body.byteLength), ...headers };
  }
  return mf.dispatchFetch(`https://test.local${path}`, {
    method, body, ...(body instanceof ReadableStream ? { duplex: 'half' } : {}),
    headers: { Authorization: `Basic ${Buffer.from(`${username}:${password}`).toString('base64')}`, ...headers },
  });
}
async function usage(username) {
  const namespace = await mf.getDurableObjectNamespace('USER_STORAGE');
  const response = await namespace.get(namespace.idFromName(`user:${username}`)).fetch('https://internal/usage', {
    headers: { 'X-Storage-User': username },
  });
  assert.equal(response.status, 200);
  return (await response.json()).bytes;
}

// These requests pass through workerd, the actual R2 emulator and SQLite-backed DOs.
test('admin-like paths never bypass authentication or create undefined-owned data', async () => {
  for (const path of ['/administrator/test', '/admin123/test', '/admin-other/test']) {
    const response = await mf.dispatchFetch(`https://test.local${path}`, { method: 'PUT', body: 'anonymous' });
    assert.equal(response.status, 401, path);
  }
  assert.equal((await bucket.list({ prefix: 'undefined/' })).objects.length, 0);
  const response = await mf.dispatchFetch('https://test.local/admin/not-a-route', { method: 'PUT', body: 'x', redirect: 'manual' });
  assert.ok([302, 404].includes(response.status));
  assert.equal((await bucket.list({ prefix: 'undefined/' })).objects.length, 0);
});

test('concurrent PUTs reserve quota serially and overwrite accounting is exact', async () => {
  const name = await user('concurrent');
  const responses = await Promise.all([
    request(name, '/one', 'PUT', new Uint8Array(700000)),
    request(name, '/two', 'PUT', new Uint8Array(700000)),
  ]);
  assert.deepEqual(responses.map(r => r.status).sort(), [201, 507]);
  assert.equal(await usage(name), 700000);
  const existing = (await bucket.list({ prefix: `${name}/` })).objects[0].key.split('/')[1];
  const overwrites = await Promise.all([
    request(name, `/${existing}`, 'PUT', new Uint8Array(100)),
    request(name, `/${existing}`, 'PUT', new Uint8Array(200)),
  ]);
  assert.deepEqual(overwrites.map(r => r.status), [201, 201]);
  assert.equal(await usage(name), (await bucket.head(`${name}/${existing}`)).size);
});

test('reject oversized uploads and require a known body length', async () => {
  const name = await user('limits');
  assert.equal((await request(name, '/large', 'PUT', new Uint8Array(2 * 1024 * 1024))).status, 413);
  const unknownLength = new ReadableStream({ start(controller) { controller.enqueue(new Uint8Array(10)); controller.close(); } });
  assert.equal((await request(name, '/chunked', 'PUT', unknownLength)).status, 411);
  assert.equal((await bucket.list({ prefix: `${name}/` })).objects.length, 0);
});

test('DELETE returns an empty 204 and updates storage accounting', async () => {
  const name = await user('delete');
  assert.equal((await request(name, '/backup', 'PUT', 'payload')).status, 201);
  const response = await request(name, '/backup', 'DELETE');
  assert.equal(response.status, 204);
  assert.equal(await response.text(), '');
  assert.equal(await bucket.head(`${name}/backup`), null);
  assert.equal(await usage(name), 0);
});

test('special filename round trips, literal percent, mount boundary and traversal rejection', async () => {
  const name = await user('paths');
  for (const filename of ['a#b.txt', 'truyện có dấu.txt', '100%.txt', '%2e%2e.txt', 'a?b.txt', 'a&b.txt']) {
    const path = `/webdav/${encodeURIComponent(filename)}`;
    assert.equal((await request(name, path, 'PUT', filename)).status, 201, filename);
    assert.equal(await (await request(name, path)).text(), filename, filename);
    const xml = await (await request(name, '/webdav/', 'PROPFIND', undefined, { Depth: '1' })).text();
    assert.ok(xml.includes(`<D:href>${path}</D:href>`), filename);
  }
  assert.equal((await request(name, '/webdav2/test', 'PUT', 'boundary')).status, 201);
  assert.ok(await bucket.head(`${name}/webdav2/test`));
  assert.equal(await bucket.head(`${name}/2/test`), null);
  assert.equal((await request(name, '/webdav/%2e%2e%2fother/file', 'PUT', 'x')).status, 403);
  const ui = await (await request(name, '/', 'GET', undefined, { Accept: 'text/html' })).text();
  assert.ok(ui.includes('/webdav/a%23b.txt'));
  assert.ok(ui.includes('data-name="a&amp;b.txt"'));
  assert.ok(!ui.includes('data-name="a&amp;amp;b.txt"'));
});

test('downloads including HTML are attachments; HEAD returns only metadata', async () => {
  const name = await user('download');
  await request(name, '/page.html', 'PUT', '<script>alert(1)</script>', { 'Content-Type': 'text/html' });
  for (const method of ['GET', 'HEAD']) {
    const response = await request(name, '/page.html', method);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('Content-Type'), 'application/octet-stream');
    assert.match(response.headers.get('Content-Disposition'), /^attachment;/);
    assert.equal(response.headers.get('X-Content-Type-Options'), 'nosniff');
    assert.match(response.headers.get('Content-Security-Policy'), /sandbox/);
    if (method === 'HEAD') assert.equal(await response.text(), '');
  }
});

test('PROPFIND pages past 1000 files and DELETE without trailing slash removes only its tree', async () => {
  const name = await user('pagination');
  for (let start = 0; start < 1002; start += 50) {
    await Promise.all(Array.from({ length: Math.min(50, 1002 - start) }, (_, i) => bucket.put(`${name}/folder/${start + i}`, 'x')));
  }
  await bucket.put(`${name}/folder-other/keep`, 'keep');
  const response = await request(name, '/webdav/folder', 'PROPFIND', undefined, { Depth: '1' });
  assert.equal(response.status, 207);
  assert.equal(((await response.text()).match(/<D:getcontentlength>/g) || []).length, 1002);
  assert.equal((await request(name, '/webdav/folder', 'DELETE')).status, 204);
  assert.equal((await bucket.list({ prefix: `${name}/folder/` })).objects.length, 0);
  assert.ok(await bucket.head(`${name}/folder-other/keep`));
  assert.equal(await usage(name), 4);
  assert.equal((await request(name, '/webdav/missing/', 'PROPFIND')).status, 404);
});

test('different users never read or delete each other files', async () => {
  const alice = await user('isolated_a'), bob = await user('isolated_b');
  await request(alice, '/same', 'PUT', 'alice');
  await request(bob, '/same', 'PUT', 'bob');
  await request(alice, '/', 'DELETE');
  assert.equal(await (await request(bob, '/same')).text(), 'bob');
  assert.equal(await usage(alice), 0);
  assert.equal(await usage(bob), 3);
});

test('admin sessions are scoped, expiring and protected by CSRF; delete removes user and files', async () => {
  const name = await user('admin_delete');
  assert.equal((await request(name, '/file', 'PUT', 'file')).status, 201);
  const login = await mf.dispatchFetch('https://test.local/admin/login', {
    method: 'POST', body: new URLSearchParams({ pin }), redirect: 'manual',
  });
  assert.equal(login.status, 302);
  const sessionHeader = login.headers.getSetCookie().find(value => value.startsWith('admin_session=') && !value.includes('Max-Age=0'));
  for (const flag of ['HttpOnly', 'Secure', 'SameSite=Strict', 'Path=/admin', 'Max-Age=28800']) assert.ok(sessionHeader.includes(flag), flag);
  assert.ok(!sessionHeader.includes(pin));
  const session = sessionHeader.split(';')[0];
  const dashboard = await mf.dispatchFetch('https://test.local/admin', { headers: { Cookie: session }, redirect: 'manual' });
  assert.equal(dashboard.status, 200);
  const csrfHeader = dashboard.headers.getSetCookie().find(value => value.startsWith('csrf_token='));
  const csrfCookie = csrfHeader.split(';')[0];
  const csrf = decodeURIComponent(csrfCookie.substring('csrf_token='.length));
  const cookie = `${session}; ${csrfCookie}`;
  const denied = await mf.dispatchFetch('https://test.local/admin/delete', { method: 'POST', headers: { Cookie: cookie }, body: new URLSearchParams({ username: name }) });
  assert.equal(denied.status, 403);
  const deleted = await mf.dispatchFetch('https://test.local/admin/delete', { method: 'POST', headers: { Cookie: cookie }, body: new URLSearchParams({ username: name, _csrf: csrf }), redirect: 'manual' });
  assert.equal(deleted.status, 302);
  assert.ok(deleted.headers.get('location').includes('ok='));
  assert.equal(await kv.get(`user:${name}`), null);
  assert.equal((await bucket.list({ prefix: `${name}/` })).objects.length, 0);
});

test('missing ADMIN_PIN fails closed for both login and dashboard', async () => {
  const unconfigured = new Miniflare({ ...config(), bindings: {} });
  try {
    for (const path of ['/admin', '/admin/login']) {
      const response = await unconfigured.dispatchFetch(`https://test.local${path}`, { redirect: 'manual' });
      assert.equal(response.status, 503);
    }
    const response = await unconfigured.dispatchFetch('https://test.local/admin/login', { method: 'POST', body: new URLSearchParams(), redirect: 'manual' });
    assert.equal(response.status, 503);
  } finally { await unconfigured.dispose(); }
});
