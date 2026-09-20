import { Hono } from 'hono';
import { AppEnv } from './types';
import { adminApp } from './webui/admin';
import { userAuthMiddleware } from './middleware/auth';
import { webdavHandler } from './webdav/handler';
import { webuiHandler, webuiDataHandler } from './webui/handler';
import { shareApi, sharedApp } from './webdav/shares';
import { metadataApi } from './webui/metadata';
import { driveConfigApi, driveWebDavApp } from './webdav/google-drive';

import { extensionApi, extensionApp } from './webdav/extensions';

const app = new Hono<AppEnv>();

app.use('*', async (c, next) => {
  c.header('X-VBook-Version', 'drive-share-20260920');
  c.header('X-Content-Type-Options', 'nosniff');
  c.header('X-Frame-Options', 'DENY');
  c.header('Referrer-Policy', 'no-referrer');
  c.header('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  c.header('Content-Security-Policy', "default-src 'none'; connect-src 'self'; img-src https: data:; style-src 'unsafe-inline'; script-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'");
  if (new URL(c.req.url).protocol === 'https:') c.header('Strict-Transport-Security', 'max-age=31536000');
  await next();
});

// Publicly reachable WebDAV shares use their own read-only credentials.
app.route('/shared', sharedApp);
app.route('/extensions', extensionApp);

// 1. Mount Admin Dashboard (No basic auth required, uses PIN cookie)
app.route('/admin', adminApp);
app.all('/admin', (c) => c.notFound());
app.all('/admin/*', (c) => c.notFound());

// 2. Apply Basic Auth for all other routes
app.use('*', userAuthMiddleware);

app.route('/api/shares', shareApi);
app.route('/api/extensions', extensionApi);
app.route('/api/metadata', metadataApi);
app.route('/api/drive', driveConfigApi);
app.route('/drive-webdav', driveWebDavApp);

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
