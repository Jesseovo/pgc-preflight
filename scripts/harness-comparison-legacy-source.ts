/** Local entrypoints for the frozen container comparison. No network or deployment. */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = realpathSync(fileURLToPath(new URL('../', import.meta.url)));
const gitEnv = {
  PATH: '/usr/bin:/bin', GIT_NO_REPLACE_OBJECTS: '1', GIT_CONFIG_NOSYSTEM: '1',
  GIT_CONFIG_GLOBAL: '/dev/null', GIT_ATTR_NOSYSTEM: '1',
};
const maxBuffer = 32 * 1024 * 1024;
export const legacyComparisonAdapterCommit = 'd67553ff2e42d716ae08c5d1e670521a368749c9';
const legacyAdapterTree = '16cd6ac4df46902c5787a3fdaae8dbf34eb38804';
const entrypoints = {
  rehearsal: ['scripts/harness-comparison-harness-rehearsal.ts', 'runHarnessRehearsal'],
  package: ['scripts/prepare-harness-comparison-package.ts', 'prepareComparisonPackage'],
} as const;

// The subprocess loads only the fixed archive entry, never the current Worker tree.
const child = `
  import { readFileSync } from 'node:fs';
  const { entry, name, options } = JSON.parse(readFileSync(0, 'utf8'));
  globalThis.fetch = () => { throw new Error('Legacy comparison cannot access the network'); };
  try {
    const module = await import(entry);
    process.stdout.write(JSON.stringify({ ok: true, result: await module[name](options) }));
  } catch (error) {
    process.stdout.write(JSON.stringify({ ok: false, message: error.message, code: error.code }));
  }
`;

function git(cwd: string, args: string[]) {
  return execFileSync('/usr/bin/git', args, { cwd, env: gitEnv, maxBuffer });
}

export function absoluteLegacyPath(path: string, error: string) {
  assert(path && !path.split(/[\\/]/).includes('..'), error);
  return resolve(path);
}

export function runLegacyComparison<T>(mode: keyof typeof entrypoints, options: Record<string, string>) {
  const [entryPath, name] = entrypoints[mode];
  const archiveTree = git(root, ['rev-parse', legacyComparisonAdapterCommit + '^{tree}']).toString().trim();
  assert.equal(archiveTree, legacyAdapterTree, 'Legacy comparison adapter tree differs from its pin');
  const gitDir = git(root, ['rev-parse', '--path-format=absolute', '--git-common-dir']).toString().trim();
  const objects = realpathSync(join(gitDir, 'objects'));
  assert(!/[\r\n]/.test(objects), 'Invalid Git object directory');

  // Each run owns its private directory. Parallel tests never share a checkout or cleanup.
  const checkout = mkdtempSync(join(realpathSync(tmpdir()), 'pgc-legacy-comparison-'));
  try {
    const archive = git(root, ['archive', '--format=tar', legacyComparisonAdapterCommit]);
    execFileSync('/usr/bin/tar', ['-xf', '-', '-C', checkout], { input: archive, env: gitEnv });
    git(checkout, ['init', '--quiet']);
    writeFileSync(join(checkout, '.git/objects/info/alternates'), objects + '\n', { flag: 'wx', mode: 0o600 });
    git(checkout, ['update-ref', '--no-deref', 'HEAD', legacyComparisonAdapterCommit]);
    git(checkout, ['read-tree', legacyComparisonAdapterCommit]);

    const deps = join(root, 'node_modules');
    assert.equal(realpathSync(deps), deps, 'Legacy dependencies must come from the local installation');
    assert.deepEqual(readFileSync(join(root, 'package-lock.json')), readFileSync(join(checkout, 'package-lock.json')),
      'Use the pinned legacy dependency lockfile for the offline comparison');
    writeFileSync(join(checkout, '.git/info/exclude'), '/node_modules\n', { mode: 0o600 });
    symlinkSync(deps, join(checkout, 'node_modules'), 'dir');
    assert.equal(git(checkout, ['status', '--porcelain']).toString(), '', 'Legacy comparison checkout differs from its pin');
    const entry = join(checkout, entryPath);
    assert.equal(realpathSync(entry), entry, 'Legacy entry cannot be a symbolic link');

    const tsx = createRequire(import.meta.url).resolve('tsx');
    const bytes = execFileSync(process.execPath, ['--import', pathToFileURL(tsx).href, '--input-type=module', '--eval', child], {
      cwd: checkout, env: gitEnv, input: JSON.stringify({ entry: pathToFileURL(entry).href, name, options }),
      maxBuffer, timeout: 120_000,
    });
    const response = JSON.parse(bytes.toString()) as { ok: true; result: T } | { ok: false; message: string; code?: string };
    if (!response.ok) throw Object.assign(new Error(response.message), { code: response.code });
    assert.equal(git(checkout, ['status', '--porcelain']).toString(), '', 'Legacy comparison checkout changed during execution');
    return response.result;
  } finally {
    rmSync(checkout, { force: true, recursive: true });
  }
}
