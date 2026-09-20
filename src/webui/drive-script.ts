/** Static browser code only. All names from R2 go through textContent/dataset, never HTML. */
export const driveScript = String.raw`
(() => {
  'use strict';
  const drive = document.getElementById('drive');
  const list = document.getElementById('file-list');
  const search = document.getElementById('search-files');
  const sort = document.getElementById('sort-files');
  const refreshButton = document.getElementById('refresh-files');
  const dialog = document.getElementById('delete-dialog');
  const toast = document.getElementById('toast');
  const uploadDialog = document.getElementById('upload-dialog');
  const shareDialog = document.getElementById('share-dialog');
  const connectionDialog = document.getElementById('connection-dialog');
  const metadataDialog = document.getElementById('metadata-dialog');
  const driveDialog = document.getElementById('drive-dialog');
  const metadataForm = document.getElementById('metadata-form');
  const busy = new Set();
  let selected = null;
  let page = 1;
  let backupFilter = 'all';
  const pageSize = 20;
  let toastTimer;
  let refreshing = false;
  let usage = Number(drive.dataset.usage);
  let quota = Number(drive.dataset.quota);
  let estimated = false;
  let needsRefresh = false;
  let editingMetadataRow = null;

  const rows = () => Array.from(list.querySelectorAll('[data-file]'));
  const encodePath = name => name.split('/').map(encodeURIComponent).join('/');
  const baseName = name => name.slice(name.lastIndexOf('/') + 1);
  const normalize = value => value.toLocaleLowerCase('vi-VN').normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/đ/g, 'd');
  const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
  function rowMetadata(row) {
    try { const value = JSON.parse(row.dataset.metadata || '{}'); return value && typeof value === 'object' ? value : {}; }
    catch { return {}; }
  }
  function applyRowMetadata(row, metadata) {
    const clean = metadata && typeof metadata === 'object' ? metadata : {};
    row.dataset.metadata = JSON.stringify(clean);
    const original = baseName(row.dataset.name);
    const title = clean.title || original;
    row.querySelector('.file-name').textContent = title;
    row.querySelector('.file-name').title = clean.title ? title + ' · ' + row.dataset.name : row.dataset.name;
    const author = row.querySelector('.file-author');
    author.textContent = clean.author || '';
    author.hidden = !clean.author;
    const edit = row.querySelector('.edit-file');
    edit.hidden = !row.dataset.name.startsWith('library/');
    edit.setAttribute('aria-label', 'Sửa thông tin ' + original);
    edit.title = 'Sửa thông tin ' + original;
  }
  function formatBytes(bytes) {
    if (!bytes) return '0 B';
    const unit = Math.min(3, Math.max(0, Math.floor(Math.log(bytes) / Math.log(1000))));
    return Number((bytes / 1000 ** unit).toFixed(2)).toLocaleString('vi-VN') + ' ' + ['B', 'KB', 'MB', 'GB'][unit];
  }
  const formatDate = value => new Date(value).toLocaleString('vi-VN', { timeZone: 'Asia/Ho_Chi_Minh', day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' });

  function showToast(message, type = 'success', sticky = false) {
    clearTimeout(toastTimer);
    document.getElementById('toast-message').textContent = message;
    const icon = document.getElementById('toast-icon');
    icon.className = type === 'working' ? 'spinner' : '';
    icon.textContent = type === 'success' ? '✓' : type === 'error' ? '!' : '';
    toast.dataset.type = type;
    toast.hidden = false;
    if (!sticky) toastTimer = setTimeout(() => { toast.hidden = true; }, 6500);
  }
  document.getElementById('dismiss-toast').addEventListener('click', () => { clearTimeout(toastTimer); toast.hidden = true; });

  function controls() {
    refreshButton.disabled = refreshing || busy.size > 0;
    refreshButton.querySelector('span').textContent = refreshing ? 'Đang làm mới…' : 'Làm mới';
  }
  function updateStats() {
    const all = rows();
    document.getElementById('total-files').textContent = all.length.toLocaleString('vi-VN');
    document.getElementById('file-count').textContent = all.length;
    document.getElementById('usage-value').textContent = formatBytes(usage);
    document.getElementById('quota-value').textContent = formatBytes(quota);
    document.getElementById('usage-note').textContent = estimated ? 'Đang đối soát dung lượng…' : 'Còn ' + formatBytes(Math.max(0, quota - usage)) + ' trống';
    const percent = Math.min(100, Math.round(usage / quota * 100));
    document.querySelector('.meter-fill').style.width = percent + '%';
    document.querySelector('.meter').setAttribute('aria-valuenow', String(percent));
    const latest = all.map(row => row.dataset.uploaded).sort().pop();
    document.getElementById('latest-file').textContent = latest ? formatDate(latest) : 'Chưa có tệp';
  }
  function filterAndSort() {
    const query = normalize(search.value.trim());
    const all = rows();
    all.sort((a, b) => {
      if (sort.value === 'name') return (rowMetadata(a).title || a.dataset.name).localeCompare(rowMetadata(b).title || b.dataset.name, 'vi');
      if (sort.value === 'largest') return Number(b.dataset.size) - Number(a.dataset.size);
      return b.dataset.uploaded.localeCompare(a.dataset.uploaded) || a.dataset.name.localeCompare(b.dataset.name, 'vi');
    });
    const matches = all.filter(row => {
      const metadata = rowMetadata(row);
      const searchable = [row.dataset.name, metadata.title, metadata.author, metadata.category, metadata.description].filter(Boolean).join(' ');
      return normalize(searchable).includes(query) && (backupFilter === 'all' || row.dataset.name.startsWith('backup-history/') === (backupFilter === 'history'));
    });
    const visible = matches.length;
    const pages = Math.max(1, Math.ceil(visible / pageSize));
    page = Math.min(page, pages);
    const shown = new Set(matches.slice((page - 1) * pageSize, page * pageSize));
    for (const row of all) {
      row.hidden = !shown.has(row);
      const name = row.dataset.name;
      const history = name.startsWith('backup-history/');
      const parent = name.includes('/') ? name.slice(0, name.lastIndexOf('/')) : 'Thư mục gốc';
      row.querySelector('.file-path').textContent = history ? 'Lịch sử · ' + parent.replace(/^backup-history\/([^/]+)\/?/, (_, stamp) => stamp.replace(/_UTC\+7_.*/, ' (GMT+7)').replace('_', ' ') + ' · ') : parent;
      list.append(row);
    }
    document.getElementById('visible-count').textContent = visible ? ((page - 1) * pageSize + 1) + '–' + Math.min(page * pageSize, visible) + ' / ' + visible + ' tệp' : '0 tệp';
    document.getElementById('page-label').textContent = page + ' / ' + pages;
    document.getElementById('previous-page').disabled = page <= 1;
    document.getElementById('next-page').disabled = page >= pages;
    document.querySelector('.pagination').hidden = pages <= 1;
    document.getElementById('empty-state').hidden = visible > 0;
    document.getElementById('empty-title').textContent = all.length ? 'Không tìm thấy tệp phù hợp' : 'Kho lưu trữ đang trống';
    document.getElementById('empty-message').textContent = all.length ? 'Thử tên khác hoặc xóa bộ lọc để xem tất cả tệp.' : 'Đồng bộ từ ứng dụng VBook hoặc Legado để bản sao lưu xuất hiện tại đây.';
    document.getElementById('clear-search').hidden = !query && backupFilter === 'all';
  }
  search.addEventListener('input', () => { page = 1; filterAndSort(); });
  sort.addEventListener('change', () => { page = 1; filterAndSort(); });
  document.querySelectorAll('[data-backup-filter]').forEach(button => button.addEventListener('click', () => {
    backupFilter = button.dataset.backupFilter; page = 1;
    document.querySelectorAll('[data-backup-filter]').forEach(item => item.setAttribute('aria-pressed', String(item === button)));
    filterAndSort();
  }));
  document.getElementById('previous-page').onclick = () => { page--; filterAndSort(); };
  document.getElementById('next-page').onclick = () => { page++; filterAndSort(); };
  document.getElementById('clear-search').addEventListener('click', () => { search.value = ''; backupFilter = 'all'; page = 1; document.querySelectorAll('[data-backup-filter]').forEach(item => item.setAttribute('aria-pressed', String(item.dataset.backupFilter === 'all'))); filterAndSort(); search.focus(); });

  async function fetchWithTimeout(url, options, milliseconds = 10000) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), milliseconds);
    try {
      return await fetch(url, { credentials: 'same-origin', cache: 'no-store', redirect: 'error', ...options, signal: controller.signal });
    } finally { clearTimeout(timer); }
  }

  function makeRow(file) {
    const row = document.getElementById('file-template').content.firstElementChild.cloneNode(true);
    row.dataset.name = file.name;
    row.dataset.size = String(file.size);
    row.dataset.uploaded = file.uploaded;
    row.dataset.metadata = JSON.stringify(file.metadata || {});
    const name = baseName(file.name);
    row.querySelector('.file-name').textContent = name;
    row.querySelector('.file-name').title = file.name;
    row.querySelector('.file-path').textContent = file.name.includes('/') ? file.name.slice(0, file.name.lastIndexOf('/')) : 'Thư mục gốc';
    row.querySelector('.file-size').textContent = formatBytes(file.size);
    row.querySelector('.file-date').textContent = formatDate(file.uploaded);
    row.querySelector('.file-date').dateTime = file.uploaded;
    row.querySelector('.file-icon').dataset.kind = /\.(zip|gz|rar|7z)$/i.test(name) ? 'archive' : /\.(json|db|xml)$/i.test(name) ? 'data' : 'file';
    const download = row.querySelector('.download-file');
    download.href = '/webdav/' + encodePath(file.name);
    download.setAttribute('aria-label', 'Tải xuống ' + name);
    download.title = 'Tải xuống ' + name;
    const button = row.querySelector('.delete-file');
    button.dataset.name = file.name;
    button.setAttribute('aria-label', 'Xóa ' + name);
    button.title = 'Xóa ' + name;
    applyRowMetadata(row, file.metadata || {});
    return row;
  }
  async function refreshFiles(quiet = false) {
    if (refreshing || busy.size) return;
    refreshing = true;
    controls();
    document.getElementById('sync-note').textContent = 'Đang cập nhật…';
    try {
      const response = await fetchWithTimeout('/', { headers: { Accept: 'application/json' } });
      if (!response.ok) throw new Error(response.status === 401 || response.status === 403 ? 'auth' : 'http');
      if (!response.headers.get('Content-Type')?.includes('application/json')) throw new Error('format');
      const data = await response.json();
      if (!Array.isArray(data.files) || !Number.isFinite(data.usageBytes) || data.usageBytes < 0 || !Number.isFinite(data.quotaBytes) || data.quotaBytes <= 0) throw new Error('format');
      for (const file of data.files) {
        if (typeof file.name !== 'string' || !Number.isFinite(file.size) || file.size < 0 || !Number.isFinite(Date.parse(file.uploaded))) throw new Error('format');
      }
      // Don't reset the user's filter/sort. A failed refresh never empties the list.
      const previous = new Map(rows().map(row => [row.dataset.name, row]));
      list.replaceChildren(...data.files.map(file => {
        const row = makeRow(file);
        const prior = previous.get(file.name);
        if (prior && (prior.dataset.state === 'pending' || prior.dataset.state === 'error')) {
          setRowState(row, prior.dataset.state, prior.querySelector('.file-state').textContent);
        }
        return row;
      }));
      usage = data.usageBytes;
      quota = data.quotaBytes;
      estimated = false;
      needsRefresh = false;
      updateStats();
      filterAndSort();
      document.getElementById('sync-note').textContent = 'Vừa cập nhật';
      if (!quiet) showToast('Danh sách tệp đã được cập nhật.');
    } catch (error) {
      document.getElementById('sync-note').textContent = 'Chưa cập nhật được danh sách';
      if (!quiet) showToast(error.message === 'auth' ? 'Phiên đăng nhập đã hết hạn hoặc tài khoản không có quyền. Hãy đăng nhập lại.' : 'Chưa làm mới được danh sách. Kiểm tra kết nối rồi thử lại.', 'error');
    } finally { refreshing = false; controls(); }
  }
  refreshButton.addEventListener('click', () => refreshFiles());

  function setRowState(row, state, message) {
    row.dataset.state = state;
    row.setAttribute('aria-busy', String(state === 'working'));
    const label = row.querySelector('.file-state');
    label.hidden = !message;
    label.textContent = message || '';
    const button = row.querySelector('.delete-file');
    button.disabled = state === 'working';
    const checking = state === 'pending';
    const action = state === 'working' ? 'Đang xử lý ' : checking ? 'Kiểm tra lại ' : 'Xóa ';
    button.setAttribute('aria-label', action + baseName(row.dataset.name));
    button.title = action.trim();
  }
  function removeConfirmed(row) {
    usage = Math.max(0, usage - Number(row.dataset.size));
    estimated = true;
    needsRefresh = true;
    row.remove();
    updateStats();
    filterAndSort();
    showToast('Đã xóa “' + baseName(row.dataset.name) + '”.');
  }
  async function checkDeleted(url) {
    let state = 'unknown';
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const result = await fetchWithTimeout(url, { method: 'HEAD' }, 5000);
        if (result.status === 404) return 'missing';
        if (result.status === 401 || result.status === 403) return 'auth';
        state = result.ok ? 'exists' : 'unknown';
      } catch { state = 'unknown'; }
      if (attempt < 2) await pause(700 * (attempt + 1));
    }
    return state;
  }
  async function deleteFile(row, verifyOnly = false) {
    const name = row.dataset.name;
    if (!row.isConnected || busy.has(name) || refreshing) return;
    busy.add(name);
    controls();
    setRowState(row, 'working', verifyOnly ? 'Đang kiểm tra tệp…' : 'Đang gửi yêu cầu xóa…');
    showToast(verifyOnly ? 'Đang kiểm tra kết quả xóa…' : 'Đang xóa tệp…', 'working', true);
    let confirmed = false;
    let response;
    try {
      const url = '/webdav/' + encodePath(name);
      if (!verifyOnly) {
        try { response = await fetchWithTimeout(url, { method: 'DELETE' }, 15000); }
        catch { /* The server may have deleted the file before the connection failed. */ }
      }
      if (response && (response.status === 200 || response.status === 204)) {
        confirmed = true;
      } else if (response && (response.status === 401 || response.status === 403)) {
        setRowState(row, 'error', 'Cần đăng nhập hoặc kiểm tra quyền truy cập.');
        showToast('Không có quyền xóa tệp. Hãy đăng nhập lại hoặc liên hệ quản trị viên.', 'error');
        return;
      } else {
        setRowState(row, 'working', 'Đang xác nhận tệp còn tồn tại hay không…');
        const result = await checkDeleted(url);
        if (result === 'missing') {
          confirmed = true;
        } else if (result === 'auth') {
          setRowState(row, 'error', 'Không xác nhận được vì thiếu quyền truy cập.');
          showToast('Chưa xác nhận được kết quả. Hãy đăng nhập lại để kiểm tra.', 'error');
        } else if (result === 'unknown' || verifyOnly || response?.status === 202 || (response?.status === 503 && response.headers.get('Retry-After'))) {
          setRowState(row, 'pending', 'Chưa xác nhận hoàn tất. Bạn có thể kiểm tra lại.');
          showToast('Chưa xác nhận được kết quả xóa. Chờ một chút rồi chọn “Kiểm tra lại”.', 'pending', true);
        } else {
          setRowState(row, 'error', 'Tệp vẫn còn. Bạn có thể thử xóa lại.');
          showToast('Tệp vẫn còn trên máy chủ. ' + (response ? 'Yêu cầu xóa trả HTTP ' + response.status + '. ' : '') + 'Vui lòng thử lại.', 'error');
        }
      }
      if (confirmed) removeConfirmed(row);
    } finally {
      busy.delete(name);
      controls();
      if (row.isConnected && row.dataset.state === 'working') setRowState(row, 'pending', 'Chưa xác nhận hoàn tất. Hãy kiểm tra lại.');
      if (needsRefresh && !busy.size) void refreshFiles(true);
    }
  }

  list.addEventListener('click', event => {
    const edit = event.target.closest('.edit-file');
    if (edit) {
      const row = edit.closest('[data-file]');
      if (row?.dataset.name.startsWith('library/')) openMetadataEditor(row);
      return;
    }
    const button = event.target.closest('.delete-file');
    if (!button || button.disabled || refreshing) return;
    const row = button.closest('[data-file]');
    if (row.dataset.state === 'pending') { void deleteFile(row, true); return; }
    selected = row;
    clearTimeout(toastTimer);
    toast.hidden = true;
    document.getElementById('delete-name').textContent = row.dataset.name;
    dialog.showModal();
  });
  document.getElementById('cancel-delete').addEventListener('click', () => dialog.close());
  document.getElementById('confirm-delete').addEventListener('click', () => {
    const row = selected;
    dialog.close();
    if (row) void deleteFile(row);
  });
  dialog.addEventListener('close', () => { selected = null; });

  function metadataRequest(method, body) {
    return fetchWithTimeout('/api/metadata', { method, headers: { 'X-VBook-Action': 'metadata', 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  }
  function renderCoverPreview(value) {
    const preview = document.getElementById('metadata-cover-preview');
    preview.replaceChildren();
    if (!/^https:\/\//i.test(value)) { const empty = document.createElement('span'); empty.textContent = 'Chưa có bìa'; preview.append(empty); return; }
    const image = document.createElement('img');
    image.alt = 'Xem trước bìa'; image.referrerPolicy = 'no-referrer'; image.src = value;
    image.addEventListener('error', () => { preview.replaceChildren(); const error = document.createElement('span'); error.textContent = 'Không tải được ảnh bìa'; preview.append(error); });
    preview.append(image);
  }
  function openMetadataEditor(row) {
    editingMetadataRow = row;
    const metadata = rowMetadata(row);
    metadataForm.reset();
    for (const field of ['title', 'author', 'language', 'category', 'description', 'coverUrl']) metadataForm.elements[field].value = metadata[field] || '';
    metadataForm.elements.title.placeholder = baseName(row.dataset.name);
    document.getElementById('metadata-source').textContent = 'Tệp gốc: ' + row.dataset.name;
    document.getElementById('metadata-error').textContent = '';
    renderCoverPreview(metadata.coverUrl || '');
    metadataDialog.showModal();
  }
  metadataForm.elements.coverUrl.addEventListener('input', event => renderCoverPreview(event.target.value.trim()));
  document.getElementById('close-metadata').addEventListener('click', () => metadataDialog.close());
  metadataDialog.addEventListener('close', () => { editingMetadataRow = null; });
  metadataForm.addEventListener('submit', async event => {
    event.preventDefault();
    const row = editingMetadataRow;
    if (!row) return;
    const metadata = {};
    for (const field of ['title', 'author', 'language', 'category', 'description', 'coverUrl']) metadata[field] = metadataForm.elements[field].value.trim();
    const submit = metadataForm.querySelector('[type=submit]');
    submit.disabled = true;
    document.getElementById('metadata-error').textContent = '';
    try {
      const response = await metadataRequest('PUT', { path: row.dataset.name, metadata });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) { document.getElementById('metadata-error').textContent = data.error || 'Không lưu được thông tin truyện.'; return; }
      applyRowMetadata(row, data.metadata || {});
      metadataDialog.close();
      filterAndSort();
      showToast('Đã lưu thông tin truyện.');
    } catch { document.getElementById('metadata-error').textContent = 'Mất kết nối khi lưu thông tin.'; }
    finally { submit.disabled = false; }
  });
  document.getElementById('reset-metadata').addEventListener('click', async () => {
    const row = editingMetadataRow;
    if (!row || !confirm('Xóa toàn bộ thông tin đã chỉnh sửa và dùng lại tên file gốc?')) return;
    const response = await metadataRequest('DELETE', { path: row.dataset.name });
    if (!response.ok) { document.getElementById('metadata-error').textContent = 'Không khôi phục được dữ liệu nguồn.'; return; }
    applyRowMetadata(row, {});
    metadataDialog.close();
    filterAndSort();
    showToast('Đã khôi phục dữ liệu từ tên file gốc.');
  });

  // Browser uploads use the same PUT path as WebDAV clients, preserving quota and history behavior.
  const uploadInput = document.getElementById('upload-files');
  const uploadDropZone = document.getElementById('upload-drop-zone');
  const uploadStatus = document.getElementById('upload-status');
  const uploadProgress = document.querySelector('.upload-progress');
  const uploadBar = document.getElementById('upload-progress-bar');
  let activeUpload = null;
  let selectedUploadFiles = [];
  let dragDepth = 0;
  function updateUploadSelection(files) {
    selectedUploadFiles = Array.from(files || []);
    document.getElementById('upload-selection').textContent = selectedUploadFiles.length ? selectedUploadFiles.length + ' tệp · ' + formatBytes(selectedUploadFiles.reduce((sum, file) => sum + file.size, 0)) : 'Chưa chọn tệp.';
  }
  document.getElementById('open-upload').addEventListener('click', () => {
    uploadStatus.textContent = '';
    uploadProgress.hidden = true;
    uploadDialog.showModal();
  });
  uploadInput.addEventListener('change', () => {
    updateUploadSelection(uploadInput.files);
  });
  uploadDropZone.addEventListener('dragenter', event => {
    event.preventDefault();
    dragDepth++;
    uploadDropZone.classList.add('is-dragging');
  });
  uploadDropZone.addEventListener('dragover', event => {
    event.preventDefault();
    if (event.dataTransfer) event.dataTransfer.dropEffect = 'copy';
  });
  uploadDropZone.addEventListener('dragleave', event => {
    event.preventDefault();
    dragDepth = Math.max(0, dragDepth - 1);
    if (!dragDepth) uploadDropZone.classList.remove('is-dragging');
  });
  uploadDropZone.addEventListener('drop', event => {
    event.preventDefault();
    dragDepth = 0;
    uploadDropZone.classList.remove('is-dragging');
    if (!event.dataTransfer?.files.length) return;
    updateUploadSelection(event.dataTransfer.files);
    try { uploadInput.files = event.dataTransfer.files; } catch { /* selectedUploadFiles remains the source of truth. */ }
    uploadStatus.textContent = 'Đã nhận ' + selectedUploadFiles.length + ' tệp được thả.';
  });
  document.getElementById('close-upload').addEventListener('click', () => {
    if (activeUpload) activeUpload.abort();
    else uploadDialog.close();
  });
  function uploadOne(file, path, position, total) {
    return new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      activeUpload = xhr;
      xhr.open('PUT', '/webdav/' + encodePath(path));
      xhr.setRequestHeader('Content-Type', file.type || 'application/octet-stream');
      xhr.timeout = 120000;
      xhr.upload.onprogress = event => {
        if (!event.lengthComputable) return;
        const percent = ((position + event.loaded / event.total) / total) * 100;
        uploadBar.style.width = Math.min(100, percent) + '%';
      };
      xhr.onload = () => xhr.status >= 200 && xhr.status < 300 ? resolve() : reject(new Error(String(xhr.status)));
      xhr.onerror = () => reject(new Error('network'));
      xhr.ontimeout = () => reject(new Error('timeout'));
      xhr.onabort = () => reject(new Error('abort'));
      xhr.send(file);
    });
  }
  document.getElementById('start-upload').addEventListener('click', async () => {
    const files = [...selectedUploadFiles];
    const rawFolder = document.getElementById('upload-folder').value.trim().replace(/^\/+|\/+$/g, '');
    const segments = rawFolder ? rawFolder.split('/') : [];
    if (!files.length) { uploadStatus.textContent = 'Hãy chọn ít nhất một tệp.'; return; }
    if (segments.some(segment => !segment || segment === '.' || segment === '..' || /[\\\u0000-\u001f]/.test(segment))) { uploadStatus.textContent = 'Tên thư mục không hợp lệ.'; return; }
    if (files.some(file => file.size > 100000000 || /[\\/\u0000-\u001f]/.test(file.name))) { uploadStatus.textContent = 'Có tệp quá 100 MB hoặc tên không hợp lệ.'; return; }
    const paths = files.map(file => 'library/' + (segments.length ? segments.join('/') + '/' : '') + file.name);
    if (paths.some(path => rows().some(row => row.dataset.name === path)) && !confirm('Tệp trùng đường dẫn sẽ đưa bản hiện tại vào lịch sử. Tiếp tục?')) return;
    uploadProgress.hidden = false;
    uploadBar.style.width = '0%';
    document.getElementById('start-upload').disabled = true;
    try {
      for (let index = 0; index < files.length; index++) {
        uploadStatus.textContent = 'Đang tải ' + (index + 1) + '/' + files.length + ': ' + files[index].name;
        await uploadOne(files[index], paths[index], index, files.length);
      }
      uploadBar.style.width = '100%';
      uploadStatus.textContent = 'Đã tải lên ' + files.length + ' tệp.';
      uploadInput.value = '';
      updateUploadSelection([]);
      await refreshFiles(true);
      showToast('Đã tải tệp lên thư viện.');
    } catch (error) {
      const messages = { '401': 'Phiên đăng nhập không hợp lệ.', '403': 'Không có quyền upload vào đường dẫn này.', '411': 'Trình duyệt không gửi kích thước tệp.', '413': 'Tệp vượt quá giới hạn cho phép.', '507': 'Tài khoản không còn đủ dung lượng.', abort: 'Đã hủy upload.', timeout: 'Upload quá thời gian chờ.', network: 'Mất kết nối khi upload.' };
      uploadStatus.textContent = messages[error.message] || 'Upload thất bại (HTTP ' + error.message + ').';
      showToast(uploadStatus.textContent, 'error');
    } finally {
      activeUpload = null;
      document.getElementById('start-upload').disabled = false;
    }
  });

  function showConnection(connection) {
    document.getElementById('connection-url').value = connection.url;
    document.getElementById('connection-user').value = connection.username;
    document.getElementById('connection-password').value = connection.password;
    if (shareDialog.open) shareDialog.close();
    connectionDialog.showModal();
  }
  document.getElementById('close-connection').addEventListener('click', () => connectionDialog.close());
  document.getElementById('copy-connection').addEventListener('click', async () => {
    const text = 'URL: ' + document.getElementById('connection-url').value + '\nUsername: ' + document.getElementById('connection-user').value + '\nPassword: ' + document.getElementById('connection-password').value;
    try { await navigator.clipboard.writeText(text); showToast('Đã sao chép thông tin kết nối.'); }
    catch { showToast('Không sao chép tự động được. Hãy sao chép từng trường.', 'error'); }
  });
  function shareRequest(url, method, body) {
    return fetchWithTimeout(url, { method, headers: { 'X-VBook-Action': 'shares', ...(body ? { 'Content-Type': 'application/json' } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
  }
  function renderShares(shares) {
    const container = document.getElementById('share-list');
    container.replaceChildren();
    const active = shares.filter(share => share.status === 'active');
    if (!active.length) { const empty = document.createElement('div'); empty.className = 'share-empty'; empty.textContent = 'Chưa có kết nối chia sẻ.'; container.append(empty); return; }
    for (const share of active) {
      const item = document.createElement('article'); item.className = 'share-item';
      const details = document.createElement('div');
      const title = document.createElement('strong'); title.textContent = share.label;
      const meta = document.createElement('small'); meta.textContent = share.prefix + (share.expires_at ? ' · hết hạn ' + formatDate(new Date(share.expires_at).toISOString()) : ' · không hết hạn');
      details.append(title, meta);
      const actions = document.createElement('div'); actions.className = 'share-actions';
      const rotate = document.createElement('button'); rotate.type = 'button'; rotate.className = 'btn'; rotate.textContent = 'Đổi mật khẩu';
      rotate.onclick = async () => {
        if (!confirm('Mật khẩu cũ sẽ ngừng hoạt động. Tiếp tục?')) return;
        const response = await shareRequest('/api/shares/' + encodeURIComponent(share.id) + '/rotate', 'POST');
        if (!response.ok) { showToast('Không đổi được mật khẩu chia sẻ.', 'error'); return; }
        showConnection((await response.json()).connection);
      };
      const revoke = document.createElement('button'); revoke.type = 'button'; revoke.className = 'btn btn-danger'; revoke.textContent = 'Thu hồi';
      revoke.onclick = async () => {
        if (!confirm('Thu hồi kết nối “' + share.label + '”?')) return;
        const response = await shareRequest('/api/shares/' + encodeURIComponent(share.id), 'DELETE');
        if (!response.ok) { showToast('Không thu hồi được kết nối.', 'error'); return; }
        await loadShares(); showToast('Đã thu hồi kết nối chia sẻ.');
      };
      actions.append(rotate, revoke); item.append(details, actions); container.append(item);
    }
  }
  async function loadShares() {
    const container = document.getElementById('share-list');
    container.textContent = 'Đang tải…';
    try {
      const response = await fetchWithTimeout('/api/shares', {});
      if (!response.ok) throw new Error();
      renderShares((await response.json()).shares);
    } catch { container.textContent = 'Không tải được danh sách chia sẻ.'; }
  }
  document.getElementById('manage-shares').addEventListener('click', () => { shareDialog.showModal(); void loadShares(); });
  document.getElementById('close-shares').addEventListener('click', () => shareDialog.close());
  document.getElementById('share-form').addEventListener('submit', async event => {
    event.preventDefault();
    const formElement = event.currentTarget;
    const form = new FormData(formElement);
    const expires = String(form.get('expires') || '');
    const response = await shareRequest('/api/shares', 'POST', { label: String(form.get('label') || ''), prefix: String(form.get('prefix') || ''), expiresAt: expires ? new Date(expires).getTime() : null });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) { showToast(data.error || 'Không tạo được kết nối chia sẻ.', 'error'); return; }
    formElement.reset();
    formElement.elements.prefix.value = 'library/';
    showConnection(data.connection);
  });

  const driveStatus = document.getElementById('drive-status');
  const driveConnection = document.getElementById('drive-connection');
  const disconnectDrive = document.getElementById('disconnect-drive');
  function driveRequest(method, body) {
    return fetchWithTimeout('/api/drive', { method, headers: { 'X-VBook-Action': 'drive', ...(body ? { 'Content-Type': 'application/json' } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
  }
  async function loadDriveStatus() {
    driveStatus.textContent = 'Đang kiểm tra cấu hình…';
    try {
      const response = await fetchWithTimeout('/api/drive', {});
      if (!response.ok) throw new Error();
      const data = await response.json();
      driveStatus.textContent = !data.available ? 'Máy chủ chưa cấu hình Google Drive API key.' : data.configured ? 'Đã liên kết một thư mục Google Drive.' : 'Chưa liên kết thư mục Google Drive.';
      driveConnection.hidden = !data.configured;
      disconnectDrive.hidden = !data.configured;
      document.getElementById('drive-webdav-url').value = data.url;
    } catch { driveStatus.textContent = 'Không đọc được trạng thái Google Drive.'; }
  }
  document.getElementById('manage-drive').addEventListener('click', () => { driveDialog.showModal(); void loadDriveStatus(); });
  document.getElementById('close-drive').addEventListener('click', () => driveDialog.close());
  document.getElementById('drive-form').addEventListener('submit', async event => {
    event.preventDefault();
    driveStatus.textContent = 'Đang kiểm tra thư mục Google Drive…';
    const response = await driveRequest('PUT', { url: document.getElementById('drive-folder-url').value });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) { driveStatus.textContent = data.error || 'Không liên kết được Google Drive.'; showToast(driveStatus.textContent, 'error'); return; }
    driveStatus.textContent = 'Đã liên kết thư mục Google Drive.';
    driveConnection.hidden = false;
    disconnectDrive.hidden = false;
    document.getElementById('drive-webdav-url').value = data.url;
    showToast('Đã liên kết Google Drive với WebDAV.');
  });
  disconnectDrive.addEventListener('click', async () => {
    if (!confirm('Ngắt liên kết Google Drive khỏi tài khoản này?')) return;
    const response = await driveRequest('DELETE');
    if (!response.ok) { showToast('Không ngắt được liên kết Google Drive.', 'error'); return; }
    document.getElementById('drive-folder-url').value = '';
    driveConnection.hidden = true;
    disconnectDrive.hidden = true;
    driveStatus.textContent = 'Chưa liên kết thư mục Google Drive.';
    showToast('Đã ngắt liên kết Google Drive.');
  });
  filterAndSort();
})();
`;
