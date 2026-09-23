import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import layaRouterExtension from "../src/extension.js";

// ---------------------------------------------------------------------------
// Minimal Pi ExtensionAPI mock
// ---------------------------------------------------------------------------

function createMockPi() {
  const events = new Map<string, Array<(event: unknown, ctx: unknown) => Promise<unknown>>>();
  const commands = new Map<string, { description: string; handler: (args: string, ctx: unknown) => Promise<void> }>();

  const pi = {
    on: vi.fn((name: string, handler: (event: unknown, ctx: unknown) => Promise<unknown>) => {
      if (!events.has(name)) events.set(name, []);
      events.get(name)!.push(handler);
    }),
    registerCommand: vi.fn((name: string, config: { description: string; handler: (args: string, ctx: unknown) => Promise<void> }) => {
      commands.set(name, config);
    }),
    setModel: vi.fn().mockResolvedValue(true),
    setThinkingLevel: vi.fn(),
    appendEntry: vi.fn(),
    registerEntryRenderer: vi.fn(),
  };

  return { pi, events, commands };
}

function createMockContext(overrides?: {
  modelId?: string;
  tokens?: number;
  hasUI?: boolean;
}) {
  return {
    hasUI: overrides?.hasUI ?? true,
    model: overrides?.modelId ? { id: overrides.modelId } : undefined,
    modelRegistry: {
      find: vi.fn((provider: string, id: string) => ({ provider, id })),
    },
    getContextUsage: vi.fn().mockReturnValue({ tokens: overrides?.tokens ?? 0 }),
    ui: {
      notify: vi.fn(),
      setStatus: vi.fn(),
      setWidget: vi.fn(),
    },
    sessionManager: {
      getEntries: vi.fn().mockReturnValue([]),
    },
  };
}

// ---------------------------------------------------------------------------
// Factory wiring tests
// ---------------------------------------------------------------------------

describe("extension factory", () => {
  it("registers before_agent_start and model_select events", () => {
    const { pi } = createMockPi();
    layaRouterExtension(pi as unknown as import("@earendil-works/pi-coding-agent").ExtensionAPI);

    expect(pi.on).toHaveBeenCalledWith("session_start", expect.any(Function));
    expect(pi.on).toHaveBeenCalledWith("session_shutdown", expect.any(Function));
    expect(pi.on).toHaveBeenCalledWith("before_agent_start", expect.any(Function));
    expect(pi.on).toHaveBeenCalledWith("model_select", expect.any(Function));
  });

  it("registers /pignon and /pignon-stats, keeping /laya and /laya-stats as aliases", () => {
    const { pi, commands } = createMockPi();
    layaRouterExtension(pi as unknown as import("@earendil-works/pi-coding-agent").ExtensionAPI);

    expect(pi.registerCommand).toHaveBeenCalledWith("pignon", expect.any(Object));
    expect(pi.registerCommand).toHaveBeenCalledWith("pignon-stats", expect.any(Object));
    expect(commands.get("laya")!.handler).toBe(commands.get("pignon")!.handler);
    expect(commands.get("laya-stats")!.handler).toBe(commands.get("pignon-stats")!.handler);
  });
});

// ---------------------------------------------------------------------------
// Command handler tests
// ---------------------------------------------------------------------------

describe("pignon command", () => {
  it("sets mode to live when called with 'live'", async () => {
    const { pi, commands } = createMockPi();
    layaRouterExtension(pi as unknown as import("@earendil-works/pi-coding-agent").ExtensionAPI);

    const ctx = createMockContext();
    const cmd = commands.get("pignon")!;
    await cmd.handler("live", ctx);

    expect(ctx.ui.notify).toHaveBeenCalledWith("pignon: mode live", "info");
  });

  it("sets mode to shadow when called with 'shadow'", async () => {
    const { pi, commands } = createMockPi();
    layaRouterExtension(pi as unknown as import("@earendil-works/pi-coding-agent").ExtensionAPI);

    const ctx = createMockContext();
    const cmd = commands.get("pignon")!;
    await cmd.handler("shadow", ctx);

    expect(ctx.ui.notify).toHaveBeenCalledWith("pignon: mode shadow", "info");
  });

  it("unpins the model when called with 'unpin'", async () => {
    const { pi, commands } = createMockPi();
    layaRouterExtension(pi as unknown as import("@earendil-works/pi-coding-agent").ExtensionAPI);

    const ctx = createMockContext();
    const cmd = commands.get("pignon")!;

    // First set to live
    await cmd.handler("live", ctx);
    // Then manually pin via model_select event
    const events = pi.on.mock.calls;
    const modelSelectHandler = events.find(([name]) => name === "model_select")![1];
    await modelSelectHandler({ source: "set" }, ctx);

    // Unpin via command
    await cmd.handler("unpin", ctx);
    expect(ctx.ui.notify).toHaveBeenCalledWith("pignon: routing re-enabled", "info");
  });

  it("reports current mode when called without argument", async () => {
    const { pi, commands } = createMockPi();
    layaRouterExtension(pi as unknown as import("@earendil-works/pi-coding-agent").ExtensionAPI);

    const ctx = createMockContext();
    const cmd = commands.get("pignon")!;
    await cmd.handler("", ctx);

    expect(ctx.ui.notify).toHaveBeenCalledWith(expect.stringContaining("pignon: mode"), "info");
  });
});

// ---------------------------------------------------------------------------
// Stats command
// ---------------------------------------------------------------------------

