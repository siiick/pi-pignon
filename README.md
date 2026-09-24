# <img src="docs/assets/pignon.svg" width="40" height="40" alt="" align="top"> pignon

[![CI](https://github.com/siiick/pi-pignon/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/siiick/pi-pignon/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/github/license/siiick/pi-pignon)](LICENSE)

Pi agent extension that shifts to the right LLM for each prompt, the way a
bike changes sprocket (*pignon*): a small **decision model** judges how hard
the prompt is, and pignon looks the answer up in **your routing table**.

- Decisions come from a **local Laya System-1 model**, served on your machine
  by the official `laya-serve` (~75 ms per decision on Apple Silicon), or from
  **TypeSafe's hosted Jev model** (~70–500 ms, needs an API key)
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

### 1. Install the extension

```bash
pi install npm:pi-pignon
```

`pi update --extensions` then keeps it up to date. To stay on one version,
pin it (`pi install npm:pi-pignon@0.1.1`); installing another version replaces
it. Releases are listed on the [releases page](https://github.com/siiick/pi-pignon/releases).

To run unreleased changes, install from GitHub instead:
`pi install git:github.com/siiick/pi-pignon` (follows `main`).

### 2. Give it a decision model

pignon needs a local Laya server, Jev (an API key), or both. `/pignon init`
(step 4) finds what is available and writes it into your config.

**Local: Laya, with `laya-serve`.** Laya's official package ships a server
that speaks the same API as Jev, so pignon talks to it like to Jev, on your
machine. Install it with [uv](https://docs.astral.sh/uv/) (`brew install uv`)
or pipx, then start it:

```bash
uv tool install "laya[serve]"             # or: pipx install "laya[serve]"
LAYA_HOST=127.0.0.1 laya-serve            # listens on http://127.0.0.1:8000
```

- Always set `LAYA_HOST=127.0.0.1`: by default laya-serve listens on every
  network interface, so other machines could use it.
- It uses the best device it finds (NVIDIA GPU, Apple Silicon GPU, then CPU).
- The first start downloads the checkpoints from Hugging Face and takes a
  while; later starts take 2–3 s. By default it loads every checkpoint;
  `LAYA_MODELS=english` loads only the English one (add `multilingual` if you
  write prompts in other languages).
- pignon never waits for it: while the server is down or loading, prompts
  are not routed and keep the current model (the failure takes a few
  milliseconds).

To have it running whenever you use Pi, [start it at login](#start-laya-serve-at-login-macos).
For another address, port or key, see [Deciders](#deciders).

**Remote: Jev.** Get a key from [TypeSafe](https://typesafe.ai) and export it
where Pi runs:

```bash
export TYPESAFE_API_KEY="sk-..."
```

To go through OpenRouter instead, use an OpenRouter key and see
[Deciders](#deciders). Jev receives the first 4 000 characters of each routed
prompt; see [Privacy](#privacy).

### 3. Restart Pi

```bash
pi
# or /reload if already running
```

### 4. Create a config and check it

```
/pignon init          # writes ~/.pi/agent/pignon.json from the preset your Pi can use
/reload
/pignon doctor        # checks the config, each decider (one test decision) and each model
/pignon live          # start routing (pignon starts in shadow mode)
```

`/pignon init anthropic` (or `openai`, `openrouter`) picks a preset
explicitly; see [Presets](#presets). `init` never replaces an existing file.

## Commands

| Command | Description |
|---------|-------------|
| `/pignon` | Show current mode and config file |
| `/pignon shadow` | Observe-only mode (default) — logs decisions without applying them |
| `/pignon live` | Apply routing decisions to model selection |
| `/pignon off` | Disable routing |
| `/pignon unpin` | Re-enable routing after manual model selection |
| `/pignon log` | Show recent decider output (load progress, warnings, tracebacks) |
| `/pignon config` | Show the routing table and settings in use |
| `/pignon config migrate` | Convert a laya-router config file to the pignon format |
| `/pignon init [preset]` | Write a starter `pignon.json`: the preset's models (by default the one whose models Pi can use) and the deciders that can run here |
| `/pignon doctor` | Check the config, each decider (one real test decision; for Jev that sends a fixed test prompt) and each model of the table (known to Pi, credentials set) |
| `/pignon-stats` | Show tier × form × confidence histogram for the session |
| `/pignon-stats compare` | Compare two deciders over the decisions both answered (see [Using several deciders](#using-several-deciders)) |
| `/pignon-stats export [path]` | Write the session's decisions as JSON lines (default `~/.pi/agent/pignon-exports/`); prompts are stored as hashes, never text |

`log`, `config`, `doctor` and the stats reports open in a scrollable overlay:
↑↓, PgUp/PgDn, Home/End to scroll, Esc (or `q`, Enter) to close. Nothing stays
above the editor afterwards. The older `clear` subcommands still work and remove
a widget left by a previous version.

`/laya` and `/laya-stats` still work as aliases of `/pignon` and `/pignon-stats`;
they will be removed in a later release.

## What you see

- **While the decider works**: a spinner above the editor (`pignon is choosing a model…`). Pi's own working spinner only starts once the LLM turn begins, after routing.
- **After each routed prompt**: a decision card below your message, e.g.

  ```
  pignon laya-serve hard/exploration p=0.92 · 75 ms  ⚡ switched to openrouter/tencent/hy4-preview · thinking low
    upgrade
  ```

  The name after `pignon` is the decider that answered; `☁` means the prompt left your machine (Jev, or a laya-serve on another host). With several deciders, a third line shows each one's answer and marks the one used, e.g. `laya-serve standard 0.05 · jev ☁ hard 0.93 ✓`.

  `👁 would switch to …` in shadow mode, `· kept current model` when the policy holds, `✗ …` on failure. Expand tool output (`Ctrl+O`) to see confidence bars for tier and exploration, the current model, context size, the decision model and the question wording version. Cards are session entries (`pignon-decision`; `laya-decision` in older sessions), so they reappear when a session is resumed and are never sent to the LLM.
- **Footer status**: the latest verdict at a glance.

## Environment variables

| Variable | Default | Description |
|----------|---------|-------------|
| `PIGNON_CONFIG` | `<Pi config dir>/pignon.json` | Path of the optional [config file](#configuration) |
| `PI_CODING_AGENT_DIR` | `~/.pi/agent` | Pi's config directory; pignon keeps its config and exports there |
| `TYPESAFE_API_KEY` | *(unset)* | Jev API key (another variable can be named with `apiKeyEnv`) |
| `TYPESAFE_BASE_URL` | `https://api.typesafe.ai` | Jev API root, when `baseURL` is not set |
| `TYPESAFE_DEFAULT_MODEL` | `jev-latest` | Jev model, when `model` is not set |
| `LAYA_ROUTER_CONFIG` | `~/.pi/agent/laya-router.json` | Config of laya-router, read only when there is no pignon config |

laya-serve reads its own `LAYA_*` variables (`LAYA_HOST`, `LAYA_PORT`,
`LAYA_MODELS`, `LAYA_API_KEY`, …) when it starts; see
[Laya's documentation](https://pypi.org/project/laya/). The variables of the
[experimental worker](#experimental-pignons-mlx-worker) are listed in its section.

## Configuration

Everything is optional: with no file, pignon uses the built-in table below.
Create `~/.pi/agent/pignon.json` (or point `PIGNON_CONFIG` at another file) and
set only what you want to change. Each section is checked on its own; an
invalid section is reported when the session starts and falls back to its
default. `/pignon config` shows what is in use.

Add the `$schema` line to get autocompletion and inline errors in your editor.

### Deciders

`deciders` picks the decision model. `/pignon init` writes it for you. Without
it, pignon uses the [experimental worker](#experimental-pignons-mlx-worker) when
installed, else Jev when `TYPESAFE_API_KEY` is set; it does not look for
laya-serve on its own.

```json
{
  "deciders": [
    { "type": "laya-serve" }
  ]
}
```

| Type | Key | Default | Meaning |
|------|-----|---------|---------|
| `laya-serve` | `url` | `http://127.0.0.1:8000` | Where laya-serve listens. On another machine, prompts leave yours and cards show ☁ |
| | `model` | *(server's choice)* | Laya checkpoint: `english`, `multilingual` or `typed-decisions`. By default the server picks one from the prompt's language |
| | `apiKeyEnv` | *(none)* | Environment variable holding the server's key, when you started it with `LAYA_API_KEY`. Your TypeSafe key is never sent to laya-serve |
| | `timeoutMs` | `1500` | Timeout for one decision |
| `laya-local` | | | [Experimental worker](#experimental-pignons-mlx-worker), see its section |
| `jev` | `model` | `jev-latest` | Jev version to pin. Confidences are calibrated per version, so pinning keeps your thresholds valid |
| | `apiKeyEnv` | `TYPESAFE_API_KEY` | Environment variable holding the key. Keys are never read from the config file |
| | `baseURL` | TypeSafe | `https://openrouter.ai/api` to go through OpenRouter (with `"apiKeyEnv": "OPENROUTER_API_KEY"`) |
| | `timeoutMs` | `1500` | Timeout for one decision |
| | `maxRetries` | `0` | Retries after a failed call; each gets the full timeout |

### Using several deciders

List more than one and `strategy` says how they work together:

```json
{
  "deciders": [{ "type": "laya-serve" }, { "type": "jev" }],
  "strategy": { "mode": "sequential", "escalateBelow": 0.75 }
}
```

| Key | Default | Meaning |
|-----|---------|---------|
| `mode` | `sequential` | `sequential`: ask the deciders in order; the next one is asked only when the previous one is not ready, fails (e.g. laya-serve not running), or is less confident than `escalateBelow`. Remote deciders are only called when needed. `parallel`: ask all of them at once |
| `escalateBelow` | `0.75` | Sequential: tier confidence under which the next decider is asked. The most confident answer wins |
| `pick` | `most-confident` | Parallel: route on the most confident answer, or `first`: on the first decider in the list that answered, the others being only recorded |
| `budgetMs` | `3000` | Wall-time limit for one decision, all deciders included |

**Benchmark Laya against Jev** without changing how you route: keep Laya in
charge and record Jev's answers next to it, then compare them.

```json
{
  "deciders": [{ "type": "laya-serve" }, { "type": "jev" }],
  "strategy": { "mode": "parallel", "pick": "first" }
}
```

`/pignon-stats compare` shows tier and exploration agreement, a confusion
matrix, mean confidence, latency, failures and cost per decider.
`/pignon-stats export` writes every decision (with each decider's answer) as
JSON lines for your own analysis. In parallel mode, every routed prompt is sent
to Jev.

Laya's confidence is low (0.05–0.27 on typical prompts: the checkpoint's
temperatures are uncalibrated), so with the default `escalateBelow` of 0.75,
sequential mode asks Jev on almost every prompt. Lower `escalateBelow`, or set
`"confidenceSource": "top-probability"` (see [Other settings](#other-settings)).

### Start laya-serve at login (macOS)

A launchd agent keeps laya-serve running in the background and restarts it if
it stops. Save this as `~/Library/LaunchAgents/local.laya-serve.plist`,
replacing `/Users/you/.local/bin/laya-serve` with the output of
`which laya-serve`:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>local.laya-serve</string>
  <key>ProgramArguments</key>
  <array><string>/Users/you/.local/bin/laya-serve</string></array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>LAYA_HOST</key><string>127.0.0.1</string>
    <key>LAYA_MODELS</key><string>english,multilingual</string>
  </dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardErrorPath</key><string>/tmp/laya-serve.log</string>
</dict>
</plist>
```

```bash
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/local.laya-serve.plist   # start now and at login
launchctl bootout gui/$(id -u)/local.laya-serve                                  # stop and disable
```

### Experimental: pignon's MLX worker

pignon also has its own Laya worker (`worker/` in this repository), built on
[laya-mlx](https://github.com/mizorewww/laya-mlx). It is a little faster than
laya-serve on Apple Silicon (~61 ms against ~75 ms per decision, with the same
answers), smaller to install, and needs no server: pignon starts it with the
session and stops it afterwards. It is **experimental and not published**, and
its interface may change; prefer laya-serve.

It needs an Apple Silicon Mac and a clone of this repository:

```bash
git clone https://github.com/siiick/pi-pignon
uv tool install ./pi-pignon/worker            # puts pignon-laya on PATH
```

then `"deciders": [{ "type": "laya-local" }]`. pignon starts the worker with
the first of:

1. `command` in the `laya-local` decider, e.g. `["uv", "run", "--project", "/path/to/pi-pignon/worker", "pignon-laya"]`;
2. `LAYA_PYTHON`, running `laya_worker.py` from `LAYA_WORKER_DIR`;
3. a source checkout's `worker/.venv` (after `uv sync`), when pignon itself runs from that checkout;
4. `pignon-laya` on `PATH`.

`/pignon doctor` says which one is used. The worker reports its protocol
version when it starts; pignon refuses a worker it cannot talk to and says
which side to update. Its settings:

| Key or variable | Default | Meaning |
|-----------------|---------|---------|
| `timeoutMs` (decider) | `thresholds.layaTimeoutMs` | Timeout for one decision |
| `command` (decider) | *(found automatically)* | Command that starts the worker |
| `LAYA_MODEL` | `aac6fef/laya-mlx` | Checkpoint (e.g. `aac6fef/laya-multilingual-mlx`); fixed for the life of the worker |
| `LAYA_MODEL_REVISION` | pinned commit for the default model, latest for others | Hugging Face revision to load; empty string means latest |
| `LAYA_PYTHON` | *(unset)* | Run `laya_worker.py` with this interpreter |
| `LAYA_WORKER_DIR` | `<extension>/worker` | Directory containing `laya_worker.py` |
| `LAYA_WORKER_SCRIPT` | `<worker dir>/laya_worker.py` | Explicit worker script path |
| `LAYA_DTYPE` | `float16` | Model dtype (`float16` / `float32`) |
| `LAYA_DEVICE` | *(auto)* | Device (`gpu` / `cpu` / empty) |
| `LAYA_BATCH_SIZE` | `16` | Questions per forward pass |

### Swap a model

Tiers refer to models by name. The built-in names are `fast`, `balanced`,
`reasoner` and `agent`; redefine one to change every tier that uses it:

```json
{
  "$schema": "https://raw.githubusercontent.com/siiick/pi-pignon/main/schema/config.schema.json",
  "version": 2,
  "models": {
    "reasoner": { "provider": "anthropic", "modelId": "claude-opus-5-5", "thinking": "high" }
  }
}
```

`thinking` is one of `off`, `low`, `medium`, `high`, `xhigh`; Pi clamps it to
what the model supports. Check model ids with `pi --list-models`.

### Presets

A preset fills the four built-in model names from one provider. Use it with
`extends`, and override any name under `models`:

```json
{
  "extends": "anthropic",
  "models": { "fast": { "provider": "anthropic", "modelId": "claude-haiku-4-5-20251001", "thinking": "off" } }
}
```

| Preset | `fast` | `balanced` | `reasoner` | `agent` |
|--------|--------|------------|------------|---------|
| `openrouter` (default) | deepseek-v4-flash-0731 · off | deepseek-v4.1-flash · low | glm-5.3 · high | hy4-preview · low |
| `anthropic` | claude-haiku-4-5 · off | claude-sonnet-5 · low | claude-opus-5-5 · high | claude-sonnet-5 · medium |
| `openai` | gpt-6-luna · off | gpt-5.6-terra · low | gpt-6-sol · high | gpt-5.3-codex · medium |

Presets are starting points, not recommendations: check prices and quality on
your own work (`/pignon-stats`, shadow mode).

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
| `layaTimeoutMs` | `2500` | Timeout for one decision of the experimental worker |

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
│   │   ├── presets.ts       # Model presets (openrouter, anthropic, openai)
│   │   ├── load.ts          # Read, validate and resolve the config file
│   │   ├── migrate.ts       # /pignon config migrate (laya-router -> pignon)
│   │   └── describe.ts      # /pignon config report
│   ├── deciders/
│   │   ├── types.ts         # Decider interface: the seam between router and classifier
│   │   ├── questions.ts     # The tier and exploration questions sent to every decider
│   │   ├── parse.ts         # Raw answers -> RoutingDecision (shared by all deciders)
│   │   ├── laya-serve.ts    # Laya through the official laya-serve (reuses the Jev client)
│   │   ├── laya-local.ts    # Experimental: supervises pignon's own stdio worker
│   │   ├── jev.ts           # Remote Jev decider, through @typesafe-ai/sdk
│   │   ├── strategy.ts      # Several deciders behind one: sequential or parallel
│   │   └── create.ts        # Config -> decider, with the automatic choice
│   ├── policy.ts            # Pure routing policy (the core logic)
│   ├── router.ts            # Per-prompt routing over a Pi-free RouterHost
│   ├── stats.ts             # /pignon-stats histogram
│   ├── compare.ts           # /pignon-stats compare and export
│   ├── onboarding.ts        # /pignon init and /pignon doctor
│   ├── ui.ts                # Spinner and decision cards
│   └── extension.ts         # Pi ExtensionAPI wiring
├── worker/                  # Experimental MLX worker, not published
│   ├── laya_worker.py       # Long-lived laya-mlx process (JSON-lines on stdio)
│   ├── test_laya_worker.py  # stdlib unittest tests for the worker
│   ├── pyproject.toml       # Python package pignon-laya (command: pignon-laya)
│   └── README.md            # Worker protocol and manual smoke test
├── tests/                   # Vitest suites, one per module
│   ├── decider-contract.test.ts # What every decider must do, run against each
│   └── live/                # Real API calls, only with npm run test:live
├── schema/config.schema.json # Generated JSON Schema (npm run schema)
├── examples/pignon.json     # A four-tier config, loaded by the tests
├── docs/PLAN-deciders.md    # Roadmap: Jev decider, strategies, publishing
├── CHANGELOG.md
├── package.json
├── tsconfig.json
└── vitest.config.ts
```

## Development

Work from a clone, and point Pi at it instead of a release:

```bash
git clone https://github.com/siiick/pi-pignon && cd pi-pignon
npm install
(cd worker && uv sync)          # only for the experimental worker
pi install ./                   # loads the clone in place, no copy
```

```bash
# Install dependencies
npm install

# Type check
npm run typecheck

# Run tests
npm test

# Run the Python worker tests
npm run test:worker

# Real calls: Jev (needs TYPESAFE_API_KEY; a fraction of a cent) and the experimental worker
npm run test:live

# Regenerate schema/config.schema.json after changing src/config/schema.ts
npm run schema

# Type check + all tests
npm run check

# Watch mode
npm run test:watch
```

## Design notes

- <a id="privacy"></a>**Privacy**: With `laya-serve` on this machine (`127.0.0.1` or `localhost`) or `laya-local`, prompts never leave it. With `jev`, or a laya-serve on another host, the first 4 000 characters of each routed prompt are sent over the network, and decision cards are marked ☁. The SDK's own logging is capped at `warn` and kept in `/pignon log`, so prompts are never logged, even with `TYPESAFE_LOG_LEVEL=debug`.
- **Fail-open**: If a decider cannot be reached or a decision fails, the decision is `null` and the extension keeps the current model. A laya-serve that is down refuses the connection at once, so the prompt waits a few milliseconds, not a timeout. The experimental worker loads its model in the background from `session_start`; prompts sent before it is ready are not routed (status shows `model loading — prompt not routed`) rather than held. It stays warm for the session, is reloaded in the background if it crashes, and is stopped on `session_shutdown`. A worker that is not ready within 5 minutes is killed.
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
