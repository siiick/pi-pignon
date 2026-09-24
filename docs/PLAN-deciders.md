# Plan (pignon): pluggable deciders (local Laya + remote Jev) and a user-defined routing table

Status: implemented in 0.1.0 · 2026-09-23

## Goals

1. **Remote decider.** Route with TypeSafe's Jev (hosted, via `@typesafe-ai/sdk`) as well
   as the local Laya worker. Jev is used as a *fallback*: when Laya is unavailable, errors,
   or answers below a confidence floor.
2. **User-owned routing table.** Move the model map and the difficulty tiers out of
   `types.ts` into config. Users name their own models and write their own ordered list of
   difficulty tiers (2..N, with the criterion text sent to the decider).
3. **Publishable.** Easy setup, a schema-checked config, docs, tests, and modules small
   enough to read one at a time.

Non-goals (for now): fine-tuning Laya, per-project config, and asking questions other than
tier and form.

## What stays the same

- The routing policy (`policy.ts`) keeps its algorithm: confidence gates, cooldown, payback
  and cache guard, fail-open.
- Pi wiring: modes (shadow/live/off), manual pin, decision cards, `/pignon-stats` (renamed from `/laya*`, kept as aliases for one release).
- The Laya worker protocol and the Python worker. Only the TS client moves.
- Prompt privacy on the local path (the hash and length are logged, never the text).

## Facts that constrain the design (from the SDK v0.6.0 `.d.ts`)

