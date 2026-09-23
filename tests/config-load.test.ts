import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { DEFAULT_CONFIG, DEFAULT_MODELS, DEFAULT_THRESHOLDS, DEFAULT_TIERS } from "../src/config/defaults.js";
import { configPaths, loadConfig, parseConfig, resolveTable } from "../src/config/load.js";

const OPUS = { provider: "anthropic", modelId: "claude-opus-5-5", thinking: "high" } as const;

describe("defaults", () => {
  it("DEFAULT_CONFIG is DEFAULT_TIERS resolved over DEFAULT_MODELS", () => {
    expect(resolveTable(DEFAULT_TIERS, DEFAULT_MODELS)).toEqual({ table: DEFAULT_CONFIG.table, errors: [] });
  });

  it("an empty file means the defaults", () => {
    expect(parseConfig({})).toEqual({ config: DEFAULT_CONFIG, errors: [], warnings: [], legacy: false });
  });
});

describe("parseConfig: models and tiers", () => {
  it("lets a redefined built-in model change the default tiers that use it", () => {
    const { config, errors } = parseConfig({ models: { reasoner: OPUS } });

    expect(errors).toEqual([]);
    expect(config.table[2]!.models).toEqual({ direct: OPUS, exploration: DEFAULT_MODELS.agent });
  });

  it("builds a custom tier list from names and inline models", () => {
    const { config, errors } = parseConfig({
      models: { opus: OPUS },
      tiers: [
        { id: "easy", criterion: "Small edits", model: "fast", explorationAllowed: false },
        { id: "pro", criterion: "Everything else", direct: "opus", exploration: { provider: "p", modelId: "agent", thinking: "low" } },
      ],
    });

    expect(errors).toEqual([]);
    expect(config.table).toEqual([
      { id: "easy", criterion: "Small edits", models: { direct: DEFAULT_MODELS.fast, exploration: DEFAULT_MODELS.fast }, explorationAllowed: false },
      { id: "pro", criterion: "Everything else", models: { direct: OPUS, exploration: { provider: "p", modelId: "agent", thinking: "low" } }, explorationAllowed: true },
    ]);
  });

  it.each([
    [
      "an unknown model name",
      [{ id: "a", criterion: "a", model: "fast" }, { id: "b", criterion: "b", model: "opsu" }],
      'tiers[1] (b): unknown model name "opsu" (define it under `models`)',
    ],
    [
      "model together with direct",
      [{ id: "a", criterion: "a", model: "fast", direct: "fast" }, { id: "b", criterion: "b", model: "fast" }],
      "tiers[0] (a): use either `model` or `direct` + `exploration`, not both",
    ],
    [
      "a missing exploration model",
      [{ id: "a", criterion: "a", direct: "fast" }, { id: "b", criterion: "b", model: "fast" }],
      "tiers[0] (a): missing `exploration` model (or set `model` for both)",
    ],
    [
      "a duplicate id",
      [{ id: "a", criterion: "a", model: "fast" }, { id: "a", criterion: "b", model: "fast" }],
      "tiers[1] (a): duplicate tier id",
    ],
    [
      "no tier allowing exploration",
      [{ id: "a", criterion: "a", model: "fast", explorationAllowed: false }, { id: "b", criterion: "b", model: "fast", explorationAllowed: false }],
      "tiers: at least one tier must allow exploration",
    ],
  ])("rejects a tier list with %s and keeps the default tiers", (_case, tiers, error) => {
    const { config, errors } = parseConfig({ tiers });

    expect(errors).toEqual([error]);
    expect(config.table).toEqual(DEFAULT_CONFIG.table);
  });

  it("reports schema problems with readable paths", () => {
    const { config, errors } = parseConfig({
      tiers: [
        { id: "Easy", criterion: "a", model: "fast", colour: "red" },
        { id: "b", criterion: "b", direct: { provider: "p", modelId: "m", thinking: "max" }, exploration: 3 },
      ],
    });

    expect(errors).toEqual([
      "tiers[0].colour: unknown setting",
      'tiers[0].id: must match pattern "^[a-z][a-z0-9_-]*$"',
      "tiers[1].direct.thinking: expected one of off, low, medium, high, xhigh",
      "tiers[1].exploration: expected a model name or { provider, modelId, thinking }",
      // TypeBox collects at most 8 errors, and this list reached it.
      "tiers: more problems may follow; fix these first",
    ]);
    expect(config.table).toEqual(DEFAULT_CONFIG.table);
  });

  it("needs at least two tiers", () => {
    expect(parseConfig({ tiers: [{ id: "only", criterion: "x", model: "fast" }] }).errors).toEqual([
      "tiers: must not have fewer than 2 items",
    ]);
  });

  it("skips an invalid model entry and keeps the others", () => {
    const { config, errors } = parseConfig({ models: { opus: OPUS, broken: { provider: "p" } } });

    expect(errors).toEqual(["models.broken: must have required properties modelId, thinking"]);
    expect(config.table).toEqual(DEFAULT_CONFIG.table);
  });
});

