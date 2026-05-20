import { Hono } from 'hono';
import { html } from 'hono/html';
import { Env, UserConfig } from '../types';
import { getCookie, setCookie } from 'hono/cookie';

export const adminApp = new Hono<{ Bindings: Env }>();

const authMiddleware = async (c: any, next: any) => {
  const pin = getCookie(c, 'admin_pin');
  if (pin !== c.env.ADMIN_PIN) {
    return c.redirect('/admin/login');
  }
  await next();
};

adminApp.get('/login', (c) => {
  return c.html(html`
    <!DOCTYPE html>
    <html lang="en" class="dark">
    <head>
      <meta charset="UTF-8">
      <title>Admin Login</title>
      <script src="https://cdn.tailwindcss.com"></script>
      <style>body { background-color: #0f172a; color: white; }</style>
    </head>
    <body class="flex items-center justify-center min-h-screen">
      <form method="POST" action="/admin/login" class="bg-slate-800 p-8 rounded-xl shadow-xl w-96">
        <h2 class="text-2xl font-bold mb-6 text-center text-rose-500">Admin Area</h2>
        <input type="password" name="pin" placeholder="Enter PIN" class="w-full bg-slate-900 border border-slate-700 rounded p-3 mb-4 text-white focus:outline-none focus:border-rose-500" required>
        <button type="submit" class="w-full bg-rose-600 hover:bg-rose-700 text-white font-medium py-3 rounded transition-colors">Login</button>
      </form>
    </body>
    </html>
  `);
});

adminApp.post('/login', async (c) => {
  const body = await c.req.parseBody();
  const pin = body['pin'] as string;
  if (pin === c.env.ADMIN_PIN) {
    setCookie(c, 'admin_pin', pin, { path: '/' });
    return c.redirect('/admin');
  }
  return c.text('Invalid PIN', 401);
});

adminApp.use('*', authMiddleware);

adminApp.get('/', async (c) => {
  // Fetch all users. For KV, we list keys starting with "user:"
  const list = await c.env.USER_KV.list({ prefix: 'user:' });
  const users = await Promise.all(
    list.keys.map(async (k) => {
      const data = await c.env.USER_KV.get(k.name);
      const username = k.name.substring(5); // remove 'user:'
      if (data) {
        return { username, ...JSON.parse(data) as UserConfig };
      }
      return null;
    })
  );

  const page = html`
    <!DOCTYPE html>
    <html lang="en" class="dark">
    <head>
      <meta charset="UTF-8">
      <title>Admin Dashboard</title>
      <script src="https://cdn.tailwindcss.com"></script>
      <script>
        tailwind.config = { darkMode: 'class', theme: { extend: { colors: { rose: '#e11d48' } } } }
      </script>
      <style>
        body { font-family: 'Inter', sans-serif; background-color: #0f172a; color: #f8fafc; }
        .glass { background: rgba(30, 41, 59, 0.7); backdrop-filter: blur(10px); border: 1px solid rgba(255, 255, 255, 0.1); }
      </style>
    </head>
    <body class="p-4 md:p-8">
      <div class="max-w-5xl mx-auto">
        <header class="flex justify-between items-center mb-8 glass p-6 rounded-2xl">
          <h1 class="text-2xl font-bold text-rose-500">Admin Dashboard</h1>
        </header>

        <div class="grid grid-cols-1 md:grid-cols-3 gap-8">
          <div class="md:col-span-1">
            <div class="glass p-6 rounded-2xl">
              <h2 class="text-lg font-semibold mb-4 border-b border-slate-700 pb-2">Add / Update User</h2>
              <form method="POST" action="/admin/user" class="space-y-4">
                <div>
                  <label class="block text-xs text-slate-400 mb-1">Username</label>
                  <input type="text" name="username" class="w-full bg-slate-900 border border-slate-700 rounded p-2 text-white text-sm" required>
                </div>
                <div>
                  <label class="block text-xs text-slate-400 mb-1">Password</label>
                  <input type="text" name="password" class="w-full bg-slate-900 border border-slate-700 rounded p-2 text-white text-sm" required>
                </div>
                <div>
                  <label class="block text-xs text-slate-400 mb-1">Quota (MB)</label>
                  <input type="number" name="quota_mb" value="500" class="w-full bg-slate-900 border border-slate-700 rounded p-2 text-white text-sm" required>
                </div>
                <div>
                  <label class="block text-xs text-slate-400 mb-1">Max File Size (MB)</label>
                  <input type="number" name="max_file_size_mb" value="50" class="w-full bg-slate-900 border border-slate-700 rounded p-2 text-white text-sm" required>
                </div>
                <button type="submit" class="w-full bg-rose-600 hover:bg-rose-700 text-white font-medium py-2 rounded transition-colors text-sm">Save User</button>
              </form>
            </div>
          </div>
          
          <div class="md:col-span-2">
            <div class="glass p-6 rounded-2xl overflow-x-auto">
              <h2 class="text-lg font-semibold mb-4 border-b border-slate-700 pb-2">User List</h2>
              <table class="w-full text-left border-collapse">
                <thead>
                  <tr class="text-slate-400 text-xs uppercase bg-slate-800/50">
                    <th class="p-3">Username</th>
                    <th class="p-3">Password</th>
                    <th class="p-3">Quota</th>
                    <th class="p-3">Max Size</th>
                    <th class="p-3 text-right">Actions</th>
                  </tr>
                </thead>
                <tbody class="divide-y divide-slate-700/50 text-sm">
                  ${users.map((u: any) => html`
                    <tr class="hover:bg-slate-800/30">
                      <td class="p-3 font-medium text-white">${u.username}</td>
                      <td class="p-3 text-slate-400">${u.password_hash}</td>
                      <td class="p-3 text-slate-400">${u.quota_mb} MB</td>
                      <td class="p-3 text-slate-400">${u.max_file_size_mb} MB</td>
                      <td class="p-3 text-right">
                        <form method="POST" action="/admin/delete" class="inline" onsubmit="return confirm('Delete user ${u.username}?')">
                          <input type="hidden" name="username" value="${u.username}">
                          <button type="submit" class="text-xs px-2 py-1 bg-red-900/30 text-red-400 rounded hover:bg-red-900/50">Delete</button>
                        </form>
                      </td>
                    </tr>
                  `)}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      </div>
    </body>
    </html>
  `;
  return c.html(page);
});

adminApp.post('/user', async (c) => {
  const body = await c.req.parseBody();
  const username = body['username'] as string;
  const password = body['password'] as string;
  const quota = parseInt(body['quota_mb'] as string, 10);
  const maxSize = parseInt(body['max_file_size_mb'] as string, 10);

  if (username && password) {
    const config: UserConfig = {
      password_hash: password,
      quota_mb: quota,
      max_file_size_mb: maxSize,
      status: 'active'
    };
    await c.env.USER_KV.put(`user:${username}`, JSON.stringify(config));
  }
  return c.redirect('/admin');
});

adminApp.post('/delete', async (c) => {
  const body = await c.req.parseBody();
  const username = body['username'] as string;
  if (username) {
    await c.env.USER_KV.delete(`user:${username}`);
  }
  return c.redirect('/admin');
});
