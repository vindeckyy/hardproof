import { existsSync, rmSync } from 'node:fs';
import { relative } from 'node:path';
import {
  CHECK_FILE,
  CONTRACT_FILE,
  GATE_FILE,
  KINDS,
  PROOF_DIR,
  TASK_FILE,
  UserError,
  VERDICT_FILE,
  VERSION,
  changedTestFiles,
  contractHash,
  duration,
  excerpt,
  dirtyTrackedFiles,
  excludeProofDir,
  gitHead,
  isTestPath,
  proofPath,
  readJson,
  readTask,
  repoRoot,
  runCommand,
  runChecks,
  scopeReport,
  shorten,
  tail,
  treeHash,
  worktreeClean,
  writeJson,
} from './lib.mjs';
import { checkInstall, detectInstalls } from './install.mjs';

function rel(root, file) {
  return relative(root, file) || file;
}

function printCheckResults(results) {
  results.forEach((result, index) => {
    const status = result.ok ? 'PASS' : 'FAIL';
    const timeout = result.timedOut ? ' (timed out)' : '';
    console.log(
      `check ${index + 1}  ${status}  ${duration(result.durationMs)}  ${shorten(result.command, 90)}${timeout}`,
    );
    if (!result.ok && result.output) {
      console.log(
        tail(result.output)
          .split('\n')
          .map((line) => `         ${line}`)
          .join('\n'),
      );
    }
  });
}

function printTests(testFiles, review) {
  if (testFiles.length === 0) return;
  console.log(
    `tests    ${testFiles.length} changed${review ? '' : ' — verifier review required'}`,
  );
  for (const path of testFiles) console.log(`         ${path}`);
  if (review) console.log(`review   ${review}`);
}

function printScope(scope) {
  if (scope.changed.length === 0) {
    console.log('scope    no changes against HEAD');
    return;
  }
  if (scope.ok) {
    const note = scope.allowed ? ' (breach allowed by flag)' : '';
    console.log(`scope    ok — ${scope.changed.length} changed file(s)${note}`);
    if (scope.allowed) {
      for (const path of scope.outOfScope) console.log(`         outside: ${path}`);
    }
    return;
  }
  console.log(`scope    BREACH — ${scope.outOfScope.length} file(s) outside the contract`);
  for (const path of scope.outOfScope) console.log(`         ${path}`);
}

function assertContractLocked(root, task) {
  const lock = readJson(proofPath(root, CONTRACT_FILE));
  if (!lock) {
    throw new UserError(`contract lock is missing. Run hardproof init --force to start a new contract.`);
  }
  if (lock.contract !== contractHash(task)) {
    throw new UserError(
      `${PROOF_DIR}/${TASK_FILE} changed after init. Run hardproof init --force to start a new contract.`,
    );
  }
}

function weakCommand(command) {
  const flat = command.trim().replace(/\s+/g, ' ');
  return (
    /^(true|:|exit 0)$/.test(flat) ||
    /\|\| (true|:)$/.test(flat) ||
    /--passWithNoTests\b/.test(flat)
  );
}

function parseTimeout(value) {
  if (value === undefined) return 600;
  const timeout = Number(value);
  if (!Number.isInteger(timeout) || timeout < 1 || timeout > 3600) {
    throw new UserError('--timeout must be an integer between 1 and 3600 seconds.');
  }
  return timeout;
}

