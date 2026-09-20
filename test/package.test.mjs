/**
 * Package-shape tests: the properties that make BOTH documented install methods
 * work — `dsh plugin --profile web add link:<dir>` and `... add github:<owner>/<repo>`.
 *
 * These are static checks over the shipped files; they exist because the two
 * failure modes they guard against are silent. A single bare import
 * (`@deepseek-ai/...`, `zod`) resolves for a pnpm-installed plugin but throws
 * ERR_MODULE_NOT_FOUND for a linked one, and a `prepare` script makes pnpm hold
 * a git install until the user allowlists the build.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const manifest = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));

/** Every `.js` file the package ships. */
function shippedSources() {
  const files = ['index.js'];
  for (const entry of readdirSync(join(ROOT, 'lib'), { withFileTypes: true })) {
    if (entry.isFile() && entry.name.endsWith('.js')) files.push(join('lib', entry.name));
  }
  return files;
}

/** Import specifiers in one ES module source, static and dynamic. */
function importSpecifiers(source) {
  return [
    ...source.matchAll(/\bfrom\s*['"]([^'"]+)['"]/g),
    ...source.matchAll(/\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g),
    ...source.matchAll(/\bimport\s+['"]([^'"]+)['"]/g),
  ].map((match) => match[1]);
}

test('runtime code imports nothing but node: builtins and its own files', () => {
  for (const file of shippedSources()) {
    const source = readFileSync(join(ROOT, file), 'utf8');
    for (const specifier of importSpecifiers(source)) {
      const ok = specifier.startsWith('node:') || specifier.startsWith('./') || specifier.startsWith('../');
      assert.ok(ok, `${file} imports ${JSON.stringify(specifier)}; a linked install cannot resolve bare specifiers`);
    }
    assert.ok(!/\brequire\s*\(/.test(source), `${file} uses require(); the package is ESM`);
  }
});

test('the package declares no runtime dependency to install', () => {
  assert.deepEqual(manifest.dependencies ?? {}, {});
  assert.deepEqual(manifest.optionalDependencies ?? {}, {});
  assert.deepEqual(manifest.peerDependencies ?? {}, {});
});

test('no install-time script can make pnpm block the git install', () => {
  const scripts = manifest.scripts ?? {};
  for (const forbidden of ['prepare', 'preinstall', 'install', 'postinstall', 'prepublishOnly']) {
    assert.equal(scripts[forbidden], undefined, `${forbidden} would need an allowBuilds entry before a github: install could build`);
  }
});

test('the manifest exposes the plugin entry and its bundle patch', () => {
  assert.equal(manifest.name, 'dsh-helper-plugin-command-ask');
  assert.equal(manifest.type, 'module');
  assert.equal(manifest.main, 'index.js');
  assert.equal(manifest.exports['.'], './index.js');
  assert.equal(manifest.dsh.bundle.patch, './cordis.patch.yml');
  for (const shipped of ['index.js', 'lib', 'cordis.patch.yml']) {
    assert.ok(manifest.files.includes(shipped), `${shipped} must be packed for a github: install`);
  }
});

test('the bundle patch mounts one host row that resolves inside the package', () => {
  const patchPath = join(ROOT, manifest.dsh.bundle.patch);
  assert.ok(existsSync(patchPath), 'the declared bundle patch exists');
  const source = readFileSync(patchPath, 'utf8');
  assert.match(source, /^-\s*insert:/m, 'the patch is a top-level array of loader patches');
  assert.match(source, /id:\s*command-ask\b/, 'the row id is stable for profile overrides');
  assert.match(source, /name:\s*\.\/index\.js/, 'the row is anchored to the patch file');
  assert.ok(existsSync(join(dirname(patchPath), 'index.js')), './index.js resolves beside the patch');
});

test('the standalone overlay points at the plugin entry it sits beside', () => {
  const patchPath = join(ROOT, 'examples', 'standalone.patch.yml');
  const source = readFileSync(patchPath, 'utf8');
  assert.match(source, /name:\s*\.\.\/index\.js/);
  assert.ok(existsSync(resolve(dirname(patchPath), '../index.js')), '../index.js resolves from examples/');
});

test('the config keys documented in the bundle patch are the ones the loader accepts', () => {
  const patch = readFileSync(join(ROOT, manifest.dsh.bundle.patch), 'utf8');
  const documented = ['scope', 'section', 'enforce', 'blockedTools', 'allowedTools', 'supersedePlanMode', 'narrate'];
  for (const key of documented) {
    assert.ok(patch.includes(key), `the bundle patch should document ${key}`);
    const source = readFileSync(join(ROOT, 'lib', 'config.js'), 'utf8');
    assert.ok(source.includes(`'${key}'`), `lib/config.js should accept ${key}`);
  }
});

test('the shipped docs exist for both languages', () => {
  for (const file of ['README.md', 'README.zh.md', 'VERIFICATION.md', 'VERIFICATION.zh.md', 'LICENSE']) {
    assert.ok(existsSync(join(ROOT, file)), `${file} is missing`);
  }
  for (const file of ['VERIFICATION.md', 'VERIFICATION.zh.md']) {
    assert.ok(manifest.files.includes(file), `${file} must be packed`);
  }
});

test('the verification scripts ship with the package', () => {
  for (const file of ['scripts/run-tests.mjs', 'scripts/verify-profile.ps1', 'scripts/verify-live.mjs']) {
    assert.ok(existsSync(join(ROOT, file)), `${file} is missing`);
    assert.ok(manifest.files.includes('scripts'), 'scripts must be packed');
  }
  const readme = readFileSync(join(ROOT, 'README.md'), 'utf8');
  for (const file of ['scripts/verify-profile.ps1', 'scripts/verify-live.mjs', 'examples/profile-patch.yml', 'examples/standalone.patch.yml', 'examples/agent-preset-mount.yml']) {
    assert.ok(readme.includes(file), `README.md should reference ${file}`);
  }
});
