import { Hono } from 'hono';
import { html } from 'hono/html';
import { Env, UserConfig } from '../types';
import { getCookie, setCookie } from 'hono/cookie';
import { hashPassword, generateSalt } from '../utils/crypto';

export const adminApp = new Hono<{ Bindings: Env }>();

// ─── Security Helpers ──────────────────────────────────────────────────────────

/** SECURITY (VULN-08): Generate a random CSRF token for double-submit cookie pattern. */
function generateCsrfToken(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(24));
  return btoa(String.fromCharCode(...bytes)).replace(/[+/=]/g, (c) => ({ '+': '-', '/': '_', '=': '' }[c] ?? c));
}

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/**
 * BUG-05: Session token helpers.
 * Store HMAC-SHA256 signature of the PIN (not the PIN itself) in the cookie.
 * Stateless — no KV needed for verification.
 */
async function generateSessionToken(pin: string): Promise<string> {
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    'raw', encoder.encode(pin), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']
  );
  const sig = await crypto.subtle.sign('HMAC', key, encoder.encode('admin-session-v1'));
  return btoa(String.fromCharCode(...new Uint8Array(sig)));
}

async function verifySessionToken(token: string, pin: string): Promise<boolean> {
  return timingSafeEqual(token, await generateSessionToken(pin));
}

const authMiddleware = async (c: any, next: any) => {
  const token = getCookie(c, 'admin_session');
  if (!token || !await verifySessionToken(token, c.env.ADMIN_PIN)) {
    return c.redirect('/admin/login');
  }
  // Ensure CSRF token cookie is always set for authenticated sessions
  if (!getCookie(c, 'csrf_token')) {
    setCookie(c, 'csrf_token', generateCsrfToken(), {
      path: '/admin',
      secure: true,
      sameSite: 'Strict'
    });
  }
  await next();
};

/** Cache the parsed body in context to avoid consuming the stream twice. */
async function getParsedBody(c: any): Promise<Record<string, unknown>> {
  if (!c.get('_parsedBody')) c.set('_parsedBody', await c.req.parseBody());
  return c.get('_parsedBody') as Record<string, unknown>;
}

/** Validate CSRF: header (fetch) takes priority, falls back to body field (form POST). */
async function validateCsrf(c: any): Promise<boolean> {
  const cookie = getCookie(c, 'csrf_token');
  if (!cookie) return false;
  const token = c.req.header('X-CSRF-Token')
    ?? (await getParsedBody(c))['_csrf'] as string | undefined;
  return !!token && timingSafeEqual(cookie, token);
}

// ─── Login ─────────────────────────────────────────────────────────────────────

adminApp.get('/login', (c) => {
  return c.html(html`
    <!DOCTYPE html>
    <html lang="en" class="dark">
    <head>
      <meta charset="UTF-8">
      <title>Admin Login · Vân Du</title>
      <script src="https://cdn.tailwindcss.com"></script>
      <style>body { background-color: #0f172a; color: white; }</style>
    </head>
    <body class="flex items-center justify-center min-h-screen">
      <form method="POST" action="/admin/login" class="bg-slate-800 p-8 rounded-xl shadow-xl w-96">
        <h2 class="text-2xl font-bold mb-6 text-center text-rose-500">Admin Area</h2>
        <input type="password" name="pin" placeholder="Enter PIN"
          class="w-full bg-slate-900 border border-slate-700 rounded p-3 mb-4 text-white focus:outline-none focus:border-rose-500"
          required autofocus>
        <button type="submit"
          class="w-full bg-rose-600 hover:bg-rose-700 text-white font-medium py-3 rounded transition-colors">
          Login
        </button>
      </form>
    </body>
    </html>
  `);
});

