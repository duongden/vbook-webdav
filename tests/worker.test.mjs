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
const driveRootId = 'ROOT_FOLDER_12345';
const config = () => ({
  modules: true, scriptPath, modulesRoot: directory, compatibilityDate: '2026-05-20',
  bindings: { ADMIN_PIN: pin, PASSWORD_VAULT_KEY: 'ab'.repeat(32), DRIVE_VAULT_KEY: 'ab'.repeat(32) }, kvNamespaces: ['USER_KV'], r2Buckets: ['STORAGE_R2'],
  durableObjects: { USER_STORAGE: { className: 'UserStorage', useSQLite: true } },
  outboundService: request => {
    const url = new URL(request.url);
    if (url.origin !== 'https://www.googleapis.com' || !['test-drive-key-user-123456', 'second-drive-key-user-123456'].includes(url.searchParams.get('key'))) return new Response('blocked', { status: 502 });
    if (url.pathname === `/drive/v3/files/${driveRootId}`) return Response.json({ id: driveRootId, name: 'Books', mimeType: 'application/vnd.google-apps.folder' });
    if (url.pathname === '/drive/v3/files') {
      const query = url.searchParams.get('q') || '';
      if (query.includes(`'${driveRootId}' in parents`)) return Response.json({ files: [
        { id: 'SUB_FOLDER_12345', name: 'Tiên Hiệp', mimeType: 'application/vnd.google-apps.folder', modifiedTime: '2026-09-20T01:02:03Z' },
        { id: 'BOOK_FILE_12345', name: 'Sách & truyện.epub', mimeType: 'application/epub+zip', size: '1234', modifiedTime: '2026-09-20T02:03:04Z' },
      ] });
      if (query.includes("'SUB_FOLDER_12345' in parents")) return Response.json({ files: [
        { id: 'NESTED_FILE_12345', name: 'Tập 1.pdf', mimeType: 'application/pdf', size: '5678', modifiedTime: '2026-09-20T03:04:05Z' },
      ] });
    }
    return new Response('not found', { status: 404 });
  },
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
  assert.equal(await usage(name), 700300);
  assert.equal((await bucket.list({ prefix: `${name}/backup-history/` })).objects.length, 2);
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

test('security headers, request body limits and user login throttling fail closed', async () => {
  const name = await user('security_user');
  const authorization = `Basic ${Buffer.from(`${name}:${password}`).toString('base64')}`;
  const page = await mf.dispatchFetch('https://test.local/', { headers: { Authorization: authorization, Accept: 'text/html' } });
  assert.equal(page.status, 200);
  assert.equal(page.headers.get('X-Frame-Options'), 'DENY');
  assert.equal(page.headers.get('Referrer-Policy'), 'no-referrer');
  assert.match(page.headers.get('Content-Security-Policy'), /frame-ancestors 'none'/);
  assert.match(page.headers.get('Strict-Transport-Security'), /max-age=31536000/);

  const oversized = JSON.stringify({ path: 'library/book.epub', metadata: { description: 'x'.repeat(20_000) } });
  const limited = await mf.dispatchFetch('https://test.local/api/metadata', {
    method: 'PUT',
    headers: { Authorization: authorization, Origin: 'https://test.local', 'X-VBook-Action': 'metadata', 'Content-Type': 'application/json' },
    body: oversized,
  });
  assert.equal(limited.status, 413);

  const badAuthorization = `Basic ${Buffer.from(`${name}:wrong-password`).toString('base64')}`;
  for (let attempt = 1; attempt <= 7; attempt++) {
    const response = await mf.dispatchFetch('https://test.local/', { headers: { Authorization: badAuthorization, 'CF-Connecting-IP': '203.0.113.9' } });
    assert.equal(response.status, 401);
  }
  const locked = await mf.dispatchFetch('https://test.local/', { headers: { Authorization: badAuthorization, 'CF-Connecting-IP': '203.0.113.9' } });
  assert.equal(locked.status, 429);
  assert.equal(locked.headers.get('Retry-After'), '900');
  const validButLocked = await mf.dispatchFetch('https://test.local/', { headers: { Authorization: authorization, 'CF-Connecting-IP': '203.0.113.9' } });
  assert.equal(validButLocked.status, 429);
});

test('JSON inventory is authenticated, scoped to the user and never cached', async () => {
  const alice = await user('inventory_a'), bob = await user('inventory_b');
  await bucket.put(`${alice}/a&b.json`, 'data');
  await bucket.put(`${bob}/private.json`, 'private');
  const response = await request(alice, '/', 'GET', undefined, { Accept: 'application/json' });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('Cache-Control'), 'private, no-store');
  assert.equal(response.headers.get('Vary'), 'Accept');
  const data = await response.json();
  assert.deepEqual(data.files.map(file => file.name), ['a&b.json']);
  assert.equal(data.usageBytes, 4);
  assert.equal(data.quotaBytes, 1024 * 1024);
  assert.ok(!JSON.stringify(data).includes('password'));
  const unauthorized = await mf.dispatchFetch('https://test.local/', { headers: { Accept: 'application/json' } });
  assert.equal(unauthorized.status, 401);
});

test('Google Drive WebDAV is opt-in, read-only and protects configuration mutations', async () => {
  const name = await user('drive_webdav');
  const authorization = `Basic ${Buffer.from(`${name}:${password}`).toString('base64')}`;
  const root = 'https://test.local/drive-webdav/';
  assert.equal((await mf.dispatchFetch(root, { method: 'PROPFIND', headers: { Authorization: authorization, Depth: '1' } })).status, 404);
  assert.equal((await mf.dispatchFetch(root, { method: 'PUT', headers: { Authorization: authorization, 'Content-Length': '1' }, body: 'x' })).status, 404);

  const status = await mf.dispatchFetch('https://test.local/api/drive', { headers: { Authorization: authorization } });
  assert.equal(status.status, 200);
  assert.deepEqual(await status.json(), { configured: false, available: true, hasApiKey: false, url: root });

  const invalid = await mf.dispatchFetch('https://test.local/api/drive', {
    method: 'PUT', headers: { Authorization: authorization, Origin: 'https://test.local', 'X-VBook-Action': 'drive', 'Content-Type': 'application/json' },
    body: JSON.stringify({ url: 'https://evil.example/drive/folders/1234567890' }),
  });
  assert.equal(invalid.status, 400);
  const crossSite = await mf.dispatchFetch('https://test.local/api/drive', {
    method: 'DELETE', headers: { Authorization: authorization, Origin: 'https://evil.example', 'X-VBook-Action': 'drive' },
  });
  assert.equal(crossSite.status, 403);

  const actionHeaders = { Authorization: authorization, Origin: 'https://test.local', 'X-VBook-Action': 'drive', 'Content-Type': 'application/json' };
  const connected = await mf.dispatchFetch('https://test.local/api/drive', {
    method: 'PUT', headers: actionHeaders, body: JSON.stringify({ url: `https://drive.google.com/drive/folders/${driveRootId}`, apiKey: 'test-drive-key-user-123456' }),
  });
  assert.equal(connected.status, 200);
  assert.deepEqual(await connected.json(), { configured: true, url: root });

  const privateConfig = await (await mf.getDurableObjectNamespace('USER_STORAGE')).get((await mf.getDurableObjectNamespace('USER_STORAGE')).idFromName(`user:${name}`)).fetch('https://internal/drive-get', { headers: { 'X-Storage-User': name } });
  const encrypted = await privateConfig.json();
  assert.ok(encrypted.encryptedKey.startsWith('v1.'));
  assert.ok(!JSON.stringify(encrypted).includes('test-drive-key-user-123456'));
  const publicStatus = await (await mf.dispatchFetch('https://test.local/api/drive', { headers: { Authorization: authorization } })).text();
  assert.ok(!publicStatus.includes(encrypted.encryptedKey));
  const other = await user('drive_other');
  assert.equal((await request(other, '/drive-webdav/', 'PROPFIND')).status, 404);
  const otherAuth = `Basic ${Buffer.from(`${other}:${password}`).toString('base64')}`;
  const otherHeaders = { ...actionHeaders, Authorization: otherAuth };
  const ns = await mf.getDurableObjectNamespace('USER_STORAGE');
  const otherStub = ns.get(ns.idFromName(`user:${other}`));
  await otherStub.fetch('https://internal/drive-set', { method: 'POST', headers: { 'X-Storage-User': other }, body: JSON.stringify(encrypted) });
  assert.equal((await request(other, '/drive-webdav/', 'PROPFIND')).status, 503, 'ciphertext cannot move to another user');
  assert.equal((await mf.dispatchFetch('https://test.local/api/drive', { method: 'PUT', headers: otherHeaders, body: JSON.stringify({ url: driveRootId, apiKey: 'second-drive-key-user-123456' }) })).status, 200);
  assert.equal((await request(other, '/drive-webdav/', 'PROPFIND')).status, 207);

  assert.equal((await mf.dispatchFetch('https://test.local/api/drive', { method: 'PUT', headers: actionHeaders, body: JSON.stringify({ url: `https://drive.google.com/drive/folders/${driveRootId}` }) })).status, 200, 'blank key preserves own key');

  const propfind = await mf.dispatchFetch(root, { method: 'PROPFIND', headers: { Authorization: authorization, Depth: '1' } });
  assert.equal(propfind.status, 207);
  const xml = await propfind.text();
  assert.match(xml, /Ti%C3%AAn%20Hi%E1%BB%87p\//);
  assert.match(xml, /S%C3%A1ch%20%26%20truy%E1%BB%87n\.epub/);
  assert.doesNotMatch(xml, /ROOT_FOLDER|BOOK_FILE|test-drive-key/);

  // vBook can join the server and root-folder fields without a trailing slash.
  for (const path of ['/drive-webdav', '/drive-webdav/', '/drive-webdav/' + encodeURIComponent('Tiên Hiệp'), '/drive-webdav/' + encodeURIComponent('Tiên Hiệp') + '/']) {
    for (const depth of ['0', '1']) {
      const response = await request(name, path, 'PROPFIND', undefined, { Depth: depth });
      assert.equal(response.status, 207);
      const hrefs = [...(await response.text()).matchAll(/<D:href>([^<]+)<\/D:href>/g)].map(match => match[1]);
      assert.equal(hrefs[0], path, 'self href matches the requested collection exactly');
      assert.equal(hrefs.filter(href => href === path).length, 1);
      assert.equal(new Set(hrefs).size, hrefs.length);
      const children = hrefs.filter(href => href !== path);
      assert.equal(children.length, depth === '0' ? 0 : path.includes('%') ? 1 : 2);
      assert.ok(children.every(href => href.startsWith(path.replace(/\/$/, '') + '/')));
      assert.equal(response.headers.get('Content-Location'), path.replace(/\/$/, '') + '/');
    }
  }

  const nested = await mf.dispatchFetch(root + encodeURIComponent('Tiên Hiệp') + '/', { method: 'PROPFIND', headers: { Authorization: authorization, Depth: '1' } });
  assert.equal(nested.status, 207);
  assert.match(await nested.text(), /T%E1%BA%ADp%201\.pdf/);

  const download = await mf.dispatchFetch(root + encodeURIComponent('Sách & truyện.epub'), { headers: { Authorization: authorization }, redirect: 'manual' });
  assert.equal(download.status, 302);
  assert.equal(download.headers.get('location'), 'https://drive.google.com/uc?export=download&id=BOOK_FILE_12345&confirm=t');
  assert.equal((await mf.dispatchFetch(root + 'new.epub', { method: 'PUT', headers: { Authorization: authorization, 'Content-Length': '1' }, body: 'x' })).status, 405);

  assert.equal((await mf.dispatchFetch('https://test.local/api/drive', { method: 'DELETE', headers: actionHeaders })).status, 204);
  assert.equal((await mf.dispatchFetch(root, { method: 'PROPFIND', headers: { Authorization: authorization } })).status, 404);
  assert.equal((await request(other, '/drive-webdav/', 'PROPFIND')).status, 207, 'disconnecting one user leaves the other connected');
});

test('read-only WebDAV shares are scoped, revocable and use independent credentials', async () => {
  const name = await user('share_owner');
  await bucket.put(`${name}/library/Fantasy/Sách & truyện.epub`, 'book-data');
  await bucket.put(`${name}/library-private/secret.epub`, 'secret');
  await bucket.put(`${name}/backup-history/old.zip`, 'history');
  const ownerAuth = `Basic ${Buffer.from(`${name}:${password}`).toString('base64')}`;
  const actionHeaders = { Authorization: ownerAuth, Origin: 'https://test.local', 'X-VBook-Action': 'shares', 'Content-Type': 'application/json' };
  const created = await mf.dispatchFetch('https://test.local/api/shares', {
    method: 'POST', headers: actionHeaders, body: JSON.stringify({ label: 'Gia đình', prefix: 'library/Fantasy/' }),
  });
  assert.equal(created.status, 201);
  const payload = await created.json();
  assert.equal(payload.connection.username, 'reader');
  assert.ok(payload.connection.password.length >= 40);
  const sharedAuth = `Basic ${Buffer.from(`reader:${payload.connection.password}`).toString('base64')}`;
  const root = payload.connection.url;

  const propfind = await mf.dispatchFetch(root, { method: 'PROPFIND', headers: { Authorization: sharedAuth, Depth: '1' } });
  assert.equal(propfind.status, 207);
  const xml = await propfind.text();
  assert.match(xml, /S%C3%A1ch%20%26%20truy%E1%BB%87n\.epub/);
  assert.doesNotMatch(xml, /secret|backup-history/);

  const download = await mf.dispatchFetch(root + encodeURIComponent('Sách & truyện.epub'), { headers: { Authorization: sharedAuth } });
  assert.equal(download.status, 200);
  assert.equal(download.headers.get('Content-Type'), 'application/octet-stream');
  assert.equal(await download.text(), 'book-data');
  assert.equal((await mf.dispatchFetch(root + 'new.epub', { method: 'PUT', headers: { Authorization: sharedAuth, 'Content-Length': '1' }, body: 'x' })).status, 405);
  assert.equal((await mf.dispatchFetch(root, { method: 'DELETE', headers: { Authorization: sharedAuth } })).status, 405);
  assert.equal((await mf.dispatchFetch(root, { method: 'PROPFIND', headers: { Authorization: 'Basic ' + Buffer.from('reader:wrong').toString('base64') } })).status, 401);

  const list = await mf.dispatchFetch('https://test.local/api/shares', { headers: { Authorization: ownerAuth } });
  assert.equal(list.status, 200);
  const listed = await list.json();
  assert.equal(listed.shares.length, 1);
  assert.equal(Object.hasOwn(listed.shares[0], 'secret_hash'), false);

  const id = listed.shares[0].id;
  const rotated = await mf.dispatchFetch(`https://test.local/api/shares/${id}/rotate`, { method: 'POST', headers: actionHeaders });
  assert.equal(rotated.status, 200);
  const next = await rotated.json();
  assert.equal((await mf.dispatchFetch(root, { method: 'PROPFIND', headers: { Authorization: sharedAuth } })).status, 401);
  const nextAuth = `Basic ${Buffer.from(`reader:${next.connection.password}`).toString('base64')}`;
  assert.equal((await mf.dispatchFetch(root, { method: 'PROPFIND', headers: { Authorization: nextAuth } })).status, 207);

  const revoked = await mf.dispatchFetch(`https://test.local/api/shares/${id}`, { method: 'DELETE', headers: actionHeaders });
  assert.equal(revoked.status, 204);
  assert.equal((await mf.dispatchFetch(root, { method: 'PROPFIND', headers: { Authorization: nextAuth } })).status, 401);
});

test('share creation rejects cross-site mutations and paths outside library', async () => {
  const name = await user('share_csrf');
  const authorization = `Basic ${Buffer.from(`${name}:${password}`).toString('base64')}`;
  const create = (prefix, headers = {}) => mf.dispatchFetch('https://test.local/api/shares', {
    method: 'POST', headers: { Authorization: authorization, 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify({ label: 'Test', prefix }),
  });
  assert.equal((await create('library/', { Origin: 'https://evil.example', 'X-VBook-Action': 'shares' })).status, 403);
  assert.equal((await create('library/')).status, 403);
  assert.equal((await create('backup-history/', { Origin: 'https://test.local', 'X-VBook-Action': 'shares' })).status, 400);
  assert.equal((await create('library/../backup-history/', { Origin: 'https://test.local', 'X-VBook-Action': 'shares' })).status, 400);
});

test('book metadata overrides are validated, tenant-scoped and removed with the file', async () => {
  const name = await user('metadata_owner');
  await bucket.put(`${name}/library/book.epub`, 'book');
  const authorization = `Basic ${Buffer.from(`${name}:${password}`).toString('base64')}`;
  const headers = { Authorization: authorization, Origin: 'https://test.local', 'X-VBook-Action': 'metadata', 'Content-Type': 'application/json' };
  const metadata = { title: 'Tên hiển thị', author: 'Tác giả', language: 'vi', category: 'Tiên hiệp', description: 'Mô tả', coverUrl: 'https://images.example/cover.jpg' };
  const saved = await mf.dispatchFetch('https://test.local/api/metadata', {
    method: 'PUT', headers, body: JSON.stringify({ path: 'library/book.epub', metadata }),
  });
  assert.equal(saved.status, 200);
  assert.deepEqual((await saved.json()).metadata, metadata);

  const inventory = await mf.dispatchFetch('https://test.local/', { headers: { Authorization: authorization, Accept: 'application/json' } });
  assert.equal(inventory.status, 200);
  assert.deepEqual((await inventory.json()).files[0].metadata, metadata);
  const html = await (await mf.dispatchFetch('https://test.local/', { headers: { Authorization: authorization, Accept: 'text/html' } })).text();
  assert.match(html, /Tên hiển thị/);
  assert.match(html, /Tác giả/);

  const invalidLanguage = await mf.dispatchFetch('https://test.local/api/metadata', {
    method: 'PUT', headers, body: JSON.stringify({ path: 'library/book.epub', metadata: { language: 'not a language' } }),
  });
  assert.equal(invalidLanguage.status, 400);
  const invalidCover = await mf.dispatchFetch('https://test.local/api/metadata', {
    method: 'PUT', headers, body: JSON.stringify({ path: 'library/book.epub', metadata: { coverUrl: 'http://unsafe.example/cover.jpg' } }),
  });
  assert.equal(invalidCover.status, 400);
  assert.equal((await mf.dispatchFetch('https://test.local/api/metadata', {
    method: 'PUT', headers, body: JSON.stringify({ path: 'backup-history/private.zip', metadata: { title: 'No' } }),
  })).status, 400);

  assert.equal((await request(name, '/library/book.epub', 'DELETE')).status, 204);
  const records = await mf.dispatchFetch('https://test.local/api/metadata', { headers: { Authorization: authorization } });
  assert.deepEqual((await records.json()).records, []);
});


test('admin cannot reveal passwords and resetting an account disconnects Drive', async () => {
  const name = await user('vault_user');
  const login = await mf.dispatchFetch('https://test.local/admin/login', { method: 'POST', body: new URLSearchParams({ pin }), redirect: 'manual' });
  const session = login.headers.getSetCookie().find(v => v.startsWith('admin_session=') && !v.includes('Max-Age=0')).split(';')[0];
  const dashboard = await mf.dispatchFetch('https://test.local/admin', { headers: { Cookie: session } });
  const csrfCookie = dashboard.headers.getSetCookie().find(v => v.startsWith('csrf_token=')).split(';')[0];
  const csrf = decodeURIComponent(csrfCookie.slice('csrf_token='.length));
  const cookie = `${session}; ${csrfCookie}`;
  const post = (path, body, Cookie = cookie) => mf.dispatchFetch(`https://test.local/admin/${path}`, { method: 'POST', headers: { Cookie }, body: new URLSearchParams(body), redirect: 'manual' });
  assert.equal((await post('password', { username: name, _csrf: csrf }, '')).status, 302);
  assert.equal((await post('password', { username: name })).status, 403);
  assert.equal((await post('password', { username: name, _csrf: csrf })).status, 403);
  const ns = await mf.getDurableObjectNamespace('USER_STORAGE');
  const stub = ns.get(ns.idFromName(`user:${name}`));
  await stub.fetch('https://internal/drive-set', { method: 'POST', headers: { 'X-Storage-User': name }, body: JSON.stringify({ folderId: driveRootId, encryptedKey: 'encrypted-test-record' }) });
  const update = pass => post('user', { username: name, password: pass, _csrf: csrf, _mode: 'edit', quota_mb: '20', max_file_size_mb: '10', status: 'active' });
  const secret = 'private-test-<>&-mật-khẩu';
  assert.equal((await update(secret)).status, 302);
  const stored = await kv.get(`user:${name}`);
  assert.ok(!stored.includes(secret));
  assert.equal(JSON.parse(stored).password_encrypted, undefined);
  assert.equal((await post('password', { username: name, _csrf: csrf })).status, 403);
  assert.equal(await (await stub.fetch('https://internal/drive-get', { headers: { 'X-Storage-User': name } })).json(), null);
  const page = await mf.dispatchFetch('https://test.local/admin', { headers: { Cookie: cookie } });
  assert.doesNotMatch(await page.text(), /viewPassword|encrypted-test-record/);

});


test('dated history preserves old content, stays user-scoped and supports manual deletion', async () => {
  const name = await user('dated_backup');
  assert.equal((await request(name, '/folder/backup.zip', 'PUT', 'old backup')).status, 201);
  assert.equal((await request(name, '/folder/backup.zip', 'PUT', 'new backup')).status, 201);
  const history = (await bucket.list({ prefix: `${name}/backup-history/` })).objects;
  assert.equal(history.length, 1);
  assert.match(history[0].key, /backup-history\/\d{4}-\d{2}-\d{2}_\d{2}-\d{2}-\d{2}.*UTC\+7.*\/folder\/backup.zip$/);
  assert.equal(await (await bucket.get(history[0].key)).text(), 'old backup');
  assert.equal(await (await request(name, '/folder/backup.zip')).text(), 'new backup');
  assert.equal(await usage(name), 20);
  const path = '/' + history[0].key.slice(name.length + 1);
  assert.equal((await request(name, path, 'PUT', 'overwrite')).status, 403);
  const other = await user('dated_other');
  assert.equal((await request(other, path)).status, 404);
  assert.equal((await request(name, path, 'DELETE')).status, 204);
  assert.equal(await usage(name), 10);
  assert.equal(await (await request(name, '/folder/backup.zip')).text(), 'new backup');
});

test('history quota rejects overwrite without losing current file', async () => {
  const name = await user('history_quota');
  assert.equal((await request(name, '/backup', 'PUT', new Uint8Array(700000))).status, 201);
  assert.equal((await request(name, '/backup', 'PUT', new Uint8Array(700000))).status, 507);
  assert.equal((await bucket.head(`${name}/backup`)).size, 700000);
  assert.equal((await bucket.list({ prefix: `${name}/backup-history/` })).objects.length, 0);
});

test('VBook repeated MKCOL and directory HEAD work with either trailing slash and mounts', async () => {
  const name = await user('vbook_mkcol');
  for (const path of ['/', '/webdav', '/webdav/', '/vbook-backup', '/vbook-backup/', '/webdav/vbook-backup', '/webdav/vbook-backup/']) {
    assert.equal((await request(name, path, 'MKCOL')).status, 201, path);
    assert.equal((await request(name, path, 'HEAD')).status, 200, path);
    assert.equal((await request(name, path, 'PROPFIND', undefined, { Depth: '0' })).status, 207, path);
  }
  assert.equal((await request(name, '/vbook-backup/file.zip', 'PUT', 'backup')).status, 201);
  assert.equal((await request(name, '/vbook-backup', 'MKCOL')).status, 201);
  assert.equal(await (await request(name, '/vbook-backup/file.zip')).text(), 'backup');
  await request(name, '/implicit/backup.zip', 'PUT', 'data');
  assert.equal((await request(name, '/implicit', 'HEAD')).status, 200);
  assert.equal((await request(name, '/implicit/', 'HEAD')).status, 200);
  assert.equal((await request(name, '/implicit', 'MKCOL')).status, 201);
  for (const path of ['/implicit/backup.zip', '/implicit/backup.zip/']) {
    assert.equal((await request(name, path, 'MKCOL')).status, 405);
  }
  assert.equal((await request(name, '/missing', 'HEAD')).status, 404);
  assert.equal((await request(name, '/vbook-backup-other', 'HEAD')).status, 404);
  const other = await user('vbook_mkcol_other');
  assert.equal((await request(other, '/vbook-backup', 'HEAD')).status, 404);
});

test('decimal MB admin limits are exact and legacy limits survive a form save', async () => {
  const name = await user('decimal_units', 500, 50);
  const login = await mf.dispatchFetch('https://test.local/admin/login', { method: 'POST', body: new URLSearchParams({ pin }), redirect: 'manual' });
  const session = login.headers.getSetCookie().find(v => v.startsWith('admin_session=') && !v.includes('Max-Age=0')).split(';')[0];
  const dashboard = await mf.dispatchFetch('https://test.local/admin', { headers: { Cookie: session } });
  const csrfCookie = dashboard.headers.getSetCookie().find(v => v.startsWith('csrf_token=')).split(';')[0];
  const csrf = decodeURIComponent(csrfCookie.slice('csrf_token='.length));
  const cookie = `${session}; ${csrfCookie}`;
  const update = (quota, max) => mf.dispatchFetch('https://test.local/admin/user', { method: 'POST', headers: { Cookie: cookie }, body: new URLSearchParams({ username: name, _csrf: csrf, _mode: 'edit', size_unit: 'decimal_mb', quota_mb: quota, max_file_size_mb: max }), redirect: 'manual' });
  assert.equal((await update('524.288', '52.4288')).status, 302);
  let record = JSON.parse(await kv.get('user:' + name));
  assert.equal(record.quota_mb, 500);
  assert.equal(record.max_file_size_mb, 50);
  await update('100', '1');
  record = JSON.parse(await kv.get('user:' + name));
  assert.equal(record.quota_mb * 1048576, 100000000);
  assert.equal(record.max_file_size_mb * 1048576, 1000000);
  assert.equal((await request(name, '/exact', 'PUT', new Uint8Array(1000000))).status, 201);
  assert.equal((await request(name, '/too-large', 'PUT', new Uint8Array(1000001))).status, 413);
});