export async function cmdInit(options) {
  const root = repoRoot();
  const goal = (options.goal ?? '').trim();
  if (!goal) throw new UserError('--goal is required. State the result in one sentence.');

  const commands = (options.check ?? []).map((command) => command.trim()).filter(Boolean);
  if (commands.length === 0) {
    throw new UserError('at least one --check is required. A claim needs a command that can fail.');
  }

  if (existsSync(proofPath(root, TASK_FILE)) && !options.force) {
    throw new UserError(
      `${PROOF_DIR}/${TASK_FILE} already exists. Use --force only to replace a contract before work starts.`,
    );
  }

  const kind = (options.kind ?? 'feature').trim().toLowerCase();
  if (!KINDS.includes(kind)) {
    throw new UserError(`--kind must be one of: ${KINDS.join(', ')}.`);
  }
  const request = (options.request ?? '').trim();
  const cause = (options.cause ?? '').trim();
  if (kind === 'bug' && !cause) {
    throw new UserError(
      'bug work needs --cause. Name the root cause you will verify, or use --kind feature.',
    );
  }

  const baseHead = gitHead(root);
  if (baseHead === 'unborn') {
    throw new UserError(
      'the repository has no commits. Make an initial commit before init, so the proof has a baseline boundary.',
    );
  }

  const dirty = dirtyTrackedFiles(root);
  const dirtyTests = dirty.filter((path) => isTestPath(path));
  const dirtyProduction = dirty.filter((path) => !isTestPath(path));
  if (dirtyProduction.length > 0 && !options.allowDirty) {
    throw new UserError(
      `tracked production files are dirty: ${dirtyProduction.slice(0, 5).join(', ')}. Commit or stash them before init, or pass --allow-dirty when they are intentional.`,
    );
  }
  const timeoutSec = parseTimeout(options.timeout);
  const scope = (options.scope ?? []).map((entry) => entry.trim()).filter(Boolean);
  const createdAt = new Date().toISOString();

  console.log('hardproof init');
  console.log(`kind     ${kind}`);
  console.log(`goal     ${goal}`);
  if (cause) console.log(`cause    ${cause}`);
  if (dirtyProduction.length > 0 && options.allowDirty) {
    console.log(
      `warning  production files were already dirty: ${dirtyProduction.slice(0, 5).join(', ')}`,
    );
  }
  if (dirtyTests.length > 0) {
    console.log(
      'note     test changes are already present; they will be part of the run and need review',
    );
  }
  if (scope.length > 0) console.log(`scope    ${scope.join(', ')}`);
  for (const command of commands) {
    if (weakCommand(command)) {
      console.log(`warning  check may always pass: ${shorten(command, 90)}`);
    }
  }

  const checks = [];
  for (const [index, command] of commands.entries()) {
    const { ok, exitCode, durationMs, output } = await runCommand(command, root, timeoutSec);
    checks.push({
      command,
      timeoutSec,
      baseline: {
        ok,
        exitCode,
        durationMs,
        output: excerpt(output),
        at: createdAt,
      },
    });
    console.log(
      `baseline ${index + 1}  ${ok ? 'PASS' : 'FAIL'}  exit ${exitCode}  ${shorten(command, 90)}`,
    );
    if (!ok && output) {
      console.log(
        excerpt(output, 700, 700)
          .split('\n')
          .map((line) => `          ${line}`)
          .join('\n'),
      );
    }
  }

  const failing = checks.filter((check) => !check.baseline.ok).length;
  if (kind === 'bug' && failing === 0) {
    throw new UserError(
      'bug work needs at least one check that fails at baseline. Add the regression test first, run it red, then init.',
    );
  }
  if (kind === 'refactor' && failing > 0) {
    throw new UserError(
      'refactor work needs a clean baseline. Fix the existing failures first, or use --kind bug.',
    );
  }

  const task = {
    schema: 1,
    kind,
    baseHead,
    dirtyStart: dirty.length > 0,
    request,
    goal,
    cause,
    createdAt,
    checks,
    scope,
  };
  for (const stale of [VERDICT_FILE, CHECK_FILE, GATE_FILE]) {
    rmSync(proofPath(root, stale), { force: true });
  }
  writeJson(proofPath(root, TASK_FILE), task);
  writeJson(proofPath(root, CONTRACT_FILE), {
    schema: 1,
    contract: contractHash(task),
    at: createdAt,
  });
  const excluded = excludeProofDir(root);

  if (kind === 'bug') {
    console.log(`baseline ${failing}/${checks.length} failing — reproduction is red.`);
  } else if (kind === 'refactor') {
    console.log('baseline 0 failures — behavior preservation has a clean starting point.');
  } else if (failing === 0) {
    console.log('warning  every check passes before any change.');
    console.log('         Make sure these checks can detect the problem, or add one that fails first.');
  } else {
    console.log(`baseline ${failing}/${checks.length} failing — these also need to pass at the gate.`);
  }

  console.log(`task     ${rel(root, proofPath(root, TASK_FILE))}`);
  if (excluded) console.log(`git      added ${PROOF_DIR}/ to .git/info/exclude`);
  return 0;
}

