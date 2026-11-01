---
name: hardproof
description: Prove coding work before calling it done. Use when the user asks to implement, fix, refactor, migrate, or verify a change and wants evidence, or when the user invokes hardproof. Freezes acceptance checks, runs a read-only independent verifier, and blocks "done" until a gate re-runs the checks on the exact tree.
---

# Hardproof

Hardproof turns "I think it works" into evidence. It freezes a contract, implements against it, then makes a fresh verifier and a gate check the exact result.

## The one rule

Never say done, fixed, passing, or working unless `hardproof gate` passes on the current tree. A green run you remember is not evidence. A subagent summary is not evidence.

Skip hardproof for questions, explanations, and reading only. For a one-line fix, use one check and the same gate: the ceremony scales down, the proof does not.

## 1. Define done before code

Classify the work first:

- `bug`: behavior is wrong. A regression check must fail before the fix.
- `feature`: behavior is missing. Checks must prove the new behavior and its edges.
- `refactor`: behavior must not change. Checks must be green before and after.

Classify honestly. A bug fix is not a feature; calling it one only skips the reproduction the user needs.

Then write down, in one or two sentences each:

- Goal: the result the user asked for.
- Acceptance checks: commands that fail while the result is missing and pass when it exists. Prefer behavior over implementation. Reuse the repository's test, typecheck, and lint commands. If none exist, use a narrow executable check or say the result will be unverified.
- Non-goals: what you will not touch.
- Scope: files or directories you expect to change, including tests.
- Cause: for a bug, the concrete mechanism you believe produces the wrong behavior.

Derive missing checks from the user's words. Ask only when the goal or the meaning of success is genuinely ambiguous. Do not ask permission for routine implementation choices.

## 2. Recon, read-only

Find the code path, its tests, and the local conventions. Confirm the cause with evidence: a failing command, a stack trace, or a line of code. For a bug, write the regression test now and run it to see the failure. Do not edit production code before the contract exists.

## 3. Record the contract

    hardproof init --kind bug --cause "<root cause>" \
      --request "<the user's request, verbatim>" \
      --goal "<one sentence>" \
      --check "<test command>" --check "<typecheck or lint command>" \
      --scope "<path>" --scope "<path>"

Start from a clean production tree: commit or stash existing production changes before init. Test changes, such as the failing regression test, and untracked files are allowed; they become part of the run and need review. For inline tests in a production file (Rust, for example) or intentional work in progress, pass `--allow-dirty` and keep those files in scope.

Use one to three checks, run at the repository root. Each must be able to fail.

- `--kind bug` is refused when every check already passes. That is the point: no reproduction, no fix.
- `--kind refactor` is refused when a check already fails. Fix that first, or classify it as a bug.
- If the baseline is green for a feature, say why the check still proves the change.

The init output is the baseline. A red baseline is good: it proves the checks can see the problem.

## 4. Implement the smallest complete change

- For a bug, fix the stated cause. If the evidence disproves it, stop and re-init with the real cause.
- Make the contract pass. Do not refactor beyond it.
- Run `hardproof check` as you go.
- Stay in scope. If the correct fix needs an out-of-scope change, stop and report why; do not widen scope silently.
- Do not weaken, skip, or delete a failing test. Do not hard-code the expected output.
- Do not commit unless asked.

## 5. Verify in a fresh context

When `hardproof check` passes, run `hardproof brief`. Give that brief to the independent verifier, verbatim, with no extra reasoning.

- Claude Code: use the `hardproof-verifier` subagent.
- OpenCode: use the `hardproof-verifier` subagent.
- Codex: start a fresh `codex exec` and invoke `$hardproof-verifier`.
- Other hosts: give `references/verifier.md` plus the brief to a fresh agent process.
- No way to start a fresh context: stop and ask the user to verify. Never verify your own work in this context.

Use the strongest available model and the highest reasoning effort the host exposes, ideally not the model that wrote the change. The verifier runs `hardproof check`, reads the diff adversarially, and records `hardproof verdict pass` or `hardproof verdict fail` with findings. When tests changed, the verifier must pass `--test-review`; the gate rejects a pass without it.

## 6. Repair or stop

If the verdict fails, fix only the findings, run `hardproof check`, and launch a new verifier. Two repair rounds maximum.

Stop before the limit when the same failure fingerprint repeats: same check, same error, no new evidence. Change the hypothesis once; if the second attempt also makes no progress, report the blocker instead of looping.

If it still fails, report the findings and the gate output. Do not force a pass, weaken a check, or widen scope.

## 7. Report

Run `hardproof gate`. Then report, in this order:

    Done: <goal>
    Kind: <bug|feature|refactor>
    Checks: <n/n pass> — <commands>
    Scope: <changed files> (within contract)
    Verifier: <pass|fail> — <summary>
    Gate: PASS | FAIL
    Unverified: <anything you could not check>

Quote the gate result. If the gate fails, say the work is unverified and why.

## Larger work

If the request contains independent workstreams, split it into one contract per workstream. Run each loop separately, with one writer per workstream, then add an integration contract whose checks exercise the combined behavior. Never let two writers own the same files, and do not start a new contract until the previous one has a verdict or is abandoned.

## Hard rules

- Never edit the checks in `.proof/task.json` after implementation starts. The contract is locked; changing it requires `hardproof init --force`, which resets the proof.
- Never claim success from a passing check alone; the verdict and the gate are both required.
- Never hide a failing check, a skipped test, or an out-of-scope edit.
- Never write the verifier's `--test-review`. If you touched tests, the verifier explains what it checked and why the tests still prove the behavior.
- If the tool cannot run (no git, missing runtime), say the result is unverified. Do not fake evidence.

## Commands

    hardproof init ...      record goal, kind, cause, checks, scope; run the baseline
    hardproof check         re-run the checks, scope check, and test-file report
    hardproof brief         print the factual brief for the verifier
    hardproof verdict ...   record a verifier decision (verifier only)
    hardproof gate          final proof: fresh verdict, checks, scope, test review
    hardproof doctor        show install and run state

State lives in `.proof/` and is excluded from git. The gate measures every change since the baseline commit, including commits made during the run, and compares the verifier's tree hash with the current tree, so any later edit invalidates the verdict.