| Fact | Consequence |
|---|---|
| `TypeSafeClient({ apiKey, baseURL, defaultModel, timeout, retry, logger, logLevel, fetch })` | `fetch` can be injected, so tests need no network. `baseURL: "https://openrouter.ai/api"` + an OpenRouter key also works. |
| Env fallbacks: `TYPESAFE_API_KEY`, `TYPESAFE_BASE_URL`, `TYPESAFE_DEFAULT_MODEL` | Nothing to configure for the common case. |
| `timeout` applies **per attempt**, default 2 retries, no total budget | Set `retry.maxRetries: 0` (or 1) and bound the whole call with our own `AbortSignal.timeout`. |
| Default logger is `console`, and `debug` logs request **bodies** | Pass our own logger (into the `/pignon log` ring buffer), cap `logLevel` at `warn`, so nothing draws over the TUI and prompts never reach logs. |
| `ChoiceResponse` = `{ choice, confidence, probabilities }`, **no `type` field** | The shared parser must not require `type === "choice"` (the local worker's `choiceOf` does today). |
| `usage` has tokens; cost comes back at runtime but is not typed | Record `costUsd` when present and show it in stats. |
| 70–500 ms latency, 32k-token state limit, input-billed | Separate timeout per decider (Jev ≈ 1500 ms). Keep the 4 000-char prompt cap for both deciders. |
| Error classes: `AuthenticationError`, `RateLimitError`, `APITimeoutError`, `APIUserAbortError`… | Map them to short status texts ("jev: bad API key", "jev: rate limited"). |

## Architecture

```
            ┌──────────────── extension.ts (Pi wiring only) ────────────────┐
prompt ───► │ router.ts: routePrompt()                                      │
            │   deciders/*  ──► RoutingDecision ──► policy.decide() ──► setModel
            └───────────────────────────────────────────────────────────────┘

deciders/
  types.ts        Decider interface, DecisionQuestions, RawAnswers
  questions.ts    build the tier/form questions from config (single source)
  parse.ts        RawAnswers → RoutingDecision (shared, tolerant)
  laya-local.ts   LayaWorker (today's laya-worker.ts) implementing Decider
  jev.ts          TypeSafeClient adapter implementing Decider
  fallback.ts     FallbackDecider: tries deciders in order, escalating on low confidence
  create.ts       factory: config → Decider
```

### The `Decider` seam

```ts
export interface Decider {
  readonly id: string;                 // "laya-local" | "jev" | "fallback(laya-local→jev)"
  readonly label: string;              // shown on the spinner and card, e.g. "jev-1.13.0"
  readonly isReady: boolean;           // local: model warm; remote: key present
  readonly remote: boolean;            // prompt leaves the machine → shown on the card
  warmup(signal?: AbortSignal): Promise<void>;
  decide(q: DecisionQuestions, text: string, signal: AbortSignal): Promise<DeciderResult>;
  stop(): void;
  readonly recentLogs: readonly string[];
}

export interface DeciderResult {
  answers: RawAnswers;                 // { reasoning_demand: {choice, confidence}, needs_exploration: … }
  deciderId: string;                   // which decider actually answered
  model: string;                       // checkpoint / jev model version
  latencyMs: number;
  costUsd?: number;
  attempts: Attempt[];                 // one per decider tried (for the card and stats)
}
```

`parse.ts` turns `answers` into `RoutingDecision` against the **configured** tier ids, so the
policy never sees decider-specific shapes.

### Fallback semantics (`FallbackDecider`)

Config order is the try order. For each decider:

1. Skip it if it is not ready (e.g. Laya still loading) → record `skipped: not ready`.
2. Call it with its own timeout, under the caller's signal.
3. Accept the answer if `tierConfidence >= escalateBelow` **or** it is the last decider.
4. Otherwise escalate: record the attempt and try the next one.

If every decider fails, rethrow → the policy fails open (as today). When the last decider
answers with *lower* confidence than an earlier one, keep the most confident answer. An
overall `budgetMs` (default 3000) caps total latency, so a slow Laya plus a slow Jev cannot
stall a prompt.

Defaults: `escalateBelow: 0.75`, and escalate on error and on not-ready.

## Configuration (v2)

One JSON file, as today (`~/.pi/agent/pignon.json` or `$PIGNON_CONFIG`; the old `laya-router.json` is read as a fallback with a rename hint). Every
key is optional; defaults reproduce today's behavior exactly.

```jsonc
{
  "$schema": "https://unpkg.com/pignon/schema/config.schema.json",
  "version": 2,

  // 1. Deciders, in fallback order
  "deciders": [
    { "type": "laya-local", "timeoutMs": 2500 },               // optional: model, python, workerDir…
    { "type": "jev", "timeoutMs": 1500, "model": "jev-1.13.0" } // apiKey from TYPESAFE_API_KEY
  ],
  "strategy": { "mode": "sequential", "escalateBelow": 0.75 },   // see "Decision strategies"

  // 2. Model aliases: define once, reference by name
  "models": {
    "flash":    { "provider": "openrouter", "modelId": "deepseek/deepseek-v4-flash-0731", "thinking": "off" },
    "flash-41": { "provider": "openrouter", "modelId": "deepseek/deepseek-v4.1-flash", "thinking": "low" },
    "glm":      { "provider": "openrouter", "modelId": "z-ai/glm-5.3", "thinking": "high" },
    "hy4":      { "provider": "openrouter", "modelId": "tencent/hy4-preview", "thinking": "low" }
  },

  // 3. Difficulty tiers, easiest first. The criterion is what the decider reads.
  "tiers": [
    { "id": "trivial",  "criterion": "Mechanical edit, rename, formatting, or a single factual lookup",
      "model": "flash", "explorationAllowed": false },
    { "id": "standard", "criterion": "Localized change across a few files with clear intent",
      "model": "flash-41" },
    { "id": "hard",     "criterion": "Multi-step investigation, debugging with unclear cause, or cross-cutting design",
      "direct": "glm", "exploration": "hy4" }
  ],

  // Optional wording overrides; bump questionsVersion whenever you edit criteria.
  "questions": { "version": "q1", "tierInstructions": "…", "explorationInstructions": "…" },

  "thresholds": { "minConfidenceDowngrade": 0.85 }
}
```

Rules:

- A tier gives either `model` (both forms) or `direct` + `exploration`. A value can be an
  alias or an inline `{ provider, modelId, thinking }`.
- `explorationAllowed: false` generalizes today's hard-coded "exploration forbids trivial"
  rule: an exploration task at that tier goes up to the next tier that allows it.
- Need 2..8 tiers with unique ids. Unknown alias → error naming the tier.
- `version` missing + the old `tiers: { hard: { direct: … } }` object shape → migrate in
  memory and notify once ("config uses v1 format; run `/pignon config migrate`").
- Invalid config: same contract as today. Report it on session start, fall back per
  section, never block loading.
- **Secrets never go in the file.** `jev.apiKeyEnv` (default `TYPESAFE_API_KEY`) names the
  variable. A literal `apiKey` is rejected with a message.

### Validation

Use TypeBox (see "Validation with TypeBox" below). The schema module is the single source
for the TS types, the runtime checks, and `schema/config.schema.json`.

### Presets and onboarding

- `presets/openrouter.json` (today's table), `presets/anthropic.json`, `presets/openai.json`.
  Config can say `"extends": "openrouter"` and override only what differs.
- `/pignon init [preset]` writes a starter config (it refuses to overwrite an existing file),
  lists the models from `ctx.modelRegistry` that resolve, and flags those that do not.
- `/pignon doctor` checks each decider (worker venv present? Apple Silicon? key set? one test
  `decide` round-trip) and each table model (in registry? auth?), with one ✓/✗ line per check.
- `/pignon config` shows the resolved table (tier × form → model · thinking) and its source.

## Code changes, file by file

| File | Change |
|---|---|
| `src/types.ts` | Drop `Tier` union, `DEFAULT_TIERS`, `TIER_ORDER`; keep protocol + policy types. `Profile.tier: TierId` (string). Add `DeciderAttempt`, extend `RouterLogEntry` with `decider`, `escalated`, `attempts`, `costUsd`, `questionsVersion`. |
| `src/config/schema.ts` | TypeBox schema, v1→v2 migration. |
| `src/config/load.ts` | Today's `loadConfig` (file read, error collection) on top of the schema; resolves `extends` and aliases into a `ResolvedConfig` whose `table` is an ordered array. |
| `src/config/defaults.ts` | Default models, tiers, and deciders (`[laya-local]` so behavior does not change on upgrade). |
| `src/deciders/*` | See the architecture section. `laya-worker.ts` moves to `deciders/laya-local.ts` with its public API unchanged, plus a thin `Decider` adapter. |
| `src/policy.ts` | Tier order comes from `config.table` (index = rank). The trivial/exploration rule reads `explorationAllowed`. `profileFromModel` takes the table. |
| `src/router.ts` | New: `routePrompt` + `buildLogEntry` pulled out of `extension.ts` (Pi-free except for a small `RouterHost` interface: `findModel`, `setModel`, `setThinking`, `contextTokens`), so it can be tested without Pi mocks. |
| `src/extension.ts` | Wiring only: build the decider from config, register hooks and commands. Spinner/status text use `decider.label`. |
| `src/ui.ts` | Card head shows the decider that answered (`laya` / `jev ☁`), escalation (`laya 0.62 → jev 0.91`), and cost. Stats grid rows come from the config tiers. |
| `package.json` | `@typesafe-ai/sdk` and `typebox` in `dependencies`; `files`, `license`, `repository`, `keywords: ["pi-package", "pi-extension"]`; drop `private`. |

The old `~/.pi/agent/extensions/jev-router` becomes redundant: its behavior equals
`deciders: [{ "type": "jev" }]`. Remove it after migration so two routers don't both fire.

## Tests

| Suite | Covers |
|---|---|
| `deciders/contract.test.ts` | One shared suite run against every `Decider` (Laya via a fake spawn, Jev via an injected `fetch`): ready/not-ready, abort, timeout, malformed answers, `stop()`. |
| `deciders/jev.test.ts` | Request body (questions from config, 4 000-char cap, model pin); SDK errors → short messages; `maxRetries` 0; no console output; cost parsing; missing key → `isReady=false`, never throws at construction. |
| `deciders/fallback.test.ts` | Escalation on low confidence, error, and not-ready; keeps the best answer; overall budget; caller abort stops the chain; `attempts` recorded. |
| `config/*.test.ts` | Schema accept/reject tables, alias resolution, `extends`, v1 migration, literal-apiKey rejection, per-section fallback, JSON Schema file up to date. |
| `policy.test.ts` | Existing 38 cases kept, parameterized over a 2-tier and a 4-tier table; `explorationAllowed`. |
| `router.test.ts` | End-to-end through `RouterHost` fakes (moves most of `extension-routing.test.ts`). |
| `extension.test.ts` | Commands incl. `init`, `doctor`, `config`. |
| `live.test.ts` | Skipped unless `TYPESAFE_API_KEY` is set (`npm run test:live`): one real Jev call checks the response shape still matches the parser. |

`npm run check` = typecheck + unit + worker tests + schema freshness. No network in `check`.

## Docs

- `README.md`, restructured: 60-second quickstart (Jev only: set the key, `/pignon init`,
  `/pignon live`), then "Add the local Laya model (Apple Silicon)", then Configuration
  reference, Commands, How routing decides, Privacy, Troubleshooting (`/pignon doctor`).
- **Privacy section:** local Laya keeps prompts on the machine. Jev sends the first 4 000
  characters of each routed prompt to TypeSafe (or OpenRouter). The card marks remote
  decisions with ☁.
- `docs/configuration.md`: every key, generated tables from the schema descriptions.
- `docs/writing-tiers.md`: how to write criteria, why to bump `questions.version`, and how
  to calibrate thresholds from `/laya-stats` in shadow mode.
- `CHANGELOG.md`, `LICENSE`, and `examples/*.json`.

## Phases (each ends green on `npm run check`)

1. ✅ **Seam, no behavior change.** `git init`; add the `Decider` interface; wrap `LayaWorker`;
   move parsing to `parse.ts`; extract `router.ts`. Existing tests keep passing.
2. ✅ **Configurable table.** TypeBox schema, aliases, ordered tiers, questions built from config,
   v1 migration, dynamic tiers in policy/UI/stats.
3. ✅ **Jev decider.** SDK adapter, error mapping, logger/retry hardening, contract + unit tests.
4. ✅ **Strategies.** sequential + parallel, budget, `/pignon-stats compare|export`, attempts on card and log, stats
   per decider (escalation rate, cost).
5. ✅ **Onboarding.** Presets + `extends`, `/pignon init|doctor|config`, JSON Schema generation.
6. ✅ **Publish.** ~~PyPI `pignon-laya` + uvx launcher~~ (dropped, see below) + protocol check, docs, package metadata, live test,
   `npm pack` dry-run, and a test install into a clean `~/.pi` via `pi install`/symlink. Retire `jev-router`.
   Released as git tag `v0.1.0` (`pi install git:github.com/siiick/pignon@v0.1.0`); npm is deferred, the package
   is ready for it (only the Pi package gallery needs npm).
7. ✅ **laya-serve.** `laya-serve` decider over the Jev client (no key, local when on loopback), detected by
   `/pignon init`, documented as the way to run Laya locally; `laya-local` becomes experimental.

## Decision (2026-09-23): laya-serve instead of publishing pignon-laya

The official `laya` package already ships `laya-serve`, a server speaking Jev's
`POST /v1/systemone`. Benchmarked through pignon's own deciders on 12 prompts × 5 rounds:
same tier and exploration answers on 12/12 (probabilities equal to ~0.001), p50 75 ms
against 61 ms for the MLX worker, 2–3 s restart (18 s on the very first run), 712 MB
installed against 258 MB. A stopped server refuses connections within milliseconds, so
prompts are never held. Publishing our own package would duplicate it for ~14 ms, so
`pignon-laya` stays in the repository, unpublished (PyPI's `Private :: Do Not Upload`
classifier), and the uvx launcher is removed. A `serve` command upstream in laya-mlx
would bring MLX speed to everyone; to propose there.

## Decisions (2026-09-23)

1. **Default deciders.** Laya if its runtime can start, else Jev if a key is set, else a
   status that says "no decider, run `/pignon doctor`". Resolved once per session, and
   `/pignon config` shows which one was picked.
2. **Name: `pignon`** (the sprocket on a bike cassette: the router changes sprockets between tiers). npm `pignon`, PyPI `pignon-laya`, commands `/pignon` and `/pignon-stats`, config `~/.pi/agent/pignon.json`, env prefix `PIGNON_` (`LAYA_*` stays for the worker itself).
3. **Validation: TypeBox**, not zod (see below).
4. **Both strategies**, `sequential` and `parallel`, with a comparison view for benchmarking.

## Validation with TypeBox (replaces the zod section)

TypeBox 1.x (`typebox` on npm, 1.3.x; Pi itself depends on 1.3.27) builds schemas that
*are* JSON Schema objects:

- Types: `Static<typeof ConfigSchema>`.
- Checking: `Compile(ConfigSchema)` from `typebox/compile`. Its `.Errors(value)` gives
  instance paths for the notify message.
- JSON Schema: `npm run schema` writes `JSON.stringify(ConfigSchema, null, 2)` to
  `schema/config.schema.json`. No converter needed. A test fails if the file is stale.
- Add `typebox` as our own `dependency` (range `^1.3.27`). It is not hoisted from Pi.

## Decision strategies

```jsonc
"deciders": [ { "type": "laya-local" }, { "type": "jev" } ],
"strategy": {
  "mode": "sequential",          // or "parallel"
  "escalateBelow": 0.75,         // sequential: try the next decider below this confidence
  "pick": "most-confident",      // parallel: "most-confident" | "first" (list order wins when it answers)
  "budgetMs": 3000               // both modes: total wall time
}
```

- **sequential** (default): the fallback behavior above. Cheapest; Jev is only called
  when needed.
- **parallel**: every ready decider runs at once under `budgetMs`. The router then uses
  one answer, chosen by `pick`. With `pick: "first"`, Laya stays authoritative and Jev
  only runs alongside it for comparison: this is the benchmarking setup. Note that every
  routed prompt then costs a Jev call and sends the prompt out.
- Every attempt is logged (`decider`, `model`, tier, confidences, latency, cost, error), so
  the data is the same in both modes.
- `/pignon-stats compare` shows, over the session's parallel decisions, the tier agreement rate
  and a Laya × Jev confusion matrix, the form agreement rate, mean confidence per decider,
  p50/p95 latency, and total Jev cost. `/pignon-stats export` writes the attempts as JSONL
  (hashes, not prompts) for offline analysis or future fine-tuning labels.

## Distributing the optional Laya runtime

Laya needs Python, `laya-mlx` (MLX), and Apple Silicon. Most users of a published
extension will have none of these. So the runtime must be **opt-in**, **outside the npm
package**, and it **must survive extension updates**.

| Option | Verdict |
|---|---|
| Ship `worker/` in the npm package; user runs `uv sync` inside `node_modules/…` | ✗ The venv is hidden, is wiped on every update, and the absolute paths break (already an issue today with `rsync`). |
| Prebuilt binary (PyInstaller) as an optional npm dependency | ✗ MLX + Metal make it large, it needs code signing and notarization, and it rebuilds on every laya-mlx release. |
| Docker | ✗ No Metal GPU in containers on macOS. |
| **Separate PyPI package, launched with `uvx`** | ✓ Recommended. |

**Recommended design:**

- Publish `worker/` to PyPI as `pignon-laya` (`[project.scripts] pignon-laya = "laya_worker:main"`,
  dependency `laya-mlx`). It is a separate release artifact with its own version, and it
  lives in the same repo.
- The npm package does **not** include `worker/` (`files` whitelist).
- Launch order in the `laya-local` decider:
  1. `command` in config (dev: `["uv", "run", "--project", "./worker", "pignon-laya"]`);
  2. `pignon-laya` on `PATH` (for `uv tool install pignon-laya` or `pipx`);
  3. `uvx --from pignon-laya==<compatible range> pignon-laya`. It installs nothing up
     front, uv caches the environment outside the extension, and it survives npm updates;
  4. none of these → `isReady = false` with a clear reason; the strategy skips it.
- **Protocol handshake:** the `ready` line already carries `PROTOCOL_VERSION` (0.3.0).
  The extension declares the major version it accepts and refuses a mismatch with an
  "upgrade with `uv tool upgrade pignon-laya`" message instead of misparsing.
- **Platform gate:** on anything other than `darwin`/`arm64`, the decider reports
  "unsupported platform" without trying to spawn anything.
- **Onboarding:** `/pignon laya install` runs `uv tool install pignon-laya` and then a warmup
  (the first checkpoint download is about 850 MB; progress goes to the log widget). It
  asks first and needs `uv` (doctor links to the uv installer).
- **Worker tests** stay in the Python package. `npm run check` still runs them in the repo.
- The existing env allowlist, the model pinning, and the stderr capture are unchanged.
