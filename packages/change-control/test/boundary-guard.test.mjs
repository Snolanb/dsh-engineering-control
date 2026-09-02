import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

// Integration boundary guard: no module outside packages/change-control/src
// may import the ChangeStore implementation. The integration contract is the
// ctx.changeControl service facade only. (In-package tests may open stores.)

const pkgRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const repoRoot = join(pkgRoot, '..', '..');

async function* walk(dir) {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
      yield* walk(full);
    } else if (/\.(m?js|cjs)$/.test(entry.name)) {
      yield full;
    }
  }
}

test('no file outside packages/change-control imports the ChangeStore implementation', async () => {
  // Only meaningful in the monorepo; standalone package checkouts skip.
  const rootPkg = JSON.parse(await readFile(join(repoRoot, 'package.json'), 'utf8').catch(() => 'null'));
  if (!rootPkg || rootPkg.private !== true) return;

  const offenders = [];
  for await (const file of walk(join(repoRoot, 'packages'))) {
    const rel = relative(repoRoot, file);
    if (rel.startsWith('packages/change-control/')) continue;
    const source = await readFile(file, 'utf8');
    if (/from\s+['"][^'"]*storage\/change-store(\.js)?['"]/.test(source) || /import\([^)]*storage\/change-store/.test(source)) {
      offenders.push(rel);
    }
  }
  assert.deepEqual(offenders, [], `ChangeStore boundary violated by: ${offenders.join(', ')}`);
});
