import { test } from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';

const result = await build({
  entryPoints: ['src/webdav/google-drive.ts'], bundle: true, write: false, format: 'esm', platform: 'browser',
});
const module = await import(`data:text/javascript;base64,${Buffer.from(result.outputFiles[0].text).toString('base64')}`);

test('Google Drive folder parser accepts only bounded Drive folder links and IDs', () => {
  assert.equal(module.extractDriveFolderId('https://drive.google.com/drive/folders/ROOT_FOLDER_12345'), 'ROOT_FOLDER_12345');
  assert.equal(module.extractDriveFolderId('https://drive.google.com/drive/u/1/folders/ROOT_FOLDER_12345?usp=sharing'), 'ROOT_FOLDER_12345');
  assert.equal(module.extractDriveFolderId('https://drive.google.com/open?id=ROOT_FOLDER_12345'), 'ROOT_FOLDER_12345');
  assert.equal(module.extractDriveFolderId('ROOT_FOLDER_12345'), 'ROOT_FOLDER_12345');
  for (const value of [
    'http://drive.google.com/drive/folders/ROOT_FOLDER_12345',
    'https://drive.google.com.evil.example/drive/folders/ROOT_FOLDER_12345',
    'https://user@drive.google.com/drive/folders/ROOT_FOLDER_12345',
    'https://evil.example/drive/folders/ROOT_FOLDER_12345',
    'short',
  ]) assert.equal(module.extractDriveFolderId(value), null, value);
});
