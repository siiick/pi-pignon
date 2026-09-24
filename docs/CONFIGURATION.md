# Configuration

pignon reads `~/.pi/agent/pignon.json` (or the path in `PIGNON_CONFIG`).
Every key is optional: with no file, it uses the built-in defaults shown below.
Add the `$schema` line for autocompletion and inline validation in your editor.

```json
{
  "$schema": "https://raw.githubusercontent.com/siiick/pi-pignon/main/schema/config.schema.json",
  "version": 2
}
```

Run `/pignon config` to see the resolved table currently in use.

## Environment variables

| Variable | Default | Description |
|----------|---------|-------------|
| `PIGNON_CONFIG` | `<Pi config dir>/pignon.json` | Path of the optional config file |
| `PI_CODING_AGENT_DIR` | `~/.pi/agent` | Pi's config directory; pignon keeps its config, exports and saved key (`pignon/credentials.json`) there |
| `TYPESAFE_API_KEY` | *(unset)* | Jev API key (another variable can be named with `apiKeyEnv`). Takes precedence over a key saved with `/pignon login` |
| `TYPESAFE_BASE_URL` | `https://api.typesafe.ai` | Jev API root, when `baseURL` is not set |
| `TYPESAFE_DEFAULT_MODEL` | `jev-latest` | Jev model, when `model` is not set |
| `LAYA_ROUTER_CONFIG` | `~/.pi/agent/laya-router.json` | **Legacy:** read only when there is no pignon config |

