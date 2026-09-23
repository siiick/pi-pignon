/**
 * The real Laya worker and real Jev side by side (parallel strategy), on a few
 * fixed prompts: `npm run test:live`. Needs TYPESAFE_API_KEY and a Laya
 * worker that can run here; skipped otherwise.
 */

import { describe, expect, it } from "vitest";

import { DEFAULT_CONFIG } from "../../src/config/defaults.js";
import { JevDecider } from "../../src/deciders/jev.js";
import { LayaWorker, layaRuntimeStatus } from "../../src/deciders/laya-local.js";
import { parseDecision } from "../../src/deciders/parse.js";
import { buildQuestions } from "../../src/deciders/questions.js";
import { StrategyDecider } from "../../src/deciders/strategy.js";

const PROMPTS = [
  "Rename the variable `cnt` to `count` in src/stats.ts",
  "Add a unit test for parseDecision covering answers without a type tag",
  "Requests sometimes hang for minutes under load and we don't know why; find the cause and fix it",
];

describe.skipIf(!process.env.TYPESAFE_API_KEY || !layaRuntimeStatus().ok)("Laya and Jev in parallel (live)", () => {
  it("records both answers for every prompt", async () => {
    const laya = new LayaWorker({ timeoutMs: 5_000 });
    const decider = new StrategyDecider(
      [laya, new JevDecider({ timeoutMs: 10_000 })],
      { ...DEFAULT_CONFIG.strategy, mode: "parallel", pick: "first", budgetMs: 15_000 },
      (answers, latencyMs) => parseDecision(answers, latencyMs),
    );
    try {
      await laya.warmup(); // load the model first, so the comparison is not about loading time
      for (const text of PROMPTS) {
        const result = await decider.decide({ text, questions: buildQuestions(DEFAULT_CONFIG) });
        const summary = result.attempts!.map((a) => `${a.decider}=${a.tier}@${a.tierConfidence?.toFixed(2)} ${a.latencyMs}ms`);
        console.log(`${text.slice(0, 40).padEnd(40)} ${summary.join("  ")}`);
        expect(result.attempts!.map((a) => a.outcome)).toEqual(["answered", "answered"]);
      }
    } finally {
      decider.stop();
    }
  }, 120_000);
});