adminApp.post('/login', async (c) => {
  // SECURITY (VULN-03): Rate limiting — lock after 5 failed attempts for 15 min
  const ip = c.req.header('CF-Connecting-IP') || c.req.header('X-Forwarded-For') || 'unknown';
  const rateLimitKey = `ratelimit:admin:${ip}`;
  const MAX_ATTEMPTS = 5;
  const LOCKOUT_SECONDS = 15 * 60;

  const attemptsStr = await c.env.USER_KV.get(rateLimitKey);
  const attempts = attemptsStr
    ? JSON.parse(attemptsStr) as { count: number; until: number }
    : { count: 0, until: 0 };

  if (attempts.count >= MAX_ATTEMPTS && Date.now() < attempts.until) {
    const remainingMinutes = Math.ceil((attempts.until - Date.now()) / 60000);
    return c.html(`<!DOCTYPE html><html lang="en" class="dark">
      <head><meta charset="UTF-8"><title>Locked</title>
      <script src="https://cdn.tailwindcss.com"></script>
      <style>body{background:#0f172a;color:white;}</style></head>
      <body class="flex items-center justify-center min-h-screen">
        <div class="bg-slate-800 p-8 rounded-xl shadow-xl w-96 text-center">
          <div class="text-4xl mb-4">🔒</div>
          <h2 class="text-xl font-bold mb-2 text-rose-400">Too Many Attempts</h2>
          <p class="text-slate-400 text-sm">Locked for <strong class="text-white">${remainingMinutes} minute${remainingMinutes > 1 ? 's' : ''}</strong>.</p>
        </div>
      </body></html>`, 429);
  }

  const body = await c.req.parseBody();
  const pin = body['pin'] as string;

  if (pin === c.env.ADMIN_PIN) {
    c.executionCtx.waitUntil(c.env.USER_KV.delete(rateLimitKey));
    const sessionToken = await generateSessionToken(pin);
    setCookie(c, 'admin_session', sessionToken, {
      path: '/', httpOnly: true, secure: true, sameSite: 'Strict'
    });
    return c.redirect('/admin');
  }

  const newCount = (attempts.count < MAX_ATTEMPTS ? attempts.count : 0) + 1;
  const until = newCount >= MAX_ATTEMPTS ? Date.now() + LOCKOUT_SECONDS * 1000 : attempts.until;
  c.executionCtx.waitUntil(
    c.env.USER_KV.put(rateLimitKey, JSON.stringify({ count: newCount, until }), { expirationTtl: LOCKOUT_SECONDS })
  );
  const remaining = MAX_ATTEMPTS - newCount;
  return c.html(`<!DOCTYPE html><html lang="en" class="dark">
    <head><meta charset="UTF-8"><title>Admin Login</title>
    <script src="https://cdn.tailwindcss.com"></script>
    <style>body{background:#0f172a;color:white;}</style></head>
    <body class="flex items-center justify-center min-h-screen">
      <form method="POST" action="/admin/login" class="bg-slate-800 p-8 rounded-xl shadow-xl w-96">
        <h2 class="text-2xl font-bold mb-4 text-center text-rose-500">Admin Area</h2>
        <p class="text-amber-400 text-sm text-center mb-4">
          Invalid PIN. ${remaining > 0 ? `${remaining} attempt${remaining > 1 ? 's' : ''} remaining.` : 'Account locked.'}
        </p>
        <input type="password" name="pin" placeholder="Enter PIN"
          class="w-full bg-slate-900 border border-rose-700 rounded p-3 mb-4 text-white focus:outline-none" required autofocus>
        <button type="submit" class="w-full bg-rose-600 hover:bg-rose-700 text-white font-medium py-3 rounded transition-colors">Login</button>
      </form>
    </body></html>`, 401);
});

// ─── Protected routes ──────────────────────────────────────────────────────────

adminApp.use('*', authMiddleware);

// ─── Dashboard ─────────────────────────────────────────────────────────────────

