import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { DEFAULT_CONFIG } from "../src/config/defaults.js";
import { parseConfig } from "../src/config/load.js";
import { PRESETS, PRESET_NAMES } from "../src/config/presets.js";
import { StrategyDecider } from "../src/deciders/strategy.js";
import { type Decider, DeciderError } from "../src/deciders/types.js";
import {
  type ModelLookup,
  choosePreset,
  detectDeciders,
  runDoctor,
  starterConfig,
  writeStarterConfig,
} from "../src/onboarding.js";
import type { ModelSpec } from "../src/types.js";

/** A registry that knows the given models, with credentials for the given providers. */
function registry(models: ModelSpec[], authed: string[]): ModelLookup<ModelSpec> {
  return {
    find: (provider, modelId) => models.find((m) => m.provider === provider && m.modelId === modelId),
    hasConfiguredAuth: (model) => authed.includes(model.provider),
  };
}

const allModels = PRESET_NAMES.flatMap((name) => Object.values(PRESETS[name].models) as ModelSpec[]);

describe("presets", () => {
  it("each preset loads without errors through extends", () => {
    for (const name of PRESET_NAMES) {
      const { config, errors } = parseConfig({ extends: name });
      expect(errors).toEqual([]);
      expect(config.table[2]!.models.direct).toEqual(PRESETS[name].models.reasoner);
    }
  });

  it("lets models override a preset", () => {
    const own = { provider: "p", modelId: "m", thinking: "off" } as const;
    const { config } = parseConfig({ extends: "anthropic", models: { fast: own } });

    expect(config.table[0]!.models.direct).toEqual(own);
    expect(config.table[1]!.models.direct).toEqual(PRESETS.anthropic.models.balanced);
  });

  it("rejects an unknown preset", () => {
    expect(parseConfig({ extends: "mistral" }).errors).toEqual([`extends: expected one of ${PRESET_NAMES.join(", ")}`]);
  });
});

describe("init", () => {
  it("chooses the preset whose models Pi can use", () => {
    expect(choosePreset(registry(allModels, ["anthropic"]))).toBe("anthropic");
    expect(choosePreset(registry(allModels, ["openai"]))).toBe("openai");
    expect(choosePreset(registry([], []))).toBe("openrouter");
  });

  it("detects the deciders that can run here, local first", async () => {
    const ok = () => ({ ok: true as const });
    const missing = () => ({ ok: false as const, reason: "x" });
    const up = async () => true;
    const down = async () => false;
    expect(await detectDeciders({ TYPESAFE_API_KEY: "k" }, ok, up)).toEqual([{ type: "laya-serve" }]);
    expect(await detectDeciders({}, ok, down)).toEqual([{ type: "laya-local" }]);
    expect(await detectDeciders({ TYPESAFE_API_KEY: "k" }, missing, down)).toEqual([{ type: "jev" }]);
    expect(await detectDeciders({}, missing, down)).toEqual([]);
  });

  it("writes a laya-serve starter config that loads cleanly", () => {
    const { config, errors } = parseConfig(starterConfig("openrouter", [{ type: "laya-serve" }]));

    expect(errors).toEqual([]);
    expect(config.deciders).toEqual([{ type: "laya-serve" }]);
  });

  it("writes a starter config that loads cleanly", () => {
    const doc = starterConfig("anthropic", [{ type: "jev" }]);
    const { config, errors, warnings } = parseConfig(doc);

    expect(errors).toEqual([]);
    expect(warnings).toEqual([]);
    expect(config.deciders).toEqual([{ type: "jev" }]);
    expect(config.table[2]!.models.direct).toEqual(PRESETS.anthropic.models.reasoner);
  });

  describe("writeStarterConfig", () => {
    let dir: string;
    beforeEach(() => {
      dir = mkdtempSync(join(tmpdir(), "pignon-init-"));
    });
    afterEach(() => {
      rmSync(dir, { recursive: true, force: true });
    });

    it("creates the file and its folder", () => {
      const path = join(dir, "agent", "pignon.json");

      expect(writeStarterConfig(path, { version: 2 })).toEqual({ ok: true, path });
      expect(JSON.parse(readFileSync(path, "utf8"))).toEqual({ version: 2 });
    });

    it("never replaces an existing file", () => {
      const path = join(dir, "pignon.json");
      writeFileSync(path, "{}");

      const result = writeStarterConfig(path, { version: 2 });

      expect(result.ok).toBe(false);
      expect(readFileSync(path, "utf8")).toBe("{}");
    });
  });
});

