import { Context } from 'hono';
import { html } from 'hono/html';
import { AppEnv } from '../types';
import { getUsage } from '../storage/client';

export const webuiHandler = async (c: Context<AppEnv>) => {
  const username = c.get('username');
  const user = c.get('user');

  // List user files
  const prefix = `${username}/`;
  let listOptions: R2ListOptions = { prefix };
  let listed;
  const allObjects = [];

  do {
    listed = await c.env.STORAGE_R2.list(listOptions);
    allObjects.push(...listed.objects);
    listOptions.cursor = listed.truncated ? listed.cursor : undefined;
  } while (listed.truncated);

  const currentUsageBytes = await getUsage(c.env, username);
  const files = allObjects.filter(obj => !obj.key.endsWith('/')).map(obj => {
    return {
      name: obj.key.substring(prefix.length),
      size: obj.size,
      date: obj.uploaded.toLocaleString()
    };
  });

  c.header('Cache-Control', 'no-store');

  const quotaBytes = (user.quota_mb || 500) * 1024 * 1024;
  const usagePercent = Math.min(100, Math.round((currentUsageBytes / quotaBytes) * 100));

  function formatBytes(bytes: number) {
    if (bytes === 0) return '0 B';
    const k = 1024;
    const sizes = ['B', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
  }

  function encodePath(path: string) {
    return path.split('/').map(encodeURIComponent).join('/');
  }

  const page = html`
    <!DOCTYPE html>
    <html lang="en">
    <head>
      <meta charset="UTF-8">
      <meta name="viewport" content="width=device-width, initial-scale=1.0">
      <title>My Cloud Drive</title>
      <script src="https://cdn.tailwindcss.com"></script>
      <script>
        tailwind.config = {
          theme: { extend: { colors: { base: '#fbfbfb', primary: '#fae87a', secondary: '#fcf6c6', info: '#80c6f9', danger: '#e43b12' } } }
        }
      </script>
      <style>
        body { font-family: system-ui, sans-serif; background-color: #fbfbfb; color: #333;
          background-image: linear-gradient(rgba(128,198,249,0.15) 1px, transparent 1px), linear-gradient(90deg, rgba(128,198,249,0.15) 1px, transparent 1px); background-size: 24px 24px; }
        .glass { background: rgba(255,255,255,0.85); backdrop-filter: blur(12px); border: 1px solid rgba(250,232,122,0.6); box-shadow: 0 10px 25px -5px rgba(0,0,0,0.05); }
        .file-card { background: #ffffff; border: 1px solid #e2e8f0; transition: all 0.2s; box-shadow: 0 1px 3px rgba(0,0,0,0.05); }
        .file-card:hover { transform: translateY(-2px); box-shadow: 0 10px 15px -3px rgba(0,0,0,0.1); border-color: #80c6f9; }

        #toast { position: fixed; bottom: 24px; right: 24px; padding: 14px 24px; border-radius: 12px;
                 font-size: 0.875rem; font-weight: 600; opacity: 0; transform: translateY(12px); color: #fff;
                 transition: all 0.3s cubic-bezier(0.16, 1, 0.3, 1); pointer-events: none; z-index: 999; box-shadow: 0 10px 15px -3px rgba(0,0,0,0.1); }
        #toast.show { opacity: 1; transform: translateY(0); }
        .toast-success { background: #10b981; }
        .toast-error { background: #e43b12; }
      </style>
    </head>
    <body class="min-h-screen p-4 md:p-8">
      <div id="toast"></div>

      <div class="max-w-4xl mx-auto space-y-6">
        <header class="flex flex-col sm:flex-row justify-between items-center glass p-6 rounded-2xl relative overflow-hidden">
          <div class="absolute inset-0 bg-gradient-to-r from-primary/20 to-transparent pointer-events-none"></div>
          <div class="relative z-10 text-center sm:text-left mb-4 sm:mb-0">
            <h1 class="text-2xl font-bold text-slate-800 flex items-center gap-2 justify-center sm:justify-start">
              <span class="text-3xl">☁️</span> Vbook WebDAV Cloud
            </h1>
            <p class="text-slate-500 text-sm mt-1">Logged in as <span class="font-bold text-slate-700">${username}</span></p>
          </div>
          <div class="relative z-10 w-full sm:w-auto bg-white/60 p-4 rounded-xl border border-secondary">
            <div class="text-xs text-slate-500 mb-1.5 font-medium uppercase tracking-wider">Storage Usage</div>
            <div class="flex items-center gap-3">
              <div class="w-full sm:w-32 h-2 bg-slate-200 rounded-full overflow-hidden shadow-inner">
                <div class="h-full bg-info" style="width: ${usagePercent}%"></div>
              </div>
              <span class="text-sm font-bold text-slate-700 whitespace-nowrap">${formatBytes(currentUsageBytes)} / ${formatBytes(quotaBytes)}</span>
            </div>
          </div>
        </header>

        <main class="glass rounded-2xl p-6">
          <div class="flex justify-between items-center mb-6">
            <h2 class="font-bold text-lg text-slate-800">My Files</h2>
            <button onclick="location.reload()" class="flex items-center gap-2 text-sm px-4 py-2 bg-white hover:bg-slate-50 text-slate-700 font-medium rounded-lg transition-all border border-slate-200 shadow-sm">
              <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15"></path></svg>
              Refresh
            </button>
          </div>

          <div class="grid grid-cols-1 md:grid-cols-2 gap-4">
            ${files.length === 0 ? html`
              <div class="col-span-full py-16 text-center bg-white/50 rounded-xl border border-dashed border-slate-300">
                <div class="text-4xl mb-3">📭</div>
                <h3 class="text-slate-700 font-bold text-lg mb-1">No files found</h3>
                <p class="text-slate-500 text-sm max-w-sm mx-auto">Upload files directly from the VBook or Legado apps using the WebDAV integration.</p>
              </div>
            ` : files.map(f => html`
              <div class="file-card p-4 rounded-xl flex flex-col justify-between" id="file-${f.name}">
                <div class="flex items-start gap-3 mb-4">
                  <div class="p-2 bg-secondary/50 rounded-lg text-yellow-600">
                    <svg class="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z"></path></svg>
                  </div>
                  <div class="flex-1 min-w-0">
                    <h3 class="font-bold text-slate-800 text-sm truncate" title="${f.name}">${f.name}</h3>
                    <div class="flex items-center gap-3 mt-1 text-xs text-slate-500">
                      <span class="font-medium bg-slate-100 px-2 py-0.5 rounded">${formatBytes(f.size)}</span>
                      <span>${f.date}</span>
                    </div>
                  </div>
                </div>

                <div class="flex justify-end gap-2 border-t border-slate-100 pt-3 mt-auto">
                  <a href="/webdav/${encodePath(f.name)}" target="_blank"
                    class="px-4 py-1.5 bg-info hover:brightness-95 text-slate-900 font-semibold text-xs rounded-lg transition-all shadow-sm">
                    Download
                  </a>
                  <button onclick="deleteFile(this.dataset.name)" data-name="${f.name}"
                    class="px-4 py-1.5 bg-white text-danger hover:bg-red-50 font-semibold text-xs rounded-lg transition-all border border-danger/30">
                    Delete
                  </button>
                </div>
              </div>
            `)}
          </div>
        </main>
      </div>

      <script>
        function showToast(msg, type) {
          const t = document.getElementById('toast');
          t.textContent = msg;
          t.className = 'toast-' + type;
          t.classList.add('show');
          setTimeout(() => t.classList.remove('show'), 3000);
        }

        function encodePath(path) {
          return path.split('/').map(encodeURIComponent).join('/');
        }

        async function deleteFile(name) {
          if (!confirm('Are you sure you want to delete "' + name + '"?')) return;
          try {
            const res = await fetch('/webdav/' + encodePath(name), { method: 'DELETE' });
            if (res.ok) {
              const card = document.getElementById('file-' + name);
              if (card) {
                card.style.transform = 'scale(0.95)';
                card.style.opacity = '0';
                setTimeout(() => card.remove(), 200);
              }
              showToast('File deleted successfully', 'success');
              setTimeout(() => window.location.reload(), 1500);
            } else if (res.status === 503 && res.headers.get('Retry-After')) {
              showToast('Deletion is still running. Try again shortly.', 'error');
            } else {
              showToast('Failed to delete file', 'error');
            }
          } catch (e) {
            showToast('Error connecting to server', 'error');
          }
        }
      </script>
    </body>
    </html>
  `;

  return c.html(page);
};