laya-serve reads its own `LAYA_*` variables (`LAYA_HOST`, `LAYA_PORT`, `LAYA_MODELS`, `LAYA_API_KEY`, …) when it starts; see [Laya's documentation](https://pypi.org/project/laya/). The variables of the experimental worker are listed in its [section below](#experimental-pignons-mlx-worker).

## Deciders

`deciders` picks the decision model. `/pignon init` writes it for you. Without it, pignon uses the experimental worker when installed, else Jev when `TYPESAFE_API_KEY` is set or a key was saved with `/pignon login`; it does not look for laya-serve on its own.

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
| | `apiKeyEnv` | `TYPESAFE_API_KEY` | Environment variable holding the key. When it is unset, the key saved with `/pignon login` is used, but only when neither `apiKeyEnv` nor `baseURL` is set, so the TypeSafe key never goes elsewhere. Keys are never read from the config file |
| | `baseURL` | TypeSafe | Another API root, e.g. [OpenRouter](#jev-through-openrouter) |
| | `timeoutMs` | `1500` | Timeout for one decision |
| | `maxRetries` | `0` | Retries after a failed call; each gets the full timeout |

### Jev's API key

pignon looks for the key in this order:

1. the environment variable named by `apiKeyEnv` (`TYPESAFE_API_KEY` by default);
2. the key saved with `/pignon login`, in `<Pi config dir>/pignon/credentials.json`: either the key itself, or a `!command` that prints it (run once per session, e.g. to read the macOS Keychain or 1Password). The file must be readable by you only (`chmod 600`).

`/pignon login` and `/pignon logout` take effect after `/reload`. A saved key is only used for TypeSafe's own API: never with a `baseURL` or `apiKeyEnv` of your own, and never for laya-serve.

### Jev through OpenRouter

Jev is also reachable through OpenRouter. `/pignon login` does not apply there: export your OpenRouter key and name it in the config:

```json
{
  "deciders": [
    { "type": "jev", "baseURL": "https://openrouter.ai/api", "apiKeyEnv": "OPENROUTER_API_KEY" }
  ]
}
```

Run `/pignon doctor` to check that it answers.

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

**Benchmark Laya against Jev** without changing how you route: keep Laya in charge and record Jev's answers next to it, then compare.

```json
{
  "deciders": [{ "type": "laya-serve" }, { "type": "jev" }],
  "strategy": { "mode": "parallel", "pick": "first" }
}
```

`/pignon-stats compare` shows tier and exploration agreement, a confusion matrix, mean confidence, latency, failures and cost per decider.
`/pignon-stats export` writes every decision (with each decider's answer) as JSON lines for your own analysis. In parallel mode, every routed prompt is sent to Jev.

Laya's confidence is low (0.05–0.27 on typical prompts: the checkpoint's temperatures are uncalibrated), so with the default `escalateBelow` of 0.75, sequential mode asks Jev on almost every prompt. Lower `escalateBelow`, or set `"confidenceSource": "top-probability"` (see [Other settings](#other-settings)).

### Start laya-serve at login (macOS)

A launchd agent keeps laya-serve running in the background and restarts it if it stops. Save this as `~/Library/LaunchAgents/local.laya-serve.plist`, replacing `/Users/you/.local/bin/laya-serve` with the output of `which laya-serve`:

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

## Experimental: pignon's MLX worker

pignon also has its own Laya worker (`worker/` in this repository), built on [laya-mlx](https://github.com/mizorewww/laya-mlx). It is a little faster than laya-serve on Apple Silicon (~61 ms against ~75 ms per decision, with the same answers), smaller to install, and needs no server: pignon starts it with the session and stops it afterwards. It is **experimental and not published**, and its interface may change; prefer laya-serve.

It needs an Apple Silicon Mac and a clone of this repository:

```bash
git clone https://github.com/siiick/pi-pignon
uv tool install ./pi-pignon/worker            # puts pignon-laya on PATH
```

then `"deciders": [{ "type": "laya-local" }]`. pignon starts the worker with the first of:

1. `command` in the `laya-local` decider, e.g. `["uv", "run", "--project", "/path/to/pi-pignon/worker", "pignon-laya"]`;
2. `LAYA_PYTHON`, running `laya_worker.py` from `LAYA_WORKER_DIR`;
3. a source checkout's `worker/.venv` (after `uv sync`), when pignon itself runs from that checkout;
4. `pignon-laya` on `PATH`.

`/pignon doctor` says which one is used. The worker reports its protocol version when it starts; pignon refuses a worker it cannot talk to and says which side to update. Its settings:

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

## Swap a model

Tiers refer to models by name. The built-in names are `fast`, `balanced`, `reasoner` and `agent`; redefine one to change every tier that uses it:

```json
{
  "$schema": "https://raw.githubusercontent.com/siiick/pi-pignon/main/schema/config.schema.json",
  "version": 2,
  "models": {
    "reasoner": { "provider": "anthropic", "modelId": "claude-opus-5-5", "thinking": "high" }
  }
}
```

`thinking` is one of `off`, `low`, `medium`, `high`, `xhigh`; Pi clamps it to what the model supports. Check model ids with `pi --list-models`.

## Presets

A preset fills the four built-in model names from one provider. Use it with `extends`, and override any name under `models`:

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

Presets are starting points, not recommendations: check prices and quality on your own work (`/pignon-stats`, shadow mode).

## Write your own tiers

`tiers` replaces the built-in list as a whole: 2 to 8 tiers, **easiest first** (position is rank, so moving down the list is a downgrade). Each tier has:

| Key | Meaning |
|-----|---------|
| `id` | Tier name shown on decision cards (lowercase, digits, `-`, `_`) |
| `criterion` | How to recognize a task of this tier. **This is the text the decision model reads**, so write it as a description of the task |
| `model` | Model for every task of the tier… |
| `direct` / `exploration` | …or one model for each form |
| `explorationAllowed` | `false` sends tasks that need exploration to the next tier up (default `true`) |

A model is a name from `models` or an inline `{ provider, modelId, thinking }`. See [`examples/pignon.json`](../examples/pignon.json) for a four-tier table.

When you change the wording of criteria or questions, also change `questions.version`: it is stored with each decision, so you can tell which wording your thresholds were calibrated on.

### Built-in table

| Tier | Direct | Exploration |
|------|--------|-------------|
| trivial | `fast`: `openrouter/deepseek/deepseek-v4-flash-0731` · off | → standard (`explorationAllowed: false`) |
| standard | `balanced`: `openrouter/deepseek/deepseek-v4.1-flash` · low | same |
| hard | `reasoner`: `openrouter/z-ai/glm-5.3` · high | `agent`: `openrouter/tencent/hy4-preview` · low |

## Other settings

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

## Coming from laya-router

A `~/.pi/agent/laya-router.json` is still read when there is no `pignon.json`,
including its old `tiers: { hard: { direct: … } }` format. pignon warns at
session start; run `/pignon config migrate` to write the equivalent
`pignon.json` (a `pignon.json` in the old format is backed up to
`pignon.json.bak` first), then `/reload`.
