import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { makeRepo } from '../test-support/helpers.mjs';

const ENSEMBLE = fileURLToPath(new URL('../skill/scripts/ensemble.mjs', import.meta.url));

test('ensemble runs candidates, checks them, and applies the best patch', (t) => {
  const repo = makeRepo(t);
  const fake = join(repo, 'fake-agent.mjs');
  writeFileSync(
    fake,
    [
      "import { writeFileSync } from 'node:fs';",
      "const id = process.cwd().split('/').pop();",
      "writeFileSync('value.txt', id === 'a' ? 'good\\n' : 'bad\\n');",
      '',
    ].join('\n'),
  );

  const result = spawnSync(
    process.execPath,
    [
      ENSEMBLE,
      '--goal',
      'make value good',
      '--request',
      'make value good',
      '--check',
      'node check.mjs',
      '--candidates',
      '2',
      '--agent-cmd',
      `node ${fake}`,
      '--timeout',
      '30',
    ],
    { cwd: repo, encoding: 'utf8', timeout: 60_000 },
  );

  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  assert.match(result.stdout, /candidate a/);
  assert.match(result.stdout, /winner {2}a/);
  assert.equal(readFileSync(join(repo, 'value.txt'), 'utf8'), 'good\n');
});
