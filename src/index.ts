import { Hono } from 'hono';
import { AppEnv } from './types';
import { adminApp } from './webui/admin';
import { userAuthMiddleware } from './middleware/auth';
import { webdavHandler } from './webdav/handler';
import { webuiHandler, webuiDataHandler } from './webui/handler';

const app = new Hono<AppEnv>();

app.use('*', async (c, next) => {
  c.header('X-VBook-Version', 'drive-ui-20260905');
  await next();
});

// 1. Mount Admin Dashboard (No basic auth required, uses PIN cookie)
app.route('/admin', adminApp);
app.all('/admin', (c) => c.notFound());
app.all('/admin/*', (c) => c.notFound());

// 2. Apply Basic Auth for all other routes
app.use('*', userAuthMiddleware);

// 4. Main Router (Device Recognition)
app.all('*', async (c) => {
  const method = c.req.method;
  const path = c.req.path;
  const accept = c.req.header('Accept') || '';

  if (method === 'GET' && path === '/' && accept.includes('application/json')) {
    return webuiDataHandler(c);
  }

  // If it's a GET request to root (/) from a browser, show the Fake Cloud Drive UI
  if (method === 'GET' && path === '/' && accept.includes('text/html')) {
    return webuiHandler(c);
  }

  // Otherwise, it's a WebDAV request (or file download from the UI which triggers GET /webdav/filename)
  return webdavHandler(c);
});

export default app;
export { UserStorage } from './storage/user-storage';
