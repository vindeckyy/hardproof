#!/usr/bin/env node
import { execFileSync, spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';

const args = parseArgs(process.argv.slice(2));
const root = process.cwd();
const goal = (args.goal ?? '').trim();
const request = (args.request ?? goal).trim();
const checks = args.check ?? [];
const count = Number(args.candidates ?? 3);
const timeoutSec = Number(args.timeout ?? 600);
const checkTimeout = Number(args['check-timeout'] ?? 300);
const model = args.model ?? process.env.HARDPROOF_MODEL;
const agentCmd = args['agent-cmd'];
const strategies = ['direct', 'test-first', 'plan', 'minimal'];

if (!goal) fail('--goal is required');
if (checks.length === 0) fail('at least one --check is required');
if (!Number.isInteger(count) || count < 2 || count > 4) fail('--candidates must be 2-4');

const base = ensureRepo();
const ensembleDir = join(root, '.hardproof', 'ensemble');
const candidateDir = join(ensembleDir, 'candidates');
const logDir = join(ensembleDir, 'logs');
rmSync(candidateDir, { recursive: true, force: true });
rmSync(logDir, { recursive: true, force: true });
mkdirSync(candidateDir, { recursive: true });
mkdirSync(logDir, { recursive: true });
excludeEnsemble();
git(['worktree', 'prune']);

const candidates = [];
for (let index = 0; index < count; index += 1) {
  const id = String.fromCharCode(97 + index);
  const path = join(candidateDir, id);
  git(['worktree', 'add', '--detach', path, base]);
  for (const shared of ['node_modules', '.venv', 'venv']) {
    const source = join(root, shared);
    const target = join(path, shared);
    if (existsSync(source) && !existsSync(target)) {
      try {
        execFileSync('ln', ['-s', source, target], { cwd: path });
      } catch {
        // Shared dependency directories are optional.
      }
    }
  }
  candidates.push({ id, path, strategy: strategies[index] ?? 'direct', log: join(logDir, `${id}.log`) });
}

console.log(`hardproof ensemble  ${count} candidates  ${strategies.slice(0, count).join(', ')}`);

const runs = await Promise.all(
  candidates.map((candidate) => runCandidate(candidate)),
);

const results = [];
for (const [index, candidate] of candidates.entries()) {
  const checkResults = await runChecks(candidate.path);
  const diff = diffStat(candidate.path);
  results.push({
    id: candidate.id,
    path: candidate.path,
    strategy: candidate.strategy,
    agent: runs[index],
    checks: checkResults,
    passed: checkResults.filter((entry) => entry.ok).length,
    diff,
  });
}

for (const result of results) {
  console.log(
    `candidate ${result.id}  ${result.strategy.padEnd(10)}  checks ${result.passed}/${result.checks.length}  diff ${result.diff.files} file(s), ${result.diff.lines} line(s)  agent exit ${result.agent.exitCode}`,
  );
}

const eligible = results.filter((result) => result.passed === result.checks.length);
const ranked = (eligible.length > 0 ? eligible : results).sort(
  (a, b) => b.passed - a.passed || a.diff.lines - b.diff.lines || a.id.localeCompare(b.id),
);
const winner = ranked[0];

if (!winner || winner.diff.files === 0) {
  console.log('result  no candidate produced a change');
  writeResult({ ok: false, reason: 'no candidate produced a change', candidates: results });
  cleanup();
  process.exit(1);
}

console.log(`winner  ${winner.id}  ${winner.strategy}  ${winner.passed}/${winner.checks.length}`);
applyCandidate(winner.path);
cleanup();

const finalChecks = await runChecks(root);
for (const check of finalChecks) {
  console.log(`${check.ok ? 'PASS' : 'FAIL'}  ${check.command}`);
  if (!check.ok && check.output) console.log(indent(tail(check.output, 8), '      '));
}
const ok = finalChecks.every((check) => check.ok);
writeResult({
  ok,
  winner: winner.id,
  strategy: winner.strategy,
  checks: finalChecks.map((check) => ({
    command: check.command,
    ok: check.ok,
    exitCode: check.exitCode,
  })),
  candidates: results,
});
console.log(`ensemble ${ok ? 'PASS' : 'FAIL'}`);
process.exit(ok ? 0 : 1);

function parseArgs(argv) {
  const parsed = { check: [] };
  for (let index = 0; index < argv.length; index += 1) {
    const item = argv[index];
    if (!item.startsWith('--')) continue;
    const key = item.slice(2);
    const value = argv[index + 1];
    if (value === undefined || value.startsWith('--')) {
      parsed[key] = true;
    } else {
      if (key === 'check') parsed.check.push(value);
      else parsed[key] = value;
      index += 1;
    }
  }
  return parsed;
}

function fail(message) {
  console.error(`hardproof ensemble: ${message}`);
  process.exit(1);
}

function git(argsList, cwd = root) {
  return execFileSync('git', argsList, { cwd, encoding: 'utf8' });
}

function ensureRepo() {
  try {
    git(['rev-parse', '--show-toplevel']);
  } catch {
    git(['init']);
  }

  const dirty = git(['status', '--porcelain']).trim();
  if (dirty) {
    git(['add', '-A']);
    git(['-c', 'user.email=hardproof@local', '-c', 'user.name=hardproof', 'commit', '-q', '-m', 'hardproof ensemble baseline']);
  }

  try {
    git(['rev-parse', 'HEAD']);
  } catch {
    git(['-c', 'user.email=hardproof@local', '-c', 'user.name=hardproof', 'commit', '-q', '--allow-empty', '-m', 'hardproof ensemble baseline']);
  }

  return git(['rev-parse', 'HEAD']).trim();
}

function excludeEnsemble() {
  const excludePath = resolve(root, git(['rev-parse', '--git-path', 'info/exclude']).trim());
  mkdirSync(join(excludePath, '..'), { recursive: true });
  const current = existsSync(excludePath) ? readFileSync(excludePath, 'utf8') : '';
  if (!/^\.hardproof\/$/m.test(current)) {
    writeFileSync(excludePath, `${current}${current && !current.endsWith('\n') ? '\n' : ''}.hardproof/\n`);
  }
}

function promptFor(candidate) {
  return `You are candidate ${candidate.id} for a benchmark task. Work only in this directory: ${candidate.path}

Task:
${request}

Acceptance checks (run these; they must pass):
${checks.map((command) => `- ${command}`).join('\n')}

Strategy: ${candidate.strategy}.
- Implement the task completely in this directory.
- Use the repository's real tools and tests.
- Run every acceptance check before you stop.
- Do not commit.
- Do not modify files outside this directory.
- End with a short summary of files changed and checks run.`;
}

function runCandidate(candidate) {
  const prompt = promptFor(candidate);
  const started = Date.now();
  const command = agentCmd
    ? `${agentCmd} ${shellQuote(prompt)}`
    : [
        'opencode',
        'run',
        ...permissionFlags(),
        ...(model ? ['--model', model] : []),
        '--',
        prompt,
      ]
        .map(shellQuote)
        .join(' ');

  return new Promise((resolvePromise) => {
    const child = spawn(command, {
      cwd: candidate.path,
      shell: true,
      env: { ...process.env, HARDPROOF_ENSEMBLE: '1' },
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: process.platform !== 'win32',
    });
    let output = '';
    const collect = (chunk) => {
      output += chunk.toString();
      if (output.length > 200_000) output = output.slice(-200_000);
    };
    child.stdout.on('data', collect);
    child.stderr.on('data', collect);

    let settled = false;
    let timer;
    const finish = (exitCode, timedOut) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.stdout.destroy();
      child.stderr.destroy();
      writeFileSync(candidate.log, output);
      resolvePromise({
        exitCode: timedOut ? 124 : exitCode,
        timedOut,
        durationMs: Date.now() - started,
      });
    };

    timer = setTimeout(() => {
      try {
        if (process.platform === 'win32') child.kill('SIGKILL');
        else process.kill(-child.pid, 'SIGKILL');
      } catch {
        child.kill('SIGKILL');
      }
      finish(124, true);
    }, timeoutSec * 1000);

    child.on('close', (code) => finish(code ?? 1, false));
    child.on('error', () => finish(127, false));
  });
}

