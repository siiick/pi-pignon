# Laya LLM Router

Pi agent extension that routes user prompts to the best matching LLM model by
consulting a **local Laya System-1 decision model**.

- No cloud API calls for routing decisions
- ~7–14 ms per decision on Apple Silicon (via laya-mlx)
- Strongly typed TypeScript with full test coverage

## How it works

On every prompt the extension asks the local Laya worker two questions:

1. **reasoning_demand** — How hard is this task?
   - `trivial` → mechanical edits, renames, single lookup
   - `standard` → localized change across a few files
   - `hard` → multi-step investigation, debugging, cross-cutting design

2. **needs_exploration** — Does the agent need to explore the codebase first?
   - `yes` / `no`

The answers are fed into a **pure policy function** that decides:
- Whether to **upgrade**, **downgrade**, or **keep** the current tier
- Whether to switch between **direct** (reasoner) and **exploration** (agent) forms
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
| `/laya` | Show current mode |
| `/laya shadow` | Observe-only mode (default) — logs decisions without applying them |
| `/laya live` | Apply routing decisions to model selection |
| `/laya off` | Disable Laya routing |
| `/laya unpin` | Re-enable routing after manual model selection |
| `/laya log` | Show recent worker output (load progress, warnings, tracebacks) |
| `/laya log clear` | Hide the worker log widget |
| `/laya-stats` | Show tier × form × confidence histogram for the session |
| `/laya-stats clear` | Hide the stats widget |

## What you see

- **While Laya decides**: a spinner above the editor (`Laya is choosing a model…`). Pi's own working spinner only starts once the LLM turn begins, after routing.
- **After each routed prompt**: a decision card below your message, e.g.

  ```
  laya hard/exploration p=0.92 · 143 ms  ⚡ switched to openrouter/tencent/hy4-preview · thinking low
    upgrade
  ```

  `👁 would switch to …` in shadow mode, `· kept current model` when the policy holds, `✗ …` on failure. Expand tool output (`Ctrl+O`) to see confidence bars for tier and exploration, the current model, context size and the Laya checkpoint. Cards are session entries (`laya-decision`), so they reappear when a session is resumed and are never sent to the LLM.
- **Footer status**: the latest verdict at a glance.

## Environment variables