export async function cmdCheck(options) {
  const root = repoRoot();
  const task = readTask(root);
  assertContractLocked(root, task);
  const checks = await runChecks(root, task);
  const scope = scopeReport(root, task, Boolean(options.allowScopeBreach));
  const testFiles = changedTestFiles(root, task.baseHead);
  const ok = checks.ok && scope.ok;

  writeJson(proofPath(root, CHECK_FILE), {
    schema: 1,
    at: new Date().toISOString(),
    version: VERSION,
    ok,
    checks: checks.results,
    scope,
    testFiles,
  });

  if (options.json) {
    console.log(JSON.stringify({ ok, checks: checks.results, scope, testFiles }, null, 2));
    return ok ? 0 : 1;
  }

  console.log('hardproof check');
  console.log(`kind     ${task.kind}`);
  console.log(`goal     ${task.goal}`);
  if (task.cause) console.log(`cause    ${task.cause}`);
  printCheckResults(checks.results);
  printScope(scope);
  printTests(testFiles);
  console.log(`result   ${ok ? 'PASS' : 'FAIL'}`);
  return ok ? 0 : 1;
}

export function cmdVerdict(positionals, options) {
  const root = repoRoot();
  const task = readTask(root);
  assertContractLocked(root, task);
  const verdict = positionals[0];

  if (verdict !== 'pass' && verdict !== 'fail') {
    throw new UserError('verdict must be "pass" or "fail".');
  }

  const summary = (options.summary ?? '').trim();
  if (!summary) throw new UserError('--summary is required. Say what you checked.');

  const findings = (options.finding ?? []).map((item) => item.trim()).filter(Boolean);
  if (verdict === 'fail' && findings.length === 0) {
    throw new UserError('a fail verdict needs at least one --finding.');
  }
  if (verdict === 'pass' && findings.length > 0) {
    throw new UserError('a pass verdict cannot include findings. Use verdict fail.');
  }

  const testFiles = changedTestFiles(root, task.baseHead);
  const testReview = (options.testReview ?? '').trim();
  if (verdict === 'pass' && testFiles.length > 0 && testReview.length < 12) {
    throw new UserError(
      'test files changed. Pass --test-review "<what you checked>" before a pass verdict.',
    );
  }
  if (summary.length < 12) {
    throw new UserError('--summary is too short. Say what you checked in at least 12 characters.');
  }

  const record = {
    schema: 1,
    verdict,
    summary,
    findings,
    testReview: testReview || null,
    verifier: (options.verifier ?? process.env.HARDPROOF_VERIFIER ?? 'verifier').trim(),
    tree: treeHash(root, task.baseHead),
    head: gitHead(root),
    contract: contractHash(task),
    at: new Date().toISOString(),
  };

  writeJson(proofPath(root, VERDICT_FILE), record);

  console.log(
    `verdict  ${verdict}  tree ${record.tree.slice(0, 8)}  ${PROOF_DIR}/${VERDICT_FILE}`,
  );
  console.log(`summary  ${summary}`);
  for (const finding of findings) console.log(`finding  ${finding}`);
  if (testReview) console.log(`tests    ${testReview}`);
  return 0;
}

function verdictProblem(verdict, tree, contract, testFiles, root) {
  if (!verdict) return 'verifier has not recorded a verdict';
  if (verdict.schema !== 1) return 'verdict schema is unsupported; run the verifier again';
  if (typeof verdict.head !== 'string' || !verdict.head) {
    return 'verdict has no commit binding; run the verifier again';
  }
  if (verdict.tree !== tree) return 'verdict is stale: the tree changed after verification';
  if (verdict.contract !== contract) {
    return 'verdict is stale: the contract changed after verification';
  }
  if (verdict.verdict !== 'pass') {
    const count = Array.isArray(verdict.findings) ? verdict.findings.length : 0;
    return `verifier rejected the change (${count} finding(s))`;
  }
  if (!Array.isArray(verdict.findings)) return 'verdict has no findings list';
  if (verdict.findings.length > 0) return 'verdict has open findings';
  if (testFiles.length > 0) {
    const review = typeof verdict.testReview === 'string' ? verdict.testReview.trim() : '';
    if (review.length < 12) {
      return 'test files changed; verifier did not certify a test review';
    }
  }
  if (verdict.head !== gitHead(root) && !worktreeClean(root)) {
    return 'HEAD moved since verification and the working tree is not clean; commit every verified change or re-verify';
  }
  return null;
}