function runChecks(cwd) {
  return Promise.all(
    checks.map((command) => {
      return new Promise((resolvePromise) => {
        const child = spawn(command, {
          cwd,
          shell: true,
          env: { ...process.env, HARDPROOF: '1' },
          stdio: ['ignore', 'pipe', 'pipe'],
        });
        let output = '';
        const collect = (chunk) => {
          output += chunk.toString();
          if (output.length > 20_000) output = output.slice(-20_000);
        };
        child.stdout.on('data', collect);
        child.stderr.on('data', collect);

        let settled = false;
        let timer;
        const finish = (code) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          child.stdout.destroy();
          child.stderr.destroy();
          resolvePromise({ command, ok: code === 0, exitCode: code ?? 1, output });
        };

        timer = setTimeout(() => {
          child.kill('SIGKILL');
          finish(124);
        }, checkTimeout * 1000);
        child.on('close', (code) => finish(code ?? 1));
        child.on('error', () => finish(127));
      });
    }),
  );
}

function stageChanges(cwd) {
  git(['add', '-A'], cwd);
  for (const junk of ['__pycache__', '.pytest_cache', '.mypy_cache']) {
    try {
      git(['reset', '-q', '--', junk], cwd);
    } catch {
      // The cache directory is optional.
    }
  }
}

