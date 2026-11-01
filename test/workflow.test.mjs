import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { cli, makeRepo, output, tempDir } from '../test-support/helpers.mjs';

test('init records the goal, checks, baseline, and scope', (t) => {
  const repo = makeRepo(t);
  const home = tempDir(t);

  const result = cli(
    ['init', '--goal', 'make value good', '--check', 'node check.mjs', '--scope', 'value.txt'],
    { cwd: repo, home },
  );

  assert.equal(result.status, 0, output(result));
  assert.match(result.stdout, /baseline 1 {2}FAIL/);
  assert.match(result.stdout, /baseline 1\/1 failing/);

  const task = JSON.parse(readFileSync(join(repo, '.proof', 'task.json'), 'utf8'));
  assert.equal(task.goal, 'make value good');
  assert.deepEqual(task.scope, ['value.txt']);
  assert.equal(task.checks[0].baseline.ok, false);
  assert.equal(task.checks[0].baseline.exitCode, 1);

  assert.equal(execFileSync('git', ['status', '--porcelain'], { cwd: repo, encoding: 'utf8' }).trim(), '');
});

test('init requires a goal and at least one check', (t) => {
  const repo = makeRepo(t);
  const home = tempDir(t);

  const noGoal = cli(['init', '--check', 'node check.mjs'], { cwd: repo, home });
  assert.equal(noGoal.status, 1);
  assert.match(output(noGoal), /--goal is required/);

  const noCheck = cli(['init', '--goal', 'do it'], { cwd: repo, home });
  assert.equal(noCheck.status, 1);
  assert.match(output(noCheck), /at least one --check/);

  const ok = cli(['init', '--goal', 'do it', '--check', 'node check.mjs'], { cwd: repo, home });
  assert.equal(ok.status, 0, output(ok));

  const again = cli(['init', '--goal', 'do it', '--check', 'node check.mjs'], { cwd: repo, home });
  assert.equal(again.status, 1);
  assert.match(output(again), /already exists/);

  const forced = cli(
    ['init', '--goal', 'do it again', '--check', 'node check.mjs', '--force'],
    { cwd: repo, home },
  );
  assert.equal(forced.status, 0, output(forced));
  const task = JSON.parse(readFileSync(join(repo, '.proof', 'task.json'), 'utf8'));
  assert.equal(task.goal, 'do it again');
});

test('check and gate pass only after a fresh verifier verdict', (t) => {
  const repo = makeRepo(t);
  const home = tempDir(t);

  assert.equal(
    cli(
      ['init', '--goal', 'make value good', '--check', 'node check.mjs', '--scope', 'value.txt'],
      { cwd: repo, home },
    ).status,
    0,
  );

  const failing = cli(['check'], { cwd: repo, home });
  assert.equal(failing.status, 1);
  assert.match(failing.stdout, /result {3}FAIL/);

  writeFileSync(join(repo, 'value.txt'), 'good\n');
  const passing = cli(['check'], { cwd: repo, home });
  assert.equal(passing.status, 0, output(passing));

  const noVerdict = cli(['gate'], { cwd: repo, home });
  assert.equal(noVerdict.status, 1);
  assert.match(output(noVerdict), /verifier has not recorded a verdict/);

  const verdict = cli(
    ['verdict', 'pass', '--summary', 'ran the check', '--verifier', 'test-verifier'],
    { cwd: repo, home },
  );
  assert.equal(verdict.status, 0, output(verdict));

  const gate = cli(['gate'], { cwd: repo, home });
  assert.equal(gate.status, 0, output(gate));
  assert.match(gate.stdout, /gate {5}PASS/);

  const json = cli(['gate', '--json'], { cwd: repo, home });
  assert.equal(json.status, 0, output(json));
  assert.equal(JSON.parse(json.stdout).ok, true);

  writeFileSync(join(repo, 'src', 'app.js'), 'export const value = 2;\n');
  const stale = cli(['gate'], { cwd: repo, home });
  assert.equal(stale.status, 1);
  assert.match(output(stale), /stale/);
});

