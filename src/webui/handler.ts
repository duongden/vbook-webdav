import { Context } from 'hono';
import { html } from 'hono/html';
import { Env, UserConfig } from '../types';

export const webuiHandler = async (c: Context<{ Bindings: Env; Variables: { user: UserConfig; username: string } }>) => {
  const username = c.get('username');
  const user = c.get('user');

  // List user files
  const prefix = `${username}/`;
  const listed = await c.env.STORAGE_R2.list({ prefix });
  
  let currentUsageBytes = 0;
  const files = listed.objects.filter(obj => !obj.key.endsWith('/')).map(obj => {
    currentUsageBytes += obj.size;
    return {
      name: obj.key.substring(prefix.length),
      size: obj.size,
      date: obj.uploaded.toLocaleString()
    };
  });

  // Seed/update the KV usage cache with the calculated value
  c.executionCtx.waitUntil(c.env.USER_KV.put(`usage:${username}`, currentUsageBytes.toString()));

  const quotaBytes = (user.quota_mb || 500) * 1024 * 1024;
  const usagePercent = Math.min(100, Math.round((currentUsageBytes / quotaBytes) * 100));

  function formatBytes(bytes: number) {
    if (bytes === 0) return '0 B';
    const k = 1024;
    const sizes = ['B', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
  }

  /** SECURITY: Escape user-controlled strings before inserting into HTML to prevent XSS. */
  function escapeHtml(str: string): string {
    return str
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#x27;');
  }

  function encodePath(path: string) {
    return path.split('/').map(encodeURIComponent).join('/');
  }

  const page = html`
    <!DOCTYPE html>
    <html lang="en" class="dark">
    <head>
      <meta charset="UTF-8">
      <meta name="viewport" content="width=device-width, initial-scale=1.0">
      <title>My Cloud Drive</title>
      <script src="https://cdn.tailwindcss.com"></script>
      <script>
        tailwind.config = {
          darkMode: 'class',
          theme: {
            extend: {
              colors: {
                crimson: '#e11d48',
              }
            }
          }
        }
      </script>
      <style>
        body { font-family: 'Inter', sans-serif; background-color: #0f172a; color: #f8fafc; }
        .glass { background: rgba(30, 41, 59, 0.7); backdrop-filter: blur(10px); border: 1px solid rgba(255, 255, 255, 0.1); }
      </style>
      <link href="https://fonts.googleapis.com/css2?family=Inter:wght@300;400;500;600;700&display=swap" rel="stylesheet">
    </head>
    <body class="min-h-screen p-4 md:p-8">
      <div class="max-w-4xl mx-auto">
        <header class="flex justify-between items-center mb-8 glass p-6 rounded-2xl shadow-xl">
          <div>
            <h1 class="text-2xl font-bold text-transparent bg-clip-text bg-gradient-to-r from-crimson to-pink-500">
              Vân Du
            </h1>
            <p class="text-slate-400 text-sm mt-1">Welcome back, <span class="text-white font-medium">${username}</span></p>
          </div>
          <div class="text-right">
            <div class="text-sm text-slate-400 mb-1">Storage Usage</div>
            <div class="flex items-center gap-3">
              <div class="w-32 h-2 bg-slate-700 rounded-full overflow-hidden">
                <div class="h-full bg-crimson" style="width: ${usagePercent}%"></div>
              </div>
              <span class="text-xs font-mono">${formatBytes(currentUsageBytes)} / ${formatBytes(quotaBytes)}</span>
            </div>
          </div>
        </header>

        <main class="glass rounded-2xl shadow-xl overflow-hidden">
          <div class="p-6 border-b border-slate-700/50 flex justify-between items-center">
            <h2 class="font-semibold text-lg">My Files</h2>
            <button onclick="location.reload()" class="text-sm px-3 py-1.5 bg-slate-800 hover:bg-slate-700 rounded-lg transition-colors border border-slate-600">
              Refresh
            </button>
          </div>
          
          <div class="overflow-x-auto">
            <table class="w-full text-left border-collapse">
              <thead>
                <tr class="bg-slate-800/50 text-slate-400 text-sm">
                  <th class="p-4 font-medium">File Name</th>
                  <th class="p-4 font-medium">Size</th>
                  <th class="p-4 font-medium">Uploaded At</th>
                  <th class="p-4 font-medium text-right">Actions</th>
                </tr>
              </thead>
              <tbody class="divide-y divide-slate-700/50">
                ${files.length === 0 ? html`
                  <tr>
                    <td colspan="4" class="p-8 text-center text-slate-500">
                      No files found. Try uploading via VBook or WebDAV client.
                    </td>
                  </tr>
                ` : files.map(f => html`
                  <tr class="hover:bg-slate-800/30 transition-colors">
                    <td class="p-4 font-medium flex items-center gap-3">
                      <svg class="w-5 h-5 text-crimson" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M7 21h10a2 2 0 002-2V9.414a1 1 0 00-.293-.707l-5.414-5.414A1 1 0 0012.586 3H7a2 2 0 00-2 2v14a2 2 0 002 2z"></path></svg>
                      ${escapeHtml(f.name)}
                    </td>
                    <td class="p-4 text-sm text-slate-400">${formatBytes(f.size)}</td>
                    <td class="p-4 text-sm text-slate-400">${escapeHtml(f.date)}</td>
                    <td class="p-4 text-right">
                      <a href="/webdav/${encodePath(f.name)}" target="_blank" class="inline-block px-3 py-1 bg-slate-700 hover:bg-slate-600 text-white text-xs rounded transition-colors mr-2">Download</a>
                      <button onclick="deleteFile(this.dataset.name)" data-name="${escapeHtml(f.name)}" class="px-3 py-1 bg-crimson/20 text-crimson hover:bg-crimson hover:text-white text-xs rounded transition-colors border border-crimson/30">Delete</button>
                    </td>
                  </tr>
                `)}
              </tbody>
            </table>
          </div>
        </main>
      </div>

      <script>
        function encodePath(path) {
          return path.split('/').map(encodeURIComponent).join('/');
        }
        async function deleteFile(name) {
          if (!confirm('Are you sure you want to delete ' + name + '?')) return;
          try {
            const res = await fetch('/webdav/' + encodePath(name), { method: 'DELETE' });
            if (res.ok) {
              window.location.reload();
            } else {
              alert('Failed to delete file.');
            }
          } catch (e) {
            alert('Error deleting file.');
          }
        }
      </script>
    </body>
    </html>
  `;

  return c.html(page);
};
