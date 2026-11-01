import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { chmodSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { gitHead, isTestPath, matchesScope, runCommand, treeHash } from '../src/lib.mjs';
import { cli, makeRepo, tempDir } from '../test-support/helpers.mjs';

test('tree hash tracks changed and untracked files but ignores .proof', (t) => {
  const repo = makeRepo(t);
  const first = treeHash(repo);

  mkdirSync(join(repo, '.proof'), { recursive: true });
  writeFileSync(join(repo, '.proof', 'task.json'), '{"goal":"x"}\n');
  assert.equal(treeHash(repo), first);

  writeFileSync(join(repo, 'src', 'app.js'), 'export const value = 2;\n');
  const changed = treeHash(repo);
  assert.notEqual(changed, first);

  writeFileSync(join(repo, 'src', 'extra.js'), 'export const extra = true;\n');
  assert.notEqual(treeHash(repo), changed);
});

test('tree hash tracks renames, deletions, and untracked directories', (t) => {
  const repo = makeRepo(t);
  const first = treeHash(repo);

  execFileSync('git', ['mv', 'src/app.js', 'src/renamed.js'], { cwd: repo });
  const renamed = treeHash(repo);
  assert.notEqual(renamed, first);

  rmSync(join(repo, 'value.txt'));
  const deleted = treeHash(repo);
  assert.notEqual(deleted, renamed);

  const nested = join(repo, 'nested');
  mkdirSync(nested);
  writeFileSync(join(nested, 'file.txt'), 'one\n');
  execFileSync('git', ['init', '-q'], { cwd: nested });
  const withNested = treeHash(repo);

  writeFileSync(join(nested, 'file.txt'), 'two\n');
  assert.notEqual(treeHash(repo), withNested);
});

test('tree hash includes the executable bit', (t) => {
  if (process.platform === 'win32') return;
  const repo = makeRepo(t);
  writeFileSync(join(repo, 'src', 'app.js'), 'export const value = 2;\n');
  const before = treeHash(repo, gitHead(repo));

  chmodSync(join(repo, 'src', 'app.js'), 0o755);
  assert.notEqual(treeHash(repo, gitHead(repo)), before);
});

test('a timed out check resolves even when a child holds stdout', async (t) => {
  const repo = makeRepo(t);
  const startedAt = Date.now();
  const result = await runCommand(`node -e 'setInterval(() => {}, 1000)'`, repo, 1);

  assert.equal(result.timedOut, true);
  assert.equal(result.exitCode, 124);
  assert.ok(Date.now() - startedAt < 5000);
});

test('scope globs match files, directories, and recursive patterns', () => {
  assert.equal(matchesScope('src/app.js', ['src/**']), true);
  assert.equal(matchesScope('src/deep/app.js', ['src/**']), true);
  assert.equal(matchesScope('src', ['src/**']), true);
  assert.equal(matchesScope('other/app.js', ['src/**']), false);
  assert.equal(matchesScope('README.md', ['README.md']), true);
  assert.equal(matchesScope('docs', ['docs']), true);
  assert.equal(matchesScope('docs/a.md', ['docs']), true);
  assert.equal(matchesScope('a.js', ['**/*.js']), true);
  assert.equal(matchesScope('src/a.ts', ['src/*.ts']), true);
  assert.equal(matchesScope('src/deep/a.ts', ['src/*.ts']), false);
  assert.equal(matchesScope('anything', []), true);
});

test('test paths cover common language conventions', () => {
  assert.equal(isTestPath('test/regression.test.js'), true);
  assert.equal(isTestPath('src/app.spec.ts'), true);
  assert.equal(isTestPath('pkg/foo_test.go'), true);
  assert.equal(isTestPath('pkg/test_foo.py'), true);
  assert.equal(isTestPath('src/FooTest.java'), true);
  assert.equal(isTestPath('src/FooTests.cs'), true);
  assert.equal(isTestPath('testdata/fixture.json'), true);
  assert.equal(isTestPath('src/latest.js'), false);
  assert.equal(isTestPath('src/mattest.js'), false);
  assert.equal(isTestPath('src/app.js'), false);
});

test('help and version work outside a repository', (t) => {
  const home = tempDir(t);
  const help = cli(['help'], { cwd: home, home });
  assert.equal(help.status, 0);
  assert.match(help.stdout, /hardproof 0\.1\.0/);

  const version = cli(['--version'], { cwd: home, home });
  assert.equal(version.status, 0);
  assert.equal(version.stdout.trim(), '0.1.0');
});
