import { describe, expect, it, vi } from "vitest";

import { DEFAULT_CONFIG, DEFAULT_STRATEGY } from "../src/config/defaults.js";
import { parseDecision } from "../src/deciders/parse.js";
import { StrategyDecider } from "../src/deciders/strategy.js";
import { type Decider, type DeciderResult, DeciderError } from "../src/deciders/types.js";
import type { StrategyConfig } from "../src/types.js";

type Script = { tier: string; confidence: number; costUsd?: number; delayMs?: number } | "fail" | "hang";

interface FakeOptions {
  id: string;
  remote?: boolean;
  ready?: boolean;
  script: Script;
  warmup?: () => Promise<void>;
}

function fake(options: FakeOptions): Decider & { decide: ReturnType<typeof vi.fn>; warmup: ReturnType<typeof vi.fn> } {
  const state = { ready: options.ready ?? true };
  return {
    id: options.id,
    remote: options.remote ?? false,
    get isReady() {
      return state.ready;
    },
    model: `${options.id}-model`,
    recentLogs: [`${options.id} log`],
    warmup: vi.fn(options.warmup ?? (async () => void (state.ready = true))),
    decide: vi.fn(async (_request, signal?: AbortSignal): Promise<DeciderResult> => {
      const script = options.script;
      if (script === "fail") throw new DeciderError(`${options.id} exploded`);
      if (script === "hang" || script.delayMs) {
        await new Promise<void>((resolve, reject) => {
          const timer = script === "hang" ? undefined : setTimeout(resolve, script.delayMs);
          signal?.addEventListener("abort", () => {
            clearTimeout(timer);
            reject(new DeciderError(`${options.id} aborted`));
          });
        });
      }
      const s = script as Exclude<Script, "fail" | "hang">;
      return {
        deciderId: options.id,
        model: `${options.id}-model`,
        answers: {
          reasoning_demand: { choice: s.tier, confidence: s.confidence },
          needs_exploration: { choice: "no", confidence: 0.9 },
        },
        latencyMs: 5,
        ...(s.costUsd !== undefined ? { costUsd: s.costUsd } : {}),
      };
    }),
    stop: vi.fn(),
  };
}

const parse = (answers: DeciderResult["answers"], latencyMs: number) => parseDecision(answers, latencyMs, DEFAULT_CONFIG);
const strategy = (overrides: Partial<StrategyConfig> = {}) => ({ ...DEFAULT_STRATEGY, ...overrides });
const request = { text: "hello", questions: {} };

describe("sequential", () => {
  it("stops at the first confident answer and does not ask the others", async () => {
    const laya = fake({ id: "laya-local", script: { tier: "hard", confidence: 0.9 } });
    const jev = fake({ id: "jev", remote: true, script: { tier: "trivial", confidence: 0.99 } });

    const result = await new StrategyDecider([laya, jev], strategy(), parse).decide(request);

    expect(jev.decide).not.toHaveBeenCalled();
    expect(result).toMatchObject({ deciderId: "laya-local", remote: false });
    expect(result.attempts!.map((a) => [a.decider, a.outcome, a.used])).toEqual([
      ["laya-local", "answered", true],
      ["jev", "not-asked", false],
    ]);
  });

  it("escalates below escalateBelow and routes on the more confident answer", async () => {
    const laya = fake({ id: "laya-local", script: { tier: "standard", confidence: 0.05 } });
    const jev = fake({ id: "jev", remote: true, script: { tier: "hard", confidence: 0.93, costUsd: 0.00003 } });

    const result = await new StrategyDecider([laya, jev], strategy(), parse).decide(request);

    expect(result).toMatchObject({ deciderId: "jev", model: "jev-model", remote: true, costUsd: 0.00003 });
    expect(result.attempts!.map((a) => [a.decider, a.tier, a.tierConfidence, a.used])).toEqual([
      ["laya-local", "standard", 0.05, false],
      ["jev", "hard", 0.93, true],
    ]);
  });

  it("keeps the earlier answer when the next decider is even less sure", async () => {
    const laya = fake({ id: "laya-local", script: { tier: "standard", confidence: 0.6 } });
    const jev = fake({ id: "jev", script: { tier: "hard", confidence: 0.4 } });

    const result = await new StrategyDecider([laya, jev], strategy(), parse).decide(request);

    expect(result.deciderId).toBe("laya-local");
    expect(result.attempts!.every((a) => a.outcome === "answered")).toBe(true);
  });

  it("skips a decider that is not ready, and warms it up once in the background", async () => {
    let finishLoading!: () => void;
    const laya = fake({
      id: "laya-local",
      ready: false,
      script: { tier: "hard", confidence: 0.9 },
      warmup: () => new Promise<void>((resolve) => (finishLoading = resolve)),
    });
    const jev = fake({ id: "jev", remote: true, script: { tier: "trivial", confidence: 0.95 } });
    const decider = new StrategyDecider([laya, jev], strategy(), parse);

    const first = await decider.decide(request);
    await decider.decide(request);

    expect(laya.decide).not.toHaveBeenCalled();
    expect(laya.warmup).toHaveBeenCalledTimes(1);
    expect(first.attempts![0]).toMatchObject({ decider: "laya-local", outcome: "not-ready" });
    expect(first).toMatchObject({ deciderId: "jev", remote: true });
    finishLoading();
  });

  it("moves on when a decider fails", async () => {
    const laya = fake({ id: "laya-local", script: "fail" });
    const jev = fake({ id: "jev", script: { tier: "hard", confidence: 0.9 } });

    const result = await new StrategyDecider([laya, jev], strategy(), parse).decide(request);

    expect(result.deciderId).toBe("jev");
    expect(result.attempts![0]).toMatchObject({ outcome: "failed", error: "laya-local exploded" });
  });

  it("fails with every reason when no decider answers", async () => {
    const decider = new StrategyDecider(
      [
        fake({ id: "laya-local", script: "fail" }),
        fake({ id: "jev", ready: false, script: "fail", warmup: () => new Promise(() => {}) }),
      ],
      strategy(),
      parse,
    );

    await expect(decider.decide(request)).rejects.toThrow(
      new DeciderError("no decider answered (laya-local: laya-local exploded; jev: not-ready)"),
    );
  });

  it("stays within budgetMs when a decider hangs", async () => {
    const laya = fake({ id: "laya-local", script: "hang" });
    const jev = fake({ id: "jev", script: { tier: "hard", confidence: 0.9 } });
    const started = Date.now();

    await expect(new StrategyDecider([laya, jev], strategy({ budgetMs: 50 }), parse).decide(request)).rejects.toThrow(
      "laya-local: over the 50 ms budget",
    );
    expect(Date.now() - started).toBeLessThan(500);
    expect(jev.decide).not.toHaveBeenCalled();
  });

  it("stops when the caller aborts", async () => {
    const controller = new AbortController();
    const decider = new StrategyDecider(
      [fake({ id: "laya-local", script: "hang" }), fake({ id: "jev", script: "hang" })],
      strategy(),
      parse,
    );

    const pending = decider.decide(request, controller.signal);
    controller.abort();

    await expect(pending).rejects.toBeInstanceOf(DeciderError);
  });
});

