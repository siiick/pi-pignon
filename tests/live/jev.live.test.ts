/**
 * One real Jev call, to catch API changes the fake cannot: `npm run test:live`.
 * Needs TYPESAFE_API_KEY; skipped without it, and never part of `npm test`.
 * Costs a fraction of a cent and sends only the fixed prompt below.
 */

import { describe, expect, it } from "vitest";

import { DEFAULT_CONFIG } from "../../src/config/defaults.js";
import { JevDecider } from "../../src/deciders/jev.js";
import { parseDecision } from "../../src/deciders/parse.js";
import { buildQuestions } from "../../src/deciders/questions.js";

describe.skipIf(!process.env.TYPESAFE_API_KEY)("Jev (live)", () => {
  it("answers the routing questions in the shape the parser reads", async () => {
    const decider = new JevDecider({ timeoutMs: 10_000 });

    const result = await decider.decide({
      text: "Rename the variable `cnt` to `count` in src/stats.ts",
      questions: buildQuestions(DEFAULT_CONFIG),
    });
    const decision = parseDecision(result.answers, result.latencyMs);

    console.log(JSON.stringify({ model: result.model, latencyMs: result.latencyMs, costUsd: result.costUsd, decision }));
    expect(result.model).toEqual(expect.any(String));
    expect(DEFAULT_CONFIG.table.map((t) => t.id)).toContain(decision.tier);
    expect(decision.tierConfidence).toBeGreaterThan(0);
    expect(decision.tierConfidence).toBeLessThanOrEqual(1);
  }, 15_000);
});
