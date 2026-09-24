# Changelog

## Unreleased

- `/pignon login` saves the Jev (TypeSafe) API key, so you no longer have to
  export `TYPESAFE_API_KEY`. It can store a command that prints the key
  (Keychain, 1Password, …), so the key never touches the disk, or the key
  itself in `~/.pi/agent/pignon/credentials.json` (0600; refused when others
  can read it). The environment variable still wins. `/pignon logout` removes
  the key. `/pignon init` and the no-config default pick Jev when a key was
  saved.
- README: a "Choosing a decider" comparison (latency, cost, privacy, setup),
  setup steps in the order they run in Pi, and what `/pignon doctor` reports.
  The configuration reference explains where Jev's key is looked up and how to
  reach Jev through OpenRouter.
- The internal `docs/PLAN-*.md` notes are no longer shipped in the package.

## 0.1.1 — 2026-09-23

- Published on npm: `pi install npm:pi-pignon`.

- `/pignon log`, `config`, `doctor` and `/pignon-stats` (and `compare`) open in
  a scrollable overlay that closes with Esc. They used to render in a widget,
  which Pi cuts at 10 lines (doctor lost its model checks) and which stayed
  above the editor until `… clear`. `doctor` opens at once and fills in when
  its checks finish. The `clear` subcommands are still accepted but no longer
  offered.
- `/pignon log` shows the last 200 decider lines instead of 30.

## 0.1.0 — 2026-09-23

First release as **pignon** (formerly laya-llm-router, a local-only prototype).

- **Deciders**: Laya on your machine through the official `laya-serve`
  (`laya-serve`, any platform laya supports) and TypeSafe's hosted Jev (`jev`,
  through `@typesafe-ai/sdk`), behind one interface. `/pignon init` detects a
  running laya-serve. An experimental MLX worker (`laya-local`, Apple Silicon)
  can be installed from the repository.
- **Strategies**: `sequential` (ask the next decider when one is not ready,
  fails, or is not confident enough) and `parallel` (ask all, route on the most
  confident or on the first; the others are recorded for comparison).
- **Your routing table**: named models, 2 to 8 difficulty tiers with your own
  criteria, `explorationAllowed` per tier, question wording with a version label.
- **Presets** (`openrouter`, `anthropic`, `openai`) via `extends`.
- **Config** checked against a TypeBox schema, published as
  `schema/config.schema.json` for editor autocompletion.
- **Commands**: `/pignon` (modes, `log`, `config`, `config migrate`, `init`,
  `doctor`) and `/pignon-stats` (`compare`, `export`). `/laya` and `/laya-stats`
  remain as aliases for this release.
- The experimental worker is not published; its protocol version is checked
  at startup.
- `confidenceSource: "top-probability"` for checkpoints with uncalibrated
  confidence.
- laya-router config files and session entries are still read;
  `/pignon config migrate` converts the config.
