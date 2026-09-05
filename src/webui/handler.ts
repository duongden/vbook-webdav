import { Context } from 'hono';
import { html, raw } from 'hono/html';
import { AppEnv } from '../types';
import { getUsage } from '../storage/client';
import { encodePath } from '../utils/path';
import { driveStyles } from './drive-styles';
import { driveScript } from './drive-script';

interface DriveFile { name: string; size: number; uploaded: string }

async function inventory(c: Context<AppEnv>) {
  const username = c.get('username');
  const files: DriveFile[] = [];
  let cursor: string | undefined;
  do {
    const page = await c.env.STORAGE_R2.list({ prefix: `${username}/`, cursor });
    for (const object of page.objects) {
      if (!object.key.endsWith('/')) {
        files.push({ name: object.key.substring(username.length + 1), size: object.size, uploaded: object.uploaded.toISOString() });
      }
    }
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor);
  files.sort((a, b) => b.uploaded.localeCompare(a.uploaded) || a.name.localeCompare(b.name));
  return { files, usageBytes: await getUsage(c.env, username), quotaBytes: (c.get('user').quota_mb || 500) * 1024 * 1024 };
}

export const webuiDataHandler = async (c: Context<AppEnv>) => {
  c.header('Cache-Control', 'private, no-store');
  c.header('Vary', 'Accept');
  return c.json(await inventory(c));
};

function formatBytes(bytes: number): string {
  if (bytes === 0) return '0 B';
  const unit = Math.min(3, Math.max(0, Math.floor(Math.log(bytes) / Math.log(1024))));
  return `${Number((bytes / 1024 ** unit).toFixed(2)).toLocaleString('vi-VN')} ${['B', 'KB', 'MB', 'GB'][unit]}`;
}

