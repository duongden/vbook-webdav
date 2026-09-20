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

test('browser upload stores a library file through the quota-aware PUT path', { timeout: 20000 }, async t => {
  const { page, username } = await openDrive(t, { files: [] });
  await page.getByRole('button', { name: 'Tải tệp lên', exact: true }).click();
  await page.getByRole('dialog').screenshot({ path: '/tmp/vbook-upload-dialog.png' });
  await page.getByLabel('Thư mục đích').fill('library/Tiên Hiệp');
  await page.locator('#upload-files').setInputFiles({ name: 'Sách mới.epub', mimeType: 'application/epub+zip', buffer: Buffer.from('epub-data') });
  await page.getByRole('button', { name: 'Tải lên', exact: true }).click();
  await waitText(page, 'upload-status', 'Đã tải lên 1 tệp');
  await waitText(page, 'toast-message', 'Đã tải tệp lên thư viện');
  assert.equal(await (await bucket.get(`${username}/library/Tiên Hiệp/Sách mới.epub`)).text(), 'epub-data');
  assert.equal(await page.locator('[data-file][data-name="library/Tiên Hiệp/Sách mới.epub"]').count(), 1);
});

test('drag and drop selects and uploads multiple library files', { timeout: 20000 }, async t => {
  const { page, username } = await openDrive(t, { files: [] });
  await page.getByRole('button', { name: 'Tải tệp lên', exact: true }).click();
  await page.getByLabel('Thư mục đích').fill('library/Kéo thả');
  await page.locator('#upload-drop-zone').evaluate(zone => {
    const transfer = new DataTransfer();
    transfer.items.add(new File(['first'], 'Một.epub', { type: 'application/epub+zip' }));
    transfer.items.add(new File(['second'], 'Hai.pdf', { type: 'application/pdf' }));
    zone.dispatchEvent(new DragEvent('dragenter', { bubbles: true, cancelable: true, dataTransfer: transfer }));
    zone.dispatchEvent(new DragEvent('dragover', { bubbles: true, cancelable: true, dataTransfer: transfer }));
    zone.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: transfer }));
  });
  await waitText(page, 'upload-selection', '2 tệp');
  await waitText(page, 'upload-status', 'Đã nhận 2 tệp');
  await page.getByRole('button', { name: 'Tải lên', exact: true }).click();
  await waitText(page, 'upload-status', 'Đã tải lên 2 tệp');
  assert.equal(await (await bucket.get(`${username}/library/Kéo thả/Một.epub`)).text(), 'first');
  assert.equal(await (await bucket.get(`${username}/library/Kéo thả/Hai.pdf`)).text(), 'second');
});

test('owner creates and revokes a read-only WebDAV connection from the UI', { timeout: 20000 }, async t => {
  const { page } = await openDrive(t, { files: [{ name: 'library/book.epub', size: 20 }] });
  await page.getByRole('button', { name: 'Chia sẻ', exact: true }).click();
  await page.getByLabel('Tên gợi nhớ').fill('Máy đọc sách');
  await page.getByRole('button', { name: 'Tạo kết nối', exact: true }).click();
  const connection = page.locator('#connection-dialog');
  await connection.waitFor();
  await connection.locator('input').evaluateAll(inputs => inputs.forEach(input => { input.blur(); input.scrollLeft = 0; }));
  await connection.screenshot({ path: '/tmp/vbook-share-connection.png' });
  await page.getByText('chỉ nhập kết nối này vào mục WebDAV', { exact: false }).waitFor();
  const url = await page.getByLabel('URL WebDAV', { exact: true }).inputValue();
  const sharedUser = await page.getByLabel('Username', { exact: true }).inputValue();
  const sharedPassword = await page.getByLabel('Password', { exact: true }).inputValue();
  const authorization = 'Basic ' + Buffer.from(`${sharedUser}:${sharedPassword}`).toString('base64');
  assert.equal((await mf.dispatchFetch(url, { method: 'PROPFIND', headers: { Authorization: authorization, Depth: '1' } })).status, 207);
  await page.getByRole('button', { name: 'Đã lưu', exact: true }).click();
  await page.getByRole('button', { name: 'Chia sẻ', exact: true }).click();
  await page.getByText('Máy đọc sách', { exact: true }).waitFor();
  page.once('dialog', dialog => dialog.accept());
  await page.getByRole('button', { name: 'Thu hồi', exact: true }).click();
  await waitText(page, 'toast-message', 'Đã thu hồi');
  assert.equal((await mf.dispatchFetch(url, { method: 'PROPFIND', headers: { Authorization: authorization } })).status, 401);
});

