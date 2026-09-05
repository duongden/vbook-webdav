import { Hono, Context, Next } from 'hono';
import { html, raw } from 'hono/html';
import { AppEnv, UserConfig } from '../types';
import { getUsage, storageRequest } from '../storage/client';
import { validUsername } from '../utils/path';
import { getCookie, setCookie } from 'hono/cookie';
import { hashPassword, generateSalt } from '../utils/crypto';
import { adminStyles } from './admin-styles';
import { encryptPassword, decryptPassword } from '../utils/password-vault';

export const adminApp = new Hono<AppEnv>();

adminApp.use('*', async (c, next) => {
  c.header('Cache-Control', 'no-store');
  c.header('X-Content-Type-Options', 'nosniff');
  if (typeof c.env.ADMIN_PIN !== 'string' || !c.env.ADMIN_PIN.trim()) {
    return c.text('Admin is not configured', 503);
  }
  await next();
});

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

const SESSION_SECONDS = 8 * 60 * 60;

async function signSession(payload: string, pin: string): Promise<string> {
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    'raw', encoder.encode(pin), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']
  );
  const signature = await crypto.subtle.sign('HMAC', key, encoder.encode(`admin-session-v2:${payload}`));
  return btoa(String.fromCharCode(...new Uint8Array(signature)));
}

async function generateSessionToken(pin: string): Promise<string> {
  const payload = `${Date.now() + SESSION_SECONDS * 1000}:${generateCsrfToken()}`;
  return `${payload}:${await signSession(payload, pin)}`;
}

async function verifySessionToken(token: string, pin: string): Promise<boolean> {
  const parts = token.split(':');
  if (parts.length !== 3) return false;
  const expires = Number(parts[0]);
  if (!Number.isFinite(expires) || expires <= Date.now() || expires > Date.now() + SESSION_SECONDS * 1000) return false;
  return timingSafeEqual(parts[2], await signSession(`${parts[0]}:${parts[1]}`, pin));
}

const authMiddleware = async (c: Context<AppEnv>, next: Next) => {
  const token = getCookie(c, 'admin_session');
  if (!token || !await verifySessionToken(token, c.env.ADMIN_PIN)) {
    return c.redirect('/admin/login');
  }
  // Ensure CSRF token cookie is always set for authenticated sessions
  let csrfCookie = getCookie(c, 'csrf_token');
  if (!csrfCookie) {
    csrfCookie = generateCsrfToken();
    setCookie(c, 'csrf_token', csrfCookie, {
      path: '/admin',
      secure: true,
      sameSite: 'Strict'
    });
  }
  c.set('_csrf', csrfCookie);
  await next();
};

/** Cache the parsed body in context to avoid consuming the stream twice. */
async function getParsedBody(c: Context<AppEnv>): Promise<Record<string, unknown>> {
  if (!c.get('_parsedBody')) c.set('_parsedBody', await c.req.parseBody());
  return c.get('_parsedBody') as Record<string, unknown>;
}

/** Validate CSRF: header (fetch) takes priority, falls back to body field (form POST). */
async function validateCsrf(c: Context<AppEnv>): Promise<boolean> {
  const cookie = getCookie(c, 'csrf_token');
  if (!cookie) return false;
  const token = c.req.header('X-CSRF-Token')
    ?? (await getParsedBody(c))['_csrf'] as string | undefined;
  return typeof token === 'string' && timingSafeEqual(cookie, token);
}

// ─── Login ─────────────────────────────────────────────────────────────────────

