import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

export async function configureCloudflare(env = process.env, directory = process.cwd()) {
  const rules = {
    CF_WORKER_NAME: /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/,
    CF_KV_NAMESPACE_ID: /^[a-fA-F0-9]{32}$/,
    CF_R2_BUCKET_NAME: /^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/,
  };
  for (const [key, rule] of Object.entries(rules)) {
    if (typeof env[key] !== 'string' || !rule.test(env[key])) {
      throw new Error(`Set a valid ${key} in Cloudflare Builds variables.`);
    }
  }
  if (env.WRANGLER_CI_OVERRIDE_NAME && env.WRANGLER_CI_OVERRIDE_NAME !== env.CF_WORKER_NAME) {
    throw new Error('CF_WORKER_NAME must match the connected Cloudflare Worker.');
  }
  const template = await readFile(new URL('../config/wrangler.example.jsonc', import.meta.url), 'utf8');
  const config = JSON.parse(template.split('\n').filter(line => !line.trim().startsWith('//')).join('\n'));
  config.name = env.CF_WORKER_NAME;
  config.kv_namespaces[0].id = env.CF_KV_NAMESPACE_ID;
  config.r2_buckets[0].bucket_name = env.CF_R2_BUCKET_NAME;
  config.keep_vars = true;
  // Never overwrite private local configuration or copy process.env into runtime vars.
  try {
    await writeFile(resolve(directory, 'wrangler.jsonc'), JSON.stringify(config, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
  } catch (error) {
    if (error.code === 'EEXIST') throw new Error('wrangler.jsonc already exists; existing configuration was preserved.');
    throw new Error('Could not write build configuration.');
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  configureCloudflare().then(() => {
    console.log('Generated ignored Wrangler configuration. Private values omitted.');
  }).catch(error => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
