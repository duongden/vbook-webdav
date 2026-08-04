import { Context } from 'hono';
import { Env } from '../types';

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

/**
 * SECURITY (VULN-04): Sanitize and validate the R2 object key to prevent path traversal.
 * Returns null if the resulting key escapes the user's own directory.
 */
export function sanitizeObjectKey(username: string, rawPath: string): string | null {
  // Decode any percent-encoded sequences before checking
  let decoded: string;
  try {
    decoded = decodeURIComponent(rawPath);
  } catch {
    return null; // Malformed encoding
  }

  // Normalize path: collapse consecutive slashes and resolve '..' segments
  const segments = decoded.split('/');
  const resolved: string[] = [];
  for (const seg of segments) {
    if (seg === '..') {
      resolved.pop(); // Go up one level
    } else if (seg !== '.') {
      resolved.push(seg);
    }
  }
  const normalizedPath = resolved.join('/');

  // Build the final key and ensure it is strictly prefixed by the user's directory
  const userPrefix = `${username}/`;
  const objectKey = normalizedPath === '' || normalizedPath === '/' ? userPrefix : `${username}/${normalizedPath.replace(/^\//, '')}`;
  if (!objectKey.startsWith(userPrefix)) {
    return null; // Path traversal detected — reject
  }
  return objectKey;
}

async function handlePropfind(c: Context<{ Bindings: Env; Variables: { username: string } }>) {
  const username = c.get('username');
  let path = c.req.path.replace(/^\/webdav/, '');
  if (!path.startsWith('/')) path = '/' + path;

  // SECURITY (VULN-04): Validate path against traversal — consistent with other methods
  const sanitized = sanitizeObjectKey(username, path);
  if (sanitized === null) {
    return c.text('Forbidden', 403);
  }

  const depth = c.req.header('Depth') || '1';
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

export const webdavHandler = async (c: Context<{ Bindings: Env; Variables: { username: string; uploadedObj?: R2Object } }>) => {
  const method = c.req.method;
  const username = c.get('username');
  let path = c.req.path.replace(/^\/webdav/, '');
  if (!path.startsWith('/')) path = '/' + path;

  // SECURITY (VULN-04): Validate the path and build a safe R2 object key
  const objectKey = sanitizeObjectKey(username, path);
  if (objectKey === null) {
    return c.text('Forbidden', 403);
  }

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
    const uploaded = await c.env.STORAGE_R2.put(objectKey, body, {
      httpMetadata: {
        contentType: c.req.header('Content-Type') || 'application/octet-stream'
      }
    });
    c.set('uploadedObj', uploaded);
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
    // Invalidate KV usage cache immediately
    await c.env.USER_KV.delete(`usage:${username}`);

    c.executionCtx.waitUntil((async () => {
      const dirPrefix = objectKey.endsWith('/') ? objectKey : objectKey + '/';
      let listOptions: R2ListOptions = { prefix: dirPrefix };
      let listed;
      let deletedAny = false;

      do {
        listed = await c.env.STORAGE_R2.list(listOptions);
        if (listed.objects.length > 0) {
          const keys = listed.objects.map(o => o.key);
          // Delete in chunks of 50 to avoid CF subrequest limits
          for (let i = 0; i < keys.length; i += 50) {
            await Promise.all(keys.slice(i, i + 50).map(k => c.env.STORAGE_R2.delete(k)));
          }
          deletedAny = true;
        }
        listOptions.cursor = listed.truncated ? listed.cursor : undefined;
      } while (listed.truncated);

      if (deletedAny) {
        // Re-invalidate in case files were actually deleted
        await c.env.USER_KV.delete(`usage:${username}`);
      }
    })());

    return c.text('No Content', 204);
  }

  return c.text('Method Not Allowed', 405);
};