test('init warns about checks that always pass', (t) => {
  const repo = makeRepo(t);
  const home = tempDir(t);
  const result = cli(
    ['init', '--goal', 'run nothing', '--check', 'true'],
    { cwd: repo, home },
  );
  assert.equal(result.status, 0, output(result));
  assert.match(result.stdout, /may always pass/);
});

test('init refuses a dirty tracked tree', (t) => {
  const repo = makeRepo(t);
  const home = tempDir(t);
  writeFileSync(join(repo, 'src', 'app.js'), 'export const value = 99;\n');

  const result = cli(
    ['init', '--goal', 'make value good', '--check', 'node check.mjs'],
    { cwd: repo, home },
  );
  assert.equal(result.status, 1);
  assert.match(output(result), /tracked production files are dirty/);

  const allowed = cli(
    [
      'init',
      '--goal',
      'make value good',
      '--check',
      'node check.mjs',
      '--allow-dirty',
      '--force',
    ],
    { cwd: repo, home },
  );
  assert.equal(allowed.status, 0, output(allowed));
  assert.equal(
    JSON.parse(readFileSync(join(repo, '.proof', 'task.json'), 'utf8')).dirtyStart,
    true,
  );
});

test('bug work needs a cause and a red baseline', (t) => {
  const repo = makeRepo(t);
  const home = tempDir(t);

  const noCause = cli(
    ['init', '--kind', 'bug', '--goal', 'make value good', '--check', 'node check.mjs'],
    { cwd: repo, home },
  );
  assert.equal(noCause.status, 1);
  assert.match(output(noCause), /needs --cause/);

  const bug = cli(
    [
      'init',
      '--kind',
      'bug',
      '--cause',
      'check reads a stale value',
      '--goal',
      'make value good',
      '--check',
      'node check.mjs',
    ],
    { cwd: repo, home },
  );
  assert.equal(bug.status, 0, output(bug));
  assert.equal(JSON.parse(readFileSync(join(repo, '.proof', 'task.json'), 'utf8')).kind, 'bug');

  writeFileSync(join(repo, 'value.txt'), 'good\n');
  execFileSync('git', ['add', '-A'], { cwd: repo });
  execFileSync(
    'git',
    ['-c', 'user.email=test@example.com', '-c', 'user.name=Test', 'commit', '-q', '-m', 'good'],
    { cwd: repo },
  );
  const green = cli(
    [
      'init',
      '--kind',
      'bug',
      '--cause',
      'check reads a stale value',
      '--goal',
      'make value good',
      '--check',
      'node check.mjs',
      '--force',
    ],
    { cwd: repo, home },
  );
  assert.equal(green.status, 1);
  assert.match(output(green), /at least one check that fails/);
});

test('refactor work needs a clean baseline', (t) => {
  const repo = makeRepo(t);
  const home = tempDir(t);

  const red = cli(
    ['init', '--kind', 'refactor', '--goal', 'move the value', '--check', 'node check.mjs'],
    { cwd: repo, home },
  );
  assert.equal(red.status, 1);
  assert.match(output(red), /clean baseline/);

  writeFileSync(join(repo, 'value.txt'), 'good\n');
  execFileSync('git', ['add', '-A'], { cwd: repo });
  execFileSync(
    'git',
    ['-c', 'user.email=test@example.com', '-c', 'user.name=Test', 'commit', '-q', '-m', 'good'],
    { cwd: repo },
  );
  const green = cli(
    [
      'init',
      '--kind',
      'refactor',
      '--goal',
      'move the value',
      '--check',
      'node check.mjs',
      '--force',
    ],
    { cwd: repo, home },
  );
  assert.equal(green.status, 0, output(green));
  assert.match(green.stdout, /clean starting point/);
});

