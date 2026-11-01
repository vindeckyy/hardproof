import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { UserError, VERSION, tryRepoRoot } from './lib.mjs';

const SKILL_ROOT = fileURLToPath(new URL('../skill/', import.meta.url));
const SKILL_NAME = 'hardproof';
const VERIFIER_NAME = 'hardproof-verifier';
const MARKER = 'managed by hardproof';

const PROVIDERS = {
  claude: {
    label: 'Claude Code',
    globalRoot: '.claude',
    projectRoot: '.claude',
    agent: 'claude',
  },
  opencode: {
    label: 'OpenCode',
    globalRoot: join('.config', 'opencode'),
    projectRoot: '.opencode',
    agent: 'opencode',
  },
  codex: {
    label: 'Codex',
    globalRoot: '.agents',
    projectRoot: '.agents',
    agent: 'skill',
  },
  generic: {
    label: 'Generic Agent Skills',
    globalRoot: null,
    projectRoot: '.agents',
    agent: 'skill',
  },
};

export const PROVIDER_NAMES = Object.keys(PROVIDERS);

function readSkill(relativePath) {
  return readFileSync(join(SKILL_ROOT, relativePath), 'utf8');
}

function rootFor(providerName, options) {
  if (!Object.hasOwn(PROVIDERS, providerName)) {
    throw new UserError(`unknown provider "${providerName}". Use: ${PROVIDER_NAMES.join(', ')}.`);
  }
  const provider = PROVIDERS[providerName];

  if (options.dir) {
    if (options.project) throw new UserError('--dir and --project are mutually exclusive.');
    return { provider, root: resolve(options.dir), scope: 'custom' };
  }

  if (providerName === 'generic') {
    if (!options.project) {
      throw new UserError('generic needs --dir <path> (or --project for ./.agents).');
    }
    return { provider, root: join(tryRepoRoot(), provider.projectRoot), scope: 'project' };
  }

  if (options.project) {
    return { provider, root: join(tryRepoRoot(), provider.projectRoot), scope: 'project' };
  }

  return { provider, root: join(homedir(), provider.globalRoot), scope: 'global' };
}

function claudeAgent(verifier) {
  return `---
name: ${VERIFIER_NAME}
description: Independently verify a hardproof run. Read-only. Runs the acceptance checks, attacks the diff, and records a pass or fail verdict.
tools: Read, Grep, Glob, Bash
---

${verifier}

<!-- ${MARKER} -->
`;
}

function opencodeAgent(verifier) {
  return `---
description: Independently verify a hardproof run. Read-only. Runs the acceptance checks, attacks the diff, and records a pass or fail verdict.
mode: subagent
permissions:
  - action: edit
    resource: "*"
    effect: deny
  - action: subagent
    resource: "*"
    effect: deny
---

${verifier}

<!-- ${MARKER} -->
`;
}

function verifierSkill(verifier) {
  return `---
name: ${VERIFIER_NAME}
description: Independently verify a hardproof run. Read-only. Runs the acceptance checks, attacks the diff, and records a pass or fail verdict.
---

${verifier}

<!-- ${MARKER} -->
`;
}

function hashContent(content) {
  return createHash('sha256').update(content).digest('hex');
}

function manifest(provider, scope, files, root) {
  return {
    name: SKILL_NAME,
    version: VERSION,
    provider,
    scope,
    installedAt: new Date().toISOString(),
    files: Object.fromEntries(
      files.map((file) => [
        relative(root, file.path).split('\\').join('/'),
        hashContent(file.content),
      ]),
    ),
  };
}

function isManagedDir(dir) {
  return existsSync(join(dir, '.hardproof-install.json'));
}

function isManagedFile(file) {
  return existsSync(file) && readFileSync(file, 'utf8').includes(MARKER);
}

function isManagedSkillDir(dir) {
  return isManagedFile(join(dir, 'SKILL.md'));
}

function assertReplaceable(path, kind, force) {
  if (!existsSync(path)) return;

  const managed =
    kind === 'dir'
      ? isManagedDir(path)
      : kind === 'skill-dir'
        ? isManagedSkillDir(path)
        : isManagedFile(path);

  if (!managed && !force) {
    throw new UserError(
      `${path} exists and was not installed by hardproof. Use --force to replace it.`,
    );
  }
}

function installTargets(provider, root) {
  const skillDir = join(root, 'skills', SKILL_NAME);
  const targets = [{ path: skillDir, kind: 'dir' }];

  if (provider.agent === 'claude' || provider.agent === 'opencode') {
    targets.push({ path: join(root, 'agents', `${VERIFIER_NAME}.md`), kind: 'file' });
  } else {
    targets.push({ path: join(root, 'skills', VERIFIER_NAME), kind: 'skill-dir' });
  }

  return targets;
}

