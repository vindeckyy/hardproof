# Hardproof

Hardproof is a coding-agent skill that refuses to call work done until it is proven.

The agent freezes a goal and acceptance checks before touching code, implements the smallest change, then hands the result to a fresh verifier that is read-only where the host allows. A small gate re-runs the checks and rejects a verdict that was recorded before the latest edit.

No benchmark claims. One contract, one verifier, one gate, and an honest report when the proof fails.

## Why

Coding agents are optimistic. They say "fixed, tests pass" after running one happy-path command, reviewing their own diff, and forgetting the edge case the user actually asked about. More instructions do not fix that: a self-review is not a review, and a remembered green test is not evidence.

Hardproof changes the completion condition:

| Prompt-only workflow | Hardproof |
| --- | --- |
| Acceptance checks are remembered | The gate re-runs them on the current tree |
| The author reviews the change | A fresh context verifies it, read-only where the host allows |
| "All tests pass" in prose | Exit codes and a machine-checked verdict |
| A verdict can drift after a fix | The verdict is bound to a tree hash and a contract hash |
| Scope creep is unnoticed | Changes outside the declared scope fail the gate |

The gate is not a sandbox and not a cryptographic signature. It removes the easy lies: stale evidence, a missing check, an edited contract, an out-of-scope change. The rest is the verifier's job.

## What improves agent performance

| Failure mode | Mechanism |
| --- | --- |
| Fixes the symptom, not the cause | `--kind bug` requires a red baseline and a stated `--cause` |
| "Fixed" without a reproduction | `init` refuses bug work when every check already passes |
| Regression test that passes on the old code | Baseline is recorded red; the verifier is told to re-run the test against `baseHead` |
| Weakens or deletes a test to get green | Any test change requires a verifier `--test-review`, and the gate rejects a pass without it |
| Author reviews their own work | Fresh-context verifier, read-only where the host allows |
| Evidence goes stale after another edit | Verdict is bound to a tree hash and a contract hash |
| Hides work in a commit | All evidence is measured from the baseline commit, not `HEAD` |
| Scope creep | Changes outside the declared scope fail the gate |
| Endless retry | Two repair rounds, plus a no-progress stop rule |
| Refactor changes behavior | `--kind refactor` requires a clean baseline and the verifier checks equivalence |

## Install

Requires Node.js 20+ and git.

```sh
git clone https://github.com/vindeckyy/hardproof
cd hardproof
npm install -g .
```

Install the skill into your agent:

```sh
hardproof install claude      # Claude Code: ~/.claude
hardproof install opencode    # OpenCode: ~/.config/opencode
hardproof install codex       # Codex: ~/.agents
hardproof install generic --dir <config-root>
```

`--dir` points at an agent config root; Hardproof writes `<dir>/skills/` there.

Add `--project` to install into the current repository instead of your home directory. Run `hardproof help` for every command and flag.

Restart the agent if it does not pick up new skills automatically.

## Use

Ask the agent:

```text
/hardproof fix the registration race and prove it
```

or run the loop yourself:

```sh
# 1. Write the failing regression test. Freeze the contract. This runs the baseline.
hardproof init \
  --kind bug \
  --request "fix the duplicate-email registration race and prove it" \
  --cause "retry checks the email before the insert commits the duplicate" \
  --goal "registration retry handles a duplicate email" \
  --check "npm test -- registration" \
  --check "npm run typecheck" \
  --scope "src/registration/**" \
  --scope "test/registration/**"

# 2. Implement, then run the checks as often as you like.
hardproof check

# 3. Print the factual brief for the verifier.
hardproof brief

# 4. A fresh verifier reads the diff, probes it, and records a decision.
#    If tests changed, it must certify what it checked.
hardproof verdict pass \
  --summary "ran the suite; probed duplicate and empty email; regression fails on baseHead" \
  --test-review "read the new regression test; no assertions removed; fails on the old code" \
  --verifier claude-reviewer

# 5. The final proof. Re-runs the checks and checks verdict freshness.
hardproof gate
```

`hardproof gate` exits `0` only when all checks pass, the scope is clean, and the verifier's verdict matches the current tree and contract. Commit or stash production changes before init; test changes and untracked files may be present, and become part of the run. Pass `--allow-dirty` when uncommitted production work is intentional.

## What the agent is told

The installed skill (`skill/SKILL.md`) runs this loop:

1. Classify the work as `bug`, `feature`, or `refactor`; define the goal, cause, checks, non-goals, and scope before code.
2. Recon read-only; find the repo's real test command. For a bug, write the regression test and watch it fail.
3. Run `hardproof init`; bug work is refused with a green baseline, refactor work with a red one.
4. Implement the smallest change that satisfies the contract and the stated cause.
5. Run `hardproof brief` and launch `hardproof-verifier` in a fresh context with the brief.
6. Repair findings, at most two rounds; stop when the same failure repeats with no new evidence.
7. Report the gate output, or say the work is unverified.