test('changing tests requires a certified test review', (t) => {
  const repo = makeRepo(t);
  const home = tempDir(t);
  writeFileSync(join(repo, 'test', 'regression.test.js'), '// regression\n');

  const init = cli(['init', '--goal', 'make value good', '--check', 'node check.mjs'], {
    cwd: repo,
    home,
  });
  assert.equal(init.status, 0, output(init));
  assert.match(init.stdout, /test changes are already present/);

  writeFileSync(join(repo, 'value.txt'), 'good\n');
  execFileSync('git', ['add', '-A'], { cwd: repo });
  execFileSync(
    'git',
    ['-c', 'user.email=test@example.com', '-c', 'user.name=Test', 'commit', '-q', '-m', 'fix'],
    { cwd: repo },
  );

  const check = cli(['check'], { cwd: repo, home });
  assert.equal(check.status, 0, output(check));
  assert.match(check.stdout, /test\/regression\.test\.js/);

  const unreviewed = cli(['verdict', 'pass', '--summary', 'looks fine'], { cwd: repo, home });
  assert.equal(unreviewed.status, 1);
  assert.match(output(unreviewed), /test files changed/);

  const reviewed = cli(
    [
      'verdict',
      'pass',
      '--summary',
      'ran the check and read the new test',
      '--test-review',
      'new regression test read; no assertions removed; would fail on old value',
    ],
    { cwd: repo, home },
  );
  assert.equal(reviewed.status, 0, output(reviewed));

  const gate = cli(['gate'], { cwd: repo, home });
  assert.equal(gate.status, 0, output(gate));
  assert.match(gate.stdout, /new regression test read/);

  const verdictFile = join(repo, '.proof', 'verdict.json');
  const verdict = JSON.parse(readFileSync(verdictFile, 'utf8'));
  delete verdict.testReview;
  writeFileSync(verdictFile, `${JSON.stringify(verdict, null, 2)}\n`);

  const tampered = cli(['gate'], { cwd: repo, home });
  assert.equal(tampered.status, 1);
  assert.match(output(tampered), /did not certify a test review/);
});

test('brief prints the facts a verifier needs', (t) => {
  const repo = makeRepo(t);
  const home = tempDir(t);
  cli(
    [
      'init',
      '--kind',
      'bug',
      '--cause',
      'check reads a stale value',
      '--request',
      'fix the value reader so it returns good',
      '--goal',
      'make value good',
      '--check',
      'node check.mjs',
      '--scope',
      'value.txt',
    ],
    { cwd: repo, home },
  );

  writeFileSync(join(repo, 'value.txt'), 'good\n');
  writeFileSync(join(repo, 'test', 'regression.test.js'), '// regression\n');

  const brief = cli(['brief'], { cwd: repo, home });
  assert.equal(brief.status, 0, output(brief));
  assert.match(brief.stdout, /Kind: bug/);
  assert.match(brief.stdout, /Original request:/);
  assert.match(brief.stdout, /> fix the value reader so it returns good/);
  assert.match(brief.stdout, /Cause: check reads a stale value/);
  assert.match(brief.stdout, /value is bad/);
  assert.match(brief.stdout, /test\/regression\.test\.js/);
});

test('editing the contract after init is refused', (t) => {
  const repo = makeRepo(t);
  const home = tempDir(t);
  cli(['init', '--goal', 'make value good', '--check', 'node check.mjs'], { cwd: repo, home });

  const taskFile = join(repo, '.proof', 'task.json');
  const task = JSON.parse(readFileSync(taskFile, 'utf8'));
  task.checks[0].command = 'true';
  writeFileSync(taskFile, `${JSON.stringify(task, null, 2)}\n`);

  for (const args of [['check'], ['verdict', 'pass', '--summary', 'ok'], ['gate']]) {
    const result = cli(args, { cwd: repo, home });
    assert.equal(result.status, 1, output(result));
    assert.match(output(result), /changed after init/);
  }
});

