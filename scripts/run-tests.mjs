/**
 * Direct test runner: `node scripts/run-tests.mjs`.
 *
 * `node --test` is the standard entry point (`npm test`) and spawns one child
 * process per test file. Some sandboxes deny a process that pipes its children's
 * stdio (Node reports `spawn EPERM`, and a stricter sandbox kills the runner
 * outright), so this runner imports every `test/*.test.mjs` into ONE process
 * instead. `node:test` runs the registered tests and reports the same summary,
 * and the process exit code still reflects failures.
 *
 * It deliberately lives outside `test/` so Node's default "everything under a
 * test directory is a test file" pattern cannot pick it up recursively.
 */

import { readdir } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const TEST_DIR = join(ROOT, 'test');

const entries = (await readdir(TEST_DIR, { withFileTypes: true }))
  .filter((entry) => entry.isFile() && entry.name.endsWith('.test.mjs'))
  .map((entry) => entry.name)
  .sort();

if (entries.length === 0) {
  process.stderr.write('no test files found under test/\n');
  process.exit(1);
}

for (const entry of entries) {
  await import(pathToFileURL(join(TEST_DIR, entry)).href);
}
