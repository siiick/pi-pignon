import { describe, expect, it } from "vitest";

import { DEFAULT_CONFIG } from "../src/config/defaults.js";
import { parseDecision } from "../src/deciders/parse.js";

describe("parseDecision", () => {
  it("reads tier and exploration from choice answers", () => {
    const decision = parseDecision(
      {
        reasoning_demand: { type: "choice", choice: "hard", confidence: 0.92 },
        needs_exploration: { type: "choice", choice: "yes", confidence: 0.88 },
      },
      7,
    );

    expect(decision).toEqual({
      tier: "hard",
      tierConfidence: 0.92,
      needsExploration: true,
      explorationConfidence: 0.88,
      latencyMs: 7,
    });
  });

  it("accepts answers without a type tag, as the TypeSafe SDK returns them", () => {
    const decision = parseDecision(
      {
        reasoning_demand: { choice: "trivial", confidence: 0.8, probabilities: { trivial: 0.8 } },
        needs_exploration: { choice: "no", confidence: 0.9 },
      },
      0,
    );

    expect(decision).toMatchObject({ tier: "trivial", tierConfidence: 0.8, needsExploration: false, explorationConfidence: 0.9 });
  });

  it("rejects answers tagged with another question type", () => {
    const decision = parseDecision({ reasoning_demand: { type: "score", choice: "hard", confidence: 0.9 } }, 0);

    expect(decision.tier).toBeNull();
    expect(decision.tierConfidence).toBe(0);
  });

  it("treats malformed answers as missing", () => {
    const decision = parseDecision(
      {
        reasoning_demand: { type: "choice", choice: "hard", confidence: "very" },
        needs_exploration: { type: "choice", choice: 42 },
      },
      5,
    );

    expect(decision).toEqual({
      tier: "hard",
      tierConfidence: 0,
      needsExploration: false,
      explorationConfidence: 0,
      latencyMs: 5,
    });
  });

  it("ignores tiers outside the routing table", () => {
    expect(parseDecision({ reasoning_demand: { choice: "impossible", confidence: 0.99 } }, 0).tier).toBeNull();
  });

  it("routes on the chosen option's probability with confidenceSource top-probability", () => {
    const answers = {
      reasoning_demand: { choice: "standard", confidence: 0.05, probabilities: { trivial: 0.2, standard: 0.49, hard: 0.31 } },
      needs_exploration: { choice: "yes", confidence: 0.1, probabilities: { yes: 0.8, no: 0.2 } },
    };

    const reported = parseDecision(answers, 0);
    const top = parseDecision(answers, 0, { ...DEFAULT_CONFIG, confidenceSource: "top-probability" });

    expect(reported).toMatchObject({ tierConfidence: 0.05, explorationConfidence: 0.1 });
    expect(top).toMatchObject({ tier: "standard", tierConfidence: 0.49, explorationConfidence: 0.8 });
  });

  it("accepts any tier id of the configured table", () => {
    const table = [{ ...DEFAULT_CONFIG.table[0]!, id: "easy" }, { ...DEFAULT_CONFIG.table[2]!, id: "pro" }];
    const decision = parseDecision({ reasoning_demand: { choice: "pro", confidence: 0.9 } }, 0, { ...DEFAULT_CONFIG, table });
    expect(decision.tier).toBe("pro");
  });
});