test('a fail verdict needs a finding and blocks the gate', (t) => {
  const repo = makeRepo(t);
  const home = tempDir(t);
  cli(['init', '--goal', 'make value good', '--check', 'node check.mjs'], { cwd: repo, home });

  const empty = cli(['verdict', 'fail', '--summary', 'broken'], { cwd: repo, home });
  assert.equal(empty.status, 1);
  assert.match(output(empty), /needs at least one --finding/);

  const fail = cli(
    [
      'verdict',
      'fail',
      '--summary',
      'value stays bad',
      '--finding',
      'value.txt:1 still reads bad',
      '--verifier',
      'test-verifier',
    ],
    { cwd: repo, home },
  );
  assert.equal(fail.status, 0, output(fail));

  const gate = cli(['gate'], { cwd: repo, home });
  assert.equal(gate.status, 1);
  assert.match(output(gate), /verdict {2}fail/);
  assert.match(output(gate), /value\.txt:1 still reads bad/);

  const passWithFinding = cli(
    ['verdict', 'pass', '--summary', 'ok', '--finding', 'nope'],
    { cwd: repo, home },
  );
  assert.equal(passWithFinding.status, 1);
  assert.match(output(passWithFinding), /cannot include findings/);
});

test('scope breach blocks the gate unless explicitly allowed', (t) => {
  const repo = makeRepo(t);
  const home = tempDir(t);
  cli(
    ['init', '--goal', 'make value good', '--check', 'node check.mjs', '--scope', 'src/**'],
    { cwd: repo, home },
  );

  writeFileSync(join(repo, 'value.txt'), 'good\n');

  const breach = cli(['check'], { cwd: repo, home });
  assert.equal(breach.status, 1);
  assert.match(breach.stdout, /scope {4}BREACH/);

  const allowedCheck = cli(['check', '--allow-scope-breach'], { cwd: repo, home });
  assert.equal(allowedCheck.status, 0, output(allowedCheck));

  cli(['verdict', 'pass', '--summary', 'ran the check'], { cwd: repo, home });

  const gate = cli(['gate'], { cwd: repo, home });
  assert.equal(gate.status, 1);
  assert.match(gate.stdout, /scope {4}BREACH/);

  const allowedGate = cli(['gate', '--allow-scope-breach'], { cwd: repo, home });
  assert.equal(allowedGate.status, 0, output(allowedGate));
});

test('a verdict survives committing the verified tree unchanged', (t) => {
  const repo = makeRepo(t);
  const home = tempDir(t);
  cli(['init', '--goal', 'make value good', '--check', 'node check.mjs'], { cwd: repo, home });
  writeFileSync(join(repo, 'value.txt'), 'good\n');
  assert.equal(cli(['check'], { cwd: repo, home }).status, 0);
  assert.equal(
    cli(['verdict', 'pass', '--summary', 'ran the acceptance check'], { cwd: repo, home }).status,
    0,
  );
  assert.equal(cli(['gate'], { cwd: repo, home }).status, 0);

  execFileSync('git', ['add', '-A'], { cwd: repo });
  execFileSync(
    'git',
    ['-c', 'user.email=test@example.com', '-c', 'user.name=Test', 'commit', '-q', '-m', 'verify'],
    { cwd: repo },
  );

  const after = cli(['gate'], { cwd: repo, home });
  assert.equal(after.status, 0, output(after));
});

