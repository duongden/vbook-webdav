/** Static browser code only. All names from R2 go through textContent/dataset, never HTML. */
export const driveScript = String.raw`
(() => {
  'use strict';
  const drive = document.getElementById('drive');
  const list = document.getElementById('file-list');
  const filesPanel = document.querySelector('.files-panel');
  const layoutButtons = document.querySelectorAll('[data-layout-choice]');
  function setLayout(layout) {
    filesPanel.dataset.layout = layout === 'grid' ? 'grid' : 'list';
    layoutButtons.forEach(button => button.setAttribute('aria-pressed', String(button.dataset.layoutChoice === filesPanel.dataset.layout)));
  }
  try { setLayout(localStorage.getItem('vbook-file-layout')); } catch { setLayout('list'); }
  layoutButtons.forEach(button => button.addEventListener('click', () => {
    setLayout(button.dataset.layoutChoice);
    try { localStorage.setItem('vbook-file-layout', filesPanel.dataset.layout); } catch { /* Storage may be disabled. */ }
  }));
  const search = document.getElementById('search-files');
  const sort = document.getElementById('sort-files');
  const refreshButton = document.getElementById('refresh-files');
  const dialog = document.getElementById('delete-dialog');
  const toast = document.getElementById('toast');
  const toastHome = toast.parentElement;
  const uploadDialog = document.getElementById('upload-dialog');
  const shareDialog = document.getElementById('share-dialog');
  const connectionDialog = document.getElementById('connection-dialog');
  const metadataDialog = document.getElementById('metadata-dialog');
  const driveDialog = document.getElementById('drive-dialog');
  const metadataForm = document.getElementById('metadata-form');
  const busy = new Set();
  const selectedPaths = new Set();
  let selected = null;
  let page = 1;
  let backupFilter = 'all';
  let currentFolder = '';
  let folderMode = true;
  let knownFolders = Array.from(document.querySelectorAll('#upload-folders option'), option => option.value);
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
    const link = row.querySelector('.extension-link');
    link.hidden = !row.dataset.name.startsWith('vbookext/');
    link.setAttribute('aria-label', 'Lấy link ' + original);
  }
  function formatBytes(bytes) {
    if (!bytes) return '0 B';
    const unit = Math.min(3, Math.max(0, Math.floor(Math.log(bytes) / Math.log(1000))));
    return Number((bytes / 1000 ** unit).toFixed(2)).toLocaleString('vi-VN') + ' ' + ['B', 'KB', 'MB', 'GB'][unit];
  }
  const formatDate = value => new Date(value).toLocaleString('vi-VN', { timeZone: 'Asia/Ho_Chi_Minh', day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' });

  function hideToast() {
    clearTimeout(toastTimer);
    if (typeof toast.hidePopover === 'function' && toast.matches(':popover-open')) toast.hidePopover();
    toast.hidden = true;
    if (toast.parentElement !== toastHome) toastHome.appendChild(toast);
  }
  function showToast(message, type = 'success', sticky = false) {
    clearTimeout(toastTimer);
    document.getElementById('toast-message').textContent = message;
    const icon = document.getElementById('toast-icon');
    icon.className = type === 'working' ? 'spinner' : '';
    icon.textContent = type === 'success' ? '✓' : type === 'error' ? '!' : '';
    toast.dataset.type = type;
    const openDialogs = Array.from(document.querySelectorAll('dialog[open]'));
    const host = openDialogs[openDialogs.length - 1] || toastHome;
    if (toast.parentElement !== host) {
      if (typeof toast.hidePopover === 'function' && toast.matches(':popover-open')) toast.hidePopover();
      host.appendChild(toast);
    }
    toast.hidden = false;
    if (typeof toast.showPopover === 'function' && !toast.matches(':popover-open')) toast.showPopover();
    if (!sticky) toastTimer = setTimeout(hideToast, 6500);
  }
  document.getElementById('dismiss-toast').addEventListener('click', hideToast);

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
  function selectionCheckbox(path) {
    const checkbox = document.createElement('input'); checkbox.type = 'checkbox'; checkbox.className = 'item-select';
    checkbox.dataset.selectPath = path; checkbox.setAttribute('aria-label', 'Chọn ' + path);
    return checkbox;
  }
  function visibleCheckboxes() {
    return Array.from(filesPanel.querySelectorAll('[data-select-path]')).filter(box => !box.closest('[hidden]'));
  }
  function updateSelection() {
    const boxes = visibleCheckboxes();
    const visiblePaths = new Set(boxes.map(box => box.dataset.selectPath));
    for (const path of selectedPaths) if (!visiblePaths.has(path)) selectedPaths.delete(path);
    for (const box of boxes) {
      box.checked = selectedPaths.has(box.dataset.selectPath);
      box.closest('[data-file], .folder-item').classList.toggle('is-selected', box.checked);
    }
    const all = document.getElementById('select-visible');
    all.checked = boxes.length > 0 && selectedPaths.size === boxes.length;
    all.indeterminate = selectedPaths.size > 0 && selectedPaths.size < boxes.length;
    all.disabled = !boxes.length;
    document.getElementById('selection-count').textContent = selectedPaths.size + ' mục đã chọn';
    document.getElementById('deselect-all').disabled = !selectedPaths.size;
  }
  filesPanel.addEventListener('change', event => {
    const path = event.target.dataset.selectPath;
    if (path === undefined) return;
    if (event.target.checked) selectedPaths.add(path); else selectedPaths.delete(path);
    updateSelection();
  });
  document.getElementById('select-visible').addEventListener('change', event => {
    selectedPaths.clear();
    if (event.target.checked) visibleCheckboxes().forEach(box => selectedPaths.add(box.dataset.selectPath));
    updateSelection();
  });
  document.getElementById('deselect-all').addEventListener('click', () => { selectedPaths.clear(); updateSelection(); });
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
      const parent = row.dataset.name.includes('/') ? row.dataset.name.slice(0, row.dataset.name.lastIndexOf('/')) : '';
      const inFolder = !folderMode || (query ? row.dataset.name.startsWith(currentFolder ? currentFolder + '/' : '') : parent === currentFolder);
      return inFolder && normalize(searchable).includes(query) && (backupFilter === 'all' || row.dataset.name.startsWith('backup-history/') === (backupFilter === 'history'));
    });
    const visible = matches.length;
    const pages = Math.max(1, Math.ceil(visible / pageSize));
    page = Math.min(page, pages);
    const shown = new Set(matches.slice((page - 1) * pageSize, page * pageSize));
    for (const row of all) {
      row.hidden = !shown.has(row);
      const name = row.dataset.name;
      const history = name.startsWith('backup-history/');
      row.draggable = !history;
      if (!row.querySelector('[data-select-path]')) row.querySelector('.file-main').prepend(selectionCheckbox(name));
      const parent = name.includes('/') ? name.slice(0, name.lastIndexOf('/')) : 'Thư mục gốc';
      row.querySelector('.file-path').textContent = history ? 'Lịch sử · ' + parent.replace(/^backup-history\/([^/]+)\/?/, (_, stamp) => stamp.replace(/_UTC\+7_.*/, ' (GMT+7)').replace('_', ' ') + ' · ') : parent;
      list.append(row);
    }
    document.getElementById('visible-count').textContent = visible ? ((page - 1) * pageSize + 1) + '–' + Math.min(page * pageSize, visible) + ' / ' + visible + ' tệp' : '0 tệp';
    document.getElementById('page-label').textContent = page + ' / ' + pages;
    document.getElementById('previous-page').disabled = page <= 1;
    document.getElementById('next-page').disabled = page >= pages;
    document.querySelector('.pagination').hidden = pages <= 1;
    const childCount = renderFolderNavigation(query);
    updateSelection();
    document.getElementById('file-count').textContent = visible;
    document.getElementById('empty-state').hidden = visible > 0 || childCount > 0;
    document.getElementById('empty-title').textContent = all.length ? 'Không tìm thấy tệp phù hợp' : 'Kho lưu trữ đang trống';
    document.getElementById('empty-message').textContent = all.length ? 'Thử tên khác hoặc xóa bộ lọc để xem tất cả tệp.' : 'Đồng bộ từ ứng dụng VBook hoặc Legado để bản sao lưu xuất hiện tại đây.';
    if (folderMode && !query) {
      document.getElementById('empty-title').textContent = 'Thư mục đang trống';
      document.getElementById('empty-message').textContent = 'Tạo thư mục con hoặc tải tệp vào đây.';
    }
    document.getElementById('clear-search').hidden = !query && backupFilter === 'all';
  }
  search.addEventListener('input', () => { page = 1; filterAndSort(); });
  sort.addEventListener('change', () => { page = 1; filterAndSort(); });
  document.querySelectorAll('[data-backup-filter]').forEach(button => button.addEventListener('click', () => {
    backupFilter = button.dataset.backupFilter; folderMode = false; page = 1;
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
      renderFolders(data.folders || []);
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
    if (folderMode) document.getElementById('upload-folder').value = currentFolder;
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
    if (segments[0] === 'backup-history') { uploadStatus.textContent = 'Không thể tải vào thư mục lịch sử.'; return; }
    const paths = files.map(file => (segments.length ? segments.join('/') + '/' : '') + file.name);
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
      uploadDialog.close();
      showToast('Đã tải lên ' + files.length + ' tệp.');
    } catch (error) {
      const messages = { '401': 'Phiên đăng nhập không hợp lệ.', '403': 'Không có quyền upload vào đường dẫn này.', '411': 'Trình duyệt không gửi kích thước tệp.', '413': 'Tệp vượt quá giới hạn cho phép.', '507': 'Tài khoản không còn đủ dung lượng.', abort: 'Đã hủy upload.', timeout: 'Upload quá thời gian chờ.', network: 'Mất kết nối khi upload.' };
      uploadStatus.textContent = messages[error.message] || 'Upload thất bại (HTTP ' + error.message + ').';
      showToast(uploadStatus.textContent, 'error');
    } finally {
      activeUpload = null;
      document.getElementById('start-upload').disabled = false;
    }
  });

  const extensionDialog = document.getElementById('extension-dialog');
  list.addEventListener('click', async event => {
    const button = event.target.closest('.extension-link');
    if (!button) return;
    button.disabled = true;
    try {
      const response = await fetchWithTimeout('/api/extensions', { method: 'POST', headers: { 'X-VBook-Action': 'extensions' } });
      if (!response.ok) throw new Error('link');
      const data = await response.json();
      const path = button.closest('[data-file]').dataset.name.slice('vbookext/'.length);
      document.getElementById('extension-url').value = data.baseUrl + encodePath(path);
      extensionDialog.showModal();
    } catch { showToast('Chưa lấy được link extension. Hãy thử lại.', 'error'); }
    finally { button.disabled = false; }
  });
  document.getElementById('close-extension').onclick = () => extensionDialog.close();
  document.getElementById('copy-extension').onclick = async () => {
    const input = document.getElementById('extension-url');
    try { await navigator.clipboard.writeText(input.value); showToast('Đã sao chép link extension.'); }
    catch { input.focus(); input.select(); showToast('Hãy sao chép link trong ô đã chọn.'); }
  };
  document.getElementById('revoke-extension').onclick = async () => {
    if (!confirm('Thu hồi tất cả link extension đã tạo? Các link đang dùng trong vBook sẽ ngừng hoạt động.')) return;
    try {
      const response = await fetchWithTimeout('/api/extensions', { method: 'DELETE', headers: { 'X-VBook-Action': 'extensions' } });
      if (!response.ok) throw new Error('revoke');
      document.getElementById('extension-url').value = ''; extensionDialog.close(); showToast('Đã thu hồi link extension.');
    } catch { showToast('Chưa thu hồi được link extension.', 'error'); }
  };

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
  const driveFolderInput = document.getElementById('drive-folder-url');
  const driveSourceLink = document.getElementById('drive-source-link');
  const disconnectDrive = document.getElementById('disconnect-drive');
  function setDriveStatus(message, type = 'info') {
    driveStatus.textContent = message;
    driveStatus.dataset.type = type;
    if (type === 'error') requestAnimationFrame(() => driveStatus.scrollIntoView({ block: 'nearest' }));
  }
  function driveRequest(method, body) {
    return fetchWithTimeout('/api/drive', { method, headers: { 'X-VBook-Action': 'drive', ...(body ? { 'Content-Type': 'application/json' } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
  }
  async function loadDriveStatus() {
    setDriveStatus('Đang kiểm tra cấu hình…');
    try {
      const response = await fetchWithTimeout('/api/drive', {});
      if (!response.ok) throw new Error();
      const data = await response.json();
      setDriveStatus(!data.available ? 'Máy chủ chưa bật lưu khóa an toàn. Liên hệ người vận hành.' : data.configured ? 'Đã liên kết một thư mục Google Drive.' : 'Chưa liên kết thư mục Google Drive.', data.available ? 'info' : 'error');
      driveConnection.hidden = !data.configured;
      disconnectDrive.hidden = !data.configured;
      document.getElementById('drive-webdav-url').value = data.url;
      driveFolderInput.value = data.folderUrl || '';
      driveSourceLink.href = data.folderUrl || '#';
    } catch { setDriveStatus('Không đọc được trạng thái Google Drive.', 'error'); }
  }
  document.getElementById('manage-drive').addEventListener('click', () => { driveDialog.showModal(); void loadDriveStatus(); });
  driveDialog.addEventListener('close', () => { document.getElementById('drive-api-key').value = ''; });
  document.getElementById('close-drive').addEventListener('click', () => driveDialog.close());
  document.getElementById('drive-form').addEventListener('submit', async event => {
    event.preventDefault();
    setDriveStatus('Đang kiểm tra thư mục Google Drive…');
    const submit = event.currentTarget.querySelector('[type=submit]');
    submit.disabled = true;
    try {
    const response = await driveRequest('PUT', { url: driveFolderInput.value, apiKey: document.getElementById('drive-api-key').value });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) { setDriveStatus(data.error || 'Không liên kết được Google Drive.', 'error'); return; }
    setDriveStatus('Đã liên kết thư mục Google Drive.', 'success');
    driveConnection.hidden = false;
    disconnectDrive.hidden = false;
    document.getElementById('drive-webdav-url').value = data.url;
    driveFolderInput.value = data.folderUrl;
    driveSourceLink.href = data.folderUrl;
    document.getElementById('drive-api-key').value = '';
    showToast('Đã liên kết Google Drive với WebDAV.');
    } catch { setDriveStatus('Không kết nối được máy chủ. Vui lòng thử lại.', 'error'); }
    finally { submit.disabled = false; }
  });
  disconnectDrive.addEventListener('click', async () => {
    if (!confirm('Ngắt liên kết Google Drive khỏi tài khoản này?')) return;
    const response = await driveRequest('DELETE');
    if (!response.ok) { showToast('Không ngắt được liên kết Google Drive.', 'error'); return; }
    driveFolderInput.value = '';
    driveSourceLink.href = '#';
    driveConnection.hidden = true;
    disconnectDrive.hidden = true;
    driveStatus.textContent = 'Chưa liên kết thư mục Google Drive.';
    showToast('Đã ngắt liên kết Google Drive.');
  });

  let draggedPath = null;
  let moving = false;
  let groupMoving = false;
  const dropTarget = event => event.target.closest('[data-open-folder]');
  filesPanel.addEventListener('dragstart', event => {
    const item = event.target.closest('[data-file], [data-move-source]');
    if (!item || moving || groupMoving || busy.size) { event.preventDefault(); return; }
    const path = item.dataset.moveSource || item.dataset.name;
    if (!path || path.startsWith('backup-history/')) { event.preventDefault(); return; }
    draggedPath = path;
    event.dataTransfer.effectAllowed = 'move';
    event.dataTransfer.setData('application/x-vbook-path', path);
  });
  function clearDropHighlight() { filesPanel.querySelectorAll('.drop-target').forEach(item => item.classList.remove('drop-target')); }
  filesPanel.addEventListener('dragend', () => { draggedPath = null; clearDropHighlight(); });
  filesPanel.addEventListener('dragover', event => {
    const target = dropTarget(event);
    if (!draggedPath || !target || moving) return;
    event.preventDefault(); event.dataTransfer.dropEffect = 'move';
    clearDropHighlight(); target.classList.add('drop-target');
  });
  filesPanel.addEventListener('dragleave', event => {
    const target = dropTarget(event);
    if (target && !target.contains(event.relatedTarget)) target.classList.remove('drop-target');
  });
  filesPanel.addEventListener('drop', async event => {
    const target = dropTarget(event);
    if (!draggedPath || !target) return;
    event.preventDefault();
    const source = draggedPath;
    const folder = target.dataset.openFolder;
    draggedPath = null; clearDropHighlight();
    await moveSelection(source, folder);
  });
  async function moveSelection(source, folder) {
    if (groupMoving || moving) return;
    const paths = selectedPaths.has(source) ? [...selectedPaths] : [source];
    // Moving a parent already includes its selected descendants.
    const roots = paths.filter(path => !paths.some(parent => path.startsWith(parent + '/')));
    if (roots.some(path => path.startsWith('backup-history/') || folder === path || folder.startsWith(path + '/'))) {
      showToast('Bỏ chọn lịch sử hoặc thư mục đích trước khi di chuyển nhóm.', 'error'); return;
    }
    groupMoving = true;
    let completed = 0;
    try {
      for (const path of roots) {
        if (!await moveItem(path, folder)) break;
        selectedPaths.delete(path); completed++;
      }
      if (roots.length > 1 && completed) showToast('Đã chuyển ' + completed + '/' + roots.length + ' mục.' + (completed < roots.length ? ' Các mục còn lại chưa chuyển xong; hãy làm mới để kiểm tra.' : ''), completed < roots.length ? 'pending' : undefined);
    } finally { groupMoving = false; updateSelection(); }
  }
  async function moveItem(source, folder) {
    const destination = (folder ? folder + '/' : '') + baseName(source);
    if (moving) return false;
    if (source === destination) return true;
    if (folder === source || folder.startsWith(source + '/')) {
      showToast('Không thể chuyển thư mục vào chính nó hoặc thư mục con của nó.', 'error'); return;
    }
    moving = true; filesPanel.setAttribute('aria-busy', 'true');
    let completed = false;
    try {
      const response = await fetchWithTimeout('/webdav/' + encodePath(source), {
        method: 'MOVE', headers: { Destination: new URL('/webdav/' + encodePath(destination), location.origin).href, Overwrite: 'F' }
      }, 60000);
      if (response.status === 202) {
        showToast('Đang chuyển thư mục. Máy chủ sẽ tiếp tục xử lý; bấm Làm mới để kiểm tra.', 'pending');
      } else if (response.ok) {
        completed = true;
        showToast('Đã chuyển ' + baseName(source) + ' vào ' + (folder || 'thư mục gốc') + '.');
      } else {
        showToast(response.status === 412 ? 'Thư mục đích đã có tệp hoặc thư mục trùng tên.' : response.status === 409 ? 'Không thể chuyển vào thư mục này. Hãy làm mới danh sách.' : 'Chưa chuyển xong. Hãy làm mới danh sách để kiểm tra trước khi thử lại.', 'error');
      }
      await refreshFiles(true);
    } catch {
      showToast('Chưa xác nhận được kết quả chuyển. Máy chủ có thể vẫn đang xử lý; hãy làm mới danh sách.', 'pending');
    } finally { moving = false; filesPanel.removeAttribute('aria-busy'); }
    return completed;
  }

  // Long press starts a touch drag; ordinary swipes remain available for scrolling.
  let touchDrag = null;
  let suppressClickUntil = 0;
  function endTouchDrag() {
    if (touchDrag) { clearTimeout(touchDrag.timer); touchDrag.ghost?.remove(); }
    touchDrag = null; clearDropHighlight();
  }
  filesPanel.addEventListener('touchstart', event => {
    endTouchDrag();
    if (event.touches.length !== 1 || moving || groupMoving || busy.size || event.target.closest('.file-actions, .item-select')) return;
    const item = event.target.closest('[data-file], [data-move-source]');
    const path = item?.dataset.moveSource || item?.dataset.name;
    if (!path || path.startsWith('backup-history/')) return;
    const touch = event.touches[0];
    const drag = { path, x: touch.clientX, y: touch.clientY, active: false, target: null };
    drag.timer = setTimeout(() => {
      if (touchDrag !== drag) return;
      drag.active = true;
      drag.ghost = document.createElement('div'); drag.ghost.className = 'touch-drag-label';
      drag.ghost.textContent = baseName(path); document.body.append(drag.ghost);
      drag.ghost.style.left = drag.x + 'px'; drag.ghost.style.top = drag.y + 'px';
    }, 400);
    touchDrag = drag;
  }, { passive: true });
  filesPanel.addEventListener('touchmove', event => {
    if (!touchDrag) return;
    if (event.touches.length !== 1) { endTouchDrag(); return; }
    const touch = event.touches[0];
    if (!touchDrag.active) {
      if (Math.hypot(touch.clientX - touchDrag.x, touch.clientY - touchDrag.y) > 8) endTouchDrag();
      return;
    }
    event.preventDefault();
    touchDrag.ghost.style.left = touch.clientX + 'px'; touchDrag.ghost.style.top = touch.clientY + 'px';
    touchDrag.target = document.elementFromPoint(touch.clientX, touch.clientY)?.closest('[data-open-folder]');
    clearDropHighlight(); touchDrag.target?.classList.add('drop-target');
    if (touch.clientY < 60) window.scrollBy(0, -18);
    else if (touch.clientY > innerHeight - 60) window.scrollBy(0, 18);
  }, { passive: false });
  filesPanel.addEventListener('touchend', event => {
    if (!touchDrag) return;
    const { active, path, target } = touchDrag;
    if (active) { event.preventDefault(); suppressClickUntil = Date.now() + 700; }
    endTouchDrag();
    if (active && target) void moveSelection(path, target.dataset.openFolder);
  }, { passive: false });
  filesPanel.addEventListener('touchcancel', endTouchDrag);
  filesPanel.addEventListener('contextmenu', event => { if (touchDrag) event.preventDefault(); });
  filesPanel.addEventListener('click', event => {
    if (Date.now() < suppressClickUntil) { event.preventDefault(); event.stopImmediatePropagation(); }
  }, true);
  document.addEventListener('keydown', event => { if (event.key === 'Escape') { endTouchDrag(); draggedPath = null; selectedPaths.clear(); updateSelection(); } });

  // Files from the device can be dropped directly on the panel or a destination folder.
  filesPanel.addEventListener('dragover', event => {
    if (!event.dataTransfer?.types.includes('Files')) return;
    event.preventDefault(); event.dataTransfer.dropEffect = 'copy';
  });
  filesPanel.addEventListener('drop', event => {
    if (!event.dataTransfer?.types.includes('Files')) return;
    event.preventDefault();
    if (activeUpload) return;
    if (Array.from(event.dataTransfer.items).some(item => item.webkitGetAsEntry?.()?.isDirectory)) {
      showToast('Hãy chọn các tệp bên trong thư mục để tải lên.', 'error'); return;
    }
    if (!event.dataTransfer.files.length) return;
    const target = dropTarget(event);
    document.getElementById('upload-folder').value = target ? target.dataset.openFolder : (folderMode ? currentFolder : '');
    updateUploadSelection(event.dataTransfer.files);
    uploadStatus.textContent = 'Đã nhận ' + selectedUploadFiles.length + ' tệp được thả.';
    uploadProgress.hidden = true;
    uploadDialog.showModal();
  });

  const folderDialog = document.getElementById('folder-dialog');
  const folderStatus = document.getElementById('folder-status');
  function renderFolders(folders) {
    knownFolders = folders;
    const options = document.getElementById('upload-folders');
    options.replaceChildren();
    for (const folder of folders) {
      const option = document.createElement('option'); option.value = folder; options.append(option);
    }
  }
  function openFolder(folder) {
    currentFolder = folder; folderMode = true; backupFilter = 'all'; page = 1; search.value = '';
    document.querySelectorAll('[data-backup-filter]').forEach(item => item.setAttribute('aria-pressed', String(item.dataset.backupFilter === 'all')));
    filterAndSort();
  }
  function renderFolderNavigation(query) {
    const container = document.getElementById('folder-list');
    const breadcrumb = document.getElementById('folder-breadcrumb');
    container.replaceChildren(); breadcrumb.replaceChildren();
    document.getElementById('toggle-folder-view').textContent = folderMode ? 'Xem tất cả tệp' : 'Duyệt thư mục';
    document.getElementById('toggle-folder-view').setAttribute('aria-pressed', String(!folderMode));
    document.getElementById('files-title').textContent = folderMode ? (currentFolder ? baseName(currentFolder) : 'Thư mục gốc') : 'Tất cả tệp';
    const crumb = (name, path, active) => {
      const button = document.createElement('button'); button.type = 'button'; button.className = 'btn';
      button.textContent = name; button.dataset.openFolder = path;
      if (active) button.setAttribute('aria-current', 'location');
      breadcrumb.append(button);
    };
    crumb('Thư mục gốc', '', folderMode && !currentFolder);
    const parts = folderMode && currentFolder ? currentFolder.split('/') : [];
    parts.forEach((part, index) => {
      const separator = document.createElement('span'); separator.textContent = '/'; separator.setAttribute('aria-hidden', 'true'); breadcrumb.append(separator);
      crumb(part, parts.slice(0, index + 1).join('/'), index === parts.length - 1);
    });
    const prefix = currentFolder ? currentFolder + '/' : '';
    const children = knownFolders.filter(folder => (!folderMode || (folder.startsWith(prefix) && !folder.slice(prefix.length).includes('/'))) && normalize(folder).includes(query));
    for (const folder of children) {
      const button = document.createElement('button'); button.type = 'button'; button.className = 'btn folder-target'; button.dataset.openFolder = folder; button.draggable = true; button.dataset.moveSource = folder;
      button.setAttribute('aria-label', 'Mở thư mục ' + (folderMode ? baseName(folder) : folder));
      const icon = document.createElementNS('http://www.w3.org/2000/svg', 'svg'); icon.setAttribute('viewBox', '0 0 24 24'); icon.setAttribute('aria-hidden', 'true');
      const path = document.createElementNS('http://www.w3.org/2000/svg', 'path'); path.setAttribute('d', 'M3 7V4h6l3 3h9v13H3V7Z'); icon.append(path);
      const label = document.createElement('span'); label.textContent = folderMode ? baseName(folder) : folder;
      button.append(icon, label);
      const item = document.createElement('div'); item.className = 'folder-item';
      item.append(selectionCheckbox(folder), button); container.append(item);
    }
    return children.length;
  }
  for (const id of ['folder-list', 'folder-breadcrumb']) document.getElementById(id).addEventListener('click', event => {
    const target = event.target.closest('[data-open-folder]');
    if (target) openFolder(target.dataset.openFolder);
  });
  document.getElementById('toggle-folder-view').addEventListener('click', () => {
    folderMode = !folderMode; page = 1; filterAndSort();
  });
  document.getElementById('new-folder').addEventListener('click', () => {
    folderStatus.textContent = '';
    document.getElementById('folder-path').value = '';
    document.getElementById('folder-parent').textContent = 'Tạo trong: ' + (folderMode && currentFolder ? currentFolder + '/' : 'Thư mục gốc');
    folderDialog.showModal(); document.getElementById('folder-path').focus();
  });
  document.getElementById('close-folder').addEventListener('click', () => folderDialog.close());
  document.getElementById('folder-form').addEventListener('submit', async event => {
    event.preventDefault();
    const relative = document.getElementById('folder-path').value.trim().replace(/^\/+|\/+$/g, '');
    if (!relative) { folderStatus.textContent = 'Hãy nhập tên thư mục.'; return; }
    const parent = folderMode ? currentFolder : '';
    const path = (parent ? parent + '/' : '') + relative;
    const parts = path.split('/');
    if (!path || parts[0] === 'backup-history' || parts.some(part => !part || part === '.' || part === '..' || /[\\\u0000-\u001f\u007f]/.test(part))) {
      folderStatus.textContent = 'Đường dẫn thư mục không hợp lệ.'; return;
    }
    const submit = event.currentTarget.querySelector('[type=submit]'); submit.disabled = true;
    try {
      for (let index = 1; index <= parts.length; index++) {
        const response = await fetchWithTimeout('/webdav/' + parts.slice(0, index).map(encodeURIComponent).join('/') + '/', { method: 'MKCOL' });
        if (!response.ok) throw new Error(String(response.status));
      }
      document.getElementById('upload-folder').value = path;
      await refreshFiles(true);
      openFolder(parent);
      folderDialog.close(); showToast('Đã tạo thư mục ' + path + '.');
    } catch (error) {
      folderStatus.textContent = error.message === '405' ? 'Có tệp trùng tên với thư mục này.' : 'Chưa tạo được đầy đủ thư mục. Hãy làm mới danh sách và thử lại.';
    } finally { submit.disabled = false; }
  });
  filterAndSort();
})();
`;
