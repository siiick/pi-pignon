import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { LayaRoutingDecision, Price, RouterLogEntry } from "../src/types.js";

// ---------------------------------------------------------------------------
// Worker stub: the routing tests only need decide() to return a fixed answer.
// ---------------------------------------------------------------------------

const workerDecide = vi.fn<() => Promise<LayaRoutingDecision>>();
const workerWarmup = vi.fn<() => Promise<unknown>>();
const workerState = { ready: true, logs: [] as string[] };

vi.mock("../src/laya-worker.js", () => ({
  LayaWorker: class {
    loadedModel = "stub";
    get isReady() {
      return workerState.ready;
    }
    get recentLogs() {
      return workerState.logs;
    }
    decide = workerDecide;
    warmup = workerWarmup;
    health = vi.fn();
    stop = vi.fn();
  },
  LayaWorkerError: class extends Error {},
}));

const { default: layaRouterExtension, buildStatsLines, hashPrompt } = await import("../src/extension.js");

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

const decision = (overrides: Partial<LayaRoutingDecision>): LayaRoutingDecision => ({
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
  workerWarmup.mockReset().mockResolvedValue({ loaded_model: "stub" });
  workerState.ready = true;
  workerState.logs = [];
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("live routing", () => {
  it("keeps routing after its own model switch", async () => {
    const { pi, ctx, prompt, command } = setup(GLM);
    await command("laya", "live");

    workerDecide.mockResolvedValueOnce(decision({ tier: "trivial" }));
    await prompt("rename foo to bar");
    expect(pi.setModel).toHaveBeenCalledTimes(1);
    expect(ctx.ui.setStatus).not.toHaveBeenCalledWith("laya", "laya ⏸ pinned");

    workerDecide.mockResolvedValueOnce(decision({ tier: "hard" }));
    await prompt("design a new caching layer");
    expect(workerDecide).toHaveBeenCalledTimes(2);
    expect(pi.setModel).toHaveBeenCalledTimes(2);
    expect(ctx.model).toMatchObject(GLM);
  });

  it("still pins when the user selects a model manually", async () => {
    const { pi, emit, prompt, command } = setup(GLM);
    await command("laya", "live");

    await emit("model_select", { type: "model_select", model: GLM, previousModel: GLM, source: "set" });
    workerDecide.mockResolvedValueOnce(decision({ tier: "trivial" }));
    await prompt("rename foo to bar");

    expect(workerDecide).not.toHaveBeenCalled();
    expect(pi.setModel).not.toHaveBeenCalled();
  });

  it("routes away from a model outside the routing table", async () => {
    const { pi, ctx, prompt, command } = setup({ provider: "anthropic", id: "claude-opus-5-5" });
    await command("laya", "live");

    workerDecide.mockResolvedValueOnce(decision({ tier: "standard" }));
    await prompt("add a unit test for parseDecision");

    expect(pi.setModel).toHaveBeenCalledTimes(1);
    expect(ctx.model).toMatchObject({ provider: "openrouter", id: "deepseek/deepseek-v4.1-flash" });
  });

  it("does not re-select a model shared by the current and target cells", async () => {
    const { pi, prompt, command } = setup({ provider: "openrouter", id: "deepseek/deepseek-v4.1-flash" });
    await command("laya", "live");

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
    await command("laya", "live");

    await prompt("rename foo to bar");

    expect(workerDecide).not.toHaveBeenCalled();
    expect(pi.setModel).not.toHaveBeenCalled();
    expect(workerWarmup).toHaveBeenCalledTimes(1);
    expect(ctx.ui.setStatus).toHaveBeenCalledWith("laya", expect.stringContaining("not routed"));

    await prompt("another prompt while still loading");
    expect(workerWarmup).toHaveBeenCalledTimes(1); // one load in flight, not one per prompt
  });
});

describe("/laya log", () => {
  it("shows the most recent worker output in a widget", async () => {
    workerState.logs = Array.from({ length: 40 }, (_, i) => `line ${i}`);
    const { ctx, command } = setup(GLM);

    await command("laya", "log");

    const [name, lines] = ctx.ui.setWidget.mock.calls[0] as [string, string[]];
    expect(name).toBe("laya-log");
    expect(lines[0]).toBe("line 10");
    expect(lines).toContain("line 39");
    expect(lines.at(-1)).toContain("/laya log clear");
  });

  it("says so when the worker has not written anything", async () => {
    const { ctx, command } = setup(GLM);

    await command("laya", "log");

    expect(ctx.ui.notify).toHaveBeenCalledWith("laya: no worker output yet", "info");
    expect(ctx.ui.setWidget).not.toHaveBeenCalled();
  });

  it("hides the widget with 'log clear'", async () => {
    const { ctx, command } = setup(GLM);

    await command("laya", "log clear");

    expect(ctx.ui.setWidget).toHaveBeenCalledWith("laya-log", undefined);
  });
});

describe("prompt handling", () => {
  it("sends at most 4000 characters to Laya", async () => {
    const { prompt, command } = setup(GLM);
    await command("laya", "shadow");
    workerDecide.mockResolvedValueOnce(decision({}));

    await prompt("x".repeat(50_000));

    const request = (workerDecide.mock.calls[0] as unknown[])[0] as { text: string };
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
    await command("laya", "live");

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
    await command("laya", "live");

    workerDecide.mockResolvedValueOnce(decision({ tier: "trivial" }));
    await prompt("rename foo");

    expect(pi.setModel).toHaveBeenCalledTimes(1);
    expect(lastEntry().reason).toContain("pays back");
  });

  it("falls back to the flat context guard when prices are unknown", async () => {
    const { pi, prompt, command, lastEntry } = setup(GLM, { contextTokens: 100_000 });
    await command("laya", "live");

    workerDecide.mockResolvedValueOnce(decision({ tier: "trivial" }));
    await prompt("rename foo");

    expect(pi.setModel).not.toHaveBeenCalled();
    expect(lastEntry().reason).toContain("cache protected");
  });
});

describe("config file", () => {
  const withConfig = (contents: string, run: () => Promise<void>) => async () => {
    const dir = mkdtempSync(join(tmpdir(), "laya-ext-"));
    const previous = process.env.LAYA_ROUTER_CONFIG;
    process.env.LAYA_ROUTER_CONFIG = join(dir, "laya-router.json");
    writeFileSync(process.env.LAYA_ROUTER_CONFIG, contents);
    try {
      await run();
    } finally {
      process.env.LAYA_ROUTER_CONFIG = previous;
      rmSync(dir, { recursive: true, force: true });
    }
  };

  it(
    "applies thresholds from the config file",
    withConfig(JSON.stringify({ thresholds: { minConfidenceDowngrade: 0.99 } }), async () => {
      const { pi, prompt, command, lastEntry } = setup(GLM);
      await command("laya", "live");

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
});

describe("decision cards", () => {
  it("registers a renderer for decision entries", () => {
    const { pi } = setup(GLM);
    expect(pi.registerEntryRenderer).toHaveBeenCalledWith("laya-decision", expect.any(Function));
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
    await command("laya", "live");
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

    expect(widgetDuringDecide).toEqual(["laya-deciding", expect.any(Function)]);
    expect(ctx.ui.setWidget).toHaveBeenLastCalledWith("laya-deciding", undefined);
  });

  it("removes the spinner when Laya fails", async () => {
    const { ctx, prompt } = setup(GLM);
    workerDecide.mockRejectedValueOnce(new Error("boom"));

    await prompt("hello");

    expect(ctx.ui.setWidget).toHaveBeenLastCalledWith("laya-deciding", undefined);
  });
});

describe("without a UI", () => {
  it("routes and runs commands without touching ctx.ui", async () => {
    const { ctx, prompt, command } = setup(GLM, { hasUI: false });
    workerDecide.mockResolvedValueOnce(decision({}));

    await command("laya", "live");
    await command("laya", "log");
    await command("laya-stats", "");
    await prompt("hello");

    expect(ctx.ui.notify).not.toHaveBeenCalled();
    expect(ctx.ui.setStatus).not.toHaveBeenCalled();
    expect(ctx.ui.setWidget).not.toHaveBeenCalled();
  });
});

describe("buildStatsLines", () => {
  it("averages latency over successful decisions only", () => {
    const row = (latencyMs: number | null) => ({ latencyMs, applied: false, tier: null, form: null }) as RouterLogEntry;
    const lines = buildStatsLines([row(10), row(30), row(null)]);
    expect(lines).toContain("avg latency 20 ms");
  });
});