test('a partial commit does not keep the verdict fresh', (t) => {
  const repo = makeRepo(t);
  const home = tempDir(t);
  cli(['init', '--goal', 'make value good', '--check', 'node check.mjs'], { cwd: repo, home });
  writeFileSync(join(repo, 'value.txt'), 'good\n');
  writeFileSync(join(repo, 'helper.js'), 'export const helper = true;\n');
  assert.equal(cli(['check'], { cwd: repo, home }).status, 0);
  assert.equal(
    cli(['verdict', 'pass', '--summary', 'ran the acceptance check'], { cwd: repo, home }).status,
    0,
  );

  execFileSync('git', ['add', 'value.txt'], { cwd: repo });
  execFileSync(
    'git',
    ['-c', 'user.email=test@example.com', '-c', 'user.name=Test', 'commit', '-q', '-m', 'partial'],
    { cwd: repo },
  );

  const gate = cli(['gate'], { cwd: repo, home });
  assert.equal(gate.status, 1);
  assert.match(output(gate), /working tree is not clean/);
});

test('a commit with different bytes does not keep the verdict fresh', (t) => {
  const repo = makeRepo(t);
  const home = tempDir(t);
  cli(['init', '--goal', 'make value good', '--check', 'node check.mjs'], { cwd: repo, home });
  writeFileSync(join(repo, 'value.txt'), 'good\n');
  assert.equal(cli(['check'], { cwd: repo, home }).status, 0);
  assert.equal(
    cli(['verdict', 'pass', '--summary', 'ran the acceptance check'], { cwd: repo, home }).status,
    0,
  );

  writeFileSync(join(repo, 'value.txt'), 'evil\n');
  execFileSync('git', ['add', 'value.txt'], { cwd: repo });
  writeFileSync(join(repo, 'value.txt'), 'good\n');
  execFileSync(
    'git',
    ['-c', 'user.email=test@example.com', '-c', 'user.name=Test', 'commit', '-q', '-m', 'divergent'],
    { cwd: repo },
  );

  const gate = cli(['gate'], { cwd: repo, home });
  assert.equal(gate.status, 1);
  assert.match(output(gate), /working tree is not clean/);
});

test('init refuses a repository with no baseline commit', (t) => {
  const repo = tempDir(t);
  const home = tempDir(t);
  execFileSync('git', ['init', '-q'], { cwd: repo });
  writeFileSync(join(repo, 'check.mjs'), 'process.exit(1);\n');

  const result = cli(
    ['init', '--goal', 'make value good', '--check', 'node check.mjs'],
    { cwd: repo, home },
  );
  assert.equal(result.status, 1);
  assert.match(output(result), /no commits/);
});

test('committed out-of-scope changes still fail the scope check', (t) => {
  const repo = makeRepo(t);
  const home = tempDir(t);
  cli(
    ['init', '--goal', 'make value good', '--check', 'node check.mjs', '--scope', 'value.txt'],
    { cwd: repo, home },
  );

  writeFileSync(join(repo, 'value.txt'), 'good\n');
  writeFileSync(join(repo, 'src', 'app.js'), 'export const value = 2;\n');
  execFileSync('git', ['add', '-A'], { cwd: repo });
  execFileSync(
    'git',
    ['-c', 'user.email=test@example.com', '-c', 'user.name=Test', 'commit', '-q', '-m', 'work'],
    { cwd: repo },
  );

  const check = cli(['check'], { cwd: repo, home });
  assert.equal(check.status, 1, output(check));
  assert.match(check.stdout, /src\/app\.js/);
});

test('doctor reports an installed provider and the run state', (t) => {
  const repo = makeRepo(t);
  const home = tempDir(t);
  cli(['init', '--goal', 'make value good', '--check', 'node check.mjs'], { cwd: repo, home });
  writeFileSync(join(repo, 'value.txt'), 'good\n');
  cli(['verdict', 'pass', '--summary', 'ran the check'], { cwd: repo, home });
  cli(['install', 'claude', '--global'], { cwd: repo, home });

  const doctor = cli(['doctor'], { cwd: repo, home });
  assert.equal(doctor.status, 0, output(doctor));
  assert.match(doctor.stdout, /install {2}claude {2}global/);
  assert.match(doctor.stdout, /verdict {2}pass/);
  assert.equal(existsSync(join(home, '.claude', 'skills', 'hardproof', 'SKILL.md')), true);
});