function diffStat(cwd) {
  stageChanges(cwd);
  const numstat = git(['diff', '--cached', '--numstat', base], cwd).trim();
  if (!numstat) return { files: 0, lines: 0 };
  const rows = numstat.split('\n').filter(Boolean);
  let lines = 0;
  for (const row of rows) {
    const [added, removed] = row.split('\t');
    lines += (Number(added) || 0) + (Number(removed) || 0);
  }
  return { files: rows.length, lines };
}

function applyCandidate(cwd) {
  stageChanges(cwd);
  const patch = git(['diff', '--cached', base, '--binary'], cwd);
  if (!patch.trim()) {
    if (process.env.HARDPROOF_DEBUG) {
      console.error('debug base', base, 'cwd', cwd);
      console.error(git(['status', '--porcelain'], cwd));
      console.error(git(['log', '--oneline', '-2'], cwd));
    }
    console.log('result  selected candidate has no patch');
    cleanup();
    process.exit(1);
  }
  const patchFile = join(ensembleDir, 'selected.patch');
  writeFileSync(patchFile, patch);
  try {
    git(['apply', '--whitespace=nowarn', patchFile]);
  } catch {
    console.log('result  selected patch did not apply cleanly');
    cleanup();
    process.exit(1);
  }
  console.log(`applied  ${relative(root, patchFile)}`);
}

function writeResult(value) {
  writeFileSync(
    join(ensembleDir, 'result.json'),
    `${JSON.stringify({ at: new Date().toISOString(), ...value }, null, 2)}\n`,
  );
}

function cleanup() {
  for (const candidate of candidates) {
    try {
      git(['worktree', 'remove', '--force', candidate.path]);
    } catch {
      // Already removed or incomplete worktree.
    }
  }
}

function permissionFlags() {
  if (agentCmd) return [];
  try {
    const help = execFileSync('opencode', ['run', '--help'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    if (help.includes('--auto')) return ['--auto'];
    if (help.includes('--dangerously-skip-permissions')) {
      return ['--dangerously-skip-permissions'];
    }
  } catch {
    // Older CLIs do not print the flag in help.
  }
  return ['--dangerously-skip-permissions'];
}

function shellQuote(value) {
  return `'${String(value).replaceAll("'", `'\\''`)}'`;
}

function tail(text, lines) {
  return String(text).trimEnd().split('\n').slice(-lines).join('\n');
}

function indent(text, prefix) {
  return text.split('\n').map((line) => `${prefix}${line}`).join('\n');
}
