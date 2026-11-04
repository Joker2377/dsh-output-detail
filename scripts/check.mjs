import { readFile, readdir, stat } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { resolve, relative } from 'node:path';
import assert from 'node:assert/strict';

const root = fileURLToPath(new URL('../', import.meta.url));
const pkg = JSON.parse(await readFile(resolve(root, 'package.json'), 'utf8'));
assert.equal(pkg.name, 'dsh-output-detail');
assert.equal(pkg.dsh.client.platform, 'web');
assert.equal(pkg.dsh.bundle.patch, './cordis.patch.yml');
for (const entry of ['index.js', 'client.js', 'lib/host.js', 'lib/projection.js', 'lib/style.js', 'cordis.patch.yml', 'icon.svg', 'LICENSE', 'README.md']) {
  assert.ok((await stat(resolve(root, entry))).isFile(), `Missing distribution file: ${entry}`);
}
for (const lang of ['en', 'zh']) {
  const locale = JSON.parse(await readFile(resolve(root, 'locale', `${lang}.json`), 'utf8'));
  assert.ok(locale.meta.title.trim());
  assert.ok(locale.meta.description.trim());
}
const paths = [];
async function collect(dir) {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    if (['.git', 'node_modules', 'coverage'].includes(entry.name)) continue;
    const path = resolve(dir, entry.name);
    if (entry.isDirectory()) await collect(path);
    else if (/\.(mjs|js)$/.test(entry.name)) paths.push(path);
  }
}
await collect(root);
for (const path of paths) {
  // Only syntax-check this project's declared source; never evaluates file contents.
  const result = spawnSync(process.execPath, ['--check', path], { encoding: 'utf8', shell: false });
  assert.equal(result.status, 0, `${relative(root, path)}\n${result.stderr}`);
}
const icon = await readFile(resolve(root, 'icon.svg'), 'utf8');
assert.match(icon, /<svg\b/);
assert.match(icon, /<title>/);
assert.ok(Buffer.byteLength(icon) < 256 * 1024);
assert.doesNotMatch(icon, /<script|onload=|https?:\/\/[^" ]+\.(js|png)/i);
console.log(`Checked manifest, locale resources, icon and ${paths.length} JavaScript files.`);