| Variable | Default | Description |
|----------|---------|-------------|
| `LAYA_ROUTER_CONFIG` | `~/.pi/agent/laya-router.json` | Path of the optional [config file](#configuration) |
| `LAYA_MODEL` | `aac6fef/laya-mlx` | Override the model checkpoint (e.g. `aac6fef/laya-multilingual-mlx`); fixed for the life of the worker |
| `LAYA_MODEL_REVISION` | pinned commit for the default model, latest for others | Hugging Face revision to load; empty string means latest |
| `LAYA_PYTHON` | `worker/.venv/bin/python`, else `python3` | Interpreter used to launch the worker |
| `LAYA_WORKER_DIR` | `<extension>/worker` | Directory containing `laya_worker.py` |
| `LAYA_WORKER_SCRIPT` | `<worker dir>/laya_worker.py` | Explicit worker script path |
| `LAYA_DTYPE` | `float16` | Worker model dtype (`float16` / `float32`) |
| `LAYA_DEVICE` | *(auto)* | Worker device (`gpu` / `cpu` / empty) |
| `LAYA_BATCH_SIZE` | `16` | Worker questions per forward pass |

## Configuration

Everything is optional. Create `~/.pi/agent/laya-router.json` (or point
`LAYA_ROUTER_CONFIG` at another file) and set only what you want to change;
the rest keeps its default. Invalid entries are skipped and reported when the
session starts. `/laya` shows which file is in use.

```json
{
  "thresholds": { "minConfidenceDowngrade": 0.9, "maxPaybackRequests": 5 },
  "tiers": {
    "hard": {
      "direct": { "provider": "openrouter", "modelId": "z-ai/glm-5.3", "thinking": "xhigh" }
    }
  }
}
```

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

## Model routing table

| Tier | Form | Provider / Model | Thinking |
|------|------|------------------|----------|
| trivial | direct | `openrouter/deepseek/deepseek-v4-flash-0731` | off |
| trivial | exploration | `openrouter/deepseek/deepseek-v4-flash-0731` | off |
| standard | direct | `openrouter/deepseek/deepseek-v4.1-flash` | low |
| standard | exploration | `openrouter/deepseek/deepseek-v4.1-flash` | low |
| hard | direct | `openrouter/z-ai/glm-5.3` | high |
| hard | exploration | `openrouter/tencent/hy4-preview` | low |

## Project structure

```
pignon/
├── src/
│   ├── types.ts             # Domain types and constants (zero dependencies)
│   ├── config.ts            # Optional JSON config file, merged over the defaults
│   ├── deciders/
│   │   ├── types.ts         # Decider interface: the seam between router and classifier
│   │   ├── questions.ts     # The tier and exploration questions sent to every decider
│   │   ├── parse.ts         # Raw answers -> RoutingDecision (shared by all deciders)
│   │   └── laya-local.ts    # Local Laya decider: supervises the stdio worker
│   ├── policy.ts            # Pure routing policy (the core logic)
│   ├── router.ts            # Per-prompt routing over a Pi-free RouterHost
│   ├── stats.ts             # /laya-stats histogram
│   ├── ui.ts                # Spinner and decision cards
│   └── extension.ts         # Pi ExtensionAPI wiring
├── worker/
│   ├── laya_worker.py       # Long-lived laya-mlx process (JSON-lines on stdio)
│   ├── test_laya_worker.py  # stdlib unittest tests for the worker
│   ├── pyproject.toml       # uv project: laya-mlx
│   └── README.md            # Worker protocol and manual smoke test
├── tests/                   # Vitest suites, one per module
├── docs/PLAN-deciders.md    # Roadmap: Jev decider, configurable tiers, publishing
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

# Type check + all tests
npm run check

# Watch mode
npm run test:watch
```

## Design notes

- **Fail-open**: If the worker cannot start or a decision fails, the decision is `null` and the extension keeps the current model. The worker loads its model in the background from `session_start`; prompts sent before it is ready are not routed (status shows `model loading — prompt not routed`) rather than held. It stays warm for the session, is reloaded in the background if it crashes, and is stopped on `session_shutdown`. A worker that is not ready within 5 minutes is killed.
- <a id="switch-cost"></a>**Switch cost**: Switching models throws away the prompt cache: the first request on the new model reads the whole context at the uncached (or cache-write) price. Upgrades are quality-driven and only gated by confidence. A downgrade, or a move in from a model outside the table, must pay that premium back within `maxPaybackRequests` LLM requests out of what it saves per request (cheaper cache reads on the context plus cheaper output). Prices come from Pi's model registry; when either model has no price, the flat `cacheGuardTokens` limit applies instead. Lateral switches (direct ↔ exploration) are about fit rather than price and use the flat limit.
- **Hysteresis**: After the router switches, it waits `minPromptsBetweenSwitches` prompts before the next downgrade or lateral switch, so it does not flap between models. Upgrades are never delayed.
- **Manual pin**: If the user explicitly selects a model via `/model` or `Ctrl+P`, the extension steps back (`manualPin`) until `/laya unpin`. The router's own switches also emit `model_select` (`source: "set"`) and are ignored.
- **Unrouted models**: If the current model is not in the routing table (matched on provider and model id), the router switches into the table only when tier confidence meets the downgrade threshold and the switch-cost check passes.
- **Shared models**: Cells mapped to the same provider, model and thinking level count as one; the router never re-selects the model already in use.
- **Worker isolation**: The worker gets an allowlisted environment (`PATH`, `HOME`, locale, proxies, CA bundles, `LAYA_*`, `HF_*`, `HUGGINGFACE_*`, `MLX_*`), not Pi's full environment with provider API keys. Its stderr is kept in memory (last 200 lines, see `/laya log`) instead of being written over the TUI.
- **Pinned model**: The default checkpoint is pinned to the Hugging Face commit the router was calibrated on, so changes pushed to the Hub repo do not silently change routing. Bump `PINNED_REVISION` in `worker/laya_worker.py` deliberately, after re-checking decisions in shadow mode.
- **Prompt privacy**: Session log entries (`laya-decision`) record a 16-hex-digit SHA-256 prefix and the length of each prompt, never its text.
- **Bounded worker load**: Only the first 4 000 characters of a prompt are sent (Laya reads about 320 tokens from the start anyway). Each request carries a deadline; the worker skips requests that expired while queued, so slow requests cannot pile up behind each other.
- **Shadow mode default**: New installs run in shadow mode so you can calibrate confidence thresholds on your own prompts before going live.