function installFiles(providerName, root) {
  const provider = PROVIDERS[providerName];
  const verifier = readSkill('references/verifier.md');
  const skillDir = join(root, 'skills', SKILL_NAME);
  const files = [
    { path: join(skillDir, 'SKILL.md'), content: readSkill('SKILL.md') },
    { path: join(skillDir, 'references', 'verifier.md'), content: verifier },
  ];

  if (provider.agent === 'claude') {
    files.push({
      path: join(root, 'agents', `${VERIFIER_NAME}.md`),
      content: claudeAgent(verifier),
    });
  } else if (provider.agent === 'opencode') {
    files.push({
      path: join(root, 'agents', `${VERIFIER_NAME}.md`),
      content: opencodeAgent(verifier),
    });
  } else {
    files.push({
      path: join(root, 'skills', VERIFIER_NAME, 'SKILL.md'),
      content: verifierSkill(verifier),
    });
  }

  return files;
}

export function cmdInstall(providerName, options) {
  if (!providerName) {
    throw new UserError(`choose a provider: ${PROVIDER_NAMES.join(', ')}.`);
  }

  const { provider, root, scope } = rootFor(providerName, options);
  const skillDir = join(root, 'skills', SKILL_NAME);
  const files = installFiles(providerName, root);

  files.push({
    path: join(skillDir, '.hardproof-install.json'),
    content: `${JSON.stringify(manifest(providerName, scope, files, root), null, 2)}\n`,
  });

  for (const target of installTargets(provider, root)) {
    assertReplaceable(target.path, target.kind, options.force);
  }

  console.log(`hardproof install  ${providerName}  ${scope}`);
  for (const file of files) {
    console.log(`${options.dryRun ? 'would write' : 'wrote'}  ${file.path}`);
    if (options.dryRun) continue;
    mkdirSync(dirname(file.path), { recursive: true });
    writeFileSync(file.path, file.content);
  }

  if (!options.dryRun) {
    console.log(`done  restart the agent if it does not pick up ${SKILL_NAME} automatically`);
  }
  return 0;
}

export function cmdUninstall(providerName, options) {
  if (!providerName) {
    throw new UserError(`choose a provider: ${PROVIDER_NAMES.join(', ')}.`);
  }

  const { provider, root, scope } = rootFor(providerName, options);
  const targets = installTargets(provider, root);

  console.log(`hardproof uninstall  ${providerName}  ${scope}`);
  let removed = 0;

  for (const target of targets) {
    if (!existsSync(target.path)) continue;
    assertReplaceable(target.path, target.kind, options.force);
    rmSync(target.path, { recursive: target.kind !== 'file', force: false });
    console.log(`removed  ${target.path}`);
    removed += 1;
  }

  if (removed === 0) console.log('nothing installed at the expected paths');
  return 0;
}

export function checkInstall(item) {
  const manifestPath = join(item.path, '.hardproof-install.json');
  if (!existsSync(manifestPath)) {
    return { ok: false, reason: 'manifest missing' };
  }

  let manifest;
  try {
    manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  } catch {
    return { ok: false, reason: 'manifest unreadable' };
  }

  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) {
    return { ok: false, reason: 'manifest invalid' };
  }
  if (manifest.version !== VERSION) {
    return { ok: false, reason: `installed ${manifest.version ?? 'unknown'}, CLI ${VERSION}` };
  }

  if (manifest.files && typeof manifest.files === 'object') {
    for (const [path, expected] of Object.entries(manifest.files)) {
      const absolute = join(item.root, ...path.split('/'));
      let actual;
      try {
        actual = readFileSync(absolute);
      } catch {
        return { ok: false, reason: `unreadable ${path}` };
      }
      if (hashContent(actual) !== expected) {
        return { ok: false, reason: `changed ${path}` };
      }
    }
  }

  for (const file of installFiles(item.provider, item.root)) {
    const path = relative(item.root, file.path).split('\\').join('/');
    if (!existsSync(file.path)) {
      return { ok: false, reason: `missing ${path}` };
    }
    let actual;
    try {
      actual = readFileSync(file.path, 'utf8');
    } catch {
      return { ok: false, reason: `unreadable ${path}` };
    }
    if (actual !== file.content) {
      return { ok: false, reason: `changed ${path}` };
    }
  }

  return { ok: true, reason: null };
}

export function detectInstalls(cwd = process.cwd()) {
  const found = [];
  const seen = new Set();
  const projectBase = tryRepoRoot(cwd);

  for (const [name, provider] of Object.entries(PROVIDERS)) {
    const roots = [];
    if (provider.globalRoot) {
      roots.push({ root: join(homedir(), provider.globalRoot), scope: 'global' });
    }
    if (provider.projectRoot) {
      roots.push({ root: join(projectBase, provider.projectRoot), scope: 'project' });
    }
    for (const { root, scope } of roots) {
      const skillDir = join(root, 'skills', SKILL_NAME);
      const key = `${scope}:${skillDir}`;
      if (existsSync(skillDir) && !seen.has(key)) {
        seen.add(key);
        found.push({ provider: name, scope, path: skillDir, root });
      }
    }
  }

  return found;
}
