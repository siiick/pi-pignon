import { describe, expect, it, vi } from "vitest";

import type { Decider, DeciderResult } from "../src/deciders/types.js";
import { type HostModel, type RouterHost, MAX_PROMPT_CHARS, routePrompt } from "../src/router.js";
import { DEFAULT_CONFIG } from "../src/config/defaults.js";

const GLM: HostModel = { provider: "openrouter", id: "z-ai/glm-5.3" };
const FLASH: HostModel = { provider: "openrouter", id: "deepseek/deepseek-v4-flash-0731" };
const GLM_SPEC = { provider: GLM.provider, modelId: GLM.id, thinking: "high" as const };
const FLASH_SPEC = { provider: FLASH.provider, modelId: FLASH.id, thinking: "off" as const };

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
    expect(entry).toMatchObject({ tier: "trivial", deciderModel: "fake-model", questionsVersion: "q1", latencyMs: 12, applied: true });
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
    expect(entry).toMatchObject({ error: "offline", reason: "error", deciderModel: "fake-model" });
  });

  it("warns instead of switching when the target is not in the registry", async () => {
    const host = fakeHost();
    host.findModel.mockReturnValue(undefined);

    const { applied } = await routePrompt(host, options(fakeDecider(trivial)), "rename foo");

    expect(applied).toBe(false);
    expect(host.notify).toHaveBeenCalledWith(expect.stringContaining("not in the model registry"), "warning");
  });

  it("asks about the configured tiers and routes to them", async () => {
    const table = [
      { id: "easy", criterion: "Easy work", models: { direct: FLASH_SPEC, exploration: FLASH_SPEC }, explorationAllowed: true },
      { id: "pro", criterion: "Pro work", models: { direct: GLM_SPEC, exploration: GLM_SPEC }, explorationAllowed: true },
    ];
    const config = { ...DEFAULT_CONFIG, table, questions: { ...DEFAULT_CONFIG.questions, version: "q7" } };
    const decide = vi.fn<Decider["decide"]>(async () => ({
      deciderId: "fake",
      model: "fake-model",
      answers: { reasoning_demand: { choice: "easy", confidence: 0.99 }, needs_exploration: { choice: "no", confidence: 0.99 } },
      latencyMs: 1,
    }));
    const host = fakeHost();

    const { entry } = await routePrompt(host, { ...options(fakeDecider(decide)), config }, "rename foo");

    expect(decide.mock.calls[0]![0].questions.reasoning_demand).toMatchObject({
      criteria: { easy: "Easy work", pro: "Pro work" },
    });
    expect(host.switchModel).toHaveBeenCalledWith(FLASH);
    expect(entry).toMatchObject({ tier: "easy", currentTier: "pro", questionsVersion: "q7" });
  });
});