adminApp.get('/', async (c) => {
  const list = await c.env.USER_KV.list({ prefix: 'user:' });
  const users = (await Promise.all(
    list.keys.map(async (k) => {
      const data = await c.env.USER_KV.get(k.name);
      const username = k.name.substring(5);
      if (data) return { username, ...JSON.parse(data) as UserConfig };
      return null;
    })
  )).filter(Boolean) as Array<{ username: string } & UserConfig>;

  const csrf = getCookie(c, 'csrf_token') || '';

  // Build storage usage per user using KV cache
  const usageMap: Record<string, number> = {};
  await Promise.all(users.map(async (u) => {
    let bytes = 0;
    const cachedUsage = await c.env.USER_KV.get(`usage:${u.username}`);
    if (cachedUsage !== null) {
      bytes = parseInt(cachedUsage, 10) || 0;
    } else {
      let opts: R2ListOptions = { prefix: `${u.username}/` };
      let listed;
      do {
        listed = await c.env.STORAGE_R2.list(opts);
        for (const obj of listed.objects) bytes += obj.size;
        opts.cursor = listed.truncated ? listed.cursor : undefined;
      } while (listed.truncated);
      await c.env.USER_KV.put(`usage:${u.username}`, bytes.toString());
    }
    usageMap[u.username] = bytes;
  }));

  function fmtBytes(b: number) {
    if (b === 0) return '0 B';
    const k = 1024, s = ['B','KB','MB','GB'];
    const i = Math.floor(Math.log(b) / Math.log(k));
    return parseFloat((b / Math.pow(k, i)).toFixed(1)) + ' ' + s[i];
  }

  const page = html`
    <!DOCTYPE html>
    <html lang="en" class="dark">
    <head>
      <meta charset="UTF-8">
      <meta name="viewport" content="width=device-width, initial-scale=1.0">
      <title>Admin Dashboard · Vân Du</title>
      <script src="https://cdn.tailwindcss.com"></script>
      <script>tailwind.config = { darkMode: 'class' }</script>
      <style>
        body { font-family: 'Inter', sans-serif; background-color: #0f172a; color: #f8fafc; }
        .glass { background: rgba(30,41,59,0.7); backdrop-filter: blur(12px); border: 1px solid rgba(255,255,255,0.08); }
        .bar-track { background: rgba(255,255,255,0.07); border-radius: 9999px; overflow: hidden; height: 6px; }
        .bar-fill  { height: 100%; border-radius: 9999px; transition: width 0.4s ease; }
        input, select { transition: border-color 0.15s; }
        input:focus, select:focus { outline: none; border-color: #e11d48 !important; }
        .btn { display: inline-flex; align-items: center; gap: 4px; font-size: 0.75rem;
               padding: 3px 10px; border-radius: 6px; cursor: pointer; transition: all 0.15s; border: 1px solid transparent; }
        .btn-edit    { background: rgba(99,102,241,0.15); color: #a5b4fc; border-color: rgba(99,102,241,0.3); }
        .btn-edit:hover { background: rgba(99,102,241,0.3); }
        .btn-suspend { background: rgba(245,158,11,0.15); color: #fcd34d; border-color: rgba(245,158,11,0.3); }
        .btn-suspend:hover { background: rgba(245,158,11,0.3); }
        .btn-activate{ background: rgba(16,185,129,0.15); color: #6ee7b7; border-color: rgba(16,185,129,0.3); }
        .btn-activate:hover { background: rgba(16,185,129,0.3); }
        .btn-delete  { background: rgba(239,68,68,0.12); color: #fca5a5; border-color: rgba(239,68,68,0.25); }
        .btn-delete:hover { background: rgba(239,68,68,0.3); }
        #toast { position: fixed; bottom: 24px; right: 24px; padding: 12px 20px; border-radius: 10px;
                 font-size: 0.875rem; font-weight: 500; opacity: 0; transform: translateY(8px);
                 transition: all 0.25s; pointer-events: none; z-index: 999; }
        #toast.show { opacity: 1; transform: translateY(0); }
      </style>
    </head>
    <body class="p-4 md:p-8">
      <div id="toast"></div>

      <div class="max-w-6xl mx-auto">
        <header class="flex justify-between items-center mb-8 glass p-5 rounded-2xl">
          <div>
            <h1 class="text-xl font-bold text-rose-500">Admin Dashboard</h1>
            <p class="text-xs text-slate-500 mt-0.5">${users.length} user${users.length !== 1 ? 's' : ''} registered</p>
          </div>
          <a href="/admin/logout" class="text-xs text-slate-500 hover:text-slate-300 transition-colors">Logout →</a>
        </header>

        <div class="grid grid-cols-1 lg:grid-cols-3 gap-6">

          <!-- ── Sidebar: Add / Edit Form ── -->
          <div class="lg:col-span-1">
            <div class="glass p-6 rounded-2xl sticky top-6">
              <h2 id="form-title" class="text-base font-semibold mb-5 text-slate-200">Add New User</h2>
              <form id="user-form" method="POST" action="/admin/user" class="space-y-4">
                <input type="hidden" name="_csrf" value="${csrf}">
                <input type="hidden" name="_mode" id="form-mode" value="create">

                <div>
                  <label class="block text-xs text-slate-400 mb-1.5">Username</label>
                  <input id="f-username" type="text" name="username"
                    class="w-full bg-slate-900/80 border border-slate-700 rounded-lg p-2.5 text-white text-sm"
                    placeholder="e.g. alice" required>
                </div>

                <div>
                  <label class="block text-xs text-slate-400 mb-1.5">
                    Password
                    <span id="pwd-hint" class="text-slate-600 ml-1">(required)</span>
                  </label>
                  <input id="f-password" type="password" name="password"
                    class="w-full bg-slate-900/80 border border-slate-700 rounded-lg p-2.5 text-white text-sm"
                    placeholder="Enter password">
                </div>

                <div class="grid grid-cols-2 gap-3">
                  <div>
                    <label class="block text-xs text-slate-400 mb-1.5">Quota (MB)</label>
                    <input id="f-quota" type="number" name="quota_mb" value="500" min="1"
                      class="w-full bg-slate-900/80 border border-slate-700 rounded-lg p-2.5 text-white text-sm" required>
                  </div>
                  <div>
                    <label class="block text-xs text-slate-400 mb-1.5">Max File (MB)</label>
                    <input id="f-maxfile" type="number" name="max_file_size_mb" value="50" min="1"
                      class="w-full bg-slate-900/80 border border-slate-700 rounded-lg p-2.5 text-white text-sm" required>
                  </div>
                </div>

                <div id="status-row" class="hidden">
                  <label class="block text-xs text-slate-400 mb-1.5">Status</label>
                  <select id="f-status" name="status"
                    class="w-full bg-slate-900/80 border border-slate-700 rounded-lg p-2.5 text-white text-sm">
                    <option value="active">Active</option>
                    <option value="suspended">Suspended</option>
                  </select>
                </div>

                <div class="flex gap-2 pt-1">
                  <button type="submit" id="form-submit-btn"
                    class="flex-1 bg-rose-600 hover:bg-rose-700 text-white font-medium py-2.5 rounded-lg transition-colors text-sm">
                    Save User
                  </button>
                  <button type="button" id="form-cancel-btn" onclick="resetForm()"
                    class="hidden px-4 bg-slate-700 hover:bg-slate-600 text-white font-medium py-2.5 rounded-lg transition-colors text-sm">
                    Cancel
                  </button>
                </div>
              </form>
            </div>
          </div>

          <!-- ── User Table ── -->
          <div class="lg:col-span-2">
            <div class="glass rounded-2xl overflow-hidden">
              <div class="p-5 border-b border-slate-700/50 flex items-center justify-between">
                <h2 class="text-base font-semibold text-slate-200">Users</h2>
                <span class="text-xs text-slate-500">Click <strong class="text-indigo-400">Edit</strong> to modify a user</span>
              </div>
              <div class="overflow-x-auto">
                <table class="w-full text-left">
                  <thead>
                    <tr class="text-slate-500 text-xs uppercase bg-slate-800/60 border-b border-slate-700/50">
                      <th class="px-4 py-3 font-medium">User</th>
                      <th class="px-4 py-3 font-medium">Storage</th>
                      <th class="px-4 py-3 font-medium">Limits</th>
                      <th class="px-4 py-3 font-medium">Status</th>
                      <th class="px-4 py-3 font-medium text-right">Actions</th>
                    </tr>
                  </thead>
                  <tbody class="divide-y divide-slate-700/40 text-sm">
                    ${users.length === 0 ? html`
                      <tr><td colspan="5" class="px-4 py-10 text-center text-slate-600">No users yet. Add one using the form.</td></tr>
                    ` : users.map((u) => {
                      const usageBytes = usageMap[u.username] || 0;
                      const quotaBytes = (u.quota_mb || 500) * 1024 * 1024;
                      const pct = Math.min(100, Math.round(usageBytes / quotaBytes * 100));
                      const barColor = pct > 85 ? '#ef4444' : pct > 60 ? '#f59e0b' : '#10b981';
                      return html`
                      <tr class="hover:bg-slate-800/30 transition-colors group" id="row-${u.username}">
                        <td class="px-4 py-3">
                          <span class="font-semibold text-white">${u.username}</span>
                        </td>
                        <td class="px-4 py-3">
                          <div class="text-xs text-slate-400 mb-1">${fmtBytes(usageBytes)} / ${u.quota_mb} MB</div>
                          <div class="bar-track w-28">
                            <div class="bar-fill" style="width:${pct}%;background:${barColor}"></div>
                          </div>
                        </td>
                        <td class="px-4 py-3 text-xs text-slate-400">
                          <div>Quota: <span class="text-slate-300">${u.quota_mb} MB</span></div>
                          <div>Max file: <span class="text-slate-300">${u.max_file_size_mb} MB</span></div>
                        </td>
                        <td class="px-4 py-3">
                          <span class="text-xs px-2 py-1 rounded-full font-medium
                            ${u.status === 'active'
                              ? 'bg-emerald-900/40 text-emerald-400 border border-emerald-800/50'
                              : 'bg-red-900/30 text-red-400 border border-red-800/50'}">
                            ${u.status}
                          </span>
                        </td>
                        <td class="px-4 py-3 text-right">
                          <div class="flex items-center justify-end gap-1.5">
                            <!-- Edit -->
                            <button type="button" class="btn btn-edit"
                              onclick="editUser(${JSON.stringify(u.username)}, ${u.quota_mb}, ${u.max_file_size_mb}, '${u.status}')">
                              ✏️ Edit
                            </button>

                            <!-- Suspend / Activate toggle -->
                            <form method="POST" action="/admin/suspend" class="inline">
                              <input type="hidden" name="_csrf" value="${csrf}">
                              <input type="hidden" name="username" value="${u.username}">
                              <input type="hidden" name="action" value="${u.status === 'active' ? 'suspend' : 'activate'}">
                              <button type="submit" class="btn ${u.status === 'active' ? 'btn-suspend' : 'btn-activate'}">
                                ${u.status === 'active' ? '⏸ Suspend' : '▶ Activate'}
                              </button>
                            </form>

                            <!-- Delete -->
                            <form method="POST" action="/admin/delete" class="inline"
                              onsubmit="return confirm('Delete user ${u.username} and ALL their files?')">
                              <input type="hidden" name="_csrf" value="${csrf}">
                              <input type="hidden" name="username" value="${u.username}">
                              <button type="submit" class="btn btn-delete">🗑 Delete</button>
                            </form>
                          </div>
                        </td>
                      </tr>
                    `;})}
                  </tbody>
                </table>
              </div>
            </div>
          </div>
        </div>
      </div>

      <script>
        function showToast(msg, color) {
          const t = document.getElementById('toast');
          t.textContent = msg;
          t.style.background = color === 'green' ? 'rgba(16,185,129,0.9)' : color === 'red' ? 'rgba(239,68,68,0.9)' : 'rgba(99,102,241,0.9)';
          t.classList.add('show');
          setTimeout(() => t.classList.remove('show'), 2800);
        }

        function editUser(username, quota, maxFile, status) {
          document.getElementById('form-title').textContent = 'Edit User: ' + username;
          document.getElementById('form-submit-btn').textContent = 'Update User';
          document.getElementById('form-mode').value = 'edit';
          document.getElementById('f-username').value = username;
          document.getElementById('f-username').readOnly = true;
          document.getElementById('f-username').classList.add('opacity-50', 'cursor-not-allowed');
          document.getElementById('f-password').required = false;
          document.getElementById('f-password').placeholder = 'Leave blank to keep current';
          document.getElementById('pwd-hint').textContent = '(optional — leave blank to keep)';
          document.getElementById('f-quota').value = quota;
          document.getElementById('f-maxfile').value = maxFile;
          document.getElementById('f-status').value = status;
          document.getElementById('status-row').classList.remove('hidden');
          document.getElementById('form-cancel-btn').classList.remove('hidden');
          // Scroll to form
          document.getElementById('user-form').scrollIntoView({ behavior: 'smooth', block: 'start' });
          showToast('Editing ' + username, 'indigo');
        }

        function resetForm() {
          document.getElementById('form-title').textContent = 'Add New User';
          document.getElementById('form-submit-btn').textContent = 'Save User';
          document.getElementById('form-mode').value = 'create';
          document.getElementById('f-username').value = '';
          document.getElementById('f-username').readOnly = false;
          document.getElementById('f-username').classList.remove('opacity-50', 'cursor-not-allowed');
          document.getElementById('f-password').required = true;
          document.getElementById('f-password').value = '';
          document.getElementById('f-password').placeholder = 'Enter password';
          document.getElementById('pwd-hint').textContent = '(required)';
          document.getElementById('f-quota').value = 500;
          document.getElementById('f-maxfile').value = 50;
          document.getElementById('status-row').classList.add('hidden');
          document.getElementById('form-cancel-btn').classList.add('hidden');
        }

        // Show toast if redirected with ?msg param
        const params = new URLSearchParams(location.search);
        if (params.get('ok')) showToast(params.get('ok'), 'green');
        if (params.get('err')) showToast(params.get('err'), 'red');
        // Clean URL
        if (params.has('ok') || params.has('err')) history.replaceState({}, '', '/admin');
      </script>
    </body>
    </html>
  `;
  return c.html(page);
});

