import { Context } from 'hono';
import { html, raw } from 'hono/html';
import { AppEnv } from '../types';
import { getUsage } from '../storage/client';
import { getBookMetadata } from '../storage/client';
import type { BookMetadata } from '../types';
import { encodePath } from '../utils/path';
import { driveStyles } from './drive-styles';
import { driveScript } from './drive-script';

interface DriveFile { name: string; size: number; uploaded: string; metadata?: BookMetadata }

async function inventory(c: Context<AppEnv>) {
  const username = c.get('username');
  const usageBytes = await getUsage(c.env, username);
  const files: DriveFile[] = [];
  const folders = new Set<string>();
  const metadata = new Map((await getBookMetadata(c.env, username)).map(record => [record.path, record.metadata]));
  let cursor: string | undefined;
  do {
    const page = await c.env.STORAGE_R2.list({ prefix: `${username}/`, cursor });
    for (const object of page.objects) {
      const parts = object.key.substring(username.length + 1).split('/');
      for (let index = 1; index < parts.length; index++) {
        const folder = parts.slice(0, index).join('/');
        if (parts[0] !== 'backup-history') folders.add(folder);
      }
      if (!object.key.endsWith('/')) {
        files.push({ name: object.key.substring(username.length + 1), size: object.size, uploaded: object.uploaded.toISOString(), metadata: metadata.get(object.key) });
      }
    }
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor);
  files.sort((a, b) => b.uploaded.localeCompare(a.uploaded) || a.name.localeCompare(b.name));
  return { files, folders: [...folders].sort(), usageBytes, quotaBytes: (c.get('user').quota_mb || 500) * 1024 * 1024 };
}

export const webuiDataHandler = async (c: Context<AppEnv>) => {
  c.header('Cache-Control', 'private, no-store');
  c.header('Vary', 'Accept');
  return c.json(await inventory(c));
};

function formatBytes(bytes: number): string {
  if (bytes === 0) return '0 B';
  const unit = Math.min(3, Math.max(0, Math.floor(Math.log(bytes) / Math.log(1000))));
  return `${Number((bytes / 1000 ** unit).toFixed(2)).toLocaleString('vi-VN')} ${['B', 'KB', 'MB', 'GB'][unit]}`;
}