The verifier is instructed to attack the diff: edge cases, callers, regressions, tests that would pass on the old code, and weakened assertions. It runs at least one probe the implementer did not run. It is read-only: Claude Code gets `Read, Grep, Glob, Bash`; OpenCode denies `edit`.

## Commands

| Command | Purpose |
| --- | --- |
| `hardproof init --goal ... --check ...` | Record the contract and run the baseline |
| `hardproof check` | Re-run checks, scope, and the changed-test report |
| `hardproof brief` | Print the factual brief for the verifier |
| `hardproof verdict pass\|fail` | Record a verifier decision |
| `hardproof gate` | Final proof: fresh verdict, checks, scope |
| `hardproof doctor` | Show install and run state |
| `hardproof install <provider>` | Install the skill and verifier |
| `hardproof uninstall <provider>` | Remove them |

Options: `--kind` (`bug`, `feature`, `refactor`), `--request` for the user's verbatim words, `--cause` for bug work, `--allow-dirty` when production work is intentionally uncommitted, `--timeout <seconds>` per check at init, `--test-review` on a pass verdict when tests changed, `--allow-scope-breach` for a deliberate exception, `--json` for machine-readable output, `--force` to replace an unmanaged install or restart a locked contract.

## Providers

| Provider | Key | Global path | Project path |
| --- | --- | --- | --- |
| Claude Code | `claude` | `~/.claude` | `.claude` |
| OpenCode | `opencode` | `~/.config/opencode` | `.opencode` |
| Codex | `codex` | `~/.agents` | `.agents` |
| Generic Agent Skills | `generic` | — | `.agents` or `--dir` |

The verification path varies by host: Claude Code and OpenCode get a native subagent. Codex gets a `hardproof-verifier` skill to invoke in a fresh process. Any host that can read a `SKILL.md` can use the generic install.

## How the proof works

- `.proof/task.json` stores the kind, goal, cause, baseline commit, checks, timeout, scope, and baseline result with output. Checks run at the repository root, even when you invoke the CLI from a subdirectory.
- `.proof/verdict.json` stores the verdict, findings, test review, verifier name, contract hash, and a hash of the working tree.
- `.proof/gate.json` is the final evidence artifact.
- `init` also locks the contract. Editing `.proof/task.json` afterwards is refused by the CLI, so accidental check drift fails closed.

The tree hash covers the baseline commit, `HEAD`, and every changed, staged, deleted, and untracked file since the baseline, excluding `.proof/`. Commits made during a run are still measured. If the code changes after the verifier signs off, the old verdict no longer matches and the gate fails. If the contract changes, the verdict is stale too. If a check mutates tracked files while the gate runs, the gate fails rather than certifying a moving target.

`.proof/` is added to `.git/info/exclude` by `init`, so evidence stays local and does not pollute commits.

## Limits

- **Independence is a workflow rule, not a security boundary.** A determined agent could forge a verdict file or rewrite the contract lock in `.proof/`. The gate catches drift, missing evidence, and accidental edits, not a malicious local process.
- **The checks are only as good as the contract.** A trivial check passes trivially. A red baseline proves a check can fail, not that it fails for the right reason; the stated cause and the verifier close that gap. The verifier cannot invent a domain oracle.
- **The test review is a certification, not an automatic proof.** It forces the tester to look at every test change; it does not parse assertions for you.
- **Checks must not mutate tracked files.** Snapshot updates should be committed before the final gate.
- **The checks run shell commands from `.proof/task.json`.** Review that file like any script an agent wrote.
- **Git is required.** Scope and freshness depend on working-tree state. Untracked files and test edits present at init are counted as part of the run; remove or scope unrelated ones first.
- **Check quality is still on you.** `init` warns about commands that always pass (`true`, `|| true`, `--passWithNoTests`), but it cannot tell whether a real command tests the right behavior.
- **No benchmark numbers.** Measuring agent reliability is a real experiment. This repository does not pretend to have run it.

## Measuring it

No benchmark number is bundled. To measure the effect on your own work, replay ten bugs you already fixed, with hidden tests the agent cannot edit, and compare pass@1 with and without the hardproof loop. Keep the hidden tests outside the working tree and run them after the agent stops. That measures the workflow; the gate's own PASS is not a model benchmark.

## Development

```sh
npm test
```

Zero runtime dependencies. Tests create throwaway git repositories and exercise the CLI end to end.

MIT license.