// ─── POST /admin/user — Create or Update ──────────────────────────────────────

adminApp.post('/user', async (c) => {
  if (!await validateCsrf(c)) return c.text('Forbidden: Invalid CSRF token', 403);

  const body = await getParsedBody(c);
  const username = (body['username'] as string || '').trim();
  const password = (body['password'] as string || '').trim();
  const mode     = body['_mode'] as string || 'create';
  const quota    = parseInt(body['quota_mb'] as string, 10) || 500;
  const maxSize  = parseInt(body['max_file_size_mb'] as string, 10) || 50;
  const status   = body['status'] === 'suspended' ? 'suspended' : 'active';

  if (!username) return c.redirect('/admin?err=Username+is+required');

  const existingStr = await c.env.USER_KV.get(`user:${username}`);
  const existing = existingStr ? JSON.parse(existingStr) as UserConfig : null;

  if (mode === 'create' && existing) {
    return c.redirect('/admin?err=User+already+exists.+Use+Edit+to+update.');
  }
  if (mode === 'create' && !password) {
    return c.redirect('/admin?err=Password+is+required+for+new+users.');
  }

  let passwordHash = existing?.password_hash ?? '';
  let salt         = existing?.salt;

  if (password) {
    // New password provided — re-hash
    salt = generateSalt();
    passwordHash = await hashPassword(password, salt);
  }

  const config: UserConfig = {
    password_hash: passwordHash,
    ...(salt ? { salt } : {}),
    quota_mb: quota,
    max_file_size_mb: maxSize,
    status: mode === 'create' ? 'active' : status,
  };

  await c.env.USER_KV.put(`user:${username}`, JSON.stringify(config));
  const msg = mode === 'create' ? `User+${username}+created` : `User+${username}+updated`;
  return c.redirect(`/admin?ok=${msg}`);
});

