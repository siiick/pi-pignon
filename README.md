# pignon

Pi agent extension that shifts to the right LLM for each prompt, the way a
bike changes sprocket (*pignon*): a small **decision model** judges how hard
the prompt is, and pignon looks the answer up in **your routing table**.

- Decisions come from a **local Laya System-1 model** (~7–14 ms on Apple
  Silicon, via laya-mlx); a remote Jev decider is on the way
  ([plan](docs/PLAN-deciders.md))
- You choose the models and write your own difficulty tiers
- Strongly typed TypeScript, config checked against a published JSON Schema

## How it works

On every prompt the decider is asked two questions:

1. **How hard is it?** It picks one of your tiers. The defaults are:
   - `trivial` → mechanical edits, renames, single lookup
   - `standard` → localized change across a few files
   - `hard` → multi-step investigation, debugging, cross-cutting design

2. **Does the agent need to explore the codebase first?** `yes` / `no`, which
   picks the **direct** (reasoner) or **exploration** (agent) model of the tier.

The answers are fed into a **pure policy function** that decides:
- Whether to **upgrade**, **downgrade**, or **keep** the current tier
- Whether to switch between the **direct** and **exploration** models
- Whether a switch is **worth losing the prompt cache** (see [Switch cost](#switch-cost))

## Installation

### 1. Set up the Laya stdio worker

The extension spawns and supervises a single long-lived Python process
(`worker/laya_worker.py`) that keeps the MLX model warm. There is no HTTP
service, no port, and nothing to start manually — but the worker's virtual
environment must exist once:

```bash
cd ~/projects/localLaya/pignon/worker
uv sync
```

This creates `worker/.venv`, which the extension uses automatically. The first
decision loads the checkpoint (downloaded from Hugging Face on first run).

### 2. Install the extension into Pi

```bash
cd ~/projects/localLaya/pignon
# Symlink so Pi discovers it automatically
ln -s $(pwd) ~/.pi/agent/extensions/pignon
```

Or copy it, without the virtual environment (its absolute paths break when
moved), and recreate that in place:
```bash
rsync -a --exclude node_modules --exclude worker/.venv \
  ~/projects/localLaya/pignon ~/.pi/agent/extensions/
(cd ~/.pi/agent/extensions/pignon/worker && uv sync)
```

### 3. Restart Pi

```bash
pi
# or /reload if already running
```

## Commands

| Command | Description |
|---------|-------------|
| `/pignon` | Show current mode and config file |
| `/pignon shadow` | Observe-only mode (default) — logs decisions without applying them |
| `/pignon live` | Apply routing decisions to model selection |
| `/pignon off` | Disable routing |
| `/pignon unpin` | Re-enable routing after manual model selection |
| `/pignon log` | Show recent decider output (load progress, warnings, tracebacks) |
| `/pignon log clear` | Hide the log widget |
| `/pignon config` | Show the routing table and settings in use |
| `/pignon config clear` | Hide the config widget |
| `/pignon config migrate` | Convert a laya-router config file to the pignon format |
| `/pignon-stats` | Show tier × form × confidence histogram for the session |
| `/pignon-stats clear` | Hide the stats widget |

`/laya` and `/laya-stats` still work as aliases of `/pignon` and `/pignon-stats`;
they will be removed in a later release.

## What you see

- **While the decider works**: a spinner above the editor (`pignon is choosing a model…`). Pi's own working spinner only starts once the LLM turn begins, after routing.
- **After each routed prompt**: a decision card below your message, e.g.

  ```
  pignon hard/exploration p=0.92 · 143 ms  ⚡ switched to openrouter/tencent/hy4-preview · thinking low
    upgrade
  ```

  `👁 would switch to …` in shadow mode, `· kept current model` when the policy holds, `✗ …` on failure. Expand tool output (`Ctrl+O`) to see confidence bars for tier and exploration, the current model, context size, the decision model and the question wording version. Cards are session entries (`pignon-decision`; `laya-decision` in older sessions), so they reappear when a session is resumed and are never sent to the LLM.
- **Footer status**: the latest verdict at a glance.

## Environment variables

| Variable | Default | Description |
|----------|---------|-------------|
| `PIGNON_CONFIG` | `~/.pi/agent/pignon.json` | Path of the optional [config file](#configuration) |
| `LAYA_ROUTER_CONFIG` | `~/.pi/agent/laya-router.json` | Config of laya-router, read only when there is no pignon config |
| `LAYA_MODEL` | `aac6fef/laya-mlx` | Override the model checkpoint (e.g. `aac6fef/laya-multilingual-mlx`); fixed for the life of the worker |
| `LAYA_MODEL_REVISION` | pinned commit for the default model, latest for others | Hugging Face revision to load; empty string means latest |
| `LAYA_PYTHON` | `worker/.venv/bin/python`, else `python3` | Interpreter used to launch the worker |
| `LAYA_WORKER_DIR` | `<extension>/worker` | Directory containing `laya_worker.py` |
| `LAYA_WORKER_SCRIPT` | `<worker dir>/laya_worker.py` | Explicit worker script path |
| `LAYA_DTYPE` | `float16` | Worker model dtype (`float16` / `float32`) |
| `LAYA_DEVICE` | *(auto)* | Worker device (`gpu` / `cpu` / empty) |
| `LAYA_BATCH_SIZE` | `16` | Worker questions per forward pass |

## Configuration

Everything is optional: with no file, pignon uses the built-in table below.
Create `~/.pi/agent/pignon.json` (or point `PIGNON_CONFIG` at another file) and
set only what you want to change. Each section is checked on its own; an
invalid section is reported when the session starts and falls back to its
default. `/pignon config` shows what is in use.

Add the `$schema` line to get autocompletion and inline errors in your editor.

### Swap a model

Tiers refer to models by name. The built-in names are `fast`, `balanced`,
`reasoner` and `agent`; redefine one to change every tier that uses it:

```json
{
  "$schema": "https://unpkg.com/pignon/schema/config.schema.json",
  "version": 2,
  "models": {
    "reasoner": { "provider": "anthropic", "modelId": "claude-opus-5-5", "thinking": "high" }
  }
}
```

`thinking` is one of `off`, `low`, `medium`, `high`, `xhigh`; Pi clamps it to
what the model supports. Check model ids with `pi --list-models`.

### Write your own tiers

`tiers` replaces the built-in list as a whole: 2 to 8 tiers, **easiest first**
(position is rank, so moving down the list is a downgrade). Each tier has:

| Key | Meaning |
|-----|---------|
| `id` | Tier name shown on decision cards (lowercase, digits, `-`, `_`) |
| `criterion` | How to recognize a task of this tier. **This is the text the decision model reads**, so write it as a description of the task |
| `model` | Model for every task of the tier… |
| `direct` / `exploration` | …or one model for each form |
| `explorationAllowed` | `false` sends tasks that need exploration to the next tier up (default `true`) |

A model is a name from `models` or an inline `{ provider, modelId, thinking }`.
See [`examples/pignon.json`](examples/pignon.json) for a four-tier table.

When you change the wording of criteria or questions, also change
`questions.version`: it is stored with each decision, so you can tell which
wording your thresholds were calibrated on.

### Built-in table

| Tier | Direct | Exploration |
|------|--------|-------------|
| trivial | `fast`: `openrouter/deepseek/deepseek-v4-flash-0731` · off | → standard (`explorationAllowed: false`) |
| standard | `balanced`: `openrouter/deepseek/deepseek-v4.1-flash` · low | same |
| hard | `reasoner`: `openrouter/z-ai/glm-5.3` · high | `agent`: `openrouter/tencent/hy4-preview` · low |

### Other settings

| Key | Default | Meaning |
|-----|---------|---------|
| `questions.version` | `q1` | Label stored with each decision |
| `questions.tierInstructions` | *How much reasoning does solving this request demand…* | The tier question |
| `questions.explorationInstructions` | *Does answering require exploring the codebase…* | The exploration question |
| `questions.explorationCriteria` | `{ yes, no }` | What `yes` and `no` mean |
| `confidenceSource` | `reported` | `top-probability` routes on the chosen answer's probability instead of the model's confidence, for checkpoints whose confidence is uncalibrated |

| Threshold | Default | Meaning |
|-----------|---------|---------|
| `minConfidenceDowngrade` | `0.85` | Tier confidence needed to downgrade, or to move in from a model outside the table |
| `minConfidenceUpgrade` | `0.5` | Tier confidence needed to upgrade |
| `minConfidenceForm` | `0.6` | Confidence needed to call a task `direct` rather than `exploration` |
| `minPromptsBetweenSwitches` | `2` | Prompts to wait after a switch before the next downgrade or lateral switch |
| `maxPaybackRequests` | `3` | A downgrade must recoup its cache-miss cost within this many LLM requests |
| `assumedOutputTokensPerRequest` | `1000` | Output per request assumed when estimating what a downgrade saves |
| `cacheGuardTokens` | `60000` | Context size above which lateral switches (and downgrades, when prices are unknown) are refused |
| `layaTimeoutMs` | `2500` | Timeout for one Laya decision |

### Coming from laya-router

A `~/.pi/agent/laya-router.json` is still read when there is no `pignon.json`,
including its old `tiers: { hard: { direct: … } }` format. pignon warns at
session start; run `/pignon config migrate` to write the equivalent
`pignon.json` (a `pignon.json` in the old format is backed up to
`pignon.json.bak` first), then `/reload`.

## Project structure

```
pignon/
├── src/
│   ├── types.ts             # Domain types and constants (zero dependencies)
│   ├── config/
│   │   ├── schema.ts        # TypeBox schema of the config file (also the JSON Schema)
│   │   ├── defaults.ts      # Built-in models, tiers, wording and thresholds
│   │   ├── load.ts          # Read, validate and resolve the config file
│   │   ├── migrate.ts       # /pignon config migrate (laya-router -> pignon)
│   │   └── describe.ts      # /pignon config widget
│   ├── deciders/
│   │   ├── types.ts         # Decider interface: the seam between router and classifier
│   │   ├── questions.ts     # The tier and exploration questions sent to every decider
│   │   ├── parse.ts         # Raw answers -> RoutingDecision (shared by all deciders)
│   │   └── laya-local.ts    # Local Laya decider: supervises the stdio worker
│   ├── policy.ts            # Pure routing policy (the core logic)
│   ├── router.ts            # Per-prompt routing over a Pi-free RouterHost
│   ├── stats.ts             # /pignon-stats histogram
│   ├── ui.ts                # Spinner and decision cards
│   └── extension.ts         # Pi ExtensionAPI wiring
├── worker/
│   ├── laya_worker.py       # Long-lived laya-mlx process (JSON-lines on stdio)
│   ├── test_laya_worker.py  # stdlib unittest tests for the worker
│   ├── pyproject.toml       # uv project: laya-mlx
│   └── README.md            # Worker protocol and manual smoke test
├── tests/                   # Vitest suites, one per module
├── schema/config.schema.json # Generated JSON Schema (npm run schema)
├── examples/pignon.json     # A four-tier config, loaded by the tests
├── docs/PLAN-deciders.md    # Roadmap: Jev decider, strategies, publishing
├── package.json
├── tsconfig.json
└── vitest.config.ts
```

## Development

```bash
# Install dependencies
npm install

# Type check
npm run typecheck

# Run tests
npm test

# Run the Python worker tests
npm run test:worker

# Regenerate schema/config.schema.json after changing src/config/schema.ts
npm run schema

# Type check + all tests
npm run check

# Watch mode
npm run test:watch
```

## Design notes

- **Fail-open**: If the worker cannot start or a decision fails, the decision is `null` and the extension keeps the current model. The worker loads its model in the background from `session_start`; prompts sent before it is ready are not routed (status shows `model loading — prompt not routed`) rather than held. It stays warm for the session, is reloaded in the background if it crashes, and is stopped on `session_shutdown`. A worker that is not ready within 5 minutes is killed.
- <a id="switch-cost"></a>**Switch cost**: Switching models throws away the prompt cache: the first request on the new model reads the whole context at the uncached (or cache-write) price. Upgrades are quality-driven and only gated by confidence. A downgrade, or a move in from a model outside the table, must pay that premium back within `maxPaybackRequests` LLM requests out of what it saves per request (cheaper cache reads on the context plus cheaper output). Prices come from Pi's model registry; when either model has no price, the flat `cacheGuardTokens` limit applies instead. Lateral switches (direct ↔ exploration) are about fit rather than price and use the flat limit.
- **Hysteresis**: After the router switches, it waits `minPromptsBetweenSwitches` prompts before the next downgrade or lateral switch, so it does not flap between models. Upgrades are never delayed.
- **Manual pin**: If the user explicitly selects a model via `/model` or `Ctrl+P`, the extension steps back (`manualPin`) until `/pignon unpin`. The router's own switches also emit `model_select` (`source: "set"`) and are ignored.
- **Unrouted models**: If the current model is not in the routing table (matched on provider and model id), the router switches into the table only when tier confidence meets the downgrade threshold and the switch-cost check passes.
- **Shared models**: Cells mapped to the same provider, model and thinking level count as one; the router never re-selects the model already in use.
- **Worker isolation**: The worker gets an allowlisted environment (`PATH`, `HOME`, locale, proxies, CA bundles, `LAYA_*`, `HF_*`, `HUGGINGFACE_*`, `MLX_*`), not Pi's full environment with provider API keys. Its stderr is kept in memory (last 200 lines, see `/pignon log`) instead of being written over the TUI.
- **Pinned model**: The default checkpoint is pinned to the Hugging Face commit the router was calibrated on, so changes pushed to the Hub repo do not silently change routing. Bump `PINNED_REVISION` in `worker/laya_worker.py` deliberately, after re-checking decisions in shadow mode.
- **Prompt privacy**: Session log entries (`pignon-decision`) record a 16-hex-digit SHA-256 prefix and the length of each prompt, never its text.
- **Bounded worker load**: Only the first 4 000 characters of a prompt are sent (Laya reads about 320 tokens from the start anyway). Each request carries a deadline; the worker skips requests that expired while queued, so slow requests cannot pile up behind each other.
- **Shadow mode default**: New installs run in shadow mode so you can calibrate confidence thresholds on your own prompts before going live.

## License

[MIT](LICENSE) © 2026 Nicolas Chaintron

Using pignon in your own project, or built something on top of it? I'd love to
hear about it: open an issue or a discussion and tell me what you made. It is
not required, but it helps me see what to improve.
