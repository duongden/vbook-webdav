import type { BookMetadata, BookMetadataRecord, Env, PublicWebDavShare, WebDavShare } from '../types';
import { normalizeSharePrefix, validUsername } from '../utils/path';

const MIB = 1024 * 1024;
const MAX_UPLOAD = 100 * 1000 * 1000;
const RETRY_MS = 30_000;
const DELETE_PAGES = 20;
const SHARE_ID = /^[A-Za-z0-9_-]{20,64}$/;
const MAX_SHARES = 100;

/** One instance per user: serialize R2 mutations and the durable usage counter. */
export class UserStorage {
  private tail: Promise<unknown> = Promise.resolve();

  constructor(private readonly state: DurableObjectState, private readonly env: Env) {}

  private exclusive<T>(operation: () => Promise<T>): Promise<T> {
    // DO requests can interleave while awaiting R2. The explicit queue prevents that.
    const result = this.tail.then(operation);
    this.tail = result.catch(() => undefined);
    return result;
  }

  fetch(request: Request): Promise<Response> {
    return this.exclusive(() => this.handle(request));
  }

  private async usage(username: string): Promise<number> {
    const cached = await this.state.storage.get<number>('usage');
    if (cached !== undefined && !await this.state.storage.get<boolean>('dirty')) return cached;
    // Initialize existing buckets, or recover an R2 mutation interrupted before accounting.
    let bytes = 0;
    let cursor: string | undefined;
    do {
      const page = await this.env.STORAGE_R2.list({ prefix: `${username}/`, cursor });
      for (const object of page.objects) bytes += object.size;
      cursor = page.truncated ? page.cursor : undefined;
    } while (cursor);
    await this.state.storage.put({ usage: bytes, dirty: false });
    return bytes;
  }