// ─── POST /admin/suspend — Toggle active/suspended ────────────────────────────

adminApp.post('/suspend', async (c) => {
  if (!await validateCsrf(c)) return c.text('Forbidden: Invalid CSRF token', 403);

  const body = await getParsedBody(c);
  const username = (body['username'] as string || '').trim();
  const action   = body['action'] as string; // 'suspend' | 'activate'

  if (!username) return c.redirect('/admin?err=Missing+username');

  const existingStr = await c.env.USER_KV.get(`user:${username}`);
  if (!existingStr) return c.redirect('/admin?err=User+not+found');

  const config = JSON.parse(existingStr) as UserConfig;
  config.status = action === 'suspend' ? 'suspended' : 'active';

  await c.env.USER_KV.put(`user:${username}`, JSON.stringify(config));
  const verb = config.status === 'suspended' ? 'suspended' : 'activated';
  return c.redirect(`/admin?ok=User+${username}+${verb}`);
});

// ─── POST /admin/delete — Delete user + files ─────────────────────────────────

adminApp.post('/delete', async (c) => {
  if (!await validateCsrf(c)) return c.text('Forbidden: Invalid CSRF token', 403);

  const body = await getParsedBody(c);
  const username = (body['username'] as string || '').trim();
  if (!username) return c.redirect('/admin?err=Missing+username');

  // Delete user config and usage from KV
  await c.env.USER_KV.delete(`user:${username}`);
  await c.env.USER_KV.delete(`usage:${username}`);

  // Delete all user files from R2 (fire-and-forget for large buckets)
  c.executionCtx.waitUntil((async () => {
    let opts: R2ListOptions = { prefix: `${username}/` };
    let listed;
    do {
      listed = await c.env.STORAGE_R2.list(opts);
      if (listed.objects.length > 0) {
        await Promise.all(listed.objects.map(o => c.env.STORAGE_R2.delete(o.key)));
      }
      opts.cursor = listed.truncated ? listed.cursor : undefined;
    } while (listed.truncated);
  })());

  return c.redirect(`/admin?ok=User+${username}+and+all+files+deleted`);
});

// ─── GET /admin/logout ────────────────────────────────────────────────────────

adminApp.get('/logout', (c) => {
  setCookie(c, 'admin_session', '', { path: '/', maxAge: 0 });
  setCookie(c, 'csrf_token', '', { path: '/admin', maxAge: 0 });
  return c.redirect('/admin/login');
});
