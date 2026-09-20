import { Context } from 'hono';
import { AppEnv } from '../types';
import { requestObjectKey, encodePath, validUsername } from '../utils/path';
import { storageRequest } from '../storage/client';

export interface DavAccess {
  owner: string;
  rootKey: string;
  mountPath: string;
  writable: boolean;
}

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

function contentType(name: string, stored?: string): string {
  if (stored && stored !== 'application/octet-stream') return stored;
  const extension = name.toLowerCase().split('.').pop();
  return ({
    epub: 'application/epub+zip', pdf: 'application/pdf', cbz: 'application/vnd.comicbook+zip',
    cbr: 'application/vnd.comicbook-rar', mobi: 'application/x-mobipocket-ebook',
    azw: 'application/vnd.amazon.ebook', azw3: 'application/vnd.amazon.mobi8-ebook',
    fb2: 'application/x-fictionbook+xml', txt: 'text/plain; charset=utf-8', zip: 'application/zip',
  } as Record<string, string>)[extension || ''] || 'application/octet-stream';
}

function canonicalHref(access: DavAccess, objectKey: string, directory: boolean): string {
  const relative = objectKey.substring(access.rootKey.length);
  let href = access.mountPath + encodePath(relative);
  if (directory && !href.endsWith('/')) href += '/';
  return href;
}

async function handlePropfind(c: Context<AppEnv>, access: DavAccess, objectKey: string) {
  const depth = c.req.header('Depth') || '1';
  if (depth !== '0' && depth !== '1') {
    return c.body('<D:error xmlns:D="DAV:"><D:propfind-finite-depth/></D:error>', 403, { 'Content-Type': 'application/xml' });
  }
  const prefix = objectKey.endsWith('/') ? objectKey : `${objectKey}/`;
  const isRoot = objectKey === access.rootKey;
  let isDirectory = objectKey.endsWith('/') || isRoot;
  let rootSize = 0;
  let rootLastModified = new Date();
  let rootType = 'application/octet-stream';

  if (isDirectory && !isRoot) {
    const exists = await c.env.STORAGE_R2.list({ prefix, delimiter: '/', limit: 1 });
    if (!exists.objects.length && !exists.delimitedPrefixes.length) return c.text('Not Found', 404);
  }
  if (!isDirectory) {
    const object = await c.env.STORAGE_R2.head(objectKey);
    if (object) {
      rootSize = object.size;
      rootLastModified = object.uploaded;
      rootType = contentType(objectKey, object.httpMetadata?.contentType);
    } else {
      const listed = await c.env.STORAGE_R2.list({ prefix, delimiter: '/', limit: 1 });
      if (listed.objects.length || listed.delimitedPrefixes.length) isDirectory = true;
      else return c.text('Not Found', 404);
    }
  }

  const renderResponse = (href: string, collection: boolean, size: number, lastModified: Date, type = 'application/octet-stream') => {
    let response = `  <D:response>\n    <D:href>${escapeXML(href)}</D:href>\n    <D:propstat>\n      <D:prop>\n`;
    if (collection) response += '        <D:resourcetype><D:collection/></D:resourcetype>\n';
    else response += `        <D:resourcetype/>\n        <D:getcontentlength>${size}</D:getcontentlength>\n        <D:getcontenttype>${escapeXML(type)}</D:getcontenttype>\n`;
    response += `        <D:getlastmodified>${formatHTTPDate(lastModified)}</D:getlastmodified>\n        <D:creationdate>${formatISO8601(lastModified)}</D:creationdate>\n      </D:prop>\n      <D:status>HTTP/1.1 200 OK</D:status>\n    </D:propstat>\n  </D:response>\n`;
    return response;
  };

  const requestHref = canonicalHref(access, objectKey, isDirectory);
  let xml = '<?xml version="1.0" encoding="utf-8" ?>\n<D:multistatus xmlns:D="DAV:">\n';
  xml += renderResponse(requestHref, isDirectory, rootSize, rootLastModified, rootType);

  if (depth === '1' && isDirectory) {
    let cursor: string | undefined;
    do {
      const listed = await c.env.STORAGE_R2.list({ prefix, delimiter: '/', cursor });
      for (const subPrefix of listed.delimitedPrefixes) {
        const name = subPrefix.substring(prefix.length).replace(/\/$/, '');
        const href = `${requestHref.endsWith('/') ? requestHref : `${requestHref}/`}${encodeURIComponent(name)}/`;
        xml += renderResponse(href, true, 0, new Date());
      }
      for (const object of listed.objects) {
        if (object.key === prefix) continue;
        const name = object.key.substring(prefix.length);
        const href = `${requestHref.endsWith('/') ? requestHref : `${requestHref}/`}${encodeURIComponent(name)}`;
        xml += renderResponse(href, false, object.size, object.uploaded, contentType(name, object.httpMetadata?.contentType));
      }
      cursor = listed.truncated ? listed.cursor : undefined;
    } while (cursor);
  }

  c.header('Content-Type', 'application/xml; charset=utf-8');
  c.header('Cache-Control', 'private, no-store');
  return c.body(`${xml}</D:multistatus>`, 207);
}