adminApp.get('/login', (c) => {
  return c.html(html`
    <!DOCTYPE html>
    <html lang="en">
    <head>
      <meta charset="UTF-8">
      <meta name="viewport" content="width=device-width, initial-scale=1"><title>Admin Login · Vân Du</title>
      <style>${raw(adminStyles)}</style>
    </head>
    <body class="login-page">
      <form method="POST" action="/admin/login" class="bg-white/80 backdrop-blur-md p-8 rounded-2xl shadow-xl border border-secondary w-96">
        <h2 class="text-2xl font-bold mb-6 text-center text-slate-800">Admin Area</h2>
        <input type="password" name="pin" placeholder="Enter PIN"
          class="w-full bg-white border border-slate-200 rounded-lg p-3 mb-6 text-slate-800 focus:outline-none focus:ring-2 focus:ring-primary focus:border-transparent transition-all shadow-sm"
          required autofocus>
        <button type="submit"
          class="w-full bg-primary hover:brightness-95 text-slate-800 font-bold py-3 rounded-lg shadow-sm transition-all transform hover:-translate-y-0.5">
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
    return c.html(`<!DOCTYPE html><html lang="en">
      <head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Locked</title>
      <style>${adminStyles}</style></head>
      <body class="login-page">
        <div class="bg-white/80 backdrop-blur-md p-8 rounded-2xl shadow-xl border border-danger/30 w-96 text-center">
          <div class="text-4xl mb-4">🔒</div>
          <h2 class="text-xl font-bold mb-2 text-danger">Too Many Attempts</h2>
          <p class="text-slate-600 text-sm">Locked for <strong class="text-slate-900">${remainingMinutes} minute${remainingMinutes > 1 ? 's' : ''}</strong>.</p>
        </div>
      </body></html>`, 429);
  }

  const body = await c.req.parseBody();
  const pin = typeof body['pin'] === 'string' ? body['pin'] : '';

  if (pin === c.env.ADMIN_PIN) {
    c.executionCtx.waitUntil(c.env.USER_KV.delete(rateLimitKey));
    setCookie(c, 'admin_session', '', { path: '/', maxAge: 0, httpOnly: true, secure: true, sameSite: 'Strict' });
    const sessionToken = await generateSessionToken(pin);
    setCookie(c, 'admin_session', sessionToken, {
      path: '/admin', httpOnly: true, secure: true, sameSite: 'Strict', maxAge: SESSION_SECONDS
    });
    return c.redirect('/admin');
  }

  const newCount = (attempts.count < MAX_ATTEMPTS ? attempts.count : 0) + 1;
  const until = newCount >= MAX_ATTEMPTS ? Date.now() + LOCKOUT_SECONDS * 1000 : attempts.until;
  c.executionCtx.waitUntil(
    c.env.USER_KV.put(rateLimitKey, JSON.stringify({ count: newCount, until }), { expirationTtl: LOCKOUT_SECONDS })
  );
  const remaining = MAX_ATTEMPTS - newCount;
  return c.html(`<!DOCTYPE html><html lang="en">
    <head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Admin Login</title>
    <style>${adminStyles}</style></head>
    <body class="login-page">
      <form method="POST" action="/admin/login" class="bg-white/80 backdrop-blur-md p-8 rounded-2xl shadow-xl border border-secondary w-96">
        <h2 class="text-2xl font-bold mb-4 text-center text-slate-800">Admin Area</h2>
        <p class="text-danger text-sm text-center mb-6 font-medium">
          Invalid PIN. ${remaining > 0 ? `${remaining} attempt${remaining > 1 ? 's' : ''} remaining.` : 'Account locked.'}
        </p>
        <input type="password" name="pin" placeholder="Enter PIN"
          class="w-full bg-white border border-danger/50 rounded-lg p-3 mb-6 text-slate-800 focus:outline-none focus:ring-2 focus:ring-danger transition-all shadow-sm" required autofocus>
        <button type="submit" class="w-full bg-primary hover:brightness-95 text-slate-800 font-bold py-3 rounded-lg shadow-sm transition-all transform hover:-translate-y-0.5">Login</button>
      </form>
    </body></html>`, 401);
});

// ─── Protected routes ──────────────────────────────────────────────────────────

adminApp.use('*', authMiddleware);

// ─── Dashboard ─────────────────────────────────────────────────────────────────

adminApp.get('/', async (c) => {
  const users: Array<{ username: string } & UserConfig> = [];
  let cursor: string | undefined;
  do {
    const page = await c.env.USER_KV.list({ prefix: 'user:', cursor });
    for (const key of page.keys) {
      const username = key.name.substring(5);
      const data = await c.env.USER_KV.get(key.name);
      if (data && validUsername(username)) users.push({ username, ...JSON.parse(data) as UserConfig });
    }
    cursor = page.list_complete ? undefined : page.cursor;
  } while (cursor);

  const csrf = c.get('_csrf') || getCookie(c, 'csrf_token') || '';

  const usageMap: Record<string, number> = {};
  for (const user of users) usageMap[user.username] = await getUsage(c.env, user.username);

  // Existing KV fields retain their historical MiB unit; forms use decimal MB.
  const decimalMB = (mib: number) => Number((mib * 1.048576).toFixed(6));

  function fmtBytes(b: number) {
    if (b === 0) return '0 B';
    const k = 1000, s = ['B','KB','MB','GB'];
    const i = Math.floor(Math.log(b) / Math.log(k));
    return parseFloat((b / Math.pow(k, i)).toFixed(1)) + ' ' + s[i];
  }

  const page = html`
    <!DOCTYPE html>
    <html lang="en">
    <head>
      <meta charset="UTF-8">
      <meta name="viewport" content="width=device-width, initial-scale=1.0">
      <title>Admin Dashboard · Vân Du</title>
      <style>${raw(adminStyles)}</style>
    </head>
    <body class="admin-page p-8">
      <div id="toast"></div>

      <div class="max-w-6xl mx-auto">
        <header class="flex justify-between items-center mb-8 glass p-5 rounded-2xl">
          <div>
            <h1 class="text-2xl font-bold text-slate-800">Admin Dashboard</h1>
            <p class="text-sm text-slate-500 mt-1">${users.length} user${users.length !== 1 ? 's' : ''} registered</p>
          </div>
          <a href="/admin/logout" class="text-sm font-medium text-slate-500 hover:text-danger transition-colors bg-white px-4 py-2 rounded-lg border border-slate-200 shadow-sm">Logout →</a>
        </header>

        <div class="grid grid-cols-1 lg:grid-cols-3 gap-6">

          <!-- ── Sidebar: Add / Edit Form ── -->
          <div class="lg:col-span-1">
            <div class="glass p-6 rounded-2xl sticky top-6">
              <h2 id="form-title" class="text-lg font-bold mb-5 text-slate-800">Add New User</h2>
              <form id="user-form" method="POST" action="/admin/user" class="space-y-4">
                <input type="hidden" name="_csrf" value="${csrf}">
                <input type="hidden" name="size_unit" value="decimal_mb">
                <input type="hidden" name="_mode" id="form-mode" value="create">

                <div>
                  <label class="block text-sm font-medium text-slate-700 mb-1.5">Username</label>
                  <input id="f-username" type="text" name="username"
                    class="w-full bg-white rounded-lg p-2.5 text-slate-800 text-sm"
                    placeholder="e.g. alice" required>
                </div>

                <div>
                  <label class="block text-sm font-medium text-slate-700 mb-1.5">
                    Password
                    <span id="pwd-hint" class="text-slate-400 font-normal ml-1">(required)</span>
                  </label>
                  <input id="f-password" type="password" name="password"
                    class="w-full bg-white rounded-lg p-2.5 text-slate-800 text-sm"
                    placeholder="Enter password">
                </div>

                <div class="grid grid-cols-2 gap-3">
                  <div>
                    <label class="block text-sm font-medium text-slate-700 mb-1.5">Quota (MB)</label>
                    <input id="f-quota" type="number" name="quota_mb" value="500" min="0.000001" step="0.000001"
                      class="w-full bg-white rounded-lg p-2.5 text-slate-800 text-sm" required>
                  </div>
                  <div>
                    <label class="block text-sm font-medium text-slate-700 mb-1.5">Max File (MB)</label>
                    <input id="f-maxfile" type="number" name="max_file_size_mb" value="50" min="0.000001" step="0.000001"
                      class="w-full bg-white rounded-lg p-2.5 text-slate-800 text-sm" required>
                  </div>
                </div>

                <div id="status-row" class="hidden">
                  <label class="block text-sm font-medium text-slate-700 mb-1.5">Status</label>
                  <select id="f-status" name="status"
                    class="w-full bg-white rounded-lg p-2.5 text-slate-800 text-sm">
                    <option value="active">Active</option>
                    <option value="suspended">Suspended</option>
                  </select>
                </div>

                <div class="flex gap-2 pt-2">
                  <button type="submit" id="form-submit-btn"
                    class="flex-1 bg-primary hover:brightness-95 text-slate-800 font-bold py-2.5 rounded-lg shadow-sm transition-all transform hover:-translate-y-0.5 text-sm">
                    Save User
                  </button>
                  <button type="button" id="form-cancel-btn" onclick="resetForm()"
                    class="hidden px-4 bg-white hover:bg-slate-50 border border-slate-200 text-slate-600 font-medium py-2.5 rounded-lg shadow-sm transition-all text-sm">
                    Cancel
                  </button>
                </div>
              </form>
            </div>
          </div>

          <!-- ── User Table ── -->
          <div class="lg:col-span-2">
            <div class="glass rounded-2xl overflow-hidden bg-white/60">
              <div class="p-5 border-b border-slate-200 flex items-center justify-between bg-white/40">
                <h2 class="text-lg font-bold text-slate-800">Users</h2>
                <span class="text-xs text-slate-500 font-medium bg-secondary px-3 py-1 rounded-full">Click Edit to modify a user</span>
              </div>
              <div class="overflow-x-auto">
                <table class="w-full text-left">
                  <thead>
                    <tr class="text-slate-500 text-xs uppercase bg-slate-50/80 border-b border-slate-200">
                      <th class="px-4 py-3 font-semibold">User</th>
                      <th class="px-4 py-3 font-semibold">Storage</th>
                      <th class="px-4 py-3 font-semibold">Limits</th>
                      <th class="px-4 py-3 font-semibold">Status</th>
                      <th class="px-4 py-3 font-semibold text-right">Actions</th>
                    </tr>
                  </thead>
                  <tbody class="divide-y divide-slate-100 text-sm bg-white/40">
                    ${users.length === 0 ? html`
                      <tr><td colspan="5" class="px-4 py-10 text-center text-slate-500 font-medium">No users yet. Add one using the form.</td></tr>
                    ` : users.map((u) => {
                      const usageBytes = usageMap[u.username] || 0;
                      const quotaBytes = (u.quota_mb || 500) * 1024 * 1024;
                      const pct = Math.min(100, Math.round(usageBytes / quotaBytes * 100));
                      const barColor = pct > 85 ? '#e43b12' : pct > 60 ? '#f59e0b' : '#10b981';
                      return html`
                      <tr class="hover:bg-primary/5 transition-colors group" id="row-${u.username}">
                        <td class="px-4 py-4">
                          <span class="font-bold text-slate-800">${u.username}</span>
                        </td>
                        <td class="px-4 py-4">
                          <div class="text-xs text-slate-600 mb-1.5 font-medium">${fmtBytes(usageBytes)} / ${decimalMB(u.quota_mb).toLocaleString('vi-VN')} MB</div>
                          <div class="bar-track w-28 shadow-inner">
                            <div class="bar-fill" style="width:${pct}%;background:${barColor}"></div>
                            </div></details>
                          </div>
                        </td>
                        <td class="px-4 py-4 text-xs text-slate-500">
                          <div class="mb-0.5">Quota: <span class="font-medium text-slate-700">${decimalMB(u.quota_mb).toLocaleString('vi-VN')} MB</span></div>
                          <div>Max file: <span class="font-medium text-slate-700">${decimalMB(u.max_file_size_mb).toLocaleString('vi-VN')} MB</span></div>
                        </td>
                        <td class="px-4 py-4">
                          <span class="text-xs px-2.5 py-1 rounded-full font-bold shadow-sm
                            ${u.status === 'active'
                              ? 'bg-emerald-100 text-emerald-700 border border-emerald-200'
                              : 'bg-red-100 text-red-700 border border-red-200'}">
                            ${u.status}
                          </span>
                        </td>
                        <td class="px-4 py-4 text-right">
                          <div class="user-actions">
                            <!-- Edit -->
                            <button type="button" class="btn btn-edit" data-username="${u.username}" onclick="viewPassword(this)">Mật khẩu</button>
                            <details class="account-menu"><summary class="btn">Thao tác</summary><div class="account-menu-items">
                            <button type="button" class="btn btn-edit shadow-sm"
                              onclick="editUser(${JSON.stringify(u.username)}, ${decimalMB(u.quota_mb)}, ${decimalMB(u.max_file_size_mb)}, '${u.status}')">
                              Sửa thông tin
                            </button>

                            <!-- Suspend / Activate toggle -->
                            <form method="POST" action="/admin/suspend" class="inline">
                              <input type="hidden" name="_csrf" value="${csrf}">
                              <input type="hidden" name="username" value="${u.username}">
                              <input type="hidden" name="action" value="${u.status === 'active' ? 'suspend' : 'activate'}">
                              <button type="submit" class="btn ${u.status === 'active' ? 'btn-suspend' : 'btn-activate'} shadow-sm">
                                ${u.status === 'active' ? 'Tạm khóa' : 'Mở khóa'}
                              </button>
                            </form>

                            <!-- Delete -->
                            <form method="POST" action="/admin/delete" class="inline"
                              onsubmit="return confirm('Delete user ${u.username} and ALL their files?')">
                              <input type="hidden" name="_csrf" value="${csrf}">
                              <input type="hidden" name="username" value="${u.username}">
                              <button type="submit" class="btn btn-delete shadow-sm">Xóa tài khoản</button>
                            </form>
                            </div></details>
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
        async function viewPassword(button) {
          button.disabled = true;
          try {
            const response = await fetch('/admin/password', {
              method: 'POST', redirect: 'error',
              body: new URLSearchParams({ username: button.dataset.username, _csrf: document.querySelector('#user-form input[name="_csrf"]').value })
            });
            const result = await response.json();
            if (!response.ok) throw new Error(result.error || 'Không xem được mật khẩu');
            const dialog = document.createElement('dialog');
            dialog.className = 'password-dialog';
            dialog.setAttribute('aria-labelledby', 'password-title');
            const label = document.createElement('h2');
            label.id = 'password-title';
            label.textContent = 'Mật khẩu tài khoản';
            const account = document.createElement('p');
            account.className = 'password-account';
            account.textContent = button.dataset.username;
            const field = document.createElement('input');
            field.className = 'password-field';
            field.readOnly = true;
            field.value = result.password;
            field.setAttribute('aria-label', 'Mật khẩu');
            const close = document.createElement('button');
            close.className = 'password-close';
            close.textContent = 'Đóng';
            const copy = document.createElement('button');
            copy.className = 'password-copy';
            copy.textContent = 'Sao chép';
            copy.onclick = async () => {
              try { await navigator.clipboard.writeText(field.value); copy.textContent = 'Đã sao chép'; }
              catch { field.focus(); field.select(); copy.textContent = 'Nhấn Ctrl/Cmd + C'; }
            };
            const note = document.createElement('p');
            note.className = 'password-note';
            note.textContent = 'Cửa sổ tự đóng sau 30 giây.';
            const footer = document.createElement('div');
            footer.className = 'password-footer';
            footer.append(close, copy);
            close.onclick = () => dialog.close();
            dialog.append(label, account, field, note, footer);
            document.body.append(dialog);
            const timer = setTimeout(() => dialog.close(), 30000);
            dialog.addEventListener('close', () => { clearTimeout(timer); field.value = ''; dialog.remove(); button.focus(); }, { once: true });
            dialog.showModal();
          } catch (error) { showToast(error.message || 'Không xem được mật khẩu', 'error'); }
          finally { button.disabled = false; }
        }
        function showToast(msg, type) {
          const t = document.getElementById('toast');
          // Replace literal '+' with spaces for nicer display if generated from BE
          t.textContent = msg.replace(/\\+/g, ' ');
          t.className = 'toast-' + type;
          t.classList.add('show');
          setTimeout(() => t.classList.remove('show'), 3500);
        }

        function editUser(username, quota, maxFile, status) {
          document.getElementById('form-title').textContent = 'Edit User: ' + username;
          document.getElementById('form-submit-btn').textContent = 'Update User';
          document.getElementById('form-mode').value = 'edit';
          document.getElementById('f-username').value = username;
          document.getElementById('f-username').readOnly = true;
          document.getElementById('f-username').classList.add('opacity-60', 'bg-slate-100', 'cursor-not-allowed');
          document.getElementById('f-password').required = false;
          document.getElementById('f-password').placeholder = 'Leave blank to keep current';
          document.getElementById('pwd-hint').textContent = '(optional)';
          document.getElementById('f-quota').value = quota;
          document.getElementById('f-maxfile').value = maxFile;
          document.getElementById('f-status').value = status;
          document.getElementById('status-row').classList.remove('hidden');
          document.getElementById('form-cancel-btn').classList.remove('hidden');
          document.getElementById('user-form').scrollIntoView({ behavior: 'smooth', block: 'start' });
          showToast('Editing ' + username, 'info');
        }

        function resetForm() {
          document.getElementById('form-title').textContent = 'Add New User';
          document.getElementById('form-submit-btn').textContent = 'Save User';
          document.getElementById('form-mode').value = 'create';
          document.getElementById('f-username').value = '';
          document.getElementById('f-username').readOnly = false;
          document.getElementById('f-username').classList.remove('opacity-60', 'bg-slate-100', 'cursor-not-allowed');
          document.getElementById('f-password').required = true;
          document.getElementById('f-password').value = '';
          document.getElementById('f-password').placeholder = 'Enter password';
          document.getElementById('pwd-hint').textContent = '(required)';
          document.getElementById('f-quota').value = 500;
          document.getElementById('f-maxfile').value = 50;
          document.getElementById('status-row').classList.add('hidden');
          document.getElementById('form-cancel-btn').classList.add('hidden');
        }

        const params = new URLSearchParams(location.search);
        if (params.get('ok')) showToast(params.get('ok'), 'success');
        if (params.get('err')) showToast(params.get('err'), 'error');
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
  const username = typeof body['username'] === 'string' ? body['username'].trim() : '';
  const password = typeof body['password'] === 'string' ? body['password'] : '';
  const mode     = body['_mode'] as string || 'create';
  let quota = Number(body['quota_mb']);
  let maxSize = Number(body['max_file_size_mb']);
  if (body['size_unit'] === 'decimal_mb') {
    const quotaBytes = Math.round(quota * 1_000_000);
    const maxBytes = Math.round(maxSize * 1_000_000);
    if (!Number.isSafeInteger(quotaBytes) || quotaBytes <= 0 || !Number.isSafeInteger(maxBytes) || maxBytes <= 0) {
      return c.redirect('/admin?err=Invalid+MB+limits');
    }
    quota = quotaBytes / 1_048_576;
    maxSize = maxBytes / 1_048_576;
  } else if (!Number.isSafeInteger(quota) || quota <= 0 || !Number.isSafeInteger(maxSize) || maxSize <= 0) {
    // Accept an already-open legacy form using its original unit.
    return c.redirect('/admin?err=Quota+and+file+size+must+be+positive+integers');
  }
  if (mode !== 'create' && mode !== 'edit') return c.text('Invalid mode', 400);
  const status   = body['status'] === 'suspended' ? 'suspended' : 'active';

  if (!validUsername(username)) {
    return c.redirect(`/admin?err=${encodeURIComponent('Invalid username (alphanumeric, -, _ only)')}`);
  }

  const existingStr = await c.env.USER_KV.get(`user:${username}`);
  const existing = existingStr ? JSON.parse(existingStr) as UserConfig : null;

  if (mode === 'create' && existing) {
    return c.redirect(`/admin?err=${encodeURIComponent('User already exists. Use Edit to update.')}`);
  }
  if (mode === 'edit' && !existing) {
    return c.redirect(`/admin?err=${encodeURIComponent('User not found. Cannot edit.')}`);
  }
  if (mode === 'create' && !password) {
    return c.redirect(`/admin?err=${encodeURIComponent('Password is required for new users.')}`);
  }

  let passwordHash = existing?.password_hash ?? '';
  let salt         = existing?.salt;
  let encrypted = existing?.password_encrypted;

  if (password) {
    // Without a configured vault, preserve legacy hash-only operation; never retain stale ciphertext.
    encrypted = undefined;
    if (c.env.PASSWORD_VAULT_KEY) {
      try { encrypted = await encryptPassword(c.env.PASSWORD_VAULT_KEY, username, password); }
      catch { return c.text('Password vault key is invalid; user was not changed', 503); }
    }
    // New password provided — re-hash
    salt = generateSalt();
    passwordHash = await hashPassword(password, salt);
  }

  const config: UserConfig = {
    password_hash: passwordHash,
    ...(encrypted ? { password_encrypted: encrypted } : {}),
    ...(salt ? { salt } : {}),
    quota_mb: quota,
    max_file_size_mb: maxSize,
    status: mode === 'create' ? 'active' : status,
  };

  if (mode === 'create') {
    const activated = await storageRequest(c.env, username, 'activate');
    if (!activated.ok) return c.redirect('/admin?err=Previous+deletion+is+still+pending');
  }
  await c.env.USER_KV.put(`user:${username}`, JSON.stringify(config));
  const msg = mode === 'create' ? `User ${username} created` : `User ${username} updated`;
  return c.redirect(`/admin?ok=${encodeURIComponent(msg)}`);
});

adminApp.post('/password', async (c) => {
  if (!await validateCsrf(c)) return c.json({ error: 'Phiên không hợp lệ. Hãy đăng nhập lại.' }, 403);
  const body = await getParsedBody(c);
  const username = typeof body.username === 'string' ? body.username : '';
  if (!validUsername(username)) return c.json({ error: 'Tên tài khoản không hợp lệ.' }, 400);
  const user = await c.env.USER_KV.get<UserConfig>(`user:${username}`, 'json');
  if (!user) return c.json({ error: 'Không tìm thấy tài khoản.' }, 404);
  if (!user.password_encrypted) return c.json({ error: 'Chưa có bản mã hóa. Cấu hình PASSWORD_VAULT_KEY rồi đặt lại mật khẩu một lần.' }, 409);
  if (!c.env.PASSWORD_VAULT_KEY) return c.json({ error: 'Chưa cấu hình PASSWORD_VAULT_KEY trên Cloudflare.' }, 503);
  try {
    const password = await decryptPassword(c.env.PASSWORD_VAULT_KEY, username, user.password_encrypted);
    return c.json({ password });
  } catch { return c.json({ error: 'Không giải mã được. Kiểm tra khóa hoặc đặt lại mật khẩu.' }, 503); }
});

// ─── POST /admin/suspend — Toggle active/suspended ────────────────────────────

adminApp.post('/suspend', async (c) => {
  if (!await validateCsrf(c)) return c.text('Forbidden: Invalid CSRF token', 403);

  const body = await getParsedBody(c);
  const username = typeof body['username'] === 'string' ? body['username'].trim() : '';
  const action   = body['action'] as string; // 'suspend' | 'activate'

  if (!validUsername(username)) return c.redirect(`/admin?err=${encodeURIComponent('Missing username')}`);

  const existingStr = await c.env.USER_KV.get(`user:${username}`);
  if (!existingStr) return c.redirect(`/admin?err=${encodeURIComponent('User not found')}`);

  const config = JSON.parse(existingStr) as UserConfig;
  config.status = action === 'suspend' ? 'suspended' : 'active';

  await c.env.USER_KV.put(`user:${username}`, JSON.stringify(config));
  const verb = config.status === 'suspended' ? 'suspended' : 'activated';
  return c.redirect(`/admin?ok=${encodeURIComponent(`User ${username} ${verb}`)}`);
});

// ─── POST /admin/delete — Delete user + files ─────────────────────────────────

adminApp.post('/delete', async (c) => {
  if (!await validateCsrf(c)) return c.text('Forbidden: Invalid CSRF token', 403);

  const body = await getParsedBody(c);
  const username = typeof body['username'] === 'string' ? body['username'].trim() : '';
  if (!validUsername(username)) return c.redirect(`/admin?err=${encodeURIComponent('Missing username')}`);

  const deleted = await storageRequest(c.env, username, 'retire', { key: `${username}/` });
  if (!deleted.ok) {
    return c.redirect(`/admin?err=${encodeURIComponent('Deletion is pending or failed. Retry Delete shortly.')}`);
  }
  await c.env.USER_KV.delete(`user:${username}`);
  await c.env.USER_KV.delete(`usage:${username}`);

  return c.redirect(`/admin?ok=${encodeURIComponent(`User ${username} and all files deleted`)}`);
});

// ─── GET /admin/logout ────────────────────────────────────────────────────────

adminApp.get('/logout', (c) => {
  setCookie(c, 'admin_session', '', { path: '/admin', maxAge: 0, httpOnly: true, secure: true, sameSite: 'Strict' });
  setCookie(c, 'csrf_token', '', { path: '/admin', maxAge: 0 });
  return c.redirect('/admin/login');
});
