import { describe, expect, it, vi } from "vitest";

import type { Decider, DeciderResult } from "../src/deciders/types.js";
import { type HostModel, type RouterHost, MAX_PROMPT_CHARS, routePrompt } from "../src/router.js";
import { DEFAULT_CONFIG } from "../src/types.js";

const GLM: HostModel = { provider: "openrouter", id: "z-ai/glm-5.3" };
const FLASH: HostModel = { provider: "openrouter", id: "deepseek/deepseek-v4-flash-0731" };

function fakeHost(model: HostModel | undefined = GLM) {
  const host = {
    model,
    contextTokens: 0,
    signal: undefined,
    findModel: vi.fn((provider: string, id: string): HostModel | undefined => ({ provider, id })),
    switchModel: vi.fn(async (m: HostModel) => {
      host.model = m;
      return true;
    }),
    setThinkingLevel: vi.fn(),
    status: vi.fn(),
    notify: vi.fn(),
    showDeciding: vi.fn(),
    hideDeciding: vi.fn(),
  } satisfies RouterHost;
  return host;
}

function fakeDecider(decide: Decider["decide"]): Decider {
  return {
    id: "fake",
    remote: false,
    isReady: true,
    model: "fake-model",
    recentLogs: [],
    warmup: async () => {},
    decide,
    stop: () => {},
  };
}

const trivial = async (): Promise<DeciderResult> => ({
  deciderId: "fake",
  model: "fake-model",
  answers: {
    reasoning_demand: { choice: "trivial", confidence: 0.97 },
    needs_exploration: { choice: "no", confidence: 0.95 },
  },
  latencyMs: 12,
});

const options = (decider: Decider, mode: "live" | "shadow" = "live") => ({
  decider,
  config: DEFAULT_CONFIG,
  mode,
  promptsSinceSwitch: undefined,
});

describe("routePrompt", () => {
  it("switches model and thinking level in live mode", async () => {
    const host = fakeHost();

    const { applied, entry } = await routePrompt(host, options(fakeDecider(trivial)), "rename foo");

    expect(applied).toBe(true);
    expect(host.switchModel).toHaveBeenCalledWith(FLASH);
    expect(host.setThinkingLevel).toHaveBeenCalledWith("off");
    expect(entry).toMatchObject({ tier: "trivial", layaModel: "fake-model", latencyMs: 12, applied: true });
  });

  it("only records the verdict in shadow mode", async () => {
    const host = fakeHost();

    const { applied, entry } = await routePrompt(host, options(fakeDecider(trivial), "shadow"), "rename foo");

    expect(applied).toBe(false);
    expect(host.switchModel).not.toHaveBeenCalled();
    expect(entry.targetModel).toBe(`${FLASH.provider}/${FLASH.id}`);
  });

  it("sends the capped prompt and the routing questions to the decider", async () => {
    const decide = vi.fn<Decider["decide"]>(trivial);

    await routePrompt(fakeHost(), options(fakeDecider(decide)), "x".repeat(MAX_PROMPT_CHARS + 10));

    const [request] = decide.mock.calls[0]!;
    expect(request.text).toHaveLength(MAX_PROMPT_CHARS);
    expect(Object.keys(request.questions)).toEqual(["reasoning_demand", "needs_exploration"]);
  });

  it("fails open when the decider throws, and hides the spinner", async () => {
    const host = fakeHost();
    const decider = fakeDecider(async () => {
      throw new Error("offline");
    });

    const { applied, entry } = await routePrompt(host, options(decider), "hello");

    expect(applied).toBe(false);
    expect(host.switchModel).not.toHaveBeenCalled();
    expect(host.hideDeciding).toHaveBeenCalled();
    expect(entry).toMatchObject({ error: "offline", reason: "error", layaModel: "fake-model" });
  });

  it("warns instead of switching when the target is not in the registry", async () => {
    const host = fakeHost();
    host.findModel.mockReturnValue(undefined);

    const { applied } = await routePrompt(host, options(fakeDecider(trivial)), "rename foo");

    expect(applied).toBe(false);
    expect(host.notify).toHaveBeenCalledWith(expect.stringContaining("not in the model registry"), "warning");
  });
});