describe("parseConfig: other sections", () => {
  it("merges thresholds over the defaults", () => {
    const { config, errors } = parseConfig({ thresholds: { minConfidenceDowngrade: 0.9, maxPaybackRequests: 5 } });

    expect(errors).toEqual([]);
    expect(config.thresholds).toEqual({ ...DEFAULT_THRESHOLDS, minConfidenceDowngrade: 0.9, maxPaybackRequests: 5 });
  });

  it("skips and reports invalid thresholds one by one", () => {
    const { config, errors } = parseConfig({
      thresholds: { minConfidenceDowngrade: "high", unknownKnob: 1, cacheGuardTokens: -5, minConfidenceUpgrade: 0.6 },
    });

    expect(errors).toEqual([
      "thresholds.minConfidenceDowngrade: expected a non-negative number",
      "thresholds.unknownKnob: unknown setting",
      "thresholds.cacheGuardTokens: expected a non-negative number",
    ]);
    expect(config.thresholds).toEqual({ ...DEFAULT_THRESHOLDS, minConfidenceUpgrade: 0.6 });
  });

  it("merges question wording over the defaults", () => {
    const { config, errors } = parseConfig({ questions: { version: "q2", explorationCriteria: { no: "Target is named" } } });

    expect(errors).toEqual([]);
    expect(config.questions).toEqual({
      ...DEFAULT_CONFIG.questions,
      version: "q2",
      explorationCriteria: { ...DEFAULT_CONFIG.questions.explorationCriteria, no: "Target is named" },
    });
  });

  it("keeps the default wording when the questions section is invalid", () => {
    const { config, errors } = parseConfig({ questions: { version: "" } });

    expect(errors).toEqual(["questions.version: must not have fewer than 1 characters"]);
    expect(config.questions).toEqual(DEFAULT_CONFIG.questions);
  });

  it("reads confidenceSource", () => {
    expect(parseConfig({ confidenceSource: "top-probability" }).config.confidenceSource).toBe("top-probability");
    expect(parseConfig({ confidenceSource: "max" }).errors).toEqual([
      "confidenceSource: expected one of reported, top-probability",
    ]);
  });

  it("reports unknown top-level keys and versions", () => {
    expect(parseConfig({ version: 3, tresholds: {} }).errors).toEqual(["tresholds: unknown setting", "version: expected 2"]);
  });

  it("accepts the $schema key", () => {
    expect(parseConfig({ $schema: "https://example.com/schema.json", version: 2 }).errors).toEqual([]);
  });

  it("rejects a non-object document", () => {
    expect(parseConfig([1, 2]).errors).toEqual(["expected a JSON object"]);
  });

  it("does not mutate the defaults", () => {
    parseConfig({ models: { fast: { provider: "p", modelId: "m", thinking: "off" } }, thresholds: { cacheGuardTokens: 1 } });
    expect(DEFAULT_MODELS.fast!.provider).toBe("openrouter");
    expect(DEFAULT_CONFIG.table[0]!.models.direct.provider).toBe("openrouter");
    expect(DEFAULT_THRESHOLDS.cacheGuardTokens).toBe(60_000);
  });
});

describe("parseConfig: deciders", () => {
  it("reads the list in order", () => {
    const deciders = [{ type: "laya-local", timeoutMs: 3000 }, { type: "jev", model: "jev-1.13.0", maxRetries: 1 }];
    const { config, errors } = parseConfig({ deciders });

    expect(errors).toEqual([]);
    expect(config.deciders).toEqual(deciders);
  });

  it("leaves the choice automatic when the section is absent", () => {
    expect(parseConfig({}).config.deciders).toBeNull();
  });

  it("refuses an API key in the file", () => {
    const { config, errors } = parseConfig({ deciders: [{ type: "jev", apiKey: "sk-live" }] });

    expect(errors).toEqual([
      "deciders[0].apiKey: keep secrets out of the config file; name the environment variable with apiKeyEnv",
    ]);
    expect(config.deciders).toBeNull();
  });

  it("skips invalid entries and keeps the valid ones", () => {
    const { config, errors } = parseConfig({
      deciders: [{ type: "gpt" }, { type: "jev", timeoutMs: 0 }, { type: "laya-local" }, { type: "laya-local" }],
    });

    expect(errors).toEqual([
      "deciders[0].type: expected one of laya-local, jev",
      "deciders[1].timeoutMs: must be > 0",
      "deciders[3]: laya-local is already listed",
    ]);
    expect(config.deciders).toEqual([{ type: "laya-local" }]);
  });

  it("rejects an empty list", () => {
    expect(parseConfig({ deciders: [] }).errors).toEqual(["deciders: expected a non-empty list"]);
  });
});