function formatDate(value: string): string {
  return new Date(value).toLocaleString('vi-VN', { timeZone: 'Asia/Ho_Chi_Minh', day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' });
}

const fileIcon = html`<svg aria-hidden="true" viewBox="0 0 24 24"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8Z"/><path d="M14 2v6h6M8 13h8M8 17h5"/></svg>`;
const deleteIcon = html`<svg aria-hidden="true" viewBox="0 0 24 24"><path d="M3 6h18M9 6V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2M5 6l1 14h12l1-14M10 10v6M14 10v6"/></svg>`;
const downloadIcon = html`<svg aria-hidden="true" viewBox="0 0 24 24"><path d="M12 3v12m-5-5 5 5 5-5M5 16v4h14v-4"/></svg>`;
const editIcon = html`<svg aria-hidden="true" viewBox="0 0 24 24"><path d="m4 20 4.5-1 10-10a2.1 2.1 0 0 0-3-3l-10 10L4 20Z"/><path d="m13.5 8 3 3"/></svg>`;
const linkIcon = html`<svg aria-hidden="true" viewBox="0 0 24 24"><path d="M10 13a5 5 0 0 0 7.5.5l2-2a5 5 0 0 0-7-7l-1.1 1.1"/><path d="M14 11a5 5 0 0 0-7.5-.5l-2 2a5 5 0 0 0 7 7l1.1-1.1"/></svg>`;

function fileRow(file: DriveFile) {
  const slash = file.name.lastIndexOf('/');
  const base = file.name.substring(slash + 1);
  const parent = slash >= 0 ? file.name.substring(0, slash) : 'Thư mục gốc';
  const displayTitle = file.metadata?.title || base;
  const editable = file.name.startsWith('library/');
  const kind = /\.(zip|gz|rar|7z)$/i.test(base) ? 'archive' : /\.(json|db|xml)$/i.test(base) ? 'data' : 'file';
  return html`<article class="file-row" data-file data-name="${file.name}" data-size="${file.size}" data-uploaded="${file.uploaded}" data-metadata="${JSON.stringify(file.metadata || {})}">
    <div class="file-main"><div class="file-icon" data-kind="${kind}">${fileIcon}</div>
      <div class="file-label"><h3 class="file-name" title="${file.name}">${displayTitle}</h3><div class="file-author" ${file.metadata?.author ? '' : 'hidden'}>${file.metadata?.author || ''}</div><div class="file-path">${parent}</div><span class="file-state" hidden></span></div>
    </div>
    <div class="file-size">${formatBytes(file.size)}</div>
    <time class="file-date" datetime="${file.uploaded}">${formatDate(file.uploaded)}</time>
    <div class="file-actions">
      <button type="button" class="btn btn-quiet file-action extension-link" aria-label="Lấy link ${base}" title="Lấy link extension" ${file.name.startsWith('vbookext/') ? '' : 'hidden'}>${linkIcon}</button>
      <button type="button" class="btn btn-quiet file-action edit-file" aria-label="Sửa thông tin ${base}" title="Sửa thông tin" ${editable ? '' : 'hidden'}>${editIcon}</button>
      <a class="btn btn-quiet file-action download-file" href="/webdav/${encodePath(file.name)}" aria-label="Tải xuống ${base}" title="Tải xuống">${downloadIcon}</a>
      <button type="button" class="btn btn-danger file-action delete-file" data-name="${file.name}" aria-label="Xóa ${base}" title="Xóa">${deleteIcon}</button>
    </div>
  </article>`;
}

export const webuiHandler = async (c: Context<AppEnv>) => {
  const { files, folders, usageBytes, quotaBytes } = await inventory(c);
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
    <aside class="drive-sidebar" aria-label="Điều hướng và dung lượng"><p class="sidebar-label">Kho lưu trữ</p>
      <div class="backup-filters" role="group" aria-label="Loại bản sao lưu"><button type="button" class="btn" data-backup-filter="all" aria-pressed="true">Tất cả</button><button type="button" class="btn" data-backup-filter="current" aria-pressed="false">Bản hiện tại</button><button type="button" class="btn" data-backup-filter="history" aria-pressed="false">Lịch sử</button></div>
    <section class="stats" aria-label="Tổng quan lưu trữ">
      <div class="stat"><div class="stat-title"><span>Dung lượng đã dùng</span><svg aria-hidden="true" viewBox="0 0 24 24"><ellipse cx="12" cy="5" rx="8" ry="3"/><path d="M4 5v7c0 4 16 4 16 0V5M4 12v7c0 4 16 4 16 0v-7"/></svg></div><div class="stat-value"><span id="usage-value">${formatBytes(usageBytes)}</span> <small>/ <span id="quota-value">${formatBytes(quotaBytes)}</span></small></div><div class="meter" role="progressbar" aria-label="Dung lượng đã dùng" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${percent}"><div class="meter-fill" style="width:${percent}%"></div></div><div class="stat-note" id="usage-note">Còn ${formatBytes(Math.max(0, quotaBytes - usageBytes))} trống</div></div>
      <div class="stat"><div class="stat-title"><span>Tổng số tệp</span>${fileIcon}</div><div class="stat-value" id="total-files">${files.length.toLocaleString('vi-VN')}</div><div class="stat-note">Trong kho lưu trữ của bạn</div></div>
      <div class="stat"><div class="stat-title"><span>Tệp mới nhất</span><svg aria-hidden="true" viewBox="0 0 24 24"><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/></svg></div><div class="stat-value stat-date" id="latest-file">${files.length ? formatDate(files[0].uploaded) : 'Chưa có tệp'}</div><div class="stat-note">Ngày tải lên gần nhất</div></div>
    </section>
    </aside>
    <div class="drive-main">
    <section class="intro" aria-labelledby="page-title"><div><p class="eyebrow">Không gian lưu trữ cá nhân</p><h1 id="page-title">Tệp của tôi</h1><p class="subtitle">Các bản sao lưu từ VBook và Legado, gọn gàng ở một nơi.</p></div><span class="connection"><span class="dot"></span>WebDAV</span></section>
    <section class="files-panel" data-layout="list" aria-labelledby="files-title">
      <div class="panel-heading"><div class="panel-title"><h2 id="files-title">Tất cả tệp</h2><span class="count" id="file-count">${files.length}</span></div><div class="panel-actions"><button type="button" class="btn" id="new-folder" title="Tạo thư mục" aria-label="Tạo thư mục"><svg aria-hidden="true" viewBox="0 0 24 24"><path d="M3 7V4h6l3 3h9v13H3V7Z M12 10v7 M8.5 13.5h7"/></svg></button><button type="button" class="btn" id="manage-drive" aria-label="Liên kết Google Drive" title="Liên kết Google Drive">${linkIcon}<span>Drive</span></button><button type="button" class="btn" id="manage-shares">Chia sẻ</button><button type="button" class="btn btn-primary" id="open-upload">Tải tệp lên</button><button type="button" class="btn" id="refresh-files"><svg aria-hidden="true" viewBox="0 0 24 24"><path d="M20 7v5h-5M4 17v-5h5M6 7a7 7 0 0 1 12-1l2 6M4 12l2 6a7 7 0 0 0 12-1"/></svg><span>Làm mới</span></button></div></div>

      <div class="toolbar"><label class="search"><svg aria-hidden="true" viewBox="0 0 24 24"><circle cx="10.5" cy="10.5" r="6.5"/><path d="m16 16 4 4"/></svg><span class="visually-hidden">Tìm theo tên tệp hoặc thư mục</span><input id="search-files" type="search" placeholder="Tìm theo tên tệp hoặc thư mục…" autocomplete="off"></label><label class="visually-hidden" for="sort-files">Sắp xếp tệp</label><select id="sort-files"><option value="newest">Mới nhất trước</option><option value="name">Tên: A → Z</option><option value="largest">Dung lượng lớn nhất</option></select></div>
      <div class="selection-controls"><label><input type="checkbox" id="select-visible"> Chọn tất cả đang hiển thị</label><span id="selection-count" role="status">0 mục đã chọn</span><button type="button" class="btn" id="deselect-all" disabled>Bỏ chọn</button></div>
      <div class="view-controls"><div class="view-switch" role="group" aria-label="Kiểu hiển thị"><button type="button" class="btn" data-layout-choice="list" aria-label="Danh sách chi tiết" title="Danh sách chi tiết" aria-pressed="true"><svg aria-hidden="true" viewBox="0 0 24 24"><path d="M9 5h12M9 12h12M9 19h12M3 5h1M3 12h1M3 19h1"/></svg></button><button type="button" class="btn" data-layout-choice="grid" aria-label="Dạng lưới" title="Dạng lưới" aria-pressed="false"><svg aria-hidden="true" viewBox="0 0 24 24"><rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/></svg></button></div></div>
      <div class="folder-navigation"><nav id="folder-breadcrumb" aria-label="Đường dẫn thư mục"></nav><button type="button" class="btn" id="toggle-folder-view" aria-pressed="false">Xem tất cả tệp</button></div>
      <div id="folder-list" class="folder-list" aria-label="Thư mục con"></div>
      <div class="list-heading" aria-hidden="true"><span>Tên tệp</span><span>Dung lượng</span><span class="date-heading">Ngày tải lên</span><span>Thao tác</span></div>
      <div id="file-list">${files.map(fileRow)}</div>
      <div class="empty" id="empty-state" ${files.length ? html`hidden` : ''}><div class="empty-icon">${fileIcon}</div><h3 id="empty-title">Kho lưu trữ đang trống</h3><p id="empty-message">Đồng bộ từ ứng dụng VBook hoặc Legado để bản sao lưu xuất hiện tại đây.</p><button type="button" class="btn" id="clear-search" hidden style="margin-top:18px">Xóa bộ lọc</button></div>
      <div class="panel-footer"><span id="visible-count">Hiển thị ${files.length} tệp</span><nav class="pagination" aria-label="Phân trang tệp"><button type="button" class="btn" id="previous-page" aria-label="Trang trước">←</button><span id="page-label" aria-live="polite"></span><button type="button" class="btn" id="next-page" aria-label="Trang sau">→</button></nav><span id="sync-note" role="status">Danh sách đã cập nhật</span></div>
    </section>
    <p class="footnote"><svg aria-hidden="true" viewBox="0 0 24 24"><rect x="5" y="10" width="14" height="11" rx="2"/><path d="M8 10V7a4 4 0 0 1 8 0v3"/></svg>Các tệp được lưu riêng theo tài khoản.</p>
    <noscript><p>Bật JavaScript để tìm kiếm, làm mới danh sách và xóa tệp. Bạn vẫn có thể tải tệp bằng các liên kết phía trên.</p></noscript>
    </div>
  </main>
  <template id="file-template">${fileRow({ name: '', size: 0, uploaded: '1970-01-01T00:00:00.000Z' })}</template>
  <dialog id="delete-dialog" aria-labelledby="delete-title" aria-describedby="delete-description"><div class="dialog-icon">${deleteIcon}</div><h2 id="delete-title">Xóa tệp này?</h2><p id="delete-description">Tệp sẽ được xóa khỏi kho lưu trữ. Thao tác này không thể hoàn tác.</p><strong id="delete-name" class="delete-name"></strong><div class="dialog-actions"><button type="button" class="btn" id="cancel-delete" autofocus>Giữ lại</button><button type="button" class="btn btn-remove" id="confirm-delete">Xóa tệp</button></div></dialog>
  <datalist id="upload-folders">${folders.map(folder => html`<option value="${folder}"></option>`)}</datalist>
  <dialog id="folder-dialog" aria-labelledby="folder-title"><form id="folder-form"><h2 id="folder-title">Tạo thư mục</h2><p>Thư mục mới sẽ được tạo bên trong thư mục đang mở. Có thể nhập nhiều cấp, ví dụ ten-extension/src.</p><p id="folder-parent" class="dialog-note"></p><label class="field">Đường dẫn thư mục<input id="folder-path" required maxlength="512" placeholder="vbookext" autocomplete="off"></label><p id="folder-status" class="dialog-note" role="status"></p><div class="dialog-actions"><button type="button" class="btn" id="close-folder">Đóng</button><button type="submit" class="btn btn-primary">Tạo</button></div></form></dialog>
  <dialog id="extension-dialog" aria-labelledby="extension-title"><h2 id="extension-title">Link extension</h2><p>Ai có link đều có thể tải tệp trong vbookext. Không chia sẻ link nếu bạn muốn giữ nguồn riêng.</p><label class="field">Link tệp<input id="extension-url" readonly></label><p class="dialog-note">Thêm link plugin.json vào vBook để cài nguồn. Link ngắn giữ nguyên khi upload ghi đè đúng đường dẫn. Thu hồi sẽ vô hiệu hóa mọi link extension đã tạo của tài khoản.</p><div class="dialog-actions"><button class="btn" id="revoke-extension" type="button">Thu hồi link</button><button class="btn btn-primary" id="copy-extension" type="button">Sao chép</button><button class="btn" id="close-extension" type="button">Đóng</button></div></dialog>
  <dialog id="upload-dialog" aria-labelledby="upload-title"><h2 id="upload-title">Tải tệp lên</h2><p>Chọn một hoặc nhiều tệp. Tệp trùng đường dẫn sẽ giữ bản cũ trong lịch sử.</p><label class="field">Thư mục đích<input id="upload-folder" value="library" list="upload-folders" placeholder="Ví dụ: vbookext/ten-extension/src"></label><label class="file-picker" id="upload-drop-zone"><span>Chọn hoặc thả tệp vào đây</span><small>Hỗ trợ nhiều tệp, tối đa 100 MB mỗi tệp</small><input id="upload-files" type="file" multiple></label><div id="upload-selection" class="dialog-note">Chưa chọn tệp.</div><div class="upload-progress" hidden><div id="upload-progress-bar"></div></div><div id="upload-status" class="dialog-note" role="status"></div><div class="dialog-actions"><button type="button" class="btn" id="close-upload">Đóng</button><button type="button" class="btn btn-primary" id="start-upload">Tải lên</button></div></dialog>
  <dialog id="share-dialog" class="wide-dialog" aria-labelledby="share-title"><h2 id="share-title">Chia sẻ WebDAV chỉ đọc</h2><p>Người nhận có thể duyệt và tải tệp bằng vBook, nhưng không thể upload hoặc xóa. URL tạo tại đây chỉ dùng cho kết nối WebDAV.</p><form id="share-form"><label class="field">Tên gợi nhớ<input name="label" required maxlength="80" placeholder="Ví dụ: Gia đình"></label><label class="field">Thư mục chia sẻ<input name="prefix" required value="library/" aria-describedby="share-prefix-help"></label><small id="share-prefix-help" class="dialog-note">Chỉ cho phép thư mục nằm trong library/.</small><label class="field">Hết hạn (không bắt buộc)<input name="expires" type="datetime-local"></label><div class="dialog-actions"><button type="submit" class="btn btn-primary">Tạo kết nối</button></div></form><h3>Kết nối đã tạo</h3><div id="share-list" class="share-list" aria-live="polite">Đang tải…</div><div class="dialog-actions"><button type="button" class="btn" id="close-shares">Đóng</button></div></dialog>
  <dialog id="connection-dialog" aria-labelledby="connection-title"><h2 id="connection-title">Thông tin WebDAV</h2><p>Mật khẩu chỉ hiển thị lần này. Hãy lưu trước khi đóng và chỉ nhập kết nối này vào mục WebDAV.</p><label class="field">URL WebDAV<input id="connection-url" readonly></label><label class="field">Username<input id="connection-user" readonly></label><label class="field">Password<input id="connection-password" readonly></label><div class="dialog-actions"><button type="button" class="btn" id="copy-connection">Sao chép</button><button type="button" class="btn btn-primary" id="close-connection">Đã lưu</button></div></dialog>
  <dialog id="drive-dialog" class="wide-dialog" aria-labelledby="drive-title"><h2 id="drive-title">Google Drive qua WebDAV</h2><p>Liên kết một thư mục Google Drive để duyệt và tải tệp qua kết nối WebDAV chỉ đọc. Thư mục Drive không dùng dung lượng R2.</p><form id="drive-form"><label class="field">Link thư mục Google Drive<input id="drive-folder-url" name="url" type="url" required maxlength="2048" placeholder="https://drive.google.com/drive/folders/…"></label><small class="dialog-note">Trên Google Drive, đặt quyền thư mục thành “Bất kỳ ai có đường liên kết” và quyền “Người xem”.</small><label class="field">Google Drive API key của bạn<input id="drive-api-key" type="password" autocomplete="new-password" maxlength="256" placeholder="Nhập key riêng; để trống để giữ key đã lưu"></label><small class="dialog-note">Key được mã hóa khi lưu và không hiển thị lại. Trang admin không có quyền xem key.</small><details class="dialog-note"><summary>Cách lấy Google Drive API key</summary><ol><li>Mở <a href="https://console.cloud.google.com/" target="_blank" rel="noopener noreferrer">Google Cloud Console</a>, đăng nhập Google, chọn bộ chọn project → New project → đặt tên → Create.</li><li>Chọn project vừa tạo. Vào APIs &amp; Services → Library, tìm Google Drive API và bấm Enable.</li><li>Vào APIs &amp; Services → Credentials → Create credentials → API key. Đặt tên dễ nhớ.</li><li>Trong API restrictions, chọn Restrict key → Google Drive API → Save. Nếu form yêu cầu giới hạn ngay khi tạo, chọn Google Drive API rồi Create.</li><li>Với máy chủ WebDAV này, Application restrictions chọn None; giới hạn Websites dành cho request từ trình duyệt nên không phù hợp.</li><li>Sao chép key vào ô phía trên. Không dán key vào link thư mục hoặc URL WebDAV.</li></ol><p>Tham khảo <a href="https://developers.google.com/workspace/guides/create-credentials#api-key" target="_blank" rel="noopener noreferrer">hướng dẫn Google</a>. Mỗi user dùng key của mình; không cần gửi key cho admin.</p></details><p id="drive-status" class="dialog-note" role="status">Đang kiểm tra cấu hình…</p><div id="drive-connection" hidden><label class="field">URL WebDAV chỉ đọc<input id="drive-webdav-url" readonly></label><p class="dialog-note">Dùng username và password tài khoản hiện tại khi thêm URL này vào VBook hoặc Legado.</p></div><div class="dialog-actions split-actions"><button type="button" class="btn btn-danger" id="disconnect-drive" hidden>Ngắt liên kết</button><span><button type="button" class="btn" id="close-drive">Đóng</button> <button type="submit" class="btn btn-primary">Liên kết</button></span></div></form></dialog>
  <dialog id="metadata-dialog" class="wide-dialog" aria-labelledby="metadata-title"><form id="metadata-form"><h2 id="metadata-title">Thông tin truyện</h2><p id="metadata-source" class="dialog-note"></p><div class="metadata-editor"><div class="cover-editor"><div id="metadata-cover-preview" class="cover-preview"><span>Chưa có bìa</span></div><small class="dialog-note">Bìa tải trực tiếp từ URL HTTPS.</small></div><div><label class="field">Tên hiển thị<input name="title" maxlength="240"></label><label class="field">Tác giả<input name="author" maxlength="240"></label><div class="metadata-pair"><label class="field">Ngôn ngữ<input name="language" list="metadata-languages" maxlength="35" placeholder="vi, en, zh-Hans…"></label><label class="field">Thể loại<input name="category" maxlength="120"></label></div><label class="field">Mô tả<textarea name="description" maxlength="5000" rows="4"></textarea></label><label class="field">URL bìa HTTPS<input name="coverUrl" type="url" maxlength="2048" placeholder="https://…"></label></div></div><p id="metadata-error" class="metadata-error" role="alert"></p><div class="dialog-actions split-actions"><button type="button" class="btn btn-danger" id="reset-metadata">Khôi phục dữ liệu gốc</button><span><button type="button" class="btn" id="close-metadata">Đóng</button> <button type="submit" class="btn btn-primary">Lưu thông tin</button></span></div></form></dialog>
  <datalist id="metadata-languages"><option value="vi">Tiếng Việt</option><option value="en">English</option><option value="fr">Français</option><option value="zh-Hans">中文</option><option value="ja">日本語</option><option value="ko">한국어</option></datalist>
  <div id="toast" class="toast" role="status" aria-live="polite" hidden><span id="toast-icon" aria-hidden="true"></span><p id="toast-message"></p><button type="button" id="dismiss-toast" aria-label="Đóng thông báo"><svg aria-hidden="true" viewBox="0 0 24 24"><path d="m6 6 12 12M6 18 18 6"/></svg></button></div>
  <script>${raw(driveScript)}</script>
</body></html>`);
};
