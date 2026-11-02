# Terminal-Bench 2.1 harness notes

This directory holds the prompt and commands used to run hardproof ensemble mode against Terminal-Bench 2.1 through Harbor. No benchmark results are claimed until a run is recorded.

## Setup

```sh
uv tool install harbor
colima start --cpu 4 --memory 8 --disk 40
harbor download terminal-bench/terminal-bench-2-1 --cache
```

Create an env file with the model credential and base URL. Do not commit it.

```sh
OPENCODE_API_KEY=<key>
OPENAI_API_KEY=<key>
```

Prepare the skill bundle Harbor injects:

```sh
mkdir -p /tmp/hp-skills
cp -R skill /tmp/hp-skills/hardproof
```

## Run

```sh
harbor run \
  -d terminal-bench/terminal-bench-2-1 \
  -a opencode \
  -m opencode-go/deepseek-v4.1-flash \
  -i terminal-bench/fix-git \
  -k 1 -n 1 \
  --skills /tmp/hp-skills \
  --ak "prompt_template_path=$PWD/bench/tb21/prompt.md" \
  --env-file /tmp/hp-harbor.env \
  --job-name hp-ensemble \
  --jobs-dir /tmp/hp-jobs
```

For a full run, drop `-i` and use `-k 5` as required by Terminal-Bench. Standard timeouts only; do not inflate them.

## Pilot

Start with 5-10 tasks across software engineering, data, and security. Compare:

- bare OpenCode, same model, same harness
- hardproof ensemble mode
- per-task pass, timeout rate, token use, wall time

A single 89-task run has roughly ±3 points of noise. A 15-point claim needs 5 trials and per-task evidence.