export async function cmdGate(options) {
  const root = repoRoot();
  const task = readTask(root);
  assertContractLocked(root, task);
  const tree = treeHash(root, task.baseHead);
  const contract = contractHash(task);
  const verdict = readJson(proofPath(root, VERDICT_FILE));
  const testFiles = changedTestFiles(root, task.baseHead);
  const problem = verdictProblem(verdict, tree, contract, testFiles, root);

  if (problem) {
    writeJson(proofPath(root, GATE_FILE), {
      schema: 1,
      at: new Date().toISOString(),
      version: VERSION,
      ok: false,
      reason: problem,
      tree,
      contract,
      verdict,
      checks: [],
      scope: null,
      testFiles,
    });

    if (options.json) {
      console.log(
        JSON.stringify({ ok: false, reason: problem, tree, contract, verdict, testFiles }, null, 2),
      );
      return 1;
    }

    console.log('hardproof gate');
    console.log(`kind     ${task.kind}`);
    console.log(`goal     ${task.goal}`);
    if (task.cause) console.log(`cause    ${task.cause}`);
    console.log(`tree     ${tree.slice(0, 12)}`);
    console.log(`contract ${contract.slice(0, 12)}`);
    if (verdict?.verdict === 'fail') {
      console.log(
        `verdict  fail  ${verdict.verifier ?? 'verifier'}  ${shorten(verdict.summary, 90)}`,
      );
      for (const finding of verdict.findings ?? []) console.log(`         ${finding}`);
    } else {
      console.log(`verdict  ${problem}`);
    }
    console.log('gate     FAIL');
    console.log(`evidence ${PROOF_DIR}/${GATE_FILE}`);
    return 1;
  }

  const checks = await runChecks(root, task);
  const scope = scopeReport(root, task, Boolean(options.allowScopeBreach));
  const treeAfter = treeHash(root, task.baseHead);
  const treeStable = treeAfter === tree;
  const ok = checks.ok && scope.ok && treeStable;
  const reason = ok
    ? null
    : !checks.ok
      ? 'a check failed'
      : !scope.ok
        ? 'scope breach'
        : 'the tree changed while the gate ran';

  writeJson(proofPath(root, GATE_FILE), {
    schema: 1,
    at: new Date().toISOString(),
    version: VERSION,
    ok,
    reason,
    tree,
    contract,
    verdict,
    checks: checks.results,
    scope,
    testFiles,
  });

  if (options.json) {
    console.log(
      JSON.stringify(
        { ok, reason, tree, contract, verdict, checks: checks.results, scope, testFiles },
        null,
        2,
      ),
    );
    return ok ? 0 : 1;
  }

  console.log('hardproof gate');
  console.log(`kind     ${task.kind}`);
  console.log(`goal     ${task.goal}`);
  if (task.cause) console.log(`cause    ${task.cause}`);
  console.log(`tree     ${tree.slice(0, 12)}`);
  console.log(`contract ${contract.slice(0, 12)}`);
  console.log(`verdict  pass  ${verdict.verifier ?? 'verifier'}  ${shorten(verdict.summary, 90)}`);
  printCheckResults(checks.results);
  printScope(scope);
  printTests(testFiles, verdict.testReview);
  if (!treeStable) {
    console.log('tree     CHANGED during the gate; checks must not modify the tree');
  }
  console.log(`gate     ${ok ? 'PASS' : 'FAIL'}`);
  if (!ok) console.log(`reason   ${reason}`);
  console.log(`evidence ${PROOF_DIR}/${GATE_FILE}`);
  return ok ? 0 : 1;
}

export function cmdBrief() {
  const root = repoRoot();
  const task = readTask(root);
  assertContractLocked(root, task);
  const scope = scopeReport(root, task, false);
  const testFiles = changedTestFiles(root, task.baseHead);
  const failing = task.checks.filter((check) => !check.baseline?.ok).length;

  console.log('# Hardproof verification brief');
  console.log('');
  console.log('You are verifying someone else\'s change. Do not edit code or tests.');
  console.log('');
  console.log(`Goal: ${task.goal}`);
  console.log(`Kind: ${task.kind}`);
  if (task.request) {
    console.log('');
    console.log('Original request:');
    for (const line of task.request.split('\n')) console.log(`> ${line}`);
  }
  if (task.cause) console.log(`Cause: ${task.cause}`);
  console.log(`Baseline: ${failing}/${task.checks.length} failing`);
  if (task.dirtyStart) {
    console.log('Start state: dirty; changes that predate init are part of the diff.');
  }
  console.log('');
  console.log('## Acceptance checks (run from the repository root)');

  for (const check of task.checks) {
    const baseline = check.baseline ?? {};
    console.log(
      `- ${baseline.ok ? 'PASS' : 'FAIL'} \`${check.command}\` (exit ${baseline.exitCode ?? '?'})`,
    );
    if (!baseline.ok && baseline.output) {
      const lines = baseline.output.split('\n');
      const sample =
        lines.length <= 16 ? lines : [...lines.slice(0, 8), '...', ...lines.slice(-8)];
      console.log('  ```');
      for (const line of sample) console.log(`  ${line}`);
      console.log('  ```');
    }
  }

  console.log('');
  console.log(`## Scope\n${task.scope.length > 0 ? task.scope.map((item) => `- ${item}`).join('\n') : '- (all changes allowed)'}`);
  console.log('');
  console.log('## Changed files');
  if (scope.changed.length === 0) console.log('- none');
  for (const path of scope.changed) {
    console.log(`- ${path}${scope.outOfScope.includes(path) ? ' (outside scope)' : ''}`);
  }
  console.log('');
  console.log('## Test files changed');
  if (testFiles.length === 0) console.log('- none');
  for (const path of testFiles) console.log(`- ${path}`);

  console.log('');
  console.log('## Diff');
  console.log(`- Baseline: \`${task.baseHead}\``);
  console.log(`- Run \`git diff ${task.baseHead}\` plus \`git status --porcelain\` for every change since init.`);

  console.log('');
  console.log('## Required evidence');
  console.log('- Run `hardproof check`.');
  console.log('- Read the full diff and attack it: edge cases, callers, regressions, weakened tests.');
  console.log('- Record the decision with `hardproof verdict pass|fail`.');
  if (testFiles.length > 0) {
    console.log('- Tests changed: a pass verdict needs `--test-review "<what you checked>"`.');
  }
  console.log('- Verify against the code and commands, not this brief.');
  return 0;
}

