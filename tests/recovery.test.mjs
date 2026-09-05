import { test } from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';

const { outputFiles } = await build({ entryPoints: ['src/storage/user-storage.ts'], bundle: true, format: 'esm', platform: 'node', write: false });
const { UserStorage } = await import(`data:text/javascript;base64,${Buffer.from(outputFiles[0].text).toString('base64')}`);

// Node equivalent for fault injection. The integration suite uses workerd's intrinsic.
globalThis.FixedLengthStream = class {
  constructor(expected) {
    let actual = 0;
    const stream = new TransformStream({
      transform(chunk, controller) {
        actual += chunk.byteLength;
        if (actual > expected) throw new Error('Too long');
        controller.enqueue(chunk);
      },
      flush() { if (actual !== expected) throw new Error('Too short'); },
    });
    this.readable = stream.readable;
    this.writable = stream.writable;
  }
};
function fixture(count = 5) {
  const data = new Map(), objects = new Map();
  for (let i = 0; i < count; i++) objects.set(`alice/tree/${i}`, new Uint8Array(1));
  objects.set('alice/keep', new Uint8Array(3));
  let scheduled = null;
  const state = { storage: {
    get: async key => data.get(key),
    put: async (key, value) => { for (const [k, v] of typeof key === 'string' ? [[key, value]] : Object.entries(key)) data.set(k, v); },
    delete: async key => data.delete(key),
    setAlarm: async when => { scheduled = when; },
    deleteAlarm: async () => { scheduled = null; },
  } };
  const bucket = {
    list: async ({ prefix, cursor }) => {
      const all = [...objects].filter(([key]) => key.startsWith(prefix)).map(([key, body]) => ({ key, size: body.byteLength }));
      const offset = Number(cursor || 0), page = all.slice(offset, offset + 2);
      return { objects: page, truncated: all.length > offset + 2, cursor: String(offset + 2) };
    },
    get: async key => objects.has(key) ? { body: new Response(objects.get(key)).body } : null,
    head: async key => objects.has(key) ? { size: objects.get(key).byteLength } : null,
    delete: async keys => { for (const key of Array.isArray(keys) ? keys : [keys]) objects.delete(key); },
    put: async (key, body) => {
      const bytes = new Uint8Array(await new Response(body).arrayBuffer());
      objects.set(key, bytes);
      return { size: bytes.byteLength };
    },
  };
  const env = { STORAGE_R2: bucket };
  const instance = () => new UserStorage(state, env);
  const call = (object, action, key, body, length) => object.fetch(new Request(`https://internal/${action}`, {
    method: action === 'usage' ? 'GET' : 'POST', body,
    headers: { 'X-Storage-User': 'alice', ...(key ? { 'X-Storage-Key': encodeURIComponent(key) } : {}),
      'X-Quota-MB': '1', 'X-Max-File-MB': '1', ...(length === undefined ? {} : { 'Content-Length': String(length) }) },
    ...(body ? { duplex: 'half' } : {}),
  }));
  return { data, objects, bucket, instance, call, alarm: () => scheduled };
}

test('failed delete is persisted, restarted object retries and reconciles accounting', async () => {
  const f = fixture();
  const object = f.instance();
  assert.equal((await (await f.call(object, 'usage')).json()).bytes, 8);
  const original = f.bucket.delete;
  let fail = true;
  f.bucket.delete = async keys => {
    if (Array.isArray(keys) && fail) {
      fail = false;
      await original(keys[0]);
      throw new Error('Injected R2 failure');
    }
    return original(keys);
  };
  await assert.rejects(f.call(object, 'delete', 'alice/tree'), /Injected R2 failure/);
  assert.equal(f.data.get('delete'), 'alice/tree');
  assert.ok(f.alarm());
  const restarted = f.instance();
  await restarted.alarm();
  assert.equal(f.data.has('delete'), false);
  assert.equal(f.alarm(), null);
  assert.deepEqual([...f.objects.keys()], ['alice/keep']);
  assert.equal((await (await f.call(restarted, 'usage')).json()).bytes, 3);
});

test('large deletion reports pending instead of success, then an alarm finishes it', async () => {
  const f = fixture(45), object = f.instance();
  const response = await f.call(object, 'delete', 'alice/tree');
  assert.equal(response.status, 503);
  assert.equal(response.headers.get('Retry-After'), '30');
  assert.ok(f.data.has('delete'));
  await object.alarm();
  assert.deepEqual([...f.objects.keys()], ['alice/keep']);
});

test('actual upload size must match Content-Length and a failed overwrite keeps old data', async () => {
  for (const body of ['short', 'this payload is too long']) {
    const f = fixture(), object = f.instance();
    const response = await f.call(object, 'put', 'alice/keep', body, 10);
    assert.equal(response.status, 400);
    assert.equal(f.objects.get('alice/keep').byteLength, 3);
    assert.equal((await (await f.call(object, 'usage')).json()).bytes, 8);
  }
});

test('R2 failure cancels the upload pipeline instead of hanging or reporting success', { timeout: 5000 }, async () => {
  const f = fixture(), object = f.instance();
  f.bucket.put = async () => { throw new Error('Injected R2 failure'); };
  await assert.rejects(f.call(object, 'put', 'alice/keep', 'content', 7), /Injected R2 failure/);
  assert.equal(f.objects.get('alice/keep').byteLength, 3);
});


test('failed replacement after history copy preserves old file and cleans only redundant copy', async () => {
  const f = fixture(), object = f.instance();
  const original = f.bucket.put;
  f.bucket.put = async (key, body) => {
    if (key === 'alice/keep') throw new Error('Replacement failed');
    return original(key, body);
  };
  await assert.rejects(f.call(object, 'put', 'alice/keep', 'replacement', 11), /Replacement failed/);
  assert.equal(f.objects.get('alice/keep').byteLength, 3);
  assert.equal([...f.objects.keys()].filter(key => key.includes('/backup-history/')).length, 0);
  assert.equal((await (await f.call(object, 'usage')).json()).bytes, 8);
});
