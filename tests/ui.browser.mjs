import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pbkdf2Sync } from 'node:crypto';
import { build } from 'esbuild';
import { Miniflare, Log, LogLevel } from 'miniflare';
import { chromium } from 'playwright';

let directory, mf, browser, baseURL, kv, bucket, counter = 0;
const password = 'ui-test-only-password';
const defaultFiles = [
  { name: 'vbook_backup/Truyện đã lưu.json', size: 16384 },
  { name: 'vbook_backup/backup-2026-09-05.zip', size: 1024 * 500 },
  { name: 'legado/bookSource.json', size: 2048 },
  { name: 'Ghi chú & dấu trang.txt', size: 128 },
];
const encodePath = value => value.split('/').map(encodeURIComponent).join('/');
before(async () => {
  directory = await mkdtemp(join(tmpdir(), 'vbook-ui-tests-'));
  const scriptPath = join(directory, 'worker.mjs');
  await build({ entryPoints: ['src/index.ts'], bundle: true, format: 'esm', platform: 'browser', outfile: scriptPath });
  mf = new Miniflare({
    modules: true, scriptPath, modulesRoot: directory, compatibilityDate: '2026-05-20',
    bindings: { ADMIN_PIN: 'ui-test-only-admin' },
    kvNamespaces: ['USER_KV'], r2Buckets: ['STORAGE_R2'],
    durableObjects: { USER_STORAGE: { className: 'UserStorage', useSQLite: true } },
    log: new Log(LogLevel.ERROR),
  });
  baseURL = (await mf.ready).origin;
  kv = await mf.getKVNamespace('USER_KV');
  bucket = await mf.getR2Bucket('STORAGE_R2');
  const systemChrome = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
  browser = await chromium.launch({ headless: true, executablePath: process.env.VBOOK_TEST_CHROME || (existsSync(systemChrome) ? systemChrome : undefined) });
});
after(async () => {
  await browser?.close();
  await mf?.dispose();
  if (directory) await rm(directory, { recursive: true, force: true });
});
async function openDrive(t, { files = defaultFiles, width = 1280, height = 900 } = {}) {
  const username = 'ui_demo_' + ++counter;
  const salt = '11'.repeat(16);
  await kv.put('user:' + username, JSON.stringify({
    password_hash: pbkdf2Sync(password, salt, 1000, 32, 'sha256').toString('base64'), salt,
    quota_mb: 500, max_file_size_mb: 50, status: 'active',
  }));
  for (const file of files) await bucket.put(username + '/' + file.name, new Uint8Array(file.size));
  const context = await browser.newContext({ httpCredentials: { username, password }, viewport: { width, height } });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  t.after(async () => { await context.close(); assert.deepEqual(errors, [], 'Browser script errors'); });
  await page.goto(baseURL, { waitUntil: 'networkidle' });
  await page.getByRole('heading', { name: 'Tệp của tôi', exact: true }).waitFor();
  return { page, username, context };
}
async function confirmDelete(page, filename) {
  await page.getByRole('button', { name: 'Xóa ' + filename, exact: true }).click();
  await page.getByRole('dialog').waitFor();
  await page.getByRole('button', { name: 'Xóa tệp', exact: true }).click();
}
async function waitText(page, id, text) {
  await page.waitForFunction(({ id, text }) => document.getElementById(id)?.textContent.includes(text), { id, text }, { timeout: 12000 });
}

// No production URL or credentials are used by these tests.
test('desktop: search, sort, confirmation and empty state; 204 updates without navigating', { timeout: 20000 }, async t => {
  const { page } = await openDrive(t);
  await page.screenshot({ path: '/tmp/vbook-drive-desktop.png', fullPage: true });
  await page.getByRole('searchbox').fill('truyen');
  assert.equal(await page.locator('[data-file]:visible').count(), 1);
  await page.getByRole('searchbox').fill('does-not-exist');
  await page.getByRole('heading', { name: 'Không tìm thấy tệp phù hợp' }).waitFor();
  await page.getByRole('button', { name: 'Xóa bộ lọc' }).click();
  await page.getByLabel('Sắp xếp tệp').selectOption('largest');
  assert.equal(await page.locator('[data-file]').first().getAttribute('data-size'), '512000');
  await page.getByRole('button', { name: 'Xóa Ghi chú & dấu trang.txt', exact: true }).click();
  await page.getByRole('button', { name: 'Giữ lại' }).click();
  assert.equal(await page.locator('[data-file]').count(), 4);
  let navigations = 0;
  page.on('framenavigated', frame => { if (frame === page.mainFrame()) navigations++; });
  await confirmDelete(page, 'Ghi chú & dấu trang.txt');
  await waitText(page, 'toast-message', 'Đã xóa');
  await waitText(page, 'sync-note', 'Vừa cập nhật');
  assert.equal(await page.locator('[data-file]').count(), 3);
  assert.equal(await page.locator('#total-files').textContent(), '3');
  assert.equal(navigations, 0);
});

