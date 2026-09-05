import { Context } from 'hono';
import { AppEnv } from '../types';
import { requestObjectKey, encodePath, validUsername } from '../utils/path';
import { storageRequest } from '../storage/client';

function formatHTTPDate(date: Date) {
  return date.toUTCString();
}

function formatISO8601(date: Date) {
  return date.toISOString().split('.')[0] + 'Z';
}

function escapeXML(str: string) {
  return str.replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&apos;');
}

async function handlePropfind(c: Context<AppEnv>) {
  const username = c.get('username');
  const sanitized = requestObjectKey(username, c.req.url);
  if (sanitized === null) {
    return c.text('Forbidden', 403);
  }

  const depth = c.req.header('Depth') || '1';
  if (depth !== '0' && depth !== '1') {
    return c.body('<D:error xmlns:D="DAV:"><D:propfind-finite-depth/></D:error>', 403, { 'Content-Type': 'application/xml' });
  }
  const prefix = sanitized.endsWith('/') ? sanitized : sanitized + '/';
  const filePrefix = sanitized;
  let xml = `<?xml version="1.0" encoding="utf-8" ?>\n`;
  xml += `<D:multistatus xmlns:D="DAV:">\n`;

  // For Depth 0 or 1, we always need the root element of the request
  const isRoot = sanitized === `${username}/`;

  // If not root, check if it's a file or directory
  let isDirectory = sanitized.endsWith('/') || isRoot;
  let rootSize = 0;
  let rootLastModified = new Date();

  if (isDirectory && !isRoot) {
    const exists = await c.env.STORAGE_R2.list({ prefix, limit: 1 });
    if (!exists.objects.length) return c.text('Not Found', 404);
  }
  if (!isDirectory) {
    const obj = await c.env.STORAGE_R2.head(filePrefix);
    if (obj) {
      rootSize = obj.size;
      rootLastModified = obj.uploaded;
    } else {
      // Might be a directory without trailing slash
      const list = await c.env.STORAGE_R2.list({ prefix: filePrefix + '/', limit: 1 });
      if (list.objects.length > 0 || list.delimitedPrefixes.length > 0) {
        isDirectory = true;
      } else {
        return c.text('Not Found', 404);
      }
    }
  }

  const renderResponse = (href: string, isCollection: boolean, size: number, lastModified: Date) => {
    let res = `  <D:response>\n`;
    res += `    <D:href>${escapeXML(href)}</D:href>\n`;
    res += `    <D:propstat>\n`;
    res += `      <D:prop>\n`;
    if (isCollection) {
      res += `        <D:resourcetype><D:collection/></D:resourcetype>\n`;
    } else {
      res += `        <D:resourcetype/>\n`;
      res += `        <D:getcontentlength>${size}</D:getcontentlength>\n`;
      res += `        <D:getcontenttype>application/octet-stream</D:getcontenttype>\n`;
    }
    res += `        <D:getlastmodified>${formatHTTPDate(lastModified)}</D:getlastmodified>\n`;
    res += `        <D:creationdate>${formatISO8601(lastModified)}</D:creationdate>\n`;
    res += `      </D:prop>\n`;
    res += `      <D:status>HTTP/1.1 200 OK</D:status>\n`;
    res += `    </D:propstat>\n`;
    res += `  </D:response>\n`;
    return res;
  };

  const requestPath = new URL(c.req.url).pathname;
  const mount = /^\/webdav(?:\/|$)/.test(requestPath) ? '/webdav' : '';
  const relative = sanitized.substring(username.length);
  const reqHref = mount + encodePath(relative) + (isDirectory && !relative.endsWith('/') ? '/' : '');
  xml += renderResponse(reqHref, isDirectory, rootSize, rootLastModified);

  if (depth === '1' && isDirectory) {
    let listOptions: R2ListOptions = { prefix, delimiter: '/' };
    let listed;
    const allPrefixes = [];
    const allObjects = [];

    do {
      listed = await c.env.STORAGE_R2.list(listOptions);
      allPrefixes.push(...listed.delimitedPrefixes);
      allObjects.push(...listed.objects);
      listOptions.cursor = listed.truncated ? listed.cursor : undefined;
    } while (listed.truncated);

    // Add subdirectories
    for (const subPrefix of allPrefixes) {
      const dirName = subPrefix.substring(prefix.length); // e.g. "my folder/"
      const cleanDirName = dirName.endsWith('/') ? dirName.slice(0, -1) : dirName;
      const encodedDirName = encodeURIComponent(cleanDirName) + '/';
      const subHref = reqHref.endsWith('/') ? `${reqHref}${encodedDirName}` : `${reqHref}/${encodedDirName}`;
      xml += renderResponse(subHref, true, 0, new Date());
    }

    // Add files
    for (const obj of allObjects) {
      if (obj.key === prefix) continue; // skip the folder itself if it exists as an object
      const fileName = obj.key.substring(prefix.length); // e.g. "my file.txt"
      const encodedFileName = encodeURIComponent(fileName);
      const subHref = reqHref.endsWith('/') ? `${reqHref}${encodedFileName}` : `${reqHref}/${encodedFileName}`;
      xml += renderResponse(subHref, false, obj.size, obj.uploaded);
    }
  }

  xml += `</D:multistatus>`;
  c.header('Content-Type', 'application/xml; charset=utf-8');
  return c.body(xml, 207);
}

export const webdavHandler = async (c: Context<AppEnv>) => {
  const method = c.req.method;
  const username = c.get('username');
  if (!validUsername(username || '') || !c.get('user')) return c.text('Unauthorized', 401);
  const objectKey = requestObjectKey(username, c.req.url);
  if (objectKey === null) {
    return c.text('Forbidden', 403);
  }

  if (method === 'OPTIONS') {
    c.header('Allow', 'OPTIONS, GET, HEAD, PUT, DELETE, MKCOL, PROPFIND');
    c.header('DAV', '1');
    return c.text('', 200);
  }

  if (method === 'PROPFIND') {
    return handlePropfind(c);
  }

  if (method === 'MKCOL' || method === 'PUT' || method === 'DELETE') {
    return storageRequest(c.env, username, method === 'MKCOL' ? 'mkcol' : method.toLowerCase(), {
      key: objectKey, request: c.req.raw, user: c.get('user'),
    });
  }

  if (method === 'GET' || method === 'HEAD') {
    const obj = method === 'HEAD' ? await c.env.STORAGE_R2.head(objectKey) : await c.env.STORAGE_R2.get(objectKey);
    if (!obj) {
      return c.text('Not Found', 404);
    }

    const headers = new Headers();
    const filename = objectKey.split('/').pop() || 'download';
    const encodedName = encodeURIComponent(filename).replace(/['()*]/g, c => '%' + c.charCodeAt(0).toString(16).toUpperCase());
    headers.set('Content-Type', 'application/octet-stream');
    headers.set('Content-Disposition', `attachment; filename="download"; filename*=UTF-8''${encodedName}`);
    headers.set('X-Content-Type-Options', 'nosniff');
    headers.set('Content-Security-Policy', "sandbox; default-src 'none'");
    headers.set('ETag', obj.httpEtag);
    headers.set('Last-Modified', obj.uploaded.toUTCString());
    headers.set('Content-Length', obj.size.toString());
    // CRITICAL: Prevent Cloudflare from auto-compressing and breaking Content-Length
    headers.set('Cache-Control', 'private, no-store, no-transform');

    if (method === 'HEAD') {
      return new Response(null, { headers, status: 200 });
    }
    return new Response((obj as R2ObjectBody).body, { headers, status: 200 });
  }

  return c.text('Method Not Allowed', 405);
};
