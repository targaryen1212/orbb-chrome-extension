import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';

// Exercise the exact self-contained function serialized into Instagram's tab.
const source = readFileSync(new URL('../src/background.ts', import.meta.url), 'utf8');
const collector = source.slice(source.indexOf('function collectSocialItemsInPage('), source.indexOf('\nfunction waitForTab('));
const compiled = ts.transpileModule(collector, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
async function scan(folderStatus: number, savedStatus = 200) {
  const requests: string[] = [];
  const result = await runInNewContext(compiled + '\ncollectSocialItemsInPage("instagram", 0, 30000, [])', {
    URL, URLSearchParams, setTimeout,
    document: { cookie: '' },
    location: { href: 'https://www.instagram.com/test/saved/all-posts/' },
    fetch: async (url: string) => {
      requests.push(url);
      const isFolders = url.includes('/collections/list/');
      const status = isFolders ? folderStatus : savedStatus;
      return { ok: status === 200, status, json: async () => isFolders
        ? { items: [{ collection_id: 'recipes', collection_name: 'Recipes', collection_type: 'MEDIA' }] }
        : { items: [{ media: { code: 'ABC', caption: { text: 'Saved post' } } }], more_available: false } };
    },
  });
  return { result, requests };
}
test('folder discovery failure still imports All saved with an explicit warning', async () => {
  const { result, requests } = await scan(403);
  assert.equal(result.ok, true);
  assert.equal(result.items.length, 1);
  assert.equal(result.items[0].collection, 'All saved');
  assert.match(result.warning, /without folder memberships/);
  assert.ok(requests.some(url => url.includes('/feed/saved/posts/')));
});
test('available folders retain their names without a fallback warning', async () => {
  const { result } = await scan(200);
  assert.equal(result.ok, true);
  assert.equal(result.items[0].collection, 'Recipes');
  assert.equal(result.warning, undefined);
});
test('failure of All saved remains an error rather than a successful empty import', async () => {
  const { result } = await scan(403, 401);
  assert.equal(result.ok, false);
  assert.match(result.error, /Instagram returned 401/);
});
