# <img src="docs/assets/pignon.svg" width="40" height="40" alt="" align="top"> pignon

[![pi-extension](https://img.shields.io/badge/pi-extension-blueviolet)](https://github.com/earendil-works/pi-coding-agent)
[![CI](https://github.com/siiick/pi-pignon/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/siiick/pi-pignon/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/github/license/siiick/pi-pignon)](LICENSE)

Pi agent extension that shifts to the right LLM for each prompt, the way a
bike changes sprocket (*pignon*): a small **decision model** judges how hard
the prompt is, and pignon looks the answer up in **your routing table**.

- Decisions come from a **local Laya System-1 model** (served by `laya-serve`,
  ~75 ms on Apple Silicon) or from **TypeSafe's hosted Jev** (~70–500 ms, needs
  an API key)
- You choose the models and write your own difficulty tiers
- Strongly typed TypeScript, config checked against a published JSON Schema

## How it works

On every prompt the decider answers two questions:

1. **How hard is it?** It picks one of your tiers.
   - `trivial` → mechanical edits, renames, single lookup
   - `standard` → localized change across a few files
   - `hard` → multi-step investigation, debugging, cross-cutting design

2. **Does the agent need to explore the codebase first?** `yes` / `no`,
   which picks the **direct** (reasoner) or **exploration** (agent) model of
   the tier.

The answers are fed into a **pure policy function** that decides whether to
upgrade, downgrade, or keep the current tier, and whether switching models is
worth losing the prompt cache.

## Installation

```bash
pi install npm:pi-pignon
```

`pi update --extensions` keeps it up to date. To pin a version:
`pi install npm:pi-pignon@0.1.1`. To try unreleased changes:
`pi install git:github.com/siiick/pi-pignon`.

### 1. Give it a decision model

pignon needs a local **Laya server**, a **Jev API key**, or both.

**Local: Laya with `laya-serve`**

```bash
uv tool install "laya[serve]"   # or pipx install "laya[serve]"
LAYA_HOST=127.0.0.1 laya-serve  # http://127.0.0.1:8000
```

- Always set `LAYA_HOST=127.0.0.1` (default listens on all interfaces)
- Loads the best available device (NVIDIA GPU → Apple Silicon → CPU)
- First start downloads checkpoints and may take a while; later starts take 2–3 s
- While loading or down, prompts are **not routed** — they keep the current model

**Remote: Jev**

Get a key from [TypeSafe](https://typesafe.ai) and export it:

```bash
export TYPESAFE_API_KEY="sk-..."
```

To use OpenRouter instead, see the [configuration reference](docs/CONFIGURATION.md#deciders).

### 2. Restart Pi

```bash
pi    # or /reload
```

### 3. Initialize and go live

```bash
/pignon init          # writes ~/.pi/agent/pignon.json
/pignon doctor        # checks config, deciders and models
/pignon live          # start routing (default is shadow mode)
```

`/pignon init anthropic` (or `openai`, `openrouter`) picks a preset explicitly.
`init` never overwrites an existing file.

## Commands

| Command | Description |
|---------|-------------|
| `/pignon` | Show current mode and config file |
| `/pignon shadow` | Observe-only — logs decisions without applying them |
| `/pignon live` | Apply routing decisions |
| `/pignon off` | Disable routing |
| `/pignon unpin` | Re-enable routing after manual model selection |
| `/pignon log` | Show recent decider output |
| `/pignon config` | Show the routing table and settings in use |
| `/pignon config migrate` | Convert a laya-router config to pignon format |
| `/pignon init [preset]` | Write a starter `pignon.json` |
| `/pignon doctor` | Check config, deciders and models |
| `/pignon-stats` | Show tier × form × confidence histogram |
| `/pignon-stats compare` | Compare two deciders side-by-side |
| `/pignon-stats export [path]` | Export decisions as JSON lines |

`log`, `config`, `doctor` and the stats reports open in a scrollable overlay
(↑↓, PgUp/PgDn, Home/End, Esc or `q` to close).

## What you see

- **While deciding**: a spinner above the editor (`pignon is choosing a model…`).
- **After each routed prompt**: a decision card below your message, e.g.

  ```text
  pignon laya-serve hard/exploration p=0.92 · 75 ms  ⚡ switched to openrouter/tencent/hy4-preview · thinking low
    upgrade
  ```

  The card shows the decider used, tier/form, confidence, latency, and the
  action taken (`⚡ switched`, `👁 would switch` in shadow mode, or `· kept`).
  Expand tool output (`Ctrl+O`) to see confidence bars, context size, and the
  full decision trace.
- **Footer status**: the latest verdict at a glance.

## Configuration

Everything is optional: with no file, pignon uses a built-in table.

Create `~/.pi/agent/pignon.json` (or set `PIGNON_CONFIG`) and change only what
you need. Add the `$schema` line for autocompletion:

```json
{
  "$schema": "https://raw.githubusercontent.com/siiick/pi-pignon/main/schema/config.schema.json",
  "version": 2,
  "extends": "openrouter",
  "models": {
    "reasoner": { "provider": "anthropic", "modelId": "claude-opus-5-5", "thinking": "high" }
  }
}
```

- **Deciders** — local `laya-serve`, remote `jev`, experimental `laya-local`,
  or several with a `strategy`. See [docs/CONFIGURATION.md](docs/CONFIGURATION.md#deciders).
- **Models & Presets** — name models once, reference them in tiers.
  Presets: `openrouter` (default), `anthropic`, `openai`.
- **Tiers** — define 2–8 difficulty levels with custom criteria.
  See [`examples/pignon.json`](examples/pignon.json) and the
  [configuration reference](docs/CONFIGURATION.md).

Run `/pignon config` to see the resolved table currently in use.

## Environment variables

| Variable | Default | Description |
|----------|---------|-------------|
| `PIGNON_CONFIG` | `<Pi config dir>/pignon.json` | Config file path |
| `TYPESAFE_API_KEY` | *(unset)* | Jev API key |
| `TYPESAFE_BASE_URL` | `https://api.typesafe.ai` | Jev API root |
| `LAYA_HOST`, `LAYA_PORT`, `LAYA_MODELS` | *(varies)* | `laya-serve` startup options |

Full list: [docs/CONFIGURATION.md](docs/CONFIGURATION.md#environment-variables).

## Privacy & reliability

- **Local prompts stay local.** With `laya-serve` on this machine, prompts never
  leave it. Jev (or remote laya-serve) receives the first 4 000 characters;
  cards are marked `☁`.
- **Fail-open.** If a decider is unreachable or fails, the prompt is not routed
  and keeps the current model (a few milliseconds of delay).
- **Switch cost.** Changing models discards the prompt cache. Downgrades must
  recoup that cost within a few requests; lateral switches use a flat token
  limit. See [docs/DESIGN.md](docs/DESIGN.md) for the full policy.
- **Hysteresis.** After switching, the router waits a few prompts before the
  next downgrade or lateral switch. Upgrades are never delayed.
- **Prompt privacy.** Decision logs store a SHA-256 prefix and prompt length,
  never the text.

## Development

```bash
git clone https://github.com/siiick/pi-pignon && cd pi-pignon
npm install
pi install ./         # load the clone in place
```

```bash
npm run typecheck     # Type check
npm test              # Unit tests
npm run test:worker   # Python worker tests
npm run test:live     # Real decider calls (needs API key)
npm run schema        # Regenerate JSON Schema
npm run check         # typecheck + tests + worker tests
```

The experimental MLX worker lives in `worker/`; see
[`worker/README.md`](worker/README.md).

## License

[MIT](LICENSE) © 2026 Nicolas Chaintron

Using pignon in your own project? I'd love to hear about it —
open an issue or discussion and tell me what you made.
