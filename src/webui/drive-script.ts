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
  const busy = new Set();
  let selected = null;
  let toastTimer;
  let refreshing = false;
  let usage = Number(drive.dataset.usage);
  let quota = Number(drive.dataset.quota);
  let estimated = false;
  let needsRefresh = false;

  const rows = () => Array.from(list.querySelectorAll('[data-file]'));
  const encodePath = name => name.split('/').map(encodeURIComponent).join('/');
  const baseName = name => name.slice(name.lastIndexOf('/') + 1);
  const normalize = value => value.toLocaleLowerCase('vi-VN').normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/đ/g, 'd');
  const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
  function formatBytes(bytes) {
    if (!bytes) return '0 B';
    const unit = Math.min(3, Math.max(0, Math.floor(Math.log(bytes) / Math.log(1024))));
    return Number((bytes / 1024 ** unit).toFixed(2)).toLocaleString('vi-VN') + ' ' + ['B', 'KB', 'MB', 'GB'][unit];
  }
  const formatDate = value => new Date(value).toLocaleDateString('vi-VN', { timeZone: 'Asia/Ho_Chi_Minh' });

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
      if (sort.value === 'name') return a.dataset.name.localeCompare(b.dataset.name, 'vi');
      if (sort.value === 'largest') return Number(b.dataset.size) - Number(a.dataset.size);
      return b.dataset.uploaded.localeCompare(a.dataset.uploaded) || a.dataset.name.localeCompare(b.dataset.name, 'vi');
    });
    let visible = 0;
    for (const row of all) {
      row.hidden = !normalize(row.dataset.name).includes(query);
      if (!row.hidden) visible++;
      list.append(row);
    }
    document.getElementById('visible-count').textContent = query ? 'Hiển thị ' + visible + ' / ' + all.length + ' tệp' : 'Hiển thị ' + all.length + ' tệp';
    document.getElementById('empty-state').hidden = visible > 0;
    document.getElementById('empty-title').textContent = all.length ? 'Không tìm thấy tệp phù hợp' : 'Kho lưu trữ đang trống';
    document.getElementById('empty-message').textContent = all.length ? 'Thử tên khác hoặc xóa bộ lọc để xem tất cả tệp.' : 'Đồng bộ từ ứng dụng VBook hoặc Legado để bản sao lưu xuất hiện tại đây.';
    document.getElementById('clear-search').hidden = !query;
  }
  search.addEventListener('input', filterAndSort);
  sort.addEventListener('change', filterAndSort);
  document.getElementById('clear-search').addEventListener('click', () => { search.value = ''; filterAndSort(); search.focus(); });

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
    const button = row.querySelector('.delete-file');
    button.dataset.name = file.name;
    button.setAttribute('aria-label', 'Xóa ' + name);
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
    button.querySelector('span').textContent = state === 'working' ? 'Đang xử lý…' : checking ? 'Kiểm tra lại' : 'Xóa';
    button.setAttribute('aria-label', (checking ? 'Kiểm tra lại ' : 'Xóa ') + baseName(row.dataset.name));
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
  filterAndSort();
})();
`;
