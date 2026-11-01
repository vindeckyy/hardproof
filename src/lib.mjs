import { createHash } from 'node:crypto';
import { execFileSync, spawn } from 'node:child_process';
import {
  appendFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';

export const VERSION = JSON.parse(
  readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
).version;

export const PROOF_DIR = '.proof';
export const TASK_FILE = 'task.json';
export const CONTRACT_FILE = 'contract.json';
export const VERDICT_FILE = 'verdict.json';
export const CHECK_FILE = 'check.json';
export const GATE_FILE = 'gate.json';

export class UserError extends Error {}

export function proofPath(root, file) {
  return join(root, PROOF_DIR, file);
}

export function repoRoot(cwd = process.cwd()) {
  try {
    return execFileSync('git', ['rev-parse', '--show-toplevel'], {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    throw new UserError('not inside a git repository. Run hardproof from a repository root.');
  }
}

export function tryRepoRoot(cwd = process.cwd()) {
  try {
    return repoRoot(cwd);
  } catch {
    return cwd;
  }
}

function git(root, args) {
  return execFileSync('git', args, {
    cwd: root,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
  }).trim();
}

export function gitHead(root) {
  try {
    return git(root, ['rev-parse', 'HEAD']);
  } catch {
    return 'unborn';
  }
}

export function dirtyTrackedFiles(root) {
  const unstaged = execFileSync('git', ['diff', '--name-only', '-z'], {
    cwd: root,
    stdio: ['ignore', 'pipe', 'ignore'],
  }).toString('utf8');
  const staged = execFileSync('git', ['diff', '--cached', '--name-only', '-z'], {
    cwd: root,
    stdio: ['ignore', 'pipe', 'ignore'],
  }).toString('utf8');

  return [...new Set(`${unstaged}\0${staged}`.split('\0'))].filter(Boolean);
}

export function changedFiles(root, baseHead = null) {
  let files = [];

  if (baseHead && baseHead !== 'unborn') {
    try {
      const changed = execFileSync(
        'git',
        ['diff', '--no-renames', '--name-only', '-z', baseHead, '--'],
        { cwd: root, stdio: ['ignore', 'pipe', 'ignore'] },
      ).toString('utf8');
      const untracked = execFileSync(
        'git',
        ['ls-files', '--others', '--exclude-standard', '-z'],
        { cwd: root, stdio: ['ignore', 'pipe', 'ignore'] },
      ).toString('utf8');

      for (const path of new Set(`${changed}\0${untracked}`.split('\0'))) {
        if (path) files.push({ path });
      }
    } catch {
      throw new UserError('git diff failed. Is the baseline commit still present?');
    }
  } else {
    let raw;
    try {
      raw = execFileSync(
        'git',
        ['status', '--porcelain=v1', '-z', '--untracked-files=all'],
        { cwd: root, stdio: ['ignore', 'pipe', 'ignore'] },
      ).toString('utf8');
    } catch {
      throw new UserError('git status failed. Is this a valid git repository?');
    }

    const parts = raw.split('\0');
    for (let i = 0; i < parts.length; i += 1) {
      const item = parts[i];
      if (!item) continue;

      const status = item.slice(0, 2);
      let path = item.slice(3);

      if (status.includes('R') || status.includes('C')) {
        const original = parts[i + 1] ?? '';
        i += 1;
        if (!existsSync(join(root, path)) && existsSync(join(root, original))) {
          path = original;
        }
      }
      files.push({ path });
    }
  }

  return files.filter((file) => file.path !== PROOF_DIR && !file.path.startsWith(`${PROOF_DIR}/`));
}

function addField(hash, value) {
  const buffer = Buffer.isBuffer(value) ? value : Buffer.from(value);
  hash.update(`${buffer.length}:`);
  hash.update(buffer);
}

function hashDirectory(hash, directory, state, relativeRoot) {
  state.entries += 1;
  if (state.entries > 20_000) {
    throw new UserError(
      `cannot hash ${relativeRoot}: directory is too large. Commit it, remove it, or ignore it in git.`,
    );
  }

  const entries = readdirSync(directory, { withFileTypes: true }).sort((a, b) =>
    a.name < b.name ? -1 : a.name > b.name ? 1 : 0,
  );

  addField(hash, 'dir');
  for (const entry of entries) {
    if (entry.name === '.git') continue;

    const absolute = join(directory, entry.name);
    const relativePath = `${relativeRoot}/${entry.name}`;
    addField(hash, 'entry');
    addField(hash, relativePath);

    if (entry.isSymbolicLink()) {
      addField(hash, 'link');
      addField(hash, readlinkSync(absolute));
    } else if (entry.isDirectory()) {
      hashDirectory(hash, absolute, state, relativePath);
    } else {
      addField(hash, 'mode');
      addField(hash, lstatSync(absolute).mode & 0o111 ? 'exec' : 'plain');
      addField(hash, 'file');
      addField(hash, readFileSync(absolute));
    }
  }
  addField(hash, 'end');
}

export function worktreeClean(root) {
  const raw = execFileSync(
    'git',
    ['status', '--porcelain=v1', '-z', '--untracked-files=all'],
    { cwd: root, stdio: ['ignore', 'pipe', 'ignore'] },
  ).toString('utf8');

  return raw.split('\0').every((item) => {
    if (!item) return true;
    const path = item.slice(3);
    return path === PROOF_DIR || path.startsWith(`${PROOF_DIR}/`);
  });
}

export function treeHash(root, baseHead = null) {
  const hash = createHash('sha256');
  addField(hash, 'hardproof-tree-v6');
  addField(hash, 'base');
  addField(hash, baseHead ?? '');
  if (!baseHead || baseHead === 'unborn') {
    addField(hash, 'head');
    addField(hash, gitHead(root));
  }

  let submodules = '';
  try {
    submodules = git(root, ['submodule', 'status', '--recursive']);
  } catch {
    // A repository without submodule support still has a valid tree.
  }
  addField(hash, 'submodules');
  addField(hash, submodules);

  const files = changedFiles(root, baseHead).sort((a, b) =>
    a.path < b.path ? -1 : a.path > b.path ? 1 : 0,
  );

  for (const { path } of files) {
    const absolute = resolve(root, path);
    addField(hash, 'path');
    addField(hash, path);

    let stat;
    try {
      stat = lstatSync(absolute);
    } catch {
      addField(hash, 'deleted');
      continue;
    }

    if (stat.isSymbolicLink()) {
      addField(hash, 'link');
      addField(hash, readlinkSync(absolute));
    } else if (stat.isDirectory()) {
      hashDirectory(hash, absolute, { entries: 0 }, path);
    } else if (stat.isFile()) {
      // Shortcut: hashes whole changed files. Large generated files make this
      // slower; cheap enough for normal source diffs.
      addField(hash, 'mode');
      addField(hash, stat.mode & 0o111 ? 'exec' : 'plain');
      addField(hash, 'file');
      addField(hash, readFileSync(absolute));
    } else {
      addField(hash, `special:${stat.mode}`);
    }
  }

  return hash.digest('hex');
}

export function contractHash(task) {
  const canonical = JSON.stringify({
    goal: task.goal,
    kind: task.kind,
    request: task.request ?? '',
    cause: task.cause ?? '',
    baseHead: task.baseHead,
    dirtyStart: Boolean(task.dirtyStart),
    checks: task.checks.map((check) => ({
      command: check.command,
      timeoutSec: check.timeoutSec,
      baseline: {
        ok: check.baseline?.ok,
        exitCode: check.baseline?.exitCode,
        output: check.baseline?.output ?? '',
      },
    })),
    scope: task.scope,
  });

  return createHash('sha256').update(canonical).digest('hex');
}

export const KINDS = ['bug', 'feature', 'refactor'];

export function isTestPath(path) {
  const segments = path.split('/');
  if (
    segments.some((segment) =>
      ['test', 'tests', '__tests__', 'spec', 'specs', 'testdata'].includes(
        segment.toLowerCase(),
      ),
    )
  ) {
    return true;
  }
  if (/\.(test|spec)\.[^/]+$/i.test(path)) return true;

  const name = segments[segments.length - 1];
  if (/^test_.*\.py$/i.test(name) || /_test\.(py|go|rb|rs|js|ts|tsx|jsx)$/i.test(name)) {
    return true;
  }
  if (/^conftest\.py$/i.test(name) || /_spec\.rb$/i.test(name)) return true;
  return /(test|tests|testcase)\.(java|kt|kts|cs|php|swift|scala)$/i.test(name);
}

export function changedTestFiles(root, baseHead = null) {
  return changedFiles(root, baseHead)
    .map((file) => file.path)
    .filter((path) => isTestPath(path));
}

export function validateTask(task) {
  if (!task || typeof task !== 'object') {
    throw new UserError('task file is not a JSON object.');
  }
  if (typeof task.goal !== 'string' || !task.goal.trim()) {
    throw new UserError('task file has no goal. Run hardproof init again.');
  }
  if (!KINDS.includes(task.kind)) {
    throw new UserError('task file has no valid kind. Run hardproof init again.');
  }
  if (task.cause !== undefined && typeof task.cause !== 'string') {
    throw new UserError('task file has an invalid cause.');
  }
  if (task.request !== undefined && typeof task.request !== 'string') {
    throw new UserError('task file has an invalid request.');
  }
  if (typeof task.baseHead !== 'string' || !task.baseHead) {
    throw new UserError('task file has no baseline commit. Run hardproof init again.');
  }
  if (!Array.isArray(task.checks) || task.checks.length === 0) {
    throw new UserError('task file has no checks. Run hardproof init again.');
  }
  for (const check of task.checks) {
    if (typeof check.command !== 'string' || !check.command.trim()) {
      throw new UserError('task file has an empty check command.');
    }
    if (!Number.isInteger(check.timeoutSec) || check.timeoutSec < 1) {
      throw new UserError('task file has an invalid check timeout.');
    }
  }
  if (!Array.isArray(task.scope) || task.scope.some((item) => typeof item !== 'string')) {
    throw new UserError('task file has an invalid scope list.');
  }
  return task;
}

export function readTask(root) {
  const file = proofPath(root, TASK_FILE);
  if (!existsSync(file)) {
    throw new UserError(
      `no contract at ${PROOF_DIR}/${TASK_FILE}. Run hardproof init before implementing.`,
    );
  }
  let task;
  try {
    task = JSON.parse(readFileSync(file, 'utf8'));
  } catch (error) {
    throw new UserError(`cannot parse ${PROOF_DIR}/${TASK_FILE}: ${error.message}`);
  }
  return validateTask(task);
}

export function writeJson(file, value) {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
}

export function readJson(file) {
  if (!existsSync(file)) return null;
  try {
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

const activeChildren = new Set();

function killOwnedChildren() {
  for (const child of activeChildren) {
    if (process.platform === 'win32') {
      child.kill('SIGKILL');
      continue;
    }
    try {
      process.kill(-child.pid, 'SIGKILL');
    } catch {
      child.kill('SIGKILL');
    }
  }
}

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    killOwnedChildren();
    process.exit(130);
  });
}

export function runCommand(command, cwd, timeoutSec) {
  return new Promise((resolvePromise) => {
    const startedAt = Date.now();
    let output = '';
    let timedOut = false;
    let settled = false;
    let timer;

    const child = spawn(command, {
      cwd,
      shell: true,
      env: { ...process.env, HARDPROOF: '1' },
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: process.platform !== 'win32',
    });
    activeChildren.add(child);

    const collect = (chunk) => {
      output += chunk.toString();
      if (output.length > 40_000) output = output.slice(-40_000);
    };
    child.stdout.on('data', collect);
    child.stderr.on('data', collect);

    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      activeChildren.delete(child);
      child.stdout.destroy();
      child.stderr.destroy();
      resolvePromise(result);
    };

    timer = setTimeout(() => {
      timedOut = true;
      if (process.platform === 'win32') {
        child.kill('SIGKILL');
      } else {
        try {
          process.kill(-child.pid, 'SIGKILL');
        } catch {
          child.kill('SIGKILL');
        }
      }
      finish({
        ok: false,
        exitCode: 124,
        durationMs: Date.now() - startedAt,
        timedOut: true,
        output: output.trim(),
      });
    }, timeoutSec * 1000);

    child.on('error', (error) => {
      finish({
        ok: false,
        exitCode: 127,
        durationMs: Date.now() - startedAt,
        timedOut,
        output: String(error),
      });
    });

    child.on('close', (code) => {
      finish({
        ok: !timedOut && code === 0,
        exitCode: timedOut ? 124 : (code ?? 1),
        durationMs: Date.now() - startedAt,
        timedOut,
        output: output.trim(),
      });
    });
  });
}

export function globToRegExp(glob) {
  let pattern = '^';
  for (let i = 0; i < glob.length; ) {
    if (glob.startsWith('**/', i)) {
      pattern += '(?:.*/)?';
      i += 3;
    } else if (glob.startsWith('**', i)) {
      pattern += '.*';
      i += 2;
    } else if (glob[i] === '*') {
      pattern += '[^/]*';
      i += 1;
    } else if (glob[i] === '?') {
      pattern += '[^/]';
      i += 1;
    } else {
      pattern += glob[i].replace(/[.+^${}()|[\]\\]/g, '\\$&');
      i += 1;
    }
  }
  return new RegExp(`${pattern}$`);
}

export function matchesScope(path, scope) {
  if (scope.length === 0) return true;

  return scope.some((entry) => {
    const clean = entry.replace(/^\.\//, '').replace(/\/+$/, '');
    if (!clean) return true;
    if (!/[*?[\]]/.test(clean)) {
      return path === clean || path.startsWith(`${clean}/`);
    }
    if (clean.endsWith('/**') && path === clean.slice(0, -3)) return true;
    return globToRegExp(clean).test(path);
  });
}

export function scopeReport(root, task, allowBreach) {
  const changed = changedFiles(root, task.baseHead).map((file) => file.path);
  const outOfScope = changed.filter((path) => !matchesScope(path, task.scope));
  return {
    changed,
    outOfScope,
    allowed: allowBreach && outOfScope.length > 0,
    ok: outOfScope.length === 0 || allowBreach,
  };
}

export async function runChecks(root, task) {
  const results = [];
  for (const check of task.checks) {
    const result = await runCommand(check.command, root, check.timeoutSec);
    results.push({ command: check.command, timeoutSec: check.timeoutSec, ...result });
  }
  return {
    ok: results.every((result) => result.ok),
    results,
  };
}

export function excerpt(text, headChars = 1800, tailChars = 1800) {
  const clean = String(text).trim();
  if (clean.length <= headChars + tailChars + 5) return clean;
  return `${clean.slice(0, headChars)}\n...\n${clean.slice(-tailChars)}`;
}

export function shorten(text, max = 80) {
  const flat = String(text).replace(/\s+/g, ' ').trim();
  return flat.length <= max ? flat : `${flat.slice(0, max - 1)}…`;
}

export function duration(ms) {
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

export function tail(text, lines = 20) {
  const all = String(text).trimEnd().split('\n');
  return all.slice(Math.max(0, all.length - lines)).join('\n');
}

export function excludeProofDir(root) {
  let gitPath;
  try {
    gitPath = git(root, ['rev-parse', '--git-path', 'info/exclude']);
  } catch {
    return false;
  }

  const excludeFile = resolve(root, gitPath);
  const existing = existsSync(excludeFile) ? readFileSync(excludeFile, 'utf8') : '';
  if (/^\.proof\/?$/m.test(existing)) return false;

  mkdirSync(dirname(excludeFile), { recursive: true });
  const prefix = existing && !existing.endsWith('\n') ? '\n' : '';
  appendFileSync(excludeFile, `${prefix}${PROOF_DIR}/\n`);
  return true;
}
