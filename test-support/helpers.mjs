import { execFileSync, spawnSync } from 'node:child_process';
import {
  mkdtempSync,
  mkdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const CLI = fileURLToPath(new URL('../bin/hardproof.mjs', import.meta.url));

export function tempDir(t, prefix = 'hardproof-test-') {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

export function makeRepo(t) {
  const dir = tempDir(t);
  mkdirSync(join(dir, 'src'));
  mkdirSync(join(dir, 'test'));
  writeFileSync(join(dir, 'value.txt'), 'bad\n');
  writeFileSync(join(dir, 'src', 'app.js'), 'export const value = 1;\n');
  writeFileSync(join(dir, 'test', 'regression.test.js'), '// baseline\n');
  writeFileSync(
    join(dir, 'check.mjs'),
    [
      "import { readFileSync } from 'node:fs';",
      "const value = readFileSync('value.txt', 'utf8').trim();",
      "if (value !== 'good') {",
      "  console.error('value is bad');",
      '  process.exit(1);',
      '}',
      '',
    ].join('\n'),
  );

  execFileSync('git', ['init', '-q'], { cwd: dir });
  execFileSync('git', ['add', '-A'], { cwd: dir });
  execFileSync(
    'git',
    ['-c', 'user.email=test@example.com', '-c', 'user.name=Test', 'commit', '-q', '-m', 'init'],
    { cwd: dir },
  );

  return dir;
}

export function cli(args, { cwd, home }) {
  return spawnSync(process.execPath, [CLI, ...args], {
    cwd,
    encoding: 'utf8',
    timeout: 30_000,
    env: {
      ...process.env,
      HOME: home ?? process.env.HOME,
      USERPROFILE: home ?? process.env.USERPROFILE ?? '',
      NO_COLOR: '1',
    },
  });
}

export function output(result) {
  return `${result.stdout}\n${result.stderr}`;
}
