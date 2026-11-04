import assert from 'node:assert/strict';
import { cp, mkdtemp, mkdir, readFile, realpath, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { basename, dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

if (!process.argv[2] || !process.argv[3]) throw new Error('Usage: node scripts/package-check.mjs <archive.tgz> <trusted DSH root>');
const archive = await realpath(resolve(process.argv[2]));
const runtimeRequire = createRequire(resolve(process.argv[3], 'package.json'));
const zodManifest = runtimeRequire.resolve('zod/package.json');
const zod = JSON.parse(await readFile(zodManifest, 'utf8'));
assert.match(zod.version, /^4\./);
assert.equal(Object.keys(zod.dependencies ?? {}).length, 0, 'this smoke copies only a dependency-free trusted peer');
function tar(args, cwd = dirname(archive)) {
  // GNU tar treats C: in an archive argument as a remote host. A basename
  // relative to cwd works for both GNU tar and Windows bsdtar.
  const localArgs = args.map(value => value === archive ? basename(archive) : value);
  const result = spawnSync('tar', localArgs, { cwd, encoding: 'utf8', shell: false });
  if (result.error) throw result.error;
  assert.equal(result.status, 0, result.stderr);
  return result.stdout;
}
const entries = tar(['-tzf', archive]).trim().split(/\r?\n/);
assert.ok(entries.length > 0);
for (const entry of entries) {
  assert.ok(entry.startsWith('package/') && !entry.split('/').includes('..'), `unexpected archive entry: ${entry}`);
}
// Fresh, agent-owned scratch only. No npm install, symlink, network or profile mutation.
const scratch = await mkdtemp(join(tmpdir(), 'dsh-output-detail-package-'));
try {
  const modules = join(scratch, 'node_modules');
  const target = join(modules, 'dsh-output-detail');
  await mkdir(target, { recursive: true });
  await cp(archive, join(scratch, 'bundle.tgz'));
  tar(['-xzf', '../../bundle.tgz', '--strip-components=1'], target);
  await cp(await realpath(dirname(zodManifest)), join(modules, 'zod'), { recursive: true, errorOnExist: true });
  const entry = await import(pathToFileURL(join(target, 'index.js')).href);
  assert.equal(entry.name, 'dsh-output-detail');
  assert.equal(typeof entry.apply, 'function');
  assert.deepEqual([...entry.inject].sort(), ['agents', 'commands', 'sessionProjections', 'tools']);
  const manifest = JSON.parse(await readFile(join(target, 'package.json'), 'utf8'));
  for (const resource of Object.values(manifest.exports)) await readFile(resolve(target, resource));
  console.log(`Packaged ESM entry and all exports loaded with trusted Zod ${zod.version} from an isolated physical-copy layout (${entries.length} archive files).`);
  console.log('No live profile installation, browser or model verification was performed.');
} finally {
  await rm(scratch, { recursive: true, force: true });
}