for (const failure of ['http500', 'network']) {
  test('deleted file is reported as success after ' + failure + ' response', { timeout: 20000 }, async t => {
    const { page, username } = await openDrive(t, { files: [{ name: 'a#b & c.json', size: 20 }] });
    const url = baseURL + '/webdav/' + encodePath('a#b & c.json');
    let heads = 0;
    await page.route(url, async route => {
      if (route.request().method() === 'DELETE') {
        const actual = await route.fetch();
        assert.equal(actual.status(), 204);
        if (failure === 'http500') await route.fulfill({ status: 500, body: 'Old server response error' });
        else await route.abort('failed');
      } else { if (route.request().method() === 'HEAD') heads++; await route.continue(); }
    });
    await confirmDelete(page, 'a#b & c.json');
    await waitText(page, 'toast-message', 'Đã xóa');
    await waitText(page, 'sync-note', 'Vừa cập nhật');
    assert.ok(heads >= 1);
    assert.equal(await bucket.head(username + '/a#b & c.json'), null);
    assert.equal(await page.locator('[data-file]').count(), 0);
    assert.equal(await page.locator('#total-files').textContent(), '0');
    await page.getByRole('heading', { name: 'Kho lưu trữ đang trống' }).waitFor();
  });
}

test('real 500 failure keeps the existing file and allows retry', { timeout: 20000 }, async t => {
  const { page } = await openDrive(t, { files: [{ name: 'keep.json', size: 20 }] });
  await page.route('**/webdav/keep.json', route => route.request().method() === 'DELETE' ? route.fulfill({ status: 500, body: 'R2 unavailable' }) : route.continue());
  await confirmDelete(page, 'keep.json');
  await waitText(page, 'toast-message', 'Tệp vẫn còn');
  assert.equal(await page.locator('[data-file]').count(), 1);
  assert.equal(await page.getByRole('button', { name: 'Xóa keep.json', exact: true }).isEnabled(), true);
  assert.equal(await page.locator('#toast').getAttribute('data-type'), 'error');
});

test('pending deletion verifies without sending another DELETE', { timeout: 20000 }, async t => {
  const { page, username } = await openDrive(t, { files: [{ name: 'pending.json', size: 20 }] });
  let deletes = 0;
  await page.route('**/webdav/pending.json', async route => {
    if (route.request().method() === 'DELETE') { deletes++; await route.fulfill({ status: 503, headers: { 'Retry-After': '30' }, body: 'Pending' }); }
    else await route.continue();
  });
  await confirmDelete(page, 'pending.json');
  await page.getByRole('button', { name: 'Kiểm tra lại pending.json' }).waitFor();
  assert.equal(await page.locator('#toast').getAttribute('data-type'), 'pending');
  const actual = await mf.dispatchFetch(baseURL + '/webdav/pending.json', { method: 'DELETE', headers: { Authorization: 'Basic ' + Buffer.from(username + ':' + password).toString('base64') } });
  assert.equal(actual.status, 204);
  await page.getByRole('button', { name: 'Kiểm tra lại pending.json' }).click();
  await waitText(page, 'toast-message', 'Đã xóa');
  await waitText(page, 'sync-note', 'Vừa cập nhật');
  assert.equal(deletes, 1);
  assert.equal(await page.locator('[data-file]').count(), 0);
});

test('permission errors do not pretend the file was deleted', { timeout: 20000 }, async t => {
  const { page } = await openDrive(t, { files: [{ name: 'private.json', size: 20 }] });
  let heads = 0;
  await page.route('**/webdav/private.json', async route => {
    if (route.request().method() === 'DELETE') await route.fulfill({ status: 403, body: 'Forbidden' });
    else { heads++; await route.continue(); }
  });
  await confirmDelete(page, 'private.json');
  await waitText(page, 'toast-message', 'Không có quyền');
  assert.equal(await page.locator('[data-file]').count(), 1);
  assert.equal(heads, 0);
});

test('delete button is disabled while the request is in flight', { timeout: 20000 }, async t => {
  const { page } = await openDrive(t, { files: [{ name: 'slow.json', size: 20 }] });
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  t.after(() => release());
  let count = 0;
  await page.route('**/webdav/slow.json', async route => {
    if (route.request().method() === 'DELETE') { count++; await gate; }
    await route.continue();
  });
  await confirmDelete(page, 'slow.json');
  await page.waitForFunction(() => document.querySelector('.delete-file').disabled);
  assert.equal(await page.getByRole('button', { name: 'Làm mới', exact: true }).isDisabled(), true);
  release();
  await waitText(page, 'toast-message', 'Đã xóa');
  assert.equal(count, 1);
});

