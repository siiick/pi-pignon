/**
 * What every decider must do, run against each implementation. A new decider
 * gets its behavior checked by adding one entry to `implementations`.
 */

import { describe, expect, it } from "vitest";

import { JevDecider } from "../src/deciders/jev.js";
import { parseDecision } from "../src/deciders/parse.js";
import { type Decider, DeciderError } from "../src/deciders/types.js";
import { fakeJevFetch } from "./helpers/fake-jev.js";
import { defaultRespond, makeHarness, send } from "./helpers/fake-worker.js";

type Behavior = "answer" | "fail" | "hang";

interface Implementation {
  name: string;
  make(behavior: Behavior, timeoutMs: number): Decider;
}

const implementations: Implementation[] = [
  {
    name: "laya-local",
    make: (behavior, timeoutMs) =>
      makeHarness({
        timeoutMs,
        respond: (request, child) => {
          if (request.method !== "decide" || behavior === "answer") defaultRespond(request, child);
          else if (behavior === "fail") send(child, { id: request.id, ok: false, error: "model exploded" });
          // "hang": never answer the decide request
        },
      }).worker,
  },
  {
    name: "jev",
    make: (behavior, timeoutMs) =>
      new JevDecider({
        env: { TYPESAFE_API_KEY: "sk-test" },
        timeoutMs,
        fetch: fakeJevFetch(
          behavior === "answer" ? { kind: "answer" } : behavior === "fail" ? { kind: "status", status: 500 } : { kind: "hang" },
        ).fetch,
      }),
  },
];

const request = {
  text: "debug a race condition in the cache layer",
  questions: {
    reasoning_demand: {
      type: "choice" as const,
      instructions: "How hard?",
      criteria: { trivial: "easy", standard: "medium", hard: "hard" },
    },
    needs_exploration: { type: "choice" as const, instructions: "Explore?", criteria: { yes: "yes", no: "no" } },
  },
};

describe.each(implementations)("Decider contract: $name", ({ make }) => {
  it("is ready after warmup", async () => {
    const decider = make("answer", 1_000);
    await decider.warmup();
    expect(decider.isReady).toBe(true);
  });

  it("answers with its own id, a model and answers the shared parser reads", async () => {
    const decider = make("answer", 1_000);

    const result = await decider.decide(request);

    expect(result.deciderId).toBe(decider.id);
    expect(result.model).toEqual(expect.any(String));
    expect(result.latencyMs).toBeGreaterThanOrEqual(0);
    expect(parseDecision(result.answers, result.latencyMs)).toMatchObject({ tier: "hard", needsExploration: true });
  });

  it("rejects with a DeciderError when the backend fails", async () => {
    await expect(make("fail", 1_000).decide(request)).rejects.toBeInstanceOf(DeciderError);
  });

  it("rejects with a DeciderError on timeout", async () => {
    const started = Date.now();
    await expect(make("hang", 50).decide(request)).rejects.toBeInstanceOf(DeciderError);
    expect(Date.now() - started).toBeLessThan(1_000);
  });

  it("rejects with a DeciderError when the caller aborts", async () => {
    const decider = make("hang", 5_000);
    await decider.warmup();
    const controller = new AbortController();

    const pending = decider.decide(request, controller.signal);
    setTimeout(() => controller.abort(), 20);

    await expect(pending).rejects.toBeInstanceOf(DeciderError);
  });

  it("refuses to decide after stop()", async () => {
    const decider = make("answer", 1_000);
    await decider.warmup();

    decider.stop();

    expect(decider.isReady).toBe(false);
    await expect(decider.decide(request)).rejects.toBeInstanceOf(DeciderError);
  });
});