export async function readWebDav(c: Context<AppEnv>, access: DavAccess, objectKey: string): Promise<Response> {
  if (!objectKey.startsWith(access.rootKey)) return c.text('Forbidden', 403);
  const method = c.req.method;
  if (method === 'OPTIONS') {
    c.header('Allow', access.writable ? 'OPTIONS, GET, HEAD, PUT, DELETE, MKCOL, PROPFIND' : 'OPTIONS, GET, HEAD, PROPFIND');
    c.header('DAV', '1');
    return c.text('', 200);
  }
  if (method === 'PROPFIND') return handlePropfind(c, access, objectKey);
  if (method !== 'GET' && method !== 'HEAD') return c.text('Method Not Allowed', 405, { Allow: 'OPTIONS, GET, HEAD, PROPFIND' });

  const object = method === 'HEAD' ? await c.env.STORAGE_R2.head(objectKey) : await c.env.STORAGE_R2.get(objectKey);
  if (!object) {
    if (method === 'HEAD') {
      const prefix = objectKey.endsWith('/') ? objectKey : `${objectKey}/`;
      const listed = await c.env.STORAGE_R2.list({ prefix, delimiter: '/', limit: 1 });
      if (objectKey === access.rootKey || listed.objects.length || listed.delimitedPrefixes.length) {
        return new Response(null, { status: 200, headers: { 'Content-Length': '0', 'Cache-Control': 'private, no-store' } });
      }
    }
    return c.text('Not Found', 404);
  }

  const filename = objectKey.split('/').pop() || 'download';
  const encodedName = encodeURIComponent(filename).replace(/['()*]/g, character => `%${character.charCodeAt(0).toString(16).toUpperCase()}`);
  const headers = new Headers({
    // Downloads are always attachments and never rendered as active browser content.
    'Content-Type': 'application/octet-stream',
    'Content-Disposition': `attachment; filename="download"; filename*=UTF-8''${encodedName}`,
    'X-Content-Type-Options': 'nosniff',
    'Content-Security-Policy': "sandbox; default-src 'none'",
    'ETag': object.httpEtag,
    'Last-Modified': object.uploaded.toUTCString(),
    'Content-Length': object.size.toString(),
    'Cache-Control': 'private, no-store, no-transform',
  });
  if (method === 'HEAD') return new Response(null, { headers, status: 200 });
  return new Response((object as R2ObjectBody).body, { headers, status: 200 });
}

export const webdavHandler = async (c: Context<AppEnv>) => {
  const username = c.get('username');
  if (!validUsername(username || '') || !c.get('user')) return c.text('Unauthorized', 401);
  const objectKey = requestObjectKey(username, c.req.url);
  if (objectKey === null) return c.text('Forbidden', 403);

  const method = c.req.method;
  if (method === 'MKCOL' || method === 'PUT' || method === 'DELETE') {
    return storageRequest(c.env, username, method === 'MKCOL' ? 'mkcol' : method.toLowerCase(), {
      key: objectKey, request: c.req.raw, user: c.get('user'),
    });
  }
  const pathname = new URL(c.req.url).pathname;
  const mountPath = /^\/webdav(?:\/|$)/.test(pathname) ? '/webdav/' : '/';
  return readWebDav(c, { owner: username, rootKey: `${username}/`, mountPath, writable: true }, objectKey);
};