describe("pignon-stats command", () => {
  it("shows notification when there are no decisions", async () => {
    const { pi, commands } = createMockPi();
    layaRouterExtension(pi as unknown as import("@earendil-works/pi-coding-agent").ExtensionAPI);

    const ctx = createMockContext();
    const cmd = commands.get("pignon-stats")!;
    await cmd.handler("", ctx);

    expect(ctx.ui.notify).toHaveBeenCalledWith("pignon: no decisions in this session", "info");
  });

  it("clears widget when called with 'clear'", async () => {
    const { pi, commands } = createMockPi();
    layaRouterExtension(pi as unknown as import("@earendil-works/pi-coding-agent").ExtensionAPI);

    const ctx = createMockContext();
    const cmd = commands.get("pignon-stats")!;
    await cmd.handler("clear", ctx);

    expect(ctx.ui.setWidget).toHaveBeenCalledWith("pignon-stats", undefined);
  });

  it("renders stats widget when entries exist", async () => {
    const { pi, commands } = createMockPi();
    layaRouterExtension(pi as unknown as import("@earendil-works/pi-coding-agent").ExtensionAPI);

    const data = { tier: "hard", form: "direct", tierConfidence: 0.92, latencyMs: 15, applied: true };
    // Sessions from before pignon hold "laya-decision" entries: both count.
    const mockEntries = [
      { type: "custom", customType: "pignon-decision", data },
      { type: "custom", customType: "laya-decision", data },
      { type: "custom", customType: "something-else", data },
    ];

    const ctx = createMockContext();
    ctx.sessionManager.getEntries = vi.fn().mockReturnValue(mockEntries);

    const cmd = commands.get("pignon-stats")!;
    await cmd.handler("", ctx);

    expect(ctx.ui.setWidget).toHaveBeenCalledWith(
      "pignon-stats",
      expect.arrayContaining([expect.stringContaining("2 decisions")]),
    );
  });
});

describe("pignon-stats compare and export", () => {
  const attempt = (decider: string, tier: string, used: boolean) => ({
    decider, remote: decider === "jev", outcome: "answered", used, tier, tierConfidence: 0.9, needsExploration: false, latencyMs: 5,
  });
  const entries = [
    {
      type: "custom",
      customType: "pignon-decision",
      data: { tier: "hard", form: "direct", applied: false, attempts: [attempt("laya-local", "standard", false), attempt("jev", "hard", true)] },
    },
  ];

  it("shows the comparison widget", async () => {
    const { pi, commands } = createMockPi();
    layaRouterExtension(pi as unknown as import("@earendil-works/pi-coding-agent").ExtensionAPI);
    const ctx = createMockContext();
    ctx.sessionManager.getEntries = vi.fn().mockReturnValue(entries);

    await commands.get("pignon-stats")!.handler("compare", ctx);

    expect(ctx.ui.setWidget).toHaveBeenCalledWith(
      "pignon-stats",
      expect.arrayContaining(["pignon compare — laya-local vs jev · 1 decisions answered by both"]),
    );
  });

  it("explains how to get data to compare", async () => {
    const { pi, commands } = createMockPi();
    layaRouterExtension(pi as unknown as import("@earendil-works/pi-coding-agent").ExtensionAPI);
    const ctx = createMockContext();
    ctx.sessionManager.getEntries = vi.fn().mockReturnValue([{ type: "custom", customType: "pignon-decision", data: { tier: "hard" } }]);

    await commands.get("pignon-stats")!.handler("compare", ctx);

    expect(ctx.ui.notify).toHaveBeenCalledWith(expect.stringContaining("set strategy.mode to parallel"), "info");
  });

  it("exports the session's decisions to the given path", async () => {
    const { pi, commands } = createMockPi();
    layaRouterExtension(pi as unknown as import("@earendil-works/pi-coding-agent").ExtensionAPI);
    const ctx = createMockContext();
    ctx.sessionManager.getEntries = vi.fn().mockReturnValue(entries);
    const dir = mkdtempSync(join(tmpdir(), "pignon-stats-"));
    const path = join(dir, "decisions.jsonl");
    try {
      await commands.get("pignon-stats")!.handler(`export ${path}`, ctx);

      expect(ctx.ui.notify).toHaveBeenCalledWith(`pignon: wrote 1 decisions to ${path}`, "info");
      expect(JSON.parse(readFileSync(path, "utf8"))).toEqual(entries[0]!.data);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// Model select guard
// ---------------------------------------------------------------------------

describe("model_select event", () => {
  it("sets manual pin when source is 'set'", async () => {
    const { pi, events } = createMockPi();
    layaRouterExtension(pi as unknown as import("@earendil-works/pi-coding-agent").ExtensionAPI);

    const modelSelectHandler = events.get("model_select")![0];
    const ctx = createMockContext();

    await modelSelectHandler({ source: "set" }, ctx);
    expect(ctx.ui.setStatus).toHaveBeenCalledWith("pignon", "pignon ⏸ pinned");
  });

  it("does not pin when source is 'cycle'", async () => {
    const { pi, events } = createMockPi();
    layaRouterExtension(pi as unknown as import("@earendil-works/pi-coding-agent").ExtensionAPI);

    const modelSelectHandler = events.get("model_select")![0];
    const ctx = createMockContext();

    await modelSelectHandler({ source: "cycle" }, ctx);
    expect(ctx.ui.setStatus).not.toHaveBeenCalledWith("pignon", expect.stringContaining("pinned"));
  });
});