test('Google Drive dialog explains the independent read-only WebDAV connection', async t => {
  const { page } = await openDrive(t, { files: [] });
  await page.route('**/api/drive', route => route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({ configured: true, available: true, url: 'https://library.example/drive-webdav/' }),
  }));
  await page.getByRole('button', { name: 'Liên kết Google Drive', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Google Drive qua WebDAV' });
  await dialog.getByText('Đã liên kết một thư mục Google Drive.').waitFor();
  assert.equal(await page.getByLabel('URL WebDAV chỉ đọc').inputValue(), 'https://library.example/drive-webdav/');
  assert.equal(await page.getByLabel('Google Drive API key của bạn').getAttribute('type'), 'password');
  await dialog.getByText('Cách lấy Google Drive API key', { exact: true }).click();
  await dialog.getByText('Sao chép key vào ô phía trên.', { exact: false }).waitFor();
  await dialog.getByText('Cách lấy Google Drive API key', { exact: true }).click();
  await dialog.screenshot({ path: '/tmp/vbook-drive-dialog.png' });
});

test('user edits, reloads and restores book metadata', { timeout: 20000 }, async t => {
  const { page } = await openDrive(t, { files: [{ name: 'library/book.epub', size: 20 }] });
  await page.getByRole('button', { name: 'Sửa thông tin book.epub', exact: true }).click();
  await page.getByLabel('Tên hiển thị').fill('Truyện thử nghiệm');
  await page.getByLabel('Tác giả').fill('Tác giả mẫu');
  await page.getByLabel('Ngôn ngữ').fill('vi');
  await page.getByLabel('Thể loại').fill('Tiên hiệp');
  await page.getByLabel('Mô tả').fill('Mô tả dùng để kiểm tra tìm kiếm.');
  await page.locator('#metadata-dialog').screenshot({ path: '/tmp/vbook-metadata-dialog.png' });
  await page.getByRole('button', { name: 'Lưu thông tin', exact: true }).click();
  await waitText(page, 'toast-message', 'Đã lưu thông tin truyện');
  assert.equal(await page.locator('.file-name').textContent(), 'Truyện thử nghiệm');
  assert.equal(await page.locator('.file-author').textContent(), 'Tác giả mẫu');
  await page.getByRole('button', { name: 'Làm mới', exact: true }).click();
  await waitText(page, 'sync-note', 'Vừa cập nhật');
  assert.equal(await page.locator('.file-name').textContent(), 'Truyện thử nghiệm');
  await page.getByRole('searchbox').fill('tac gia mau');
  assert.equal(await page.locator('[data-file]:visible').count(), 1);
  await page.getByRole('searchbox').fill('');

  await page.getByRole('button', { name: 'Sửa thông tin book.epub', exact: true }).click();
  page.once('dialog', dialog => dialog.accept());
  await page.getByRole('button', { name: 'Khôi phục dữ liệu gốc', exact: true }).click();
  await waitText(page, 'toast-message', 'Đã khôi phục');
  assert.equal(await page.locator('.file-name').textContent(), 'book.epub');
  assert.equal(await page.locator('.file-author').isHidden(), true);
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
  const { page } = await openDrive(t, { width: 390, height: 844, files: [...defaultFiles, { name: filename, size: 12 }, { name: 'library/mobile.epub', size: 24 }] });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  const actionBoxes = await page.locator('[data-name="library/mobile.epub"] .file-action:visible').evaluateAll(nodes => nodes.map(node => {
    const box = node.getBoundingClientRect();
    return { width: box.width, height: box.height, text: node.textContent.trim(), label: node.getAttribute('aria-label') };
  }));
  assert.equal(actionBoxes.length, 3);
  assert.ok(actionBoxes.every(box => box.width === 42 && box.height === 42 && box.text === '' && box.label));
  assert.equal(await page.locator('.file-name img').count(), 0);
  await page.getByRole('searchbox').fill('quote');
  await page.getByRole('button', { name: 'Làm mới', exact: true }).click();
  await waitText(page, 'sync-note', 'Vừa cập nhật');
  assert.equal(await page.locator('[data-file]:visible').count(), 1);
  assert.equal(await page.locator('.file-name img').count(), 0);
  assert.equal(await page.locator('[data-file]:visible .file-name').textContent(), filename);
  await page.getByRole('searchbox').fill('');
  await page.screenshot({ path: '/tmp/vbook-drive-mobile-actions.png', fullPage: true });
  await page.getByRole('button', { name: 'Xóa Ghi chú & dấu trang.txt', exact: true }).click();
  await page.screenshot({ path: '/tmp/vbook-drive-delete-dialog.png', fullPage: true });
  await page.keyboard.press('Escape');
  assert.equal(await page.getByRole('dialog').isVisible(), false);
  assert.equal(await page.locator('[data-file]').count(), 6);
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
  const { page } = await openDrive(t, { width: 390, height: 844, files: [...defaultFiles, { name: 'library/Sách mẫu.epub', size: 24_000 }] });
  assert.equal(await page.locator('.brand').innerText(), 'VBook');
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  await page.screenshot({ path: '/tmp/vbook-drive-mobile.png', fullPage: true });
  await page.getByRole('button', { name: 'Xóa Ghi chú & dấu trang.txt', exact: true }).click();
  await page.screenshot({ path: '/tmp/vbook-drive-delete-dialog.png' });
});

