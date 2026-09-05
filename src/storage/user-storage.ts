import type { Env } from '../types';
import { validUsername } from '../utils/path';

const MIB = 1024 * 1024;
const MAX_UPLOAD = 100 * 1000 * 1000;
const RETRY_MS = 30_000;
const DELETE_PAGES = 20;

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
    if (action !== '/retire' && await this.state.storage.get<boolean>('disabled')) {
      return new Response('Account storage is disabled', { status: 403 });
    }

    let key: string;
    try { key = decodeURIComponent(request.headers.get('X-Storage-Key') || ''); }
    catch { return new Response('Invalid key', { status: 400 }); }
    if (!key.startsWith(`${username}/`)) return new Response('Forbidden', { status: 403 });

    if (action === '/delete' || action === '/retire') {
      if (action === '/retire') await this.state.storage.put('disabled', true);
      // Persist the job and its retry alarm before touching R2. DELETE is idempotent.
      await this.state.storage.put({ delete: key, dirty: true });
      await this.state.storage.setAlarm(Date.now() + RETRY_MS);
      return await this.drainDelete() ? new Response(null, { status: 204 }) : this.busy();
    }
    if (action === '/mkcol') {
      if (key === `${username}/backup-history` || key.startsWith(`${username}/backup-history/`)) return new Response('Backup history is read-only', { status: 403 });
      const directory = key.endsWith('/') ? key : `${key}/`;
      if (await this.env.STORAGE_R2.head(key) || await this.env.STORAGE_R2.head(directory)) {
        return new Response('Collection already exists', { status: 405 });
      }
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
        await this.state.storage.delete('delete');
        await this.state.storage.deleteAlarm();
        // Keep dirty=true: next usage query reconciles R2, including any partial retry.
        return true;
      }
    }
    await this.state.storage.setAlarm(Date.now() + RETRY_MS);
    return false;
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
