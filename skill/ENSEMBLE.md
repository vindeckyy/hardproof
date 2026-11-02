# Hardproof ensemble mode

Use this mode when the task is scored automatically and the user asks for maximum score, or when `HARDPROOF_ENSEMBLE=1`.

Do not solve the task yourself first. Run the ensemble runner, then inspect its result:

```sh
node ~/.config/opencode/skills/hardproof/scripts/ensemble.mjs \
  --goal "<one-sentence goal>" \
  --request "<the task instruction, verbatim>" \
  --check "<acceptance command>" \
  --candidates 2 \
  --timeout 420
```

The runner reads `HARDPROOF_MODEL` when `--model` is absent, and detects the host's OpenCode permission flag (`--auto` or `--dangerously-skip-permissions`).

Rules:

1. Derive 1-3 acceptance commands from the task. They must be executable and able to fail.
2. Run the script from the task workspace. It initializes git if needed, creates worktrees, runs independent candidates with different strategies, runs the checks, applies the best candidate, and runs the checks again.
3. If the shell tool times out before the runner finishes, start it in the background and wait for `.hardproof/ensemble/result.json`. Do not start a second run. If it fails, inspect `.hardproof/ensemble/logs/` and `.hardproof/ensemble/selected.patch`.
4. After the script returns, inspect the applied diff. Do not assume the selected candidate is correct.
5. Run one independent verifier pass if the host supports it. Then report checks and remaining risk honestly.

The script calls `opencode run --auto`. Pass `--model <provider/model>` when the default model is not the benchmark model. Do not use hidden grader files or benchmark answers.
