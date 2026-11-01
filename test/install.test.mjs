import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { cli, makeRepo, output, tempDir } from '../test-support/helpers.mjs';

test('installs the skill and a read-only verifier for each provider', (t) => {
  const repo = makeRepo(t);
  const home = tempDir(t);

  assert.equal(cli(['install', 'claude', '--global'], { cwd: repo, home }).status, 0);

  const claudeSkill = join(home, '.claude', 'skills', 'hardproof', 'SKILL.md');
  const claudeAgent = join(home, '.claude', 'agents', 'hardproof-verifier.md');
  assert.equal(existsSync(claudeSkill), true);
  assert.equal(existsSync(join(home, '.claude', 'skills', 'hardproof', 'references', 'verifier.md')), true);
  assert.match(readFileSync(claudeAgent, 'utf8'), /^---\nname: hardproof-verifier/m);
  assert.match(readFileSync(claudeAgent, 'utf8'), /tools: Read, Grep, Glob, Bash/);
  assert.match(readFileSync(claudeAgent, 'utf8'), /managed by hardproof/);

  assert.equal(cli(['install', 'opencode', '--global'], { cwd: repo, home }).status, 0);
  const opencodeAgent = join(home, '.config', 'opencode', 'agents', 'hardproof-verifier.md');
  assert.match(readFileSync(opencodeAgent, 'utf8'), /mode: subagent/);
  assert.match(readFileSync(opencodeAgent, 'utf8'), /action: edit/);

  assert.equal(cli(['install', 'codex', '--global'], { cwd: repo, home }).status, 0);
  assert.equal(
    existsSync(join(home, '.agents', 'skills', 'hardproof-verifier', 'SKILL.md')),
    true,
  );

  assert.equal(cli(['install', 'generic', '--project'], { cwd: repo, home }).status, 0);
  assert.equal(existsSync(join(repo, '.agents', 'skills', 'hardproof', 'SKILL.md')), true);
});

test('reinstall updates managed files and uninstall removes them', (t) => {
  const repo = makeRepo(t);
  const home = tempDir(t);

  cli(['install', 'claude', '--global'], { cwd: repo, home });
  const skill = join(home, '.claude', 'skills', 'hardproof', 'SKILL.md');
  const original = readFileSync(skill, 'utf8');

  const again = cli(['install', 'claude', '--global'], { cwd: repo, home });
  assert.equal(again.status, 0, output(again));
  assert.equal(readFileSync(skill, 'utf8'), original);

  const uninstall = cli(['uninstall', 'claude', '--global'], { cwd: repo, home });
  assert.equal(uninstall.status, 0, output(uninstall));
  assert.equal(existsSync(join(home, '.claude', 'skills', 'hardproof')), false);
  assert.equal(existsSync(join(home, '.claude', 'agents', 'hardproof-verifier.md')), false);
});

test('refuses to overwrite or delete a foreign skill', (t) => {
  const repo = makeRepo(t);
  const home = tempDir(t);
  const skillDir = join(home, '.claude', 'skills', 'hardproof');
  mkdirSync(skillDir, { recursive: true });
  writeFileSync(join(skillDir, 'SKILL.md'), 'mine\n');

  const install = cli(['install', 'claude', '--global'], { cwd: repo, home });
  assert.equal(install.status, 1);
  assert.match(output(install), /not installed by hardproof/);

  const uninstall = cli(['uninstall', 'claude', '--global'], { cwd: repo, home });
  assert.equal(uninstall.status, 1);
  assert.match(output(uninstall), /not installed by hardproof/);

  const forced = cli(['uninstall', 'claude', '--global', '--force'], { cwd: repo, home });
  assert.equal(forced.status, 0, output(forced));
  assert.equal(existsSync(skillDir), false);
});