function formatDate(value: string): string {
  return new Date(value).toLocaleString('vi-VN', { timeZone: 'Asia/Ho_Chi_Minh', day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' });
}

const fileIcon = html`<svg aria-hidden="true" viewBox="0 0 24 24"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8Z"/><path d="M14 2v6h6M8 13h8M8 17h5"/></svg>`;
const deleteIcon = html`<svg aria-hidden="true" viewBox="0 0 24 24"><path d="M3 6h18M9 6V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2M5 6l1 14h12l1-14M10 10v6M14 10v6"/></svg>`;
const downloadIcon = html`<svg aria-hidden="true" viewBox="0 0 24 24"><path d="M12 3v12m-5-5 5 5 5-5M5 16v4h14v-4"/></svg>`;

function fileRow(file: DriveFile) {
  const slash = file.name.lastIndexOf('/');
  const base = file.name.substring(slash + 1);
  const parent = slash >= 0 ? file.name.substring(0, slash) : 'Thư mục gốc';
  const kind = /\.(zip|gz|rar|7z)$/i.test(base) ? 'archive' : /\.(json|db|xml)$/i.test(base) ? 'data' : 'file';
  return html`<article class="file-row" data-file data-name="${file.name}" data-size="${file.size}" data-uploaded="${file.uploaded}">
    <div class="file-main"><div class="file-icon" data-kind="${kind}">${fileIcon}</div>
      <div class="file-label"><h3 class="file-name" title="${file.name}">${base}</h3><div class="file-path">${parent}</div><span class="file-state" hidden></span></div>
    </div>
    <div class="file-size">${formatBytes(file.size)}</div>
    <time class="file-date" datetime="${file.uploaded}">${formatDate(file.uploaded)}</time>
    <div class="file-actions">
      <a class="btn btn-quiet download-file" href="/webdav/${encodePath(file.name)}" aria-label="Tải xuống ${base}">${downloadIcon}<span>Tải về</span></a>
      <button type="button" class="btn btn-danger delete-file" data-name="${file.name}" aria-label="Xóa ${base}">${deleteIcon}<span>Xóa</span></button>
    </div>
  </article>`;
}

export const webuiHandler = async (c: Context<AppEnv>) => {
  const { files, usageBytes, quotaBytes } = await inventory(c);
  const username = c.get('username');
  const percent = Math.min(100, Math.round(usageBytes / quotaBytes * 100));
  c.header('Cache-Control', 'private, no-store');
  c.header('Vary', 'Accept');
  c.header('X-Content-Type-Options', 'nosniff');
  return c.html(html`<!DOCTYPE html>
<html lang="vi">
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="color-scheme" content="light"><title>Tệp của tôi · VBook Cloud</title><style>${raw(driveStyles)}</style></head>
<body>
  <header class="topbar"><div class="topbar-inner">
    <a class="brand" href="/" aria-label="VBook Cloud — trang chủ"><span class="brand-icon"><svg aria-hidden="true" viewBox="0 0 24 24"><path d="M7 18a5 5 0 1 1 1-9.9A6 6 0 0 1 20 10a4 4 0 0 1-1 8H7Z"/></svg></span><span>VBook <span class="brand-secondary">Cloud</span></span></a>
    <div class="account"><span class="avatar" aria-hidden="true">${username.charAt(0).toUpperCase()}</span><span class="account-name" title="${username}">${username}</span></div>
  </div></header>
  <main class="shell" id="drive" data-usage="${usageBytes}" data-quota="${quotaBytes}">
    <section class="intro" aria-labelledby="page-title"><div><p class="eyebrow">Không gian lưu trữ cá nhân</p><h1 id="page-title">Tệp của tôi</h1><p class="subtitle">Các bản sao lưu từ VBook và Legado, gọn gàng ở một nơi.</p></div><span class="connection"><span class="dot"></span>WebDAV</span></section>
    <section class="stats" aria-label="Tổng quan lưu trữ">
      <div class="stat"><div class="stat-title"><span>Dung lượng đã dùng</span><svg aria-hidden="true" viewBox="0 0 24 24"><ellipse cx="12" cy="5" rx="8" ry="3"/><path d="M4 5v7c0 4 16 4 16 0V5M4 12v7c0 4 16 4 16 0v-7"/></svg></div><div class="stat-value"><span id="usage-value">${formatBytes(usageBytes)}</span> <small>/ <span id="quota-value">${formatBytes(quotaBytes)}</span></small></div><div class="meter" role="progressbar" aria-label="Dung lượng đã dùng" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${percent}"><div class="meter-fill" style="width:${percent}%"></div></div><div class="stat-note" id="usage-note">Còn ${formatBytes(Math.max(0, quotaBytes - usageBytes))} trống</div></div>
      <div class="stat"><div class="stat-title"><span>Tổng số tệp</span>${fileIcon}</div><div class="stat-value" id="total-files">${files.length.toLocaleString('vi-VN')}</div><div class="stat-note">Trong kho lưu trữ của bạn</div></div>
      <div class="stat"><div class="stat-title"><span>Tệp mới nhất</span><svg aria-hidden="true" viewBox="0 0 24 24"><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/></svg></div><div class="stat-value stat-date" id="latest-file">${files.length ? formatDate(files[0].uploaded) : 'Chưa có tệp'}</div><div class="stat-note">Ngày tải lên gần nhất</div></div>
    </section>
    <section class="files-panel" aria-labelledby="files-title">
      <div class="panel-heading"><div class="panel-title"><h2 id="files-title">Tất cả tệp</h2><span class="count" id="file-count">${files.length}</span></div><button type="button" class="btn" id="refresh-files"><svg aria-hidden="true" viewBox="0 0 24 24"><path d="M20 7v5h-5M4 17v-5h5M6 7a7 7 0 0 1 12-1l2 6M4 12l2 6a7 7 0 0 0 12-1"/></svg><span>Làm mới</span></button></div>
      <div class="backup-filters" role="group" aria-label="Loại bản sao lưu"><button type="button" class="btn" data-backup-filter="all" aria-pressed="true">Tất cả</button><button type="button" class="btn" data-backup-filter="current" aria-pressed="false">Bản hiện tại</button><button type="button" class="btn" data-backup-filter="history" aria-pressed="false">Lịch sử</button></div>
      <div class="toolbar"><label class="search"><svg aria-hidden="true" viewBox="0 0 24 24"><circle cx="10.5" cy="10.5" r="6.5"/><path d="m16 16 4 4"/></svg><span class="visually-hidden">Tìm theo tên tệp hoặc thư mục</span><input id="search-files" type="search" placeholder="Tìm theo tên tệp hoặc thư mục…" autocomplete="off"></label><label class="visually-hidden" for="sort-files">Sắp xếp tệp</label><select id="sort-files"><option value="newest">Mới nhất trước</option><option value="name">Tên: A → Z</option><option value="largest">Dung lượng lớn nhất</option></select></div>
      <div class="list-heading" aria-hidden="true"><span>Tên tệp</span><span>Dung lượng</span><span class="date-heading">Ngày tải lên</span><span>Thao tác</span></div>
      <div id="file-list">${files.map(fileRow)}</div>
      <div class="empty" id="empty-state" ${files.length ? html`hidden` : ''}><div class="empty-icon">${fileIcon}</div><h3 id="empty-title">Kho lưu trữ đang trống</h3><p id="empty-message">Đồng bộ từ ứng dụng VBook hoặc Legado để bản sao lưu xuất hiện tại đây.</p><button type="button" class="btn" id="clear-search" hidden style="margin-top:18px">Xóa bộ lọc</button></div>
      <div class="panel-footer"><span id="visible-count">Hiển thị ${files.length} tệp</span><nav class="pagination" aria-label="Phân trang tệp"><button type="button" class="btn" id="previous-page" aria-label="Trang trước">←</button><span id="page-label" aria-live="polite"></span><button type="button" class="btn" id="next-page" aria-label="Trang sau">→</button></nav><span id="sync-note" role="status">Danh sách đã cập nhật</span></div>
    </section>
    <p class="footnote"><svg aria-hidden="true" viewBox="0 0 24 24"><rect x="5" y="10" width="14" height="11" rx="2"/><path d="M8 10V7a4 4 0 0 1 8 0v3"/></svg>Các tệp được lưu riêng theo tài khoản.</p>
    <noscript><p>Bật JavaScript để tìm kiếm, làm mới danh sách và xóa tệp. Bạn vẫn có thể tải tệp bằng các liên kết phía trên.</p></noscript>
  </main>
  <template id="file-template">${fileRow({ name: '', size: 0, uploaded: '1970-01-01T00:00:00.000Z' })}</template>
  <dialog id="delete-dialog" aria-labelledby="delete-title" aria-describedby="delete-description"><div class="dialog-icon">${deleteIcon}</div><h2 id="delete-title">Xóa tệp này?</h2><p id="delete-description">Tệp sẽ được xóa khỏi kho lưu trữ. Thao tác này không thể hoàn tác.</p><strong id="delete-name" class="delete-name"></strong><div class="dialog-actions"><button type="button" class="btn" id="cancel-delete" autofocus>Giữ lại</button><button type="button" class="btn btn-remove" id="confirm-delete">Xóa tệp</button></div></dialog>
  <div id="toast" class="toast" role="status" aria-live="polite" hidden><span id="toast-icon" aria-hidden="true"></span><p id="toast-message"></p><button type="button" id="dismiss-toast" aria-label="Đóng thông báo"><svg aria-hidden="true" viewBox="0 0 24 24"><path d="m6 6 12 12M6 18 18 6"/></svg></button></div>
  <script>${raw(driveScript)}</script>
</body></html>`);
};