describe("doctor", () => {
  const answering = (id: string, remote = false): Decider => ({
    id,
    remote,
    isReady: true,
    model: `${id}-model`,
    recentLogs: [],
    warmup: async () => {},
    decide: vi.fn(async () => ({ deciderId: id, model: `${id}-model`, answers: {}, latencyMs: 12, ...(remote ? { costUsd: 0.00003 } : {}) })),
    stop: () => {},
  });
  const openrouterOk = registry(Object.values(PRESETS.openrouter.models), ["openrouter"]);
  const input = (decider: Decider, overrides: Partial<Parameters<typeof runDoctor>[0]> = {}) => ({
    config: DEFAULT_CONFIG,
    configSource: null,
    configErrors: [],
    decider,
    lookup: openrouterOk,
    env: {},
    layaStatus: () => ({ ok: true as const }),
    ...overrides,
  });

  it("reports a healthy setup, with one real decision per decider", async () => {
    const jev = answering("jev", true);

    const lines = await runDoctor(input(jev));

    expect(jev.decide).toHaveBeenCalledTimes(1);
    expect(lines).toContain("  ✓ jev (remote): jev-model answered a test prompt in 12 ms · $0.000030");
    expect(lines).toContain("  ✓ openrouter/z-ai/glm-5.3 (hard)");
    expect(lines.filter((l) => l.includes("✗") || l.includes("⚠"))).toEqual([]);
  });

  it("checks each decider of a strategy", async () => {
    const strategy = new StrategyDecider([answering("laya-local"), answering("jev", true)], DEFAULT_CONFIG.strategy, () => ({
      tier: null, tierConfidence: 0, needsExploration: false, explorationConfidence: 0, latencyMs: 0,
    }));

    const lines = await runDoctor(input(strategy));

    expect(lines).toContain("  ✓ sequential strategy over laya-local, jev");
    expect(lines.filter((l) => l.includes("answered a test prompt"))).toHaveLength(2);
  });

  it("explains a local model that cannot run, without trying it", async () => {
    const laya = answering("laya-local");

    const lines = await runDoctor(input(laya, { layaStatus: () => ({ ok: false, reason: "the local Laya model needs an Apple Silicon Mac" }) }));

    expect(laya.decide).not.toHaveBeenCalled();
    expect(lines).toContain("  ✗ laya-local: the local Laya model needs an Apple Silicon Mac");
  });

  it("starts loading a local model that is not ready instead of waiting for it", async () => {
    const warmup = vi.fn(() => new Promise<void>(() => {}));
    const laya = { ...answering("laya-local"), isReady: false, warmup };

    const lines = await runDoctor(input(laya));

    expect(warmup).toHaveBeenCalled();
    expect(lines.some((l) => l.startsWith("  ⚠ laya-local: model not loaded yet"))).toBe(true);
  });

  it("reports a decider that fails", async () => {
    const jev = { ...answering("jev", true), isReady: false, warmup: async () => Promise.reject(new DeciderError("jev: TYPESAFE_API_KEY is not set")) };

    const lines = await runDoctor(input(jev));

    expect(lines).toContain("  ✗ jev (remote): TYPESAFE_API_KEY is not set");
  });

  it("flags models that are missing or lack credentials", async () => {
    const lookup = registry([PRESETS.openrouter.models.fast], []);

    const lines = await runDoctor(input(answering("jev", true), { lookup }));

    expect(lines.some((l) => l.startsWith("  ⚠ openrouter/deepseek/deepseek-v4-flash-0731 (trivial): no credentials"))).toBe(true);
    expect(lines.some((l) => l.startsWith("  ✗ openrouter/z-ai/glm-5.3 (hard): not in Pi's model registry"))).toBe(true);
  });

  it("lists config problems", async () => {
    const lines = await runDoctor(input(answering("jev"), { configSource: "/x/pignon.json", configErrors: ["/x/pignon.json: tiers: bad"] }));

    expect(lines).toContain("  ✗ /x/pignon.json: 1 problem(s), defaults used for those parts");
    expect(lines).toContain("      /x/pignon.json: tiers: bad");
  });
});