test('dry run writes nothing', (t) => {
  const repo = makeRepo(t);
  const home = tempDir(t);
  const result = cli(['install', 'opencode', '--global', '--dry-run'], { cwd: repo, home });
  assert.equal(result.status, 0);
  assert.match(result.stdout, /would write/);
  assert.equal(existsSync(join(home, '.config', 'opencode', 'skills', 'hardproof')), false);
});

test('project install resolves the repository root from a subdirectory', (t) => {
  const repo = makeRepo(t);
  const home = tempDir(t);
  const sub = join(repo, 'packages', 'api');
  mkdirSync(sub, { recursive: true });

  const result = cli(['install', 'claude', '--project'], { cwd: sub, home });
  assert.equal(result.status, 0, output(result));
  assert.equal(existsSync(join(repo, '.claude', 'skills', 'hardproof', 'SKILL.md')), true);
  assert.equal(existsSync(join(sub, '.claude')), false);
});

test('unknown providers do not leak prototype properties', (t) => {
  const repo = makeRepo(t);
  const home = tempDir(t);

  for (const name of ['__proto__', 'constructor', 'toString']) {
    const result = cli(['install', name], { cwd: repo, home });
    assert.equal(result.status, 1, `${name}: ${output(result)}`);
    assert.match(output(result), /unknown provider/);
    assert.doesNotMatch(output(result), /ERR_INVALID_ARG_TYPE/);
  }
});

test('doctor reports drift from installed edits and from newer source', (t) => {
  const repo = makeRepo(t);
  const home = tempDir(t);
  const root = fileURLToPath(new URL('../', import.meta.url));
  const source = tempDir(t, 'hardproof-source-');

  for (const dir of ['bin', 'src', 'skill']) {
    cpSync(join(root, dir), join(source, dir), { recursive: true });
  }
  cpSync(join(root, 'package.json'), join(source, 'package.json'));

  const sourceCli = join(source, 'bin', 'hardproof.mjs');
  const run = (args) =>
    spawnSync(process.execPath, [sourceCli, ...args], {
      cwd: repo,
      encoding: 'utf8',
      timeout: 30_000,
      env: { ...process.env, HOME: home, USERPROFILE: home, NO_COLOR: '1' },
    });

  assert.equal(run(['install', 'opencode', '--global']).status, 0);

  const skillDir = join(home, '.config', 'opencode', 'skills', 'hardproof');
  const manifest = JSON.parse(
    readFileSync(join(skillDir, '.hardproof-install.json'), 'utf8'),
  );
  assert.ok(manifest.files);
  assert.ok(Object.keys(manifest.files).length >= 3);

  const healthy = run(['doctor']);
  assert.match(healthy.stdout, /install {2}opencode {2}global .* ok/);

  writeFileSync(join(skillDir, 'SKILL.md'), 'changed\n');
  const drifted = run(['doctor']);
  assert.match(drifted.stdout, /DRIFT/);
  assert.match(drifted.stdout, /SKILL\.md/);

  assert.equal(run(['install', 'opencode', '--global']).status, 0);
  writeFileSync(
    join(source, 'skill', 'SKILL.md'),
    `${readFileSync(join(source, 'skill', 'SKILL.md'), 'utf8')}source change\n`,
  );

  const sourceDrift = run(['doctor']);
  assert.match(sourceDrift.stdout, /DRIFT: changed skills\/hardproof\/SKILL\.md/);
});

test('generic needs a target directory', (t) => {
  const repo = makeRepo(t);
  const home = tempDir(t);
  const result = cli(['install', 'generic'], { cwd: repo, home });
  assert.equal(result.status, 1);
  assert.match(output(result), /needs --dir/);

  const custom = join(repo, 'agent-skills');
  const installed = cli(
    ['install', 'generic', '--dir', custom],
    { cwd: repo, home },
  );
  assert.equal(installed.status, 0, output(installed));
  assert.equal(existsSync(join(custom, 'skills', 'hardproof', 'SKILL.md')), true);
});
