# Pairing Bots

A two-model coding agent built on top of [pi-mono](https://github.com/badlogic/pi-mono) primitives (`@mariozechner/pi-ai`, `@mariozechner/pi-agent-core`, `@mariozechner/pi-coding-agent`).

It is designed around structured pair programming:
- one model drives implementation,
- the other navigates (reviews, critiques, suggests),
- both collaborate on a shared plan,
- both perform final quality review before sign-off.

## Why this exists

Single-agent coding can move fast, but it can also miss mistakes when reasoning and implementation happen in one loop. This tool adds a second model as an active reviewer, with explicit handoff and critique mechanics, so quality checks are built into execution instead of bolted on after.

## Default setup

- Model A: `anthropic/claude-opus-4-6` (`high`)
- Model B: `openai/gpt-5.2-codex` (`high`)
- Turn policy: `same_driver_until_navigator_signoff`
- Execution mode: `paired_turns`
- Safety cap: force swap after `3` consecutive rounds or `4` consecutive checkpoints
- Pause policy: checkpoint every `3` successful `edit`/`write` tool calls

## Features

- Shared + private memory model:
  - shared journal entries are visible to both models
  - private reflections are visible only to the model that created them
- Read-only planning handshake:
  - A drafts plan
  - B critiques
  - A revises to agreed plan
- Strict driver/navigator execution roles:
  - driver has coding tools
  - navigator has read-only tools
- Configurable turn policy and checkpointing
- Configurable execution strategy:
  - `paired_turns`: alternating/guardrailed driver-navigator rounds
  - `solo_driver_then_reviewer`: A plans, A implements, B reviews final output, A optionally integrates feedback
- Driver accountability flow:
  - navigator can provide actionable feedback or `NONE`
  - driver must `accept` / `partial` / `reject` feedback with justification
- End-of-run reporting:
  - checkpoints
  - swaps
  - rough A/B code contribution percentage
- Structured observability:
  - append-only event stream log (`.jsonl`) during execution for live tailing
  - compact stream mode by default (suppresses token-level `message_update` noise)
  - full session JSON log written at run end for post-run analysis
  - prompt/agent/tool/swap timeline with summarized tool payload metadata

## Requirements

- Node.js `>=20`
- API credentials for providers you use

## Install

```bash
npm install
```

## Credentials (`.env`)

The CLI auto-loads `.env`.

Example:

```bash
ANTHROPIC_API_KEY=...
OPENAI_API_KEY=...
```

You can also start from `.env.example`.

### 1Password CLI (`op`) support

You can avoid storing raw keys in project `.env` by using 1Password references:

```bash
ANTHROPIC_API_KEY=op://Vault/Anthropic/credential
OPENAI_API_KEY=op://Vault/OpenAI/credential
```

or provider-specific reference vars:

```bash
PAIRING_BOTS_ANTHROPIC_OP_REF=op://Vault/Anthropic/credential
PAIRING_BOTS_OPENAI_OP_REF=op://Vault/OpenAI/credential
```

Requirements:
- `op` CLI installed and on `PATH`
- active `op signin` session

If these are missing, startup fails with a clear credential-resolution error.

## Quick start

```bash
npm run start -- --task "Implement feature X with tests"
```

## What a session does (start to finish)

1. Load config + credentials.
2. Create model workers A and B.
3. Plan phase:
   - `paired_turns`: A draft -> B critique -> A revise
   - `solo_driver_then_reviewer`: A produces final plan directly
4. Implementation:
   - one model is driver, one is navigator
   - driver implements a chunk
   - automatic checkpoint pauses trigger after configured edit/write cadence
   - navigator reviews and provides feedback + handoff recommendation
   - driver addresses feedback and justifies decision
5. Repeat rounds until:
   - driver says `done` and navigator has no feedback, or
   - max rounds reached.
6. Finalization:
   - `paired_turns`: run final review with both models and synthesize joint verdict
   - `solo_driver_then_reviewer`: stop after B review and optional A integration (verdict synthesized from that cycle)

## Domain concepts

- Driver: model currently allowed to modify code.
- Navigator: model reviewing for bugs, regressions, weak assumptions, and refactor opportunities.
- Checkpoint: automatic pause after N successful `edit`/`write` calls.
- Shared context: journal entries both models receive.
- Private memory: model-local reflections not shared with the other model.
- Turn policy: strategy for deciding when to swap driver.
- Safety cap: forced swap guardrail to avoid one model driving too long.

## Turn policies

### `same_driver_until_navigator_signoff` (default)

Driver remains the same unless:
- navigator recommends `handoff`, or
- safety cap is exceeded (`max-consecutive-rounds` or `max-consecutive-checkpoints`).

### `alternate_each_round`

Driver swaps every round.

## Checkpoint policy

### `every_n_file_edits` (default)

- counts successful `edit` and `write` tool calls
- triggers checkpoint pause every `N` calls
- applies to all driver edits in a round, including post-feedback fixups

### `none`

No automatic checkpoint pauses.

## CLI reference

Required:
- `--task "<task description>"`

Optional:
- `--cwd <path>`
- `--max-rounds <n>`
- `--driver-start A|B`
- `--execution-mode paired_turns|solo_driver_then_reviewer`
- `--turn-policy alternate_each_round|same_driver_until_navigator_signoff`
- `--max-consecutive-rounds <n>`
- `--max-consecutive-checkpoints <n>`
- `--pause-mode none|every_n_file_edits`
- `--edits-per-pause <n>`
- `--model-a-provider <provider>`
- `--model-a-id <model-id>`
- `--model-a-thinking off|minimal|low|medium|high|xhigh`
- `--model-b-provider <provider>`
- `--model-b-id <model-id>`
- `--model-b-thinking off|minimal|low|medium|high|xhigh`
- `--output <json-path>`
- `--log-file <json-path>`
- `--event-log-file <jsonl-path>`
- `--event-stream-mode compact|full`
- `--workspace-mode direct|ephemeral_copy`
- `--keep-workspace`
- `--compare-strategies`
- `--help`

## Example: fully configured run

```bash
npm run start -- \
  --task "Refactor parser module and add regression tests" \
  --cwd /absolute/path/to/repo \
  --max-rounds 8 \
  --driver-start A \
  --execution-mode paired_turns \
  --turn-policy same_driver_until_navigator_signoff \
  --max-consecutive-rounds 3 \
  --max-consecutive-checkpoints 4 \
  --pause-mode every_n_file_edits \
  --edits-per-pause 3 \
  --model-a-provider anthropic \
  --model-a-id claude-opus-4-6 \
  --model-a-thinking high \
  --model-b-provider openai \
  --model-b-id gpt-5.2-codex \
  --model-b-thinking high \
  --log-file /tmp/pair-log.json \
  --event-log-file /tmp/pair-events.jsonl \
  --event-stream-mode compact \
  --output /tmp/pair-run.json
```

## Strategy Comparison Mode

Use `--compare-strategies` to run both approaches on isolated workspaces from the same baseline:
- `paired_turns`
- `solo_driver_then_reviewer`

When `--output` is set, the CLI writes:
- comparison report at the exact `--output` path
- per-strategy run artifacts with suffixed names (for example `run.paired_turns.json` and `run.solo_driver_then_reviewer.json`)

## Summary metrics explained

At the end of each run, the CLI prints:

- Total checkpoints: how many auto-pauses occurred.
- Total driver swaps: how many times the active driver changed.
- Rough code share % (A/B): estimated from bytes in successful `edit.newText` and `write.content`.

Important: this is an approximation. It is useful for directional contribution analysis, not exact authorship.

## Observability log format

Each run emits:
- an append-only event stream JSONL file (default sidecar of `--log-file`, e.g. `session.events.jsonl`) for live tailing
- a structured JSON summary log (default under `<cwd>/.pairing-bots/logs/` unless `--log-file` is set)

Event stream modes:
- `compact` (default): excludes high-frequency token update events for easier tailing
- `full`: includes every event, including token updates

The JSON summary contains:
- `meta`: start/end timestamps, duration, status
- `summary`: event counts, prompt counts, tool execution counts/errors
- `events`: ordered timeline of session/prompt/agent/orchestrator events

Tool args/results are summarized (length/hash/path metadata) to avoid dumping full file contents while retaining enough detail for debugging.

## Workspace isolation mode

Use `--workspace-mode ephemeral_copy` to run the pair in a disposable copy of the target repo. This shortens repeat-test loops and avoids cross-run contamination.

- default: `direct` (run in place)
- `ephemeral_copy`: copies workspace to a temp directory, excludes `.git` and `.pairing-bots`, and links `node_modules` when available
- add `--keep-workspace` to preserve the temp directory for post-mortem inspection

## Output artifact (`--output`)

When `--output` is provided, the run result is saved as JSON and includes:
- task + agreed plan
- per-round reports
- final review verdict
- summary metrics
- shared journal entries

## Project structure

- `src/cli.ts`: CLI entrypoint and console output
- `src/config.ts`: defaults + argument parsing
- `src/model-worker.ts`: per-model runtime wrapper
- `src/pair-orchestrator.ts`: main session orchestration
- `src/prompts.ts`: prompt contracts and protocol text
- `src/parsing.ts`: structured tag parsing
- `src/types.ts`: core domain types

## Development

```bash
npm run typecheck
npm test
npm run build
```

## Troubleshooting

### "Missing credentials for provider ..."

Set required API keys in `.env` (or env vars in shell) and rerun.

### Model not found errors

Check provider/model id spelling and ensure the selected provider exposes that model in your configured `pi-ai` version.

### Run feels too chatty or too interrupt-driven

Tune:
- `--edits-per-pause` (higher = fewer checkpoints)
- `--turn-policy`
- safety caps (`--max-consecutive-rounds`, `--max-consecutive-checkpoints`)

## Known limitations

- Rough code share is estimated from tool payload bytes, not git diff attribution.
- Session state is in-memory for the current run; private memory is not persisted across runs.