describe("parseConfig: laya-router (v1) tiers", () => {
  it("merges tier cells over the defaults and flags the format", () => {
    const { config, errors, warnings, legacy } = parseConfig({ tiers: { hard: { direct: OPUS } } });

    expect(errors).toEqual([]);
    expect(legacy).toBe(true);
    expect(warnings).toEqual(["`tiers` uses the laya-router format; run /pignon config migrate to convert it"]);
    expect(config.table[2]!.models).toEqual({ direct: OPUS, exploration: DEFAULT_MODELS.agent });
    expect(config.table[0]).toEqual(DEFAULT_CONFIG.table[0]);
  });

  it("skips and reports invalid cells", () => {
    const { config, errors } = parseConfig({
      tiers: { extreme: {}, hard: { sideways: {}, direct: { provider: "p", modelId: "m", thinking: "max" } } },
    });

    expect(errors).toEqual([
      "tiers.extreme: unknown tier",
      "tiers.hard.sideways: unknown form",
      "tiers.hard.direct: expected { provider, modelId, thinking }",
    ]);
    expect(config.table).toEqual(DEFAULT_CONFIG.table);
  });
});

describe("loadConfig", () => {
  let dir: string;
  let paths: { path: string; legacyPath: string };

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "pignon-config-"));
    paths = { path: join(dir, "pignon.json"), legacyPath: join(dir, "laya-router.json") };
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("uses the defaults when neither file exists", () => {
    expect(loadConfig(paths)).toEqual({ config: DEFAULT_CONFIG, source: null, errors: [], warnings: [], legacy: false });
  });

  it("reads pignon.json", () => {
    writeFileSync(paths.path, JSON.stringify({ thresholds: { minPromptsBetweenSwitches: 4 } }));

    const loaded = loadConfig(paths);
    expect(loaded).toMatchObject({ source: paths.path, errors: [], warnings: [], legacy: false });
    expect(loaded.config.thresholds.minPromptsBetweenSwitches).toBe(4);
  });

  it("falls back to the laya-router file and asks to migrate it", () => {
    writeFileSync(paths.legacyPath, JSON.stringify({ thresholds: { minPromptsBetweenSwitches: 4 } }));

    const loaded = loadConfig(paths);
    expect(loaded).toMatchObject({ source: paths.legacyPath, legacy: true });
    expect(loaded.warnings[0]).toContain("/pignon config migrate");
    expect(loaded.config.thresholds.minPromptsBetweenSwitches).toBe(4);
  });

  it("prefers pignon.json over the laya-router file", () => {
    writeFileSync(paths.path, JSON.stringify({}));
    writeFileSync(paths.legacyPath, JSON.stringify({ thresholds: { minPromptsBetweenSwitches: 4 } }));

    expect(loadConfig(paths)).toMatchObject({ source: paths.path, config: DEFAULT_CONFIG });
  });

  it("reports invalid JSON and falls back to the defaults", () => {
    writeFileSync(paths.path, "{ not json");

    const loaded = loadConfig(paths);
    expect(loaded.config).toEqual(DEFAULT_CONFIG);
    expect(loaded.errors).toHaveLength(1);
    expect(loaded.errors[0]).toContain(paths.path);
  });

  it("prefixes validation errors with the file path", () => {
    writeFileSync(paths.path, JSON.stringify({ thresholds: { nope: 1 } }));

    expect(loadConfig(paths).errors).toEqual([`${paths.path}: thresholds.nope: unknown setting`]);
  });
});

describe("configPaths", () => {
  it("honours PIGNON_CONFIG and LAYA_ROUTER_CONFIG", () => {
    expect(configPaths({ PIGNON_CONFIG: "/etc/pignon.json", LAYA_ROUTER_CONFIG: "/etc/laya.json" })).toEqual({
      path: "/etc/pignon.json",
      legacyPath: "/etc/laya.json",
    });
  });

  it("defaults to ~/.pi/agent", () => {
    const { path, legacyPath } = configPaths({});
    expect(path).toMatch(/\.pi\/agent\/pignon\.json$/);
    expect(legacyPath).toMatch(/\.pi\/agent\/laya-router\.json$/);
  });
});
