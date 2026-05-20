import { Context } from 'hono';
import { Env, UserConfig } from '../types';

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

async function handlePropfind(c: Context<{ Bindings: Env; Variables: { username: string } }>) {
  const username = c.get('username');
  let path = c.req.path.replace(/^\/webdav/, '');
  if (!path.startsWith('/')) path = '/' + path;
  
  const depth = c.req.header('Depth') || '1';
  const prefix = path === '/' ? `${username}/` : `${username}${path.endsWith('/') ? path : path + '/'}`;
  const filePrefix = path === '/' ? `${username}/` : `${username}${path}`;
  
  let xml = `<?xml version="1.0" encoding="utf-8" ?>\n`;
  xml += `<D:multistatus xmlns:D="DAV:">\n`;

  // For Depth 0 or 1, we always need the root element of the request
  const isRoot = path === '/';
  
  // If not root, check if it's a file or directory
  let isDirectory = path.endsWith('/') || isRoot;
  let rootSize = 0;
  let rootLastModified = new Date();
  
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

  const reqHref = c.req.path;
  xml += renderResponse(reqHref, isDirectory, rootSize, rootLastModified);

  if (depth === '1' && isDirectory) {
    const list = await c.env.STORAGE_R2.list({ prefix, delimiter: '/' });
    
    // Add subdirectories
    for (const subPrefix of list.delimitedPrefixes) {
      const dirName = subPrefix.substring(prefix.length);
      const subHref = reqHref.endsWith('/') ? `${reqHref}${dirName}` : `${reqHref}/${dirName}`;
      xml += renderResponse(subHref, true, 0, new Date());
    }

    // Add files
    for (const obj of list.objects) {
      if (obj.key === prefix) continue; // skip the folder itself if it exists as an object
      const fileName = obj.key.substring(prefix.length);
      const subHref = reqHref.endsWith('/') ? `${reqHref}${fileName}` : `${reqHref}/${fileName}`;
      xml += renderResponse(subHref, false, obj.size, obj.uploaded);
    }
  }

  xml += `</D:multistatus>`;
  c.header('Content-Type', 'application/xml; charset=utf-8');
  return c.body(xml, 207);
}

export const webdavHandler = async (c: Context<{ Bindings: Env; Variables: { username: string } }>) => {
  const method = c.req.method;
  const username = c.get('username');
  let path = c.req.path.replace(/^\/webdav/, '');
  if (!path.startsWith('/')) path = '/' + path;
  
  const objectKey = path === '/' ? `${username}/` : `${username}${path}`;

  if (method === 'OPTIONS') {
    c.header('Allow', 'OPTIONS, GET, HEAD, PUT, DELETE, MKCOL, PROPFIND');
    c.header('DAV', '1, 2');
    return c.text('', 200);
  }

  if (method === 'PROPFIND') {
    return handlePropfind(c);
  }

  if (method === 'MKCOL') {
    // In R2, we don't strictly need to create directories, but we can put an empty object with a trailing slash
    let dirKey = objectKey;
    if (!dirKey.endsWith('/')) dirKey += '/';
    await c.env.STORAGE_R2.put(dirKey, '');
    return c.text('Created', 201);
  }

  if (method === 'PUT') {
    const body = c.req.raw.body;
    await c.env.STORAGE_R2.put(objectKey, body, {
      httpMetadata: {
        contentType: c.req.header('Content-Type') || 'application/octet-stream'
      }
    });
    return c.text('Created', 201);
  }

  if (method === 'GET' || method === 'HEAD') {
    const obj = await c.env.STORAGE_R2.get(objectKey);
    if (!obj) {
      return c.text('Not Found', 404);
    }
    
    const headers = new Headers();
    if (obj.httpMetadata?.contentType) {
      headers.set('Content-Type', obj.httpMetadata.contentType);
    } else {
      headers.set('Content-Type', 'application/octet-stream');
    }
    headers.set('Content-Length', obj.size.toString());
    // CRITICAL: Prevent Cloudflare from auto-compressing and breaking Content-Length
    headers.set('Cache-Control', 'no-transform');
    
    if (method === 'HEAD') {
      return new Response(null, { headers, status: 200 });
    }
    return new Response(obj.body as ReadableStream, { headers, status: 200 });
  }

  if (method === 'DELETE') {
    await c.env.STORAGE_R2.delete(objectKey);
    // Note: To perfectly mimic a directory delete, we should delete all objects with this prefix.
    // For VBook, simple object delete might be enough, but let's implement prefix delete just in case.
    if (objectKey.endsWith('/')) {
      const list = await c.env.STORAGE_R2.list({ prefix: objectKey });
      const keys = list.objects.map(o => o.key);
      if (keys.length > 0) {
        // Cloudflare R2 currently requires deleting one by one or in batches.
        // For simplicity and to avoid limits in a single request, we do a loop (since usually few files).
        await Promise.all(keys.map(k => c.env.STORAGE_R2.delete(k)));
      }
    }
    return c.text('No Content', 204);
  }

  return c.text('Method Not Allowed', 405);
};