test('admin manages accounts without password or content controls on mobile', { timeout: 20000 }, async t => {
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
  await page.goto(baseURL + '/admin');
  assert.equal(await page.getByRole('button', { name: 'Mật khẩu', exact: true }).count(), 0);
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
  const actions = page.locator('#row-' + name + ' .user-actions');
  const boxes = await actions.locator('button').evaluateAll(nodes => nodes.map(el => ({ height: el.getBoundingClientRect().height, width: el.getBoundingClientRect().width, title: el.title, label: el.getAttribute('aria-label'), text: el.textContent.trim(), whiteSpace: getComputedStyle(el).whiteSpace })));
  assert.ok(boxes.every(box => box.width === 44 && box.height === 44 && box.title && box.label && !box.text));
  await actions.getByRole('button', { name: 'Sửa thông tin ' + name }).click();
  assert.equal(await page.locator('#f-username').inputValue(), name);
  await page.screenshot({ path: '/tmp/vbook-admin-compact-mobile.png', fullPage: true });
  assert.equal(boxes.length, 3);
  assert.ok(boxes.every(box => box.height === boxes[0].height && box.whiteSpace === 'nowrap'));
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.screenshot({ path: '/tmp/vbook-admin-shared-desktop.png', fullPage: true });

});


test('login shares theme and works without external stylesheets', async t => {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
  t.after(() => context.close());
  const page = await context.newPage();
  await page.goto(baseURL + '/admin/login');
  assert.equal(await page.locator('script[src]').count(), 0);
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
  assert.equal(await page.locator('form').evaluate(el => getComputedStyle(el).borderRadius), '18px');
  await page.screenshot({ path: '/tmp/vbook-login-shared.png' });
});


test('many backups paginate and filter history while preserving search and manual deletion', { timeout: 20000 }, async t => {
  const files = Array.from({ length: 45 }, (_, i) => ({ name: i < 5 ? 'current-' + i + '.zip' : 'backup-history/2026-09-05_12-00-00-000_UTC+7_id-' + i + '/backup-' + i + '.zip', size: 100 }));
  const { page } = await openDrive(t, { files });
  assert.equal(await page.locator('[data-file]:visible').count(), 20);
  await page.getByRole('button', { name: 'Trang sau', exact: true }).click();
  assert.equal(await page.locator('#page-label').textContent(), '2 / 3');
  await page.getByRole('button', { name: 'Bản hiện tại', exact: true }).click();
  assert.equal(await page.locator('[data-file]:visible').count(), 5);
  await page.getByRole('button', { name: 'Lịch sử', exact: true }).click();
  assert.equal(await page.locator('[data-file]:visible').count(), 20);
  assert.equal(await page.locator('#page-label').textContent(), '1 / 2');
  await page.screenshot({ path: '/tmp/vbook-history.png' });
  await page.getByRole('searchbox').fill('backup-44');
  assert.equal(await page.locator('[data-file]:visible').count(), 1);
  await confirmDelete(page, 'backup-44.zip');
  await page.getByRole('heading', { name: 'Không tìm thấy tệp phù hợp' }).waitFor();
  await page.getByRole('button', { name: 'Xóa bộ lọc', exact: true }).click();
  assert.equal(await page.locator('[data-file]:visible').count(), 20);
  await page.screenshot({ path: '/tmp/vbook-compact-many-desktop.png', fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
  await page.screenshot({ path: '/tmp/vbook-compact-many-mobile.png', fullPage: true });
});

 test('creates nested folders, persists empty folders and uploads extension files there', async t => {
  const { page, username } = await openDrive(t, { files: [] });
  await page.getByRole('button', { name: 'Tạo thư mục', exact: true }).click();
  await page.getByLabel('Đường dẫn thư mục').fill('vbookext/demo/src');
  await page.getByRole('button', { name: 'Tạo', exact: true }).click();
  await waitText(page, 'toast-message', 'Đã tạo thư mục');
  assert.ok(await bucket.head(username + '/vbookext/demo/src/'));
  await page.reload();
  await page.locator('.folder-panel summary').click();
  await page.getByRole('button', { name: 'vbookext/demo/src/', exact: true }).click();
  assert.equal(await page.getByLabel('Thư mục đích').inputValue(), 'vbookext/demo/src');
  await page.locator('#upload-files').setInputFiles({ name: 'home.js', mimeType: 'text/javascript', buffer: Buffer.from('function execute() {}') });
  await page.getByRole('button', { name: 'Tải lên', exact: true }).click();
  await waitText(page, 'upload-status', 'Đã tải lên 1 tệp');
  assert.equal(await (await bucket.get(username + '/vbookext/demo/src/home.js')).text(), 'function execute() {}');
  assert.equal(await bucket.head(username + '/library/vbookext/demo/src/home.js'), null);
 });
