import { Hono } from 'hono';
import { Env } from './types';
import { adminApp } from './webui/admin';
import { userAuthMiddleware } from './middleware/auth';
import { quotaMiddleware } from './middleware/quota';
import { webdavHandler } from './webdav/handler';
import { webuiHandler } from './webui/handler';

const app = new Hono<{ Bindings: Env }>();

// 1. Mount Admin Dashboard (No basic auth required, uses PIN cookie)
app.route('/admin', adminApp);

// 2. Apply Basic Auth for all other routes
app.use('*', userAuthMiddleware);

// 3. Apply Quota middleware (only affects PUT)
app.use('*', quotaMiddleware);

// 4. Main Router (Device Recognition)
app.all('*', async (c) => {
  const method = c.req.method;
  const path = c.req.path;
  const accept = c.req.header('Accept') || '';

  // If it's a GET request to root (/) from a browser, show the Fake Cloud Drive UI
  if (method === 'GET' && path === '/' && accept.includes('text/html')) {
    return webuiHandler(c);
  }

  // Otherwise, it's a WebDAV request (or file download from the UI which triggers GET /webdav/filename)
  return webdavHandler(c);
});

export default app;