export function cmdDoctor(options) {
  const problems = [];
  console.log(`hardproof ${VERSION}  node ${process.version}`);

  let root = null;
  try {
    root = repoRoot();
    console.log(`repo     ${root}`);
  } catch (error) {
    console.log(`repo     none — ${error.message}`);
    problems.push('not in a git repository');
  }

  if (root) {
    const task = readJson(proofPath(root, TASK_FILE));
    const taskValid =
      task &&
      KINDS.includes(task.kind) &&
      typeof task.baseHead === 'string' &&
      Array.isArray(task.checks) &&
      Array.isArray(task.scope);
    if (taskValid) {
      const failing = task.checks.filter((check) => !check.baseline?.ok).length;
      console.log(
        `task     ${PROOF_DIR}/${TASK_FILE} — ${task.kind}, ${task.checks.length} check(s), ${failing} failing at baseline`,
      );
    } else {
      console.log(`task     missing or invalid — run hardproof init`);
      problems.push('no valid contract');
    }

    if (taskValid) {
      const lock = readJson(proofPath(root, CONTRACT_FILE));
      const locked =
        lock?.contract ===
        contractHash({
          goal: task.goal ?? '',
          kind: task.kind,
          request: task.request,
          cause: task.cause,
          baseHead: task.baseHead,
          dirtyStart: task.dirtyStart,
          checks: task.checks,
          scope: task.scope,
        });
      console.log(`contract ${locked ? 'locked' : 'CHANGED since init'}`);
      if (!locked) problems.push('contract changed since init');
    }

    const verdict = readJson(proofPath(root, VERDICT_FILE));
    if (verdict) {
      const tree = treeHash(root, task.baseHead);
      const problem = taskValid
        ? verdictProblem(
            verdict,
            tree,
            contractHash({
              goal: task.goal ?? '',
              kind: task.kind,
              request: task.request,
              cause: task.cause,
              baseHead: task.baseHead,
              dirtyStart: task.dirtyStart,
              checks: task.checks,
              scope: task.scope,
            }),
            changedTestFiles(root, task.baseHead),
            root,
          )
        : 'contract is invalid';

      console.log(
        `verdict  ${verdict.verdict ?? 'unknown'}  tree ${String(verdict.tree ?? '').slice(0, 8)}  ${problem ?? 'fresh'}`,
      );
      if (problem) problems.push(problem);
    } else {
      console.log('verdict  missing');
      problems.push('no verdict');
    }
  }

  const installs = detectInstalls();
  if (installs.length === 0) {
    console.log('install  none — run hardproof install <claude|opencode|codex|generic>');
    problems.push('no provider install');
  } else {
    for (const item of installs) {
      const status = checkInstall(item);
      console.log(
        `install  ${item.provider}  ${item.scope}  ${item.path}  ${status.ok ? 'ok' : `DRIFT: ${status.reason}`}`,
      );
      if (!status.ok) problems.push(`install drift: ${item.provider} ${status.reason}`);
    }
  }

  if (options.strict && problems.length > 0) {
    console.log(`doctor   FAIL — ${problems.join('; ')}`);
    return 1;
  }
  console.log('doctor   OK');
  return 0;
}
