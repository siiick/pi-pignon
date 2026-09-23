/**
 * A real laya-serve on its default address: `npm run test:live`. Start it
 * first (`LAYA_HOST=127.0.0.1 laya-serve`); skipped when it is not running.
 */

import { describe, expect, it } from "vitest";

import { DEFAULT_CONFIG } from "../../src/config/defaults.js";
import { createLayaServeDecider, probeLayaServe } from "../../src/deciders/laya-serve.js";
import { parseDecision } from "../../src/deciders/parse.js";
import { buildQuestions } from "../../src/deciders/questions.js";

const running = await probeLayaServe();

describe.skipIf(!running)("laya-serve (live)", () => {
  it("answers pignon's questions with a tier from the table", async () => {
    const decider = createLayaServeDecider({ timeoutMs: 10_000 });
    const result = await decider.decide({
      text: "Requests sometimes hang for minutes under load and we don't know why; find the cause and fix it",
      questions: buildQuestions(DEFAULT_CONFIG),
    });
    const decision = parseDecision(result.answers, result.latencyMs);

    console.log(`laya-serve: ${decision.tier}@${decision.tierConfidence.toFixed(2)} in ${result.latencyMs} ms (${result.model})`);
    expect(DEFAULT_CONFIG.table.map((t) => t.id)).toContain(decision.tier);
    expect(result.costUsd).toBeUndefined();
  });
});