  private async handle(request: Request): Promise<Response> {
    const username = request.headers.get('X-Storage-User') || '';
    if (!validUsername(username)) return new Response('Forbidden', { status: 403 });
    const owner = await this.state.storage.get<string>('owner');
    if (owner && owner !== username) return new Response('Forbidden', { status: 403 });
    if (!owner) await this.state.storage.put('owner', username);

    const action = new URL(request.url).pathname;
    const pending = await this.state.storage.get<string>('delete');
    if (pending) {
      // Resume persisted deletion before allowing any new write into that user's tree.
      if (!await this.drainDelete()) return this.busy();
    }
    if (action === '/usage') return Response.json({ bytes: await this.usage(username) });
    if (action === '/activate') {
      await this.state.storage.put('disabled', false);
      return new Response(null, { status: 204 });
    }
    if (action === '/suspend') {
      await this.state.storage.put('disabled', true);
      return new Response(null, { status: 204 });
    }
    if (action !== '/retire' && action !== '/drive-delete' && await this.state.storage.get<boolean>('disabled')) {
      return new Response('Account storage is disabled', { status: 403 });
    }

    if (action === '/drive-get') return Response.json(await this.state.storage.get('drive-config') || null);
    if (action === '/drive-delete') {
      await this.state.storage.delete('drive-config');
      return new Response(null, { status: 204 });
    }
    if (action === '/drive-set') {
      const config = await request.json<{ folderId: string; encryptedKey: string }>();
      if (!/^[A-Za-z0-9_-]{10,100}$/.test(config.folderId) || typeof config.encryptedKey !== 'string' || config.encryptedKey.length > 2048) return new Response('Invalid config', { status: 400 });
      await this.state.storage.put('drive-config', config);
      return new Response(null, { status: 204 });
    }
    if (action.startsWith('/share-')) return this.handleShare(action, request);
    if (action.startsWith('/metadata-')) return this.handleMetadata(action, request, username);

    let key: string;
    try { key = decodeURIComponent(request.headers.get('X-Storage-Key') || ''); }
    catch { return new Response('Invalid key', { status: 400 }); }
    if (!key.startsWith(`${username}/`)) return new Response('Forbidden', { status: 403 });

    if (action === '/delete' || action === '/retire') {
      if (action === '/retire') {
        await this.state.storage.put('disabled', true);
        await this.state.storage.delete('drive-config');
        const shares = await this.state.storage.list<WebDavShare>({ prefix: 'share:' });
        if (shares.size) await this.state.storage.delete([...shares.keys()]);
      }
      // Persist the job and its retry alarm before touching R2. DELETE is idempotent.
      await this.state.storage.put({ delete: key, dirty: true });
      await this.state.storage.setAlarm(Date.now() + RETRY_MS);
      return await this.drainDelete() ? new Response(null, { status: 204 }) : this.busy();
    }
    if (action === '/mkcol') {
      if (key === `${username}/backup-history` || key.startsWith(`${username}/backup-history/`)) return new Response('Backup history is read-only', { status: 403 });
      const directory = key.endsWith('/') ? key : `${key}/`;
      const fileKey = directory.slice(0, -1);
      if (await this.env.STORAGE_R2.head(fileKey)) return new Response('A file already exists at this path', { status: 405 });
      // VBook may repeat MKCOL on every backup. Treat an existing collection as success.
      if (directory === `${username}/` || await this.env.STORAGE_R2.head(directory)) return new Response(null, { status: 201 });
      const children = await this.env.STORAGE_R2.list({ prefix: directory, limit: 1 });
      if (children.objects.length) return new Response(null, { status: 201 });
      await this.env.STORAGE_R2.put(directory, '');
      return new Response(null, { status: 201 });
    }
    if (action !== '/put') return new Response('Not Found', { status: 404 });
    if (key === `${username}/backup-history` || key.startsWith(`${username}/backup-history/`)) return new Response('Backup history is read-only', { status: 403 });
    if (key.endsWith('/')) return new Response('Cannot replace a collection', { status: 405 });

    const lengthHeader = request.headers.get('Content-Length');
    if (lengthHeader === null) return new Response('Content-Length required', { status: 411 });
    const length = Number(lengthHeader);
    if (!/^\d+$/.test(lengthHeader) || !Number.isSafeInteger(length)) {
      return new Response('Invalid Content-Length', { status: 400 });
    }
    const quota = Number(request.headers.get('X-Quota-MB')) * MIB;
    const maxFile = Number(request.headers.get('X-Max-File-MB')) * MIB;
    if (!Number.isFinite(quota) || quota <= 0 || !Number.isFinite(maxFile) || maxFile <= 0) {
      return new Response('Invalid quota configuration', { status: 503 });
    }
    if (length > Math.min(maxFile, MAX_UPLOAD)) return new Response('Payload Too Large', { status: 413 });

    const used = await this.usage(username);
    const previous = await this.env.STORAGE_R2.head(key);
    // The old object stays in history, so each upload consumes its full size.
    if (used + length > quota) {
      return new Response('Insufficient Storage', { status: 507 });
    }
    const children = await this.env.STORAGE_R2.list({ prefix: `${key}/`, limit: 1 });
    if (children.objects.length) return new Response('Cannot replace a collection', { status: 405 });

    await this.state.storage.put('dirty', true);
    let historyKey: string | undefined;
    if (previous) {
      const timestamp = new Date(Date.now() + 7 * 60 * 60 * 1000).toISOString().replace('T', '_').replace(/[:.]/g, '-').replace('Z', '_UTC+7');
      historyKey = `${username}/backup-history/${timestamp}_${crypto.randomUUID()}/${key.substring(username.length + 1)}`;
      if (new TextEncoder().encode(historyKey).length > 1024) return new Response('Path too long for backup history', { status: 414 });
      const old = await this.env.STORAGE_R2.get(key);
      if (!old) throw new Error('Previous backup disappeared');
      // Finish the durable copy before replacing the live object. Stream without buffering.
      await this.env.STORAGE_R2.put(historyKey, old.body, { httpMetadata: old.httpMetadata, customMetadata: old.customMetadata });
    }
    const metadata = { httpMetadata: { contentType: request.headers.get('Content-Type') || 'application/octet-stream' } };
    let committed = false;
    try {
      let uploaded: R2Object;
      if (request.body) {
        // R2 requires a known-length stream; abort atomically if the actual body differs.
        const stream = new FixedLengthStream(length);
        const controller = new AbortController();
        let actual = 0;
        let lengthMismatch = false;
        const measured = request.body.pipeThrough(new TransformStream<Uint8Array, Uint8Array>({
          transform(chunk, output) {
            actual += chunk.byteLength;
            if (actual > length) {
              lengthMismatch = true;
              throw new Error('Body length mismatch');
            }
            output.enqueue(chunk);
          },
          flush() {
            if (actual !== length) {
              lengthMismatch = true;
              throw new Error('Body length mismatch');
            }
          },
        }));
        const results = await Promise.allSettled([
          measured.pipeTo(stream.writable, { signal: controller.signal }),
          this.env.STORAGE_R2.put(key, stream.readable, metadata).catch(error => {
            // Unblock an outstanding write if R2 rejected before it acquired the reader.
            void stream.readable.cancel(error).catch(() => undefined);
            controller.abort(error);
            throw error;
          }),
        ]);
        const write = results[1];
        if (lengthMismatch) return new Response('Body length mismatch', { status: 400 });
        if (controller.signal.aborted && write.status === 'rejected') throw write.reason;
        if (results[0].status === 'rejected') return new Response('Body length mismatch', { status: 400 });
        if (write.status === 'rejected') throw write.reason;
        uploaded = write.value;
      } else {
        if (length !== 0) return new Response('Body length mismatch', { status: 400 });
        uploaded = await this.env.STORAGE_R2.put(key, '', metadata);
      }
      committed = true;
      await this.state.storage.put({ usage: used + uploaded.size, dirty: false });
      return new Response(null, { status: 201 });
    } finally {
      // Failed uploads retain the original; remove only the redundant copy from this attempt.
      // A process crash can leave an extra history copy; dirty accounting recovers it.
      if (!committed && historyKey) await this.env.STORAGE_R2.delete(historyKey);
    }
  }

