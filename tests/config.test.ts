import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { defaultConfigPath, loadConfig, parseConfig } from "../src/config.js";
import { DEFAULT_CONFIG, DEFAULT_THRESHOLDS, DEFAULT_TIERS } from "../src/types.js";

describe("parseConfig", () => {
  it("merges thresholds and tier cells over the defaults", () => {
    const { config, errors } = parseConfig({
      thresholds: { minConfidenceDowngrade: 0.9, maxPaybackRequests: 5 },
      tiers: { hard: { direct: { provider: "anthropic", modelId: "claude-opus-5-5", thinking: "high" } } },
    });

    expect(errors).toEqual([]);
    expect(config.thresholds).toEqual({
      ...DEFAULT_THRESHOLDS,
      minConfidenceDowngrade: 0.9,
      maxPaybackRequests: 5,
    });
    expect(config.tiers.hard.direct).toEqual({ provider: "anthropic", modelId: "claude-opus-5-5", thinking: "high" });
    expect(config.tiers.hard.exploration).toEqual(DEFAULT_TIERS.hard.exploration);
    expect(config.tiers.trivial).toEqual(DEFAULT_TIERS.trivial);
  });

  it("does not mutate the defaults", () => {
    parseConfig({ tiers: { trivial: { direct: { provider: "p", modelId: "m", thinking: "off" } } } });
    expect(DEFAULT_CONFIG.tiers.trivial.direct.provider).toBe("openrouter");
  });

  it("skips and reports invalid entries", () => {
    const { config, errors } = parseConfig({
      thresholds: { minConfidenceDowngrade: "high", unknownKnob: 1, cacheGuardTokens: -5 },
      tiers: {
        extreme: {},
        hard: { sideways: {}, direct: { provider: "p", modelId: "m", thinking: "max" } },
      },
    });

    expect(errors).toEqual([
      "thresholds.minConfidenceDowngrade: expected a non-negative number",
      "thresholds.unknownKnob: unknown setting",
      "thresholds.cacheGuardTokens: expected a non-negative number",
      "tiers.extreme: unknown tier",
      "tiers.hard.sideways: unknown form",
      "tiers.hard.direct: expected { provider, modelId, thinking }",
    ]);
    expect(config).toEqual(DEFAULT_CONFIG);
  });

  it("rejects a non-object document", () => {
    expect(parseConfig([1, 2]).errors).toEqual(["expected a JSON object"]);
  });
});

describe("loadConfig", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "laya-config-"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("uses the defaults when the file does not exist", () => {
    expect(loadConfig(join(dir, "missing.json"))).toEqual({
      config: DEFAULT_CONFIG,
      source: null,
      errors: [],
    });
  });

  it("reads a valid file", () => {
    const path = join(dir, "laya-router.json");
    writeFileSync(path, JSON.stringify({ thresholds: { minPromptsBetweenSwitches: 4 } }));

    const loaded = loadConfig(path);
    expect(loaded.source).toBe(path);
    expect(loaded.errors).toEqual([]);
    expect(loaded.config.thresholds.minPromptsBetweenSwitches).toBe(4);
  });

  it("reports invalid JSON and falls back to the defaults", () => {
    const path = join(dir, "laya-router.json");
    writeFileSync(path, "{ not json");

    const loaded = loadConfig(path);
    expect(loaded.config).toEqual(DEFAULT_CONFIG);
    expect(loaded.errors).toHaveLength(1);
    expect(loaded.errors[0]).toContain(path);
  });

  it("prefixes validation errors with the file path", () => {
    const path = join(dir, "laya-router.json");
    writeFileSync(path, JSON.stringify({ thresholds: { nope: 1 } }));

    expect(loadConfig(path).errors).toEqual([`${path}: thresholds.nope: unknown setting`]);
  });
});

describe("defaultConfigPath", () => {
  it("honours LAYA_ROUTER_CONFIG", () => {
    expect(defaultConfigPath({ LAYA_ROUTER_CONFIG: "/etc/laya.json" })).toBe("/etc/laya.json");
  });

  it("defaults to ~/.pi/agent/laya-router.json", () => {
    expect(defaultConfigPath({})).toMatch(/\.pi\/agent\/laya-router\.json$/);
  });
});
