# Changelog

## 0.1.0 — unreleased

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