  private async handleShare(action: string, request: Request): Promise<Response> {
    const id = request.headers.get('X-Share-Id') || '';
    if (action === '/share-list') {
      const records = await this.state.storage.list<WebDavShare>({ prefix: 'share:' });
      const shares: PublicWebDavShare[] = [...records.values()]
        .map(({ secret_hash: _secret, ...share }) => share.expires_at !== undefined && share.expires_at <= Date.now() ? { ...share, status: 'revoked' as const } : share)
        .sort((a, b) => b.created_at - a.created_at);
      return Response.json({ shares });
    }
    if (!SHARE_ID.test(id)) return new Response('Invalid share', { status: 400 });
    const storageKey = `share:${id}`;

    if (action === '/share-auth') {
      const share = await this.state.storage.get<WebDavShare>(storageKey);
      const supplied = request.headers.get('X-Share-Secret-Hash') || '';
      if (!share || share.status !== 'active' || !constantTimeEqual(share.secret_hash, supplied) || (share.expires_at !== undefined && share.expires_at <= Date.now())) {
        return new Response('Unauthorized', { status: 401 });
      }
      const { secret_hash: _secret, ...publicShare } = share;
      return Response.json(publicShare);
    }

    if (action === '/share-create') {
      if (await this.state.storage.get<WebDavShare>(storageKey)) return new Response('Share already exists', { status: 409 });
      const records = await this.state.storage.list<WebDavShare>({ prefix: 'share:' });
      if (records.size >= MAX_SHARES) return new Response('Share limit reached', { status: 409 });
      let prefix: string | null = null;
      let label = '';
      try {
        prefix = normalizeSharePrefix(decodeURIComponent(request.headers.get('X-Share-Prefix') || ''));
        label = decodeURIComponent(request.headers.get('X-Share-Label') || '').trim();
      } catch { return new Response('Invalid share configuration', { status: 400 }); }
      const secretHash = request.headers.get('X-Share-Secret-Hash') || '';
      const expires = request.headers.get('X-Share-Expires');
      const expiresAt = expires ? Number(expires) : undefined;
      if (!prefix || !label || label.length > 80 || !/^[A-Za-z0-9_-]{43}$/.test(secretHash) || (expiresAt !== undefined && (!Number.isSafeInteger(expiresAt) || expiresAt <= Date.now()))) {
        return new Response('Invalid share configuration', { status: 400 });
      }
      const share: WebDavShare = { id, label, prefix, secret_hash: secretHash, created_at: Date.now(), ...(expiresAt ? { expires_at: expiresAt } : {}), status: 'active' };
      await this.state.storage.put(storageKey, share);
      const { secret_hash: _secret, ...publicShare } = share;
      return Response.json(publicShare, { status: 201 });
    }

    const share = await this.state.storage.get<WebDavShare>(storageKey);
    if (!share) return new Response('Not Found', { status: 404 });
    if (action === '/share-rotate') {
      const secretHash = request.headers.get('X-Share-Secret-Hash') || '';
      if (!/^[A-Za-z0-9_-]{43}$/.test(secretHash)) return new Response('Invalid secret', { status: 400 });
      await this.state.storage.put(storageKey, { ...share, secret_hash: secretHash, status: 'active' });
      return new Response(null, { status: 204 });
    }
    if (action === '/share-revoke') {
      await this.state.storage.put(storageKey, { ...share, status: 'revoked' });
      return new Response(null, { status: 204 });
    }
    return new Response('Not Found', { status: 404 });
  }

  private busy(): Response {
    return new Response('Deletion in progress; retry shortly', { status: 503, headers: { 'Retry-After': '30' } });
  }

