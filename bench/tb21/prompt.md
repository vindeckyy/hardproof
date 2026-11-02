{{ instruction }}

You are in hardproof ensemble mode for an automatically scored task. Before editing, read `~/.config/opencode/skills/hardproof/ENSEMBLE.md` and follow it.

Requirements:
- Derive one to three executable acceptance checks from the task.
- Run the ensemble runner with two candidates, a 420-second candidate timeout, and `--model opencode-go/deepseek-v4.1-flash`.
- Do not inspect hidden tests, grader paths, benchmark answers, or task metadata outside the workspace.
- After the runner returns, inspect the applied diff, run the acceptance checks, and stop.
- Report what passed, what failed, and what remains unverified.