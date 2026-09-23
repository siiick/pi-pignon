import { describe, expect, it } from "vitest";
import { decide, formOf, paybackRequests, profileFromModel } from "../src/policy.js";
import { type Profile, type RoutingDecision, type Price, type RoutingTable, DEFAULT_THRESHOLDS, DEFAULT_TIERS } from "../src/types.js";

/** Table where every cell has its own model, so lateral switches are real. */
const DISTINCT_TIERS: RoutingTable = {
  trivial: {
    direct: { provider: "p", modelId: "trivial-direct", thinking: "off" },
    exploration: { provider: "p", modelId: "trivial-exploration", thinking: "off" },
  },
  standard: {
    direct: { provider: "p", modelId: "standard-direct", thinking: "low" },
    exploration: { provider: "p", modelId: "standard-exploration", thinking: "low" },
  },
  hard: {
    direct: { provider: "p", modelId: "hard-direct", thinking: "high" },
    exploration: { provider: "p", modelId: "hard-exploration", thinking: "low" },
  },
};

// ---------------------------------------------------------------------------
// formOf
// ---------------------------------------------------------------------------

describe("formOf", () => {
  it("returns direct when exploration is false and confidence is high", () => {
    const d: RoutingDecision = {
      tier: "standard",
      tierConfidence: 0.9,
      needsExploration: false,
      explorationConfidence: 0.8,
      latencyMs: 10,
    };
    expect(formOf(d)).toBe("direct");
  });

  it("returns exploration when needsExploration is true even with high confidence", () => {
    const d: RoutingDecision = {
      tier: "standard",
      tierConfidence: 0.9,
      needsExploration: true,
      explorationConfidence: 0.9,
      latencyMs: 10,
    };
    expect(formOf(d)).toBe("exploration");
  });

  it("returns exploration when confidence is below threshold", () => {
    const d: RoutingDecision = {
      tier: "trivial",
      tierConfidence: 0.9,
      needsExploration: false,
      explorationConfidence: 0.4,
      latencyMs: 10,
    };
    expect(formOf(d)).toBe("exploration");
  });
});

// ---------------------------------------------------------------------------
// decide — fail-open
// ---------------------------------------------------------------------------

describe("decide fail-open", () => {
  it("returns null target when decision is null", () => {
    const result = decide({
      decision: null,
      current: { tier: "standard", form: "direct" },
      contextTokens: 0,
    });
    expect(result.target).toBeNull();
    expect(result.reason).toContain("no decision");
  });

  it("returns null target when tier is null", () => {
    const d: RoutingDecision = {
      tier: null,
      tierConfidence: 0.9,
      needsExploration: false,
      explorationConfidence: 0.9,
      latencyMs: 10,
    };
    const result = decide({
      decision: d,
      current: { tier: "standard", form: "direct" },
      contextTokens: 0,
    });
    expect(result.target).toBeNull();
    expect(result.reason).toContain("no decision");
  });

});

// ---------------------------------------------------------------------------
// decide — current model outside the routing table
// ---------------------------------------------------------------------------

describe("decide from an unrouted model", () => {
  const confident: RoutingDecision = {
    tier: "standard",
    tierConfidence: 0.9,
    needsExploration: false,
    explorationConfidence: 0.9,
    latencyMs: 10,
  };

  it("enters the routing table when confidence meets the downgrade threshold", () => {
    const result = decide({
      decision: confident,
      current: null,
      contextTokens: 0,
    });
    expect(result.target).toEqual({ tier: "standard", form: "direct" });
    expect(result.reason).toContain("enter standard/direct");
  });

  it("stays put when confidence is below the downgrade threshold", () => {
    const result = decide({
      decision: { ...confident, tierConfidence: 0.7 },
      current: null,
      contextTokens: 0,
    });
    expect(result.target).toBeNull();
    expect(result.reason).toContain("entry threshold");
  });

  it("stays put when context exceeds the cache guard", () => {
    const result = decide({
      decision: confident,
      current: null,
      contextTokens: 80_000,
    });
    expect(result.target).toBeNull();
    expect(result.reason).toContain("cache protected");
  });
});

// ---------------------------------------------------------------------------
// decide — tier logic
// ---------------------------------------------------------------------------

describe("decide tier logic", () => {
  it("upgrades when confidence exceeds upgrade threshold", () => {
    const d: RoutingDecision = {
      tier: "hard",
      tierConfidence: 0.6,
      needsExploration: false,
      explorationConfidence: 0.9,
      latencyMs: 10,
    };
    const result = decide({
      decision: d,
      current: { tier: "standard", form: "direct" },
      contextTokens: 0,
    });
    expect(result.target).toEqual({ tier: "hard", form: "direct" });
    expect(result.reason).toContain("upgrade");
  });

  it("refuses upgrade when confidence is below upgrade threshold", () => {
    const d: RoutingDecision = {
      tier: "hard",
      tierConfidence: 0.3,
      needsExploration: false,
      explorationConfidence: 0.9,
      latencyMs: 10,
    };
    const result = decide({
      decision: d,
      current: { tier: "standard", form: "direct" },
      contextTokens: 0,
    });
    expect(result.target).toBeNull();
    expect(result.reason).toContain("upgrade threshold");
  });

  it("downgrades when confidence exceeds downgrade threshold", () => {
    const d: RoutingDecision = {
      tier: "trivial",
      tierConfidence: 0.9,
      needsExploration: false,
      explorationConfidence: 0.9,
      latencyMs: 10,
    };
    const result = decide({
      decision: d,
      current: { tier: "standard", form: "direct" },
      contextTokens: 0,
    });
    expect(result.target).toEqual({ tier: "trivial", form: "direct" });
    expect(result.reason).toContain("downgrade");
  });

  it("refuses downgrade when confidence is below downgrade threshold", () => {
    const d: RoutingDecision = {
      tier: "trivial",
      tierConfidence: 0.5,
      needsExploration: false,
      explorationConfidence: 0.9,
      latencyMs: 10,
    };
    const result = decide({
      decision: d,
      current: { tier: "standard", form: "direct" },
      contextTokens: 0,
    });
    expect(result.target).toBeNull();
    expect(result.reason).toContain("downgrade threshold");
  });

  it("keeps current profile when target matches current", () => {
    const d: RoutingDecision = {
      tier: "standard",
      tierConfidence: 0.9,
      needsExploration: false,
      explorationConfidence: 0.9,
      latencyMs: 10,
    };
    const result = decide({
      decision: d,
      current: { tier: "standard", form: "direct" },
      contextTokens: 0,
    });
    expect(result.target).toBeNull();
    expect(result.reason).toContain("already on target model");
  });
});

// ---------------------------------------------------------------------------
// decide — cache guard
// ---------------------------------------------------------------------------

describe("decide cache guard", () => {
  it("refuses downgrade when context exceeds cache guard", () => {
    const d: RoutingDecision = {
      tier: "trivial",
      tierConfidence: 0.95,
      needsExploration: false,
      explorationConfidence: 0.9,
      latencyMs: 10,
    };
    const result = decide({
      decision: d,
      current: { tier: "standard", form: "direct" },
      contextTokens: 80_000,
    });
    expect(result.target).toBeNull();
    expect(result.reason).toContain("cache protected");
  });

  it("refuses lateral switch when context exceeds cache guard", () => {
    const d: RoutingDecision = {
      tier: "standard",
      tierConfidence: 0.9,
      needsExploration: true,
      explorationConfidence: 0.9,
      latencyMs: 10,
    };
    const result = decide({
      decision: d,
      current: { tier: "standard", form: "direct" },
      contextTokens: 80_000,
      config: { tiers: DISTINCT_TIERS, thresholds: DEFAULT_THRESHOLDS },
    });
    expect(result.target).toBeNull();
    expect(result.reason).toContain("lateral blocked");
  });

  it("allows upgrade even when context exceeds cache guard", () => {
    const d: RoutingDecision = {
      tier: "hard",
      tierConfidence: 0.9,
      needsExploration: false,
      explorationConfidence: 0.9,
      latencyMs: 10,
    };
    const result = decide({
      decision: d,
      current: { tier: "standard", form: "direct" },
      contextTokens: 80_000,
    });
    expect(result.target).toEqual({ tier: "hard", form: "direct" });
    expect(result.reason).toContain("upgrade");
  });
});

// ---------------------------------------------------------------------------
// decide — form / exploration logic
// ---------------------------------------------------------------------------

describe("decide form logic", () => {
  it("bumps trivial to standard when exploration is needed", () => {
    const d: RoutingDecision = {
      tier: "trivial",
      tierConfidence: 0.9,
      needsExploration: true,
      explorationConfidence: 0.9,
      latencyMs: 10,
    };
    const result = decide({
      decision: d,
      current: { tier: "standard", form: "direct" },
      contextTokens: 0,
      config: { tiers: DISTINCT_TIERS, thresholds: DEFAULT_THRESHOLDS },
    });
    expect(result.target).toEqual({ tier: "standard", form: "exploration" });
    expect(result.reason).toContain("lateral"); // trivial bumped to standard, making it a lateral form switch
  });

  it("allows lateral direct -> exploration within same tier", () => {
    const d: RoutingDecision = {
      tier: "standard",
      tierConfidence: 0.9,
      needsExploration: true,
      explorationConfidence: 0.9,
      latencyMs: 10,
    };
    const result = decide({
      decision: d,
      current: { tier: "standard", form: "direct" },
      contextTokens: 0,
      config: { tiers: DISTINCT_TIERS, thresholds: DEFAULT_THRESHOLDS },
    });
    expect(result.target).toEqual({ tier: "standard", form: "exploration" });
    expect(result.reason).toContain("lateral");
  });

  it("does not switch between cells that share the same model", () => {
    // DEFAULT_TIERS maps standard/direct and standard/exploration to one model.
    const d: RoutingDecision = {
      tier: "standard",
      tierConfidence: 0.9,
      needsExploration: true,
      explorationConfidence: 0.9,
      latencyMs: 10,
    };
    const result = decide({
      decision: d,
      current: { tier: "standard", form: "direct" },
      contextTokens: 0,
    });
    expect(result.target).toBeNull();
    expect(result.reason).toContain("already on target model");
  });

  it("allows lateral exploration -> direct within same tier", () => {
    const d: RoutingDecision = {
      tier: "hard",
      tierConfidence: 0.9,
      needsExploration: false,
      explorationConfidence: 0.9,
      latencyMs: 10,
    };
    const result = decide({
      decision: d,
      current: { tier: "hard", form: "exploration" },
      contextTokens: 0,
    });
    expect(result.target).toEqual({ tier: "hard", form: "direct" });
    expect(result.reason).toContain("lateral");
  });
});

// ---------------------------------------------------------------------------
// profileFromModel
// ---------------------------------------------------------------------------

describe("profileFromModel", () => {
  it("finds a known model", () => {
    const result = profileFromModel("openrouter", "deepseek/deepseek-v4-flash-0731", DEFAULT_TIERS);
    expect(result).toEqual({ tier: "trivial", form: "direct" }); // first match wins
  });

  it("returns null for an unknown model id", () => {
    const result = profileFromModel("openrouter", "unknown-model", DEFAULT_TIERS);
    expect(result).toBeNull();
  });

  it("returns null when the model id matches but the provider does not", () => {
    const result = profileFromModel("other-provider", "z-ai/glm-5.3", DEFAULT_TIERS);
    expect(result).toBeNull();
  });

  it("finds hard direct model", () => {
    const result = profileFromModel("openrouter", "z-ai/glm-5.3", DEFAULT_TIERS);
    expect(result).toEqual({ tier: "hard", form: "direct" });
  });

  it("finds hard exploration model", () => {
    const result = profileFromModel("openrouter", "tencent/hy4-preview", DEFAULT_TIERS);
    expect(result).toEqual({ tier: "hard", form: "exploration" });
  });
});

// ---------------------------------------------------------------------------
// decide — hysteresis
// ---------------------------------------------------------------------------

describe("decide cooldown", () => {
  const downgrade: RoutingDecision = {
    tier: "trivial",
    tierConfidence: 0.95,
    needsExploration: false,
    explorationConfidence: 0.95,
    latencyMs: 10,
  };

  it("blocks a downgrade right after a switch", () => {
    const result = decide({
      decision: downgrade,
      current: { tier: "hard", form: "direct" },
      contextTokens: 0,
      promptsSinceSwitch: 1,
    });
    expect(result.target).toBeNull();
    expect(result.reason).toContain("cooldown");
  });

  it("allows the downgrade once enough prompts have passed", () => {
    const result = decide({
      decision: downgrade,
      current: { tier: "hard", form: "direct" },
      contextTokens: 0,
      promptsSinceSwitch: DEFAULT_THRESHOLDS.minPromptsBetweenSwitches,
    });
    expect(result.target).toEqual({ tier: "trivial", form: "direct" });
  });

  it("blocks a lateral switch right after a switch", () => {
    const result = decide({
      decision: { ...downgrade, tier: "hard", needsExploration: true },
      current: { tier: "hard", form: "direct" },
      contextTokens: 0,
      promptsSinceSwitch: 0,
    });
    expect(result.target).toBeNull();
    expect(result.reason).toContain("cooldown");
  });

  it("never delays an upgrade", () => {
    const result = decide({
      decision: { ...downgrade, tier: "hard" },
      current: { tier: "trivial", form: "direct" },
      contextTokens: 0,
      promptsSinceSwitch: 0,
    });
    expect(result.target).toEqual({ tier: "hard", form: "direct" });
  });
});

// ---------------------------------------------------------------------------
// decide — switch cost from model prices
// ---------------------------------------------------------------------------

describe("decide switch cost", () => {
  const downgrade: RoutingDecision = {
    tier: "trivial",
    tierConfidence: 0.95,
    needsExploration: false,
    explorationConfidence: 0.95,
    latencyMs: 10,
  };
  const expensive: Price = { input: 1, output: 4, cacheRead: 0.2, cacheWrite: 0 };
  const cheap: Price = { input: 0.1, output: 0.4, cacheRead: 0.02, cacheWrite: 0 };

  it("allows a downgrade that pays back quickly, even above the flat context guard", () => {
    const result = decide({
      decision: downgrade,
      current: { tier: "hard", form: "direct" },
      contextTokens: 100_000,
      currentPrice: expensive,
      priceOf: () => cheap,
    });
    expect(result.target).toEqual({ tier: "trivial", form: "direct" });
    expect(result.reason).toContain("pays back in 0.4 requests");
  });

  it("refuses a downgrade that would take too long to pay back", () => {
    const result = decide({
      decision: downgrade,
      current: { tier: "hard", form: "direct" },
      contextTokens: 100_000,
      currentPrice: { input: 1, output: 0.5, cacheRead: 0.03, cacheWrite: 0 },
      priceOf: () => ({ input: 2, output: 0.4, cacheRead: 0.02, cacheWrite: 0 }),
    });
    expect(result.target).toBeNull();
    expect(result.reason).toContain("pays back in 180.0 requests > 3");
  });

  it("refuses a downgrade to a model that is not cheaper", () => {
    const result = decide({
      decision: downgrade,
      current: { tier: "hard", form: "direct" },
      contextTokens: 10_000,
      currentPrice: cheap,
      priceOf: () => expensive,
    });
    expect(result.target).toBeNull();
    expect(result.reason).toContain("target is not cheaper");
  });

  it("treats all-zero prices as unknown and falls back to the flat guard", () => {
    const zero: Price = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
    const result = decide({
      decision: downgrade,
      current: { tier: "hard", form: "direct" },
      contextTokens: 100_000,
      currentPrice: expensive,
      priceOf: () => zero,
    });
    expect(result.target).toBeNull();
    expect(result.reason).toContain("cache protected");
  });

  it("applies the same check when moving in from an unrouted model", () => {
    const result = decide({
      decision: downgrade,
      current: null,
      contextTokens: 100_000,
      currentPrice: expensive,
      priceOf: () => cheap,
    });
    expect(result.target).toEqual({ tier: "trivial", form: "direct" });
    expect(result.reason).toContain("enter trivial/direct");
  });
});

describe("paybackRequests", () => {
  it("divides the cache-miss premium by the per-request saving", () => {
    // premium = 100k * (0.1 - 0.02) = 8000
    // saving  = 100k * (0.2 - 0.02) + 1000 * (4 - 0.4) = 21600
    const payback = paybackRequests(
      { input: 1, output: 4, cacheRead: 0.2, cacheWrite: 0 },
      { input: 0.1, output: 0.4, cacheRead: 0.02, cacheWrite: 0 },
      100_000,
      1_000,
    );
    expect(payback).toBeCloseTo(8_000 / 21_600);
  });

  it("uses the cache-write price when it is dearer than input", () => {
    const payback = paybackRequests(
      { input: 1, output: 4, cacheRead: 0.2, cacheWrite: 0 },
      { input: 0.1, output: 0.4, cacheRead: 0.02, cacheWrite: 0.3 },
      100_000,
      1_000,
    );
    expect(payback).toBeCloseTo((100_000 * 0.28) / 21_600);
  });

  it("returns Infinity when nothing is saved", () => {
    const price: Price = { input: 1, output: 1, cacheRead: 0.1, cacheWrite: 0 };
    expect(paybackRequests(price, price, 10_000, 1_000)).toBe(Infinity);
  });
});

describe("decide with custom thresholds", () => {
  it("uses the configured downgrade threshold", () => {
    const result = decide({
      decision: {
        tier: "trivial",
        tierConfidence: 0.9,
        needsExploration: false,
        explorationConfidence: 0.95,
        latencyMs: 10,
      },
      current: { tier: "hard", form: "direct" },
      contextTokens: 0,
      config: {
        tiers: DEFAULT_TIERS,
        thresholds: { ...DEFAULT_THRESHOLDS, minConfidenceDowngrade: 0.95 },
      },
    });
    expect(result.target).toBeNull();
    expect(result.reason).toContain("downgrade threshold");
  });
});