  private async drainDelete(): Promise<boolean> {
    const key = await this.state.storage.get<string>('delete');
    if (!key) return true;
    await this.env.STORAGE_R2.delete(key);
    const prefix = key.endsWith('/') ? key : `${key}/`;
    // Always take the first remaining page; this also resumes safely after a restart.
    for (let page = 0; page < DELETE_PAGES; page++) {
      const listed = await this.env.STORAGE_R2.list({ prefix, limit: 1000 });
      if (listed.objects.length) await this.env.STORAGE_R2.delete(listed.objects.map(object => object.key));
      if (!listed.truncated) {
        await this.deleteMetadataForKey(key);
        await this.state.storage.delete('delete');
        await this.state.storage.deleteAlarm();
        // Keep dirty=true: next usage query reconciles R2, including any partial retry.
        return true;
      }
    }
    await this.state.storage.setAlarm(Date.now() + RETRY_MS);
    return false;
  }

  private async handleMetadata(action: string, request: Request, username: string): Promise<Response> {
    if (action === '/metadata-list') {
      const records = await this.state.storage.list<BookMetadataRecord>({ prefix: 'metadata:' });
      return Response.json({ records: [...records.values()].sort((a, b) => b.updated_at - a.updated_at) });
    }
    let body: unknown;
    try { body = await request.json(); } catch { return new Response('Invalid metadata', { status: 400 }); }
    if (!body || typeof body !== 'object' || Array.isArray(body)) return new Response('Invalid metadata', { status: 400 });
    const input = body as Record<string, unknown>;
    const path = typeof input.path === 'string' ? input.path : '';
    if (!path.startsWith(`${username}/library/`) || path.endsWith('/') || path.length > 1024) return new Response('Invalid metadata path', { status: 400 });
    const storageKey = `metadata:${path.substring(username.length + 1)}`;
    if (action === '/metadata-delete') {
      await this.state.storage.delete(storageKey);
      return new Response(null, { status: 204 });
    }
    if (action !== '/metadata-put') return new Response('Not Found', { status: 404 });
    const metadata = validateBookMetadata(input.metadata);
    if (metadata === null) return new Response('Invalid metadata', { status: 400 });
    const record: BookMetadataRecord = { path, metadata, updated_at: Date.now() };
    await this.state.storage.put(storageKey, record);
    return Response.json(record);
  }

  private async deleteMetadataForKey(key: string): Promise<void> {
    // Lightweight recovery fixtures implement only the storage methods involved in deletion.
    if (typeof this.state.storage.list !== 'function') return;
    const records = await this.state.storage.list<BookMetadataRecord>({ prefix: 'metadata:' });
    const prefix = key.endsWith('/') ? key : `${key}/`;
    const remove: string[] = [];
    for (const [storageKey, record] of records) {
      if (record.path === key || record.path.startsWith(prefix)) remove.push(storageKey);
    }
    if (remove.length) await this.state.storage.delete(remove);
  }

  alarm(): Promise<void> {
    return this.exclusive(async () => {
      try { await this.drainDelete(); }
      catch (error) {
        await this.state.storage.setAlarm(Date.now() + RETRY_MS);
        throw error;
      }
    });
  }
}

function constantTimeEqual(a: string, b: string): boolean {
  let diff = a.length ^ b.length;
  for (let index = 0; index < Math.max(a.length, b.length); index++) {
    diff |= (a.charCodeAt(index) || 0) ^ (b.charCodeAt(index) || 0);
  }
  return diff === 0;
}

function validateBookMetadata(value: unknown): BookMetadata | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const input = value as Record<string, unknown>;
  const limits: Record<keyof BookMetadata, number> = { title: 240, author: 240, language: 35, category: 120, description: 5000, coverUrl: 2048 };
  const result: BookMetadata = {};
  for (const field of Object.keys(limits) as Array<keyof BookMetadata>) {
    const raw = input[field];
    if (raw === undefined || raw === '') continue;
    if (typeof raw !== 'string') return null;
    const text = raw.trim();
    if (!text) continue;
    if (text.length > limits[field] || /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(text)) return null;
    if (field === 'language' && !/^[a-z]{2,3}(?:-[a-z0-9]{2,8})*$/i.test(text)) return null;
    if (field === 'coverUrl') {
      try {
        const url = new URL(text);
        if (url.protocol !== 'https:' || url.username || url.password) return null;
        result.coverUrl = url.href;
      } catch { return null; }
    } else {
      result[field] = text;
    }
  }
  return result;
}