describe("parallel", () => {
  const both = () => [
    fake({ id: "laya-local", script: { tier: "standard", confidence: 0.6, delayMs: 10 } }),
    fake({ id: "jev", remote: true, script: { tier: "hard", confidence: 0.9, costUsd: 0.00002 } }),
  ];

  it("asks every decider and routes on the most confident answer", async () => {
    const [laya, jev] = both();

    const result = await new StrategyDecider([laya!, jev!], strategy({ mode: "parallel" }), parse).decide(request);

    expect(laya!.decide).toHaveBeenCalledTimes(1);
    expect(jev!.decide).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({ deciderId: "jev", remote: true, costUsd: 0.00002 });
    expect(result.attempts!.map((a) => [a.decider, a.outcome, a.used])).toEqual([
      ["laya-local", "answered", false],
      ["jev", "answered", true],
    ]);
  });

  it("with pick first, routes on the first decider in the list and only records the others", async () => {
    const [laya, jev] = both();

    const result = await new StrategyDecider([laya!, jev!], strategy({ mode: "parallel", pick: "first" }), parse).decide(
      request,
    );

    expect(result.deciderId).toBe("laya-local");
    expect(result.attempts![1]).toMatchObject({ decider: "jev", outcome: "answered", tier: "hard", used: false });
  });

  it("with pick first, falls back to the next decider when the first fails", async () => {
    const decider = new StrategyDecider(
      [fake({ id: "laya-local", script: "fail" }), fake({ id: "jev", script: { tier: "hard", confidence: 0.3 } })],
      strategy({ mode: "parallel", pick: "first" }),
      parse,
    );

    expect((await decider.decide(request)).deciderId).toBe("jev");
  });

  it("reports the wall time, not only the chosen decider's", async () => {
    const [laya, jev] = both();

    const result = await new StrategyDecider([laya!, jev!], strategy({ mode: "parallel" }), parse).decide(request);

    expect(result.latencyMs).toBeGreaterThanOrEqual(9);
  });
});

describe("StrategyDecider as a Decider", () => {
  it("is ready when any decider is, and describes all of them", () => {
    const decider = new StrategyDecider(
      [fake({ id: "laya-local", ready: false, script: "fail" }), fake({ id: "jev", remote: true, script: "fail" })],
      strategy(),
      parse,
    );

    expect(decider.isReady).toBe(true);
    expect(decider.remote).toBe(true);
    expect(decider.id).toBe("sequential(laya-local,jev)");
    expect(decider.model).toBe("laya-local-model → jev-model");
    expect(decider.recentLogs).toEqual(["[laya-local] laya-local log", "[jev] jev log"]);
  });

  it("warms up until one decider is ready, and fails only when all fail", async () => {
    const slow = fake({ id: "laya-local", ready: false, script: "fail", warmup: () => new Promise(() => {}) });
    const fast = fake({ id: "jev", ready: false, script: "fail" });
    await expect(new StrategyDecider([slow, fast], strategy(), parse).warmup()).resolves.toBeUndefined();

    const broken = (id: string) =>
      fake({ id, ready: false, script: "fail", warmup: () => Promise.reject(new DeciderError(`${id}: no key`)) });
    await expect(new StrategyDecider([broken("a"), broken("b")], strategy(), parse).warmup()).rejects.toThrow(
      "a: no key; b: no key",
    );
  });

  it("stops every decider", () => {
    const deciders = [fake({ id: "a", script: "fail" }), fake({ id: "b", script: "fail" })];
    new StrategyDecider(deciders, strategy(), parse).stop();
    for (const d of deciders) expect(d.stop).toHaveBeenCalled();
  });
});
