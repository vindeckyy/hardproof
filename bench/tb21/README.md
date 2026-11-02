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

Pass `--api-key-name OPENCODE_API_KEY` to Harbor; otherwise the built-in OpenCode Go provider receives no credential.

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

## Apple Silicon note

Most Terminal-Bench task images are `linux/amd64`. OpenCode's Bun binary crashes under QEMU without AVX. Build an arm64 variant of the task image and point a local task copy at it:

```sh
docker build --platform linux/arm64 -t hp/task:arm64 <task>/environment
# set docker_image = "hp/task:arm64" in the local task.toml
harbor run -p <task-dir> ...
```

This is a local pilot workaround, not a leaderboard-comparable configuration.

## Pilot

Start with 5-10 tasks across software engineering, data, and security. Compare:

- bare OpenCode, same model, same harness
- hardproof ensemble mode
- per-task pass, timeout rate, token use, wall time

A single 89-task run has roughly ±3 points of noise. A 15-point claim needs 5 trials and per-task evidence.

## Pilot result: 2026-11-02

Task: `cancel-async-tasks`, local arm64 task image, DeepSeek V4.1 Flash, one trial.

| Condition | Reward | Wall time | Tokens |
|---|---:|---:|---:|
| OpenCode baseline | 1.0 | 2m21s | 80.5k |
| hardproof ensemble | 0.0 | ~10m | 231.7k |

The ensemble failed `test_tasks_cancel_above_max_concurrent`: it printed two started tasks but zero cleanup lines. Both candidates passed the generated self-checks; those checks covered cancellation at/below the limit but not the queued-task case. The baseline model's own solution passed the hidden suite.

This is a negative result for the first ensemble version. It identifies the missing piece: an independent test writer and verifier that targets queued cancellation, partial failure, and cleanup ordering. Do not claim benchmark gains from this pilot.
