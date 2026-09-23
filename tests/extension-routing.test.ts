import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { Decider, DeciderResult, DecisionRequest } from "../src/deciders/types.js";
import { createExtension } from "../src/extension.js";
import { hashPrompt } from "../src/router.js";
import { buildStatsLines } from "../src/stats.js";
import type { Price, RouterLogEntry, RoutingDecision } from "../src/types.js";

// ---------------------------------------------------------------------------
// Decider fake: the routing tests script decisions through workerDecide.
// ---------------------------------------------------------------------------

const workerDecide = vi.fn<(request: DecisionRequest) => Promise<RoutingDecision>>();
const workerWarmup = vi.fn<() => Promise<void>>();
const workerState = { ready: true, logs: [] as string[] };

/** The raw answers a decider would return for a routing decision. */
function answersFor(d: RoutingDecision): DeciderResult["answers"] {
  return {
    ...(d.tier ? { reasoning_demand: { type: "choice", choice: d.tier, confidence: d.tierConfidence } } : {}),
    needs_exploration: {
      type: "choice",
      choice: d.needsExploration ? "yes" : "no",
      confidence: d.explorationConfidence,
    },
  };
}

const fakeDecider: Decider = {
  id: "fake",
  remote: false,
  model: "stub",
  get isReady() {
    return workerState.ready;
  },
  get recentLogs() {
    return workerState.logs;
  },
  warmup: () => workerWarmup(),
  decide: async (request) => {
    const d = await workerDecide(request);
    return { deciderId: "fake", model: "stub", answers: answersFor(d), latencyMs: d.latencyMs };
  },
  stop: vi.fn(),
};

const layaRouterExtension = createExtension({ createDecider: () => fakeDecider });

// ---------------------------------------------------------------------------
// Pi mock whose setModel behaves like Pi: it emits model_select "set".
// ---------------------------------------------------------------------------

type Handler = (event: unknown, ctx: unknown) => Promise<unknown>;
type Model = { provider: string; id: string; cost?: Price };

interface SetupOptions {
  /** Prices by model id, exposed through the registry and ctx.model. */
  prices?: Record<string, Price>;
  hasUI?: boolean;
  contextTokens?: number;
}

function setup(initial: Model, options: SetupOptions = {}) {
  const withCost = (provider: string, id: string): Model => {
    const cost = options.prices?.[id];
    return cost ? { provider, id, cost } : { provider, id };
  };
  const initialModel = withCost(initial.provider, initial.id);
  const events = new Map<string, Handler[]>();
  const commands = new Map<string, { handler: (args: string, ctx: unknown) => Promise<void> }>();

  const ctx = {
    hasUI: options.hasUI ?? true,
    model: initialModel as Model | undefined,
    signal: undefined,
    modelRegistry: { find: vi.fn(withCost) },
    getContextUsage: vi.fn().mockReturnValue({ tokens: options.contextTokens ?? 0 }),
    ui: { notify: vi.fn(), setStatus: vi.fn(), setWidget: vi.fn() },
    sessionManager: { getEntries: vi.fn().mockReturnValue([]) },
  };

  const emit = async (name: string, event: unknown) => {
    for (const handler of events.get(name) ?? []) await handler(event, ctx);
  };

  const pi = {
    on: vi.fn((name: string, handler: Handler) => {
      events.set(name, [...(events.get(name) ?? []), handler]);
    }),
    registerCommand: vi.fn((name: string, config: { handler: (args: string, ctx: unknown) => Promise<void> }) => {
      commands.set(name, config);
    }),
    setModel: vi.fn(async (model: Model) => {
      const previousModel = ctx.model;
      ctx.model = model;
      await emit("model_select", { type: "model_select", model, previousModel, source: "set" });
      return true;
    }),
    setThinkingLevel: vi.fn(),
    appendEntry: vi.fn(),
    registerEntryRenderer: vi.fn(),
  };

  layaRouterExtension(pi as unknown as ExtensionAPI);

  // Like Pi: before_agent_start runs first, then the user message is posted.
  const prompt = async (text: string) => {
    await emit("before_agent_start", { prompt: text });
    await emit("message_end", { type: "message_end", message: { role: "user", content: text } });
  };
  const command = (name: string, args: string) => commands.get(name)!.handler(args, ctx);

  const lastEntry = () => pi.appendEntry.mock.calls.at(-1)![1] as RouterLogEntry;

  return { pi, ctx, emit, prompt, command, lastEntry };
}