test('mobile layout fits, keyboard can cancel, and names remain escaped on refresh', { timeout: 20000 }, async t => {
  const filename = '<img src=x onerror=alert(1)> & "quote".json';
  const { page } = await openDrive(t, { width: 390, height: 844, files: [...defaultFiles, { name: filename, size: 12 }] });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  assert.equal(await page.locator('.file-name img').count(), 0);
  await page.getByRole('searchbox').fill('quote');
  await page.getByRole('button', { name: 'Làm mới', exact: true }).click();
  await waitText(page, 'sync-note', 'Vừa cập nhật');
  assert.equal(await page.locator('[data-file]:visible').count(), 1);
  assert.equal(await page.locator('.file-name img').count(), 0);
  assert.equal(await page.locator('[data-file]:visible .file-name').textContent(), filename);
  await page.getByRole('searchbox').fill('');
  await page.screenshot({ path: '/tmp/vbook-drive-mobile.png', fullPage: true });
  await page.getByRole('button', { name: 'Xóa Ghi chú & dấu trang.txt', exact: true }).click();
  await page.screenshot({ path: '/tmp/vbook-drive-delete-dialog.png', fullPage: true });
  await page.keyboard.press('Escape');
  assert.equal(await page.getByRole('dialog').isVisible(), false);
  assert.equal(await page.locator('[data-file]').count(), 5);
});

test('unavailable verification never reports success or removes a file', { timeout: 20000 }, async t => {
  const { page } = await openDrive(t, { files: [{ name: 'uncertain.json', size: 20 }] });
  await page.route('**/webdav/uncertain.json', route => route.fulfill({ status: 500, body: 'Unavailable' }));
  await confirmDelete(page, 'uncertain.json');
  await page.getByRole('button', { name: 'Kiểm tra lại uncertain.json' }).waitFor();
  assert.equal(await page.locator('[data-file]').count(), 1);
  assert.equal(await page.locator('#toast').getAttribute('data-type'), 'pending');
  assert.ok(!(await page.locator('#toast-message').textContent()).includes('Đã xóa'));
  await page.getByRole('button', { name: 'Làm mới', exact: true }).click();
  await waitText(page, 'sync-note', 'Vừa cập nhật');
  assert.equal(await page.getByRole('button', { name: 'Kiểm tra lại uncertain.json' }).isVisible(), true);
});

test('clean mobile preview has a visible brand and no horizontal overflow', async t => {
  const { page } = await openDrive(t, { width: 390, height: 844 });
  assert.equal(await page.locator('.brand').innerText(), 'VBook');
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  await page.screenshot({ path: '/tmp/vbook-drive-mobile.png', fullPage: true });
  await page.getByRole('button', { name: 'Xóa Ghi chú & dấu trang.txt', exact: true }).click();
  await page.screenshot({ path: '/tmp/vbook-drive-delete-dialog.png' });
});

test('admin password dialog fits mobile, renders safely and returns focus when closed', { timeout: 20000 }, async t => {
  const name = 'ui_admin_preview';
  await kv.put('user:' + name, JSON.stringify({ password_hash: 'test-only', quota_mb: 500, max_file_size_mb: 95, status: 'active' }));
  const login = await mf.dispatchFetch('https://test.local/admin/login', { method: 'POST', body: new URLSearchParams({ pin: 'ui-test-only-admin' }), redirect: 'manual' });
  const session = login.headers.getSetCookie().find(v => v.startsWith('admin_session=') && !v.includes('Max-Age=0')).split(';')[0];
  const response = await mf.dispatchFetch('https://test.local/admin', { headers: { Cookie: session } });
  const html = await response.text();
  const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
  t.after(() => context.close());
  const page = await context.newPage();
  await page.route('https://cdn.tailwindcss.com/**', route => route.fulfill({ contentType: 'text/javascript', body: 'window.tailwind = {};' }));
  await page.route('**/admin', route => route.fulfill({ contentType: 'text/html', body: html }));
  await page.route('**/admin/password', route => route.fulfill({ json: { password: 'demo-only-<safe>&123' } }));
  await page.goto(baseURL + '/admin');
  const button = page.locator('[data-username="' + name + '"]');
  await button.click();
  const dialog = page.getByRole('dialog');
  await dialog.waitFor();
  assert.equal(await page.getByLabel('Mật khẩu', { exact: true }).inputValue(), 'demo-only-<safe>&123');
  const bounds = await dialog.boundingBox();
  assert.ok(bounds.x >= 0 && bounds.x + bounds.width <= 390);
  assert.equal(await dialog.evaluate(el => getComputedStyle(el).padding), '28px');
  await page.screenshot({ path: '/tmp/vbook-admin-dialog-mobile.png' });
  await page.getByRole('button', { name: 'Đóng', exact: true }).click();
  await page.locator('.password-dialog').waitFor({ state: 'detached' });
  assert.equal(await page.locator('.password-dialog').count(), 0);
  assert.equal(await button.evaluate(el => document.activeElement === el), true);
  const actions = page.locator('#row-' + name + ' .user-actions');
  const boxes = await actions.locator('button').evaluateAll(nodes => nodes.map(el => ({ height: el.getBoundingClientRect().height, whiteSpace: getComputedStyle(el).whiteSpace })));
  assert.equal(boxes.length, 4);
  assert.ok(boxes.every(box => box.height === boxes[0].height && box.whiteSpace === 'nowrap'));
  await page.setViewportSize({ width: 1280, height: 900 });
  await button.click();
  await page.getByRole('dialog').screenshot({ path: '/tmp/vbook-admin-dialog-desktop.png' });
});
