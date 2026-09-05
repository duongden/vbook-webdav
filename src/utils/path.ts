export const validUsername = (value: string): boolean => /^[a-zA-Z0-9_-]{1,128}$/.test(value);

export function encodePath(path: string): string {
  return path.split('/').map(encodeURIComponent).join('/');
}

/** Use the raw URL, not Hono's already partially decoded req.path. Decode once. */
export function requestObjectKey(username: string, url: string): string | null {
  const pathname = new URL(url).pathname.replace(/^\/webdav(?=\/|$)/, '') || '/';
  return sanitizeObjectKey(username, pathname);
}

export function sanitizeObjectKey(username: string, rawPath: string): string | null {
  if (!validUsername(username)) return null;
  let path: string;
  try { path = decodeURIComponent(rawPath); } catch { return null; }
  if (/[\x00-\x1f\x7f\\]/.test(path)) return null;
  const segments = path.split('/').filter(Boolean);
  // Reject traversal instead of silently changing the requested resource.
  if (segments.some(segment => segment === '.' || segment === '..')) return null;
  const suffix = segments.join('/') + (segments.length && path.endsWith('/') ? '/' : '');
  return `${username}/${suffix}`;
}
