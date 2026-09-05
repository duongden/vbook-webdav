import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { configureCloudflare } from '../scripts/configure-cloudflare.mjs';

const env = { CF_WORKER_NAME: 'test-worker', CF_KV_NAMESPACE_ID: '0'.repeat(32), CF_R2_BUCKET_NAME: 'test-bucket' };
async function fixture(t) {
  const dir = await mkdtemp(join(tmpdir(), 'vbook-build-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

test('build configuration keeps bindings and migrations without embedding secrets', async t => {
  const dir = await fixture(t);
  await configureCloudflare({ ...env, ADMIN_PIN: 'test-only-do-not-copy', CLOUDFLARE_API_TOKEN: 'test-only-token' }, dir);
  const text = await readFile(join(dir, 'wrangler.jsonc'), 'utf8');
  const config = JSON.parse(text);
  assert.equal(config.name, env.CF_WORKER_NAME);
  assert.deepEqual(config.kv_namespaces, [{ binding: 'USER_KV', id: env.CF_KV_NAMESPACE_ID }]);
  assert.deepEqual(config.r2_buckets, [{ binding: 'STORAGE_R2', bucket_name: env.CF_R2_BUCKET_NAME }]);
  assert.equal(config.durable_objects.bindings[0].class_name, 'UserStorage');
  assert.deepEqual(config.migrations[0].new_sqlite_classes, ['UserStorage']);
  assert.equal(config.keep_vars, true);
  assert.equal(config.vars, undefined);
  assert.ok(!text.includes('test-only'));
});

test('missing variables or wrong connected Worker fail before writing', async t => {
  const dir = await fixture(t);
  for (const key of Object.keys(env)) {
    await assert.rejects(configureCloudflare({ ...env, [key]: '' }, dir), new RegExp(key));
  }
  await assert.rejects(configureCloudflare({ ...env, WRANGLER_CI_OVERRIDE_NAME: 'another-worker' }, dir), /must match/);
  await assert.rejects(readFile(join(dir, 'wrangler.jsonc')), { code: 'ENOENT' });
});

test('existing private config is never overwritten', async t => {
  const dir = await fixture(t);
  const path = join(dir, 'wrangler.jsonc');
  await writeFile(path, 'existing private configuration');
  await assert.rejects(configureCloudflare(env, dir), /preserved/);
  assert.equal(await readFile(path, 'utf8'), 'existing private configuration');
});