const decision = (overrides: Partial<RoutingDecision>): RoutingDecision => ({
  tier: "standard",
  tierConfidence: 0.95,
  needsExploration: false,
  explorationConfidence: 0.95,
  latencyMs: 10,
  ...overrides,
});

const GLM = { provider: "openrouter", id: "z-ai/glm-5.3" };

beforeEach(() => {
  workerDecide.mockReset();
  workerWarmup.mockReset().mockResolvedValue(undefined);
  workerState.ready = true;
  workerState.logs = [];
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("live routing", () => {
  it("keeps routing after its own model switch", async () => {
    const { pi, ctx, prompt, command } = setup(GLM);
    await command("pignon", "live");

    workerDecide.mockResolvedValueOnce(decision({ tier: "trivial" }));
    await prompt("rename foo to bar");
    expect(pi.setModel).toHaveBeenCalledTimes(1);
    expect(ctx.ui.setStatus).not.toHaveBeenCalledWith("pignon", "pignon ⏸ pinned");

    workerDecide.mockResolvedValueOnce(decision({ tier: "hard" }));
    await prompt("design a new caching layer");
    expect(workerDecide).toHaveBeenCalledTimes(2);
    expect(pi.setModel).toHaveBeenCalledTimes(2);
    expect(ctx.model).toMatchObject(GLM);
  });

  it("still pins when the user selects a model manually", async () => {
    const { pi, emit, prompt, command } = setup(GLM);
    await command("pignon", "live");

    await emit("model_select", { type: "model_select", model: GLM, previousModel: GLM, source: "set" });
    workerDecide.mockResolvedValueOnce(decision({ tier: "trivial" }));
    await prompt("rename foo to bar");

    expect(workerDecide).not.toHaveBeenCalled();
    expect(pi.setModel).not.toHaveBeenCalled();
  });

  it("routes away from a model outside the routing table", async () => {
    const { pi, ctx, prompt, command } = setup({ provider: "anthropic", id: "claude-opus-5-5" });
    await command("pignon", "live");

    workerDecide.mockResolvedValueOnce(decision({ tier: "standard" }));
    await prompt("add a unit test for parseDecision");

    expect(pi.setModel).toHaveBeenCalledTimes(1);
    expect(ctx.model).toMatchObject({ provider: "openrouter", id: "deepseek/deepseek-v4.1-flash" });
  });

  it("does not re-select a model shared by the current and target cells", async () => {
    const { pi, prompt, command } = setup({ provider: "openrouter", id: "deepseek/deepseek-v4.1-flash" });
    await command("pignon", "live");

    workerDecide.mockResolvedValueOnce(decision({ tier: "standard", needsExploration: true }));
    await prompt("find where the cache is invalidated");

    expect(pi.setModel).not.toHaveBeenCalled();
  });
});

describe("worker not ready", () => {
  it("does not hold session start while the model loads", async () => {
    workerWarmup.mockReturnValue(new Promise(() => {})); // never finishes loading
    const { emit } = setup(GLM);

    await emit("session_start", { type: "session_start" }); // resolves immediately
    expect(workerWarmup).toHaveBeenCalledTimes(1);
  });

  it("lets the prompt through unrouted and keeps warming up", async () => {
    workerState.ready = false;
    workerWarmup.mockReturnValue(new Promise(() => {}));
    const { pi, ctx, prompt, command } = setup(GLM);
    await command("pignon", "live");

    await prompt("rename foo to bar");

    expect(workerDecide).not.toHaveBeenCalled();
    expect(pi.setModel).not.toHaveBeenCalled();
    expect(workerWarmup).toHaveBeenCalledTimes(1);
    expect(ctx.ui.setStatus).toHaveBeenCalledWith("pignon", expect.stringContaining("not routed"));

    await prompt("another prompt while still loading");
    expect(workerWarmup).toHaveBeenCalledTimes(1); // one load in flight, not one per prompt
  });
});

describe("/pignon log", () => {
  it("shows the most recent worker output in a widget", async () => {
    workerState.logs = Array.from({ length: 40 }, (_, i) => `line ${i}`);
    const { ctx, command } = setup(GLM);

    await command("pignon", "log");

    const [name, lines] = ctx.ui.setWidget.mock.calls[0] as [string, string[]];
    expect(name).toBe("pignon-log");
    expect(lines[0]).toBe("line 10");
    expect(lines).toContain("line 39");
    expect(lines.at(-1)).toContain("/pignon log clear");
  });

  it("says so when the worker has not written anything", async () => {
    const { ctx, command } = setup(GLM);

    await command("pignon", "log");

    expect(ctx.ui.notify).toHaveBeenCalledWith("pignon: no decider output yet", "info");
    expect(ctx.ui.setWidget).not.toHaveBeenCalled();
  });

  it("hides the widget with 'log clear'", async () => {
    const { ctx, command } = setup(GLM);

    await command("pignon", "log clear");

    expect(ctx.ui.setWidget).toHaveBeenCalledWith("pignon-log", undefined);
  });
});

describe("prompt handling", () => {
  it("sends at most 4000 characters to Laya", async () => {
    const { prompt, command } = setup(GLM);
    await command("pignon", "shadow");
    workerDecide.mockResolvedValueOnce(decision({}));

    await prompt("x".repeat(50_000));

    const request = workerDecide.mock.calls[0]![0];
    expect(request.text).toHaveLength(4_000);
  });

  it("logs a hash of the prompt, never its text", async () => {
    const { prompt, lastEntry } = setup(GLM);
    workerDecide.mockResolvedValueOnce(decision({}));
    const secret = "deploy with token sk-live-abc123";

    await prompt(secret);

    const entry = lastEntry();
    expect(entry.promptHash).toBe(hashPrompt(secret));
    expect(entry.promptHash).toMatch(/^[0-9a-f]{16}$/);
    expect(entry.promptLength).toBe(secret.length);
    expect(entry).toMatchObject({ decider: "fake", remote: false });
    expect(JSON.stringify(entry)).not.toContain("sk-live");
  });

  it("logs failed decisions without a latency", async () => {
    const { prompt, lastEntry } = setup(GLM);
    workerDecide.mockRejectedValueOnce(new Error("timed out"));

    await prompt("hello");

    expect(lastEntry()).toMatchObject({ reason: "error", error: "timed out", latencyMs: null, applied: false });
  });
});

describe("switch policy in the extension", () => {
  it("waits before the next downgrade after a switch", async () => {
    const { pi, prompt, command, lastEntry } = setup({ provider: "openrouter", id: "tencent/hy4-preview" });
    await command("pignon", "live");

    workerDecide.mockResolvedValueOnce(decision({ tier: "hard" })); // lateral to hard/direct
    await prompt("now implement it");
    expect(pi.setModel).toHaveBeenCalledTimes(1);

    workerDecide.mockResolvedValueOnce(decision({ tier: "trivial" }));
    await prompt("rename foo");
    expect(pi.setModel).toHaveBeenCalledTimes(1);
    expect(lastEntry().reason).toContain("cooldown");

    workerDecide.mockResolvedValueOnce(decision({ tier: "trivial" }));
    await prompt("rename bar");
    expect(pi.setModel).toHaveBeenCalledTimes(2);
  });

  it("uses registry prices to allow a cheap downgrade on a large context", async () => {
    const { pi, prompt, command, lastEntry } = setup(GLM, {
      contextTokens: 100_000,
      prices: {
        "z-ai/glm-5.3": { input: 1, output: 4, cacheRead: 0.2, cacheWrite: 0 },
        "deepseek/deepseek-v4-flash-0731": { input: 0.1, output: 0.4, cacheRead: 0.02, cacheWrite: 0 },
      },
    });
    await command("pignon", "live");

    workerDecide.mockResolvedValueOnce(decision({ tier: "trivial" }));
    await prompt("rename foo");

    expect(pi.setModel).toHaveBeenCalledTimes(1);
    expect(lastEntry().reason).toContain("pays back");
  });

  it("falls back to the flat context guard when prices are unknown", async () => {
    const { pi, prompt, command, lastEntry } = setup(GLM, { contextTokens: 100_000 });
    await command("pignon", "live");

    workerDecide.mockResolvedValueOnce(decision({ tier: "trivial" }));
    await prompt("rename foo");

    expect(pi.setModel).not.toHaveBeenCalled();
    expect(lastEntry().reason).toContain("cache protected");
  });
});

describe("config file", () => {
  /** Run with PIGNON_CONFIG / LAYA_ROUTER_CONFIG pointing into a temp dir holding the given files. */
  const withFiles =
    (files: { pignon?: string; legacy?: string }, run: (paths: { pignon: string; legacy: string }) => Promise<void>) =>
    async () => {
      const dir = mkdtempSync(join(tmpdir(), "pignon-ext-"));
      const paths = { pignon: join(dir, "pignon.json"), legacy: join(dir, "laya-router.json") };
      const previous = { pignon: process.env.PIGNON_CONFIG, legacy: process.env.LAYA_ROUTER_CONFIG };
      process.env.PIGNON_CONFIG = paths.pignon;
      process.env.LAYA_ROUTER_CONFIG = paths.legacy;
      if (files.pignon !== undefined) writeFileSync(paths.pignon, files.pignon);
      if (files.legacy !== undefined) writeFileSync(paths.legacy, files.legacy);
      try {
        await run(paths);
      } finally {
        process.env.PIGNON_CONFIG = previous.pignon;
        process.env.LAYA_ROUTER_CONFIG = previous.legacy;
        rmSync(dir, { recursive: true, force: true });
      }
    };
  const withConfig = (contents: string, run: () => Promise<void>) => withFiles({ pignon: contents }, run);

  it(
    "applies thresholds from the config file",
    withConfig(JSON.stringify({ thresholds: { minConfidenceDowngrade: 0.99 } }), async () => {
      const { pi, prompt, command, lastEntry } = setup(GLM);
      await command("pignon", "live");

      workerDecide.mockResolvedValueOnce(decision({ tier: "trivial", tierConfidence: 0.95 }));
      await prompt("rename foo");

      expect(pi.setModel).not.toHaveBeenCalled();
      expect(lastEntry().reason).toContain("downgrade threshold");
    }),
  );

  it(
    "reports config problems when the session starts",
    withConfig(JSON.stringify({ thresholds: { typo: 1 } }), async () => {
      const { ctx, emit } = setup(GLM);

      await emit("session_start", { type: "session_start" });

      expect(ctx.ui.notify).toHaveBeenCalledWith(expect.stringContaining("thresholds.typo: unknown setting"), "warning");
    }),
  );

  it(
    "routes to a user-defined tier",
    withConfig(
      JSON.stringify({
        tiers: [
          { id: "easy", criterion: "Easy", model: "fast" },
          { id: "pro", criterion: "Hard", model: { provider: "anthropic", modelId: "claude-opus-5-5", thinking: "high" } },
        ],
      }),
      async () => {
        const { pi, ctx, prompt, command } = setup(GLM);
        await command("pignon", "live");

        workerDecide.mockResolvedValueOnce(decision({ tier: "pro" }));
        await prompt("design the new storage layer");

        const request = workerDecide.mock.calls[0]![0];
        expect(Object.keys((request.questions.reasoning_demand as { criteria: object }).criteria)).toEqual(["easy", "pro"]);
        expect(pi.setModel).toHaveBeenCalledTimes(1);
        expect(ctx.model).toMatchObject({ provider: "anthropic", id: "claude-opus-5-5" });
        expect(pi.setThinkingLevel).toHaveBeenCalledWith("high");
      },
    ),
  );

  it(
    "shows the table in use with /pignon config",
    withConfig(JSON.stringify({ questions: { version: "q9" } }), async () => {
      const { ctx, command } = setup(GLM);

      await command("pignon", "config");

      const [name, lines] = ctx.ui.setWidget.mock.calls[0] as [string, string[]];
      expect(name).toBe("pignon-config");
      expect(lines[0]).toContain("pignon.json");
      expect(lines).toContain("  questions q9 · confidence reported");
    }),
  );

  it(
    "reads a laya-router file, warns, and migrates it on request",
    withFiles({ legacy: JSON.stringify({ tiers: { hard: { direct: { provider: "p", modelId: "m", thinking: "high" } } } }) }, async (paths) => {
      const { ctx, emit, command } = setup(GLM);

      await emit("session_start", { type: "session_start" });
      expect(ctx.ui.notify).toHaveBeenCalledWith(expect.stringContaining("/pignon config migrate"), "warning");

      await command("pignon", "config migrate");

      expect(ctx.ui.notify).toHaveBeenLastCalledWith(expect.stringContaining(`wrote ${paths.pignon}`), "info");
      expect(JSON.parse(readFileSync(paths.pignon, "utf8"))).toMatchObject({ version: 2 });
    }),
  );

  it(
    "does not migrate a config already in the pignon format",
    withConfig(JSON.stringify({ version: 2 }), async () => {
      const { ctx, command } = setup(GLM);

      await command("pignon", "config migrate");

      expect(ctx.ui.notify).toHaveBeenCalledWith("pignon: config is already in the pignon format", "info");
    }),
  );
});

describe("decision cards", () => {
  it("registers a renderer for decision entries", () => {
    const { pi } = setup(GLM);
    expect(pi.registerEntryRenderer).toHaveBeenCalledWith("pignon-decision", expect.any(Function));
  });

  it("appends the entry only once the user message is posted", async () => {
    const { pi, emit, lastEntry } = setup(GLM);
    workerDecide.mockResolvedValueOnce(decision({ tier: "hard" }));

    await emit("before_agent_start", { prompt: "design it" });
    expect(pi.appendEntry).not.toHaveBeenCalled();

    await emit("message_end", { type: "message_end", message: { role: "assistant" } });
    expect(pi.appendEntry).not.toHaveBeenCalled();

    await emit("message_end", { type: "message_end", message: { role: "user" } });
    expect(pi.appendEntry).toHaveBeenCalledTimes(1);
    expect(lastEntry().tier).toBe("hard");
  });

  it("records the current and target models", async () => {
    const { command, prompt, lastEntry } = setup(GLM);
    await command("pignon", "live");
    workerDecide.mockResolvedValueOnce(decision({ tier: "trivial" }));

    await prompt("rename foo to bar");

    expect(lastEntry()).toMatchObject({
      currentModel: "openrouter/z-ai/glm-5.3",
      targetModel: "openrouter/deepseek/deepseek-v4-flash-0731",
      targetThinking: "off",
      applied: true,
    });
  });

  it("shows a spinner widget while Laya decides and removes it after", async () => {
    const { ctx, prompt } = setup(GLM);
    let widgetDuringDecide: unknown;
    workerDecide.mockImplementationOnce(async () => {
      widgetDuringDecide = ctx.ui.setWidget.mock.calls.at(-1);
      return decision({});
    });

    await prompt("hello");

    expect(widgetDuringDecide).toEqual(["pignon-deciding", expect.any(Function)]);
    expect(ctx.ui.setWidget).toHaveBeenLastCalledWith("pignon-deciding", undefined);
  });

  it("removes the spinner when Laya fails", async () => {
    const { ctx, prompt } = setup(GLM);
    workerDecide.mockRejectedValueOnce(new Error("boom"));

    await prompt("hello");

    expect(ctx.ui.setWidget).toHaveBeenLastCalledWith("pignon-deciding", undefined);
  });
});

describe("without a UI", () => {
  it("routes and runs commands without touching ctx.ui", async () => {
    const { ctx, prompt, command } = setup(GLM, { hasUI: false });
    workerDecide.mockResolvedValueOnce(decision({}));

    await command("pignon", "live");
    await command("pignon", "log");
    await command("laya-stats", "");
    await prompt("hello");

    expect(ctx.ui.notify).not.toHaveBeenCalled();
    expect(ctx.ui.setStatus).not.toHaveBeenCalled();
    expect(ctx.ui.setWidget).not.toHaveBeenCalled();
  });
});

describe("buildStatsLines", () => {
  it("counts decisions per decider and sums their cost", () => {
    const row = (decider: string, costUsd?: number) =>
      ({ decider, latencyMs: 1, applied: false, tier: null, form: null, ...(costUsd ? { costUsd } : {}) }) as RouterLogEntry;
    const lines = buildStatsLines([row("laya-local"), row("jev", 0.00002), row("jev", 0.00003)]);
    expect(lines).toContain("deciders laya-local 1 · jev 2 · cost $0.00005");
  });

  it("averages latency over successful decisions only", () => {
    const row = (latencyMs: number | null) => ({ latencyMs, applied: false, tier: null, form: null }) as RouterLogEntry;
    const lines = buildStatsLines([row(10), row(30), row(null)]);
    expect(lines).toContain("avg latency 20 ms");
  });
});
