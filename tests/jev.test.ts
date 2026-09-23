import { afterEach, describe, expect, it, vi } from "vitest";

import { JevDecider } from "../src/deciders/jev.js";
import { fakeJevFetch } from "./helpers/fake-jev.js";

const request = {
  text: "rename the parser module",
  questions: {
    reasoning_demand: { type: "choice" as const, instructions: "How hard?", criteria: { trivial: "a", hard: "b" } },
  },
};

const withKey = { TYPESAFE_API_KEY: "sk-test" };

afterEach(() => {
  vi.restoreAllMocks();
});

describe("JevDecider request", () => {
  it("posts the prompt and questions to /v1/systemone with the key", async () => {
    const { fetch, calls } = fakeJevFetch({ kind: "answer" });
    const decider = new JevDecider({ env: withKey, model: "jev-1.13.0", fetch });

    await decider.decide(request);

    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe("https://api.typesafe.ai/v1/systemone");
    expect(calls[0]!.headers.authorization).toBe("Bearer sk-test");
    expect(calls[0]!.body).toEqual({ state: request.text, questions: request.questions, model: "jev-1.13.0" });
  });

  it("can go through OpenRouter with another key variable", async () => {
    const { fetch, calls } = fakeJevFetch({ kind: "answer" });
    const decider = new JevDecider({
      env: { OPENROUTER_API_KEY: "or-key" },
      apiKeyEnv: "OPENROUTER_API_KEY",
      baseURL: "https://openrouter.ai/api",
      fetch,
    });

    await decider.decide(request);

    expect(calls[0]!.url).toBe("https://openrouter.ai/api/v1/systemone");
    expect(calls[0]!.headers.authorization).toBe("Bearer or-key");
  });

  it("does not retry by default", async () => {
    const { fetch } = fakeJevFetch({ kind: "status", status: 503 });
    const decider = new JevDecider({ env: withKey, fetch });

    await expect(decider.decide(request)).rejects.toThrow("jev: HTTP 503");
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("reports the model that answered and the cost", async () => {
    const { fetch } = fakeJevFetch({ kind: "answer", model: "jev-1.14.2", usage: { input_tokens: 10, output_tokens: 1, cost: 0.00042 } });
    const decider = new JevDecider({ env: withKey, fetch });

    const result = await decider.decide(request);

    expect(result).toMatchObject({ deciderId: "jev", model: "jev-1.14.2", costUsd: 0.00042 });
  });

  it("omits the cost when the API does not report one", async () => {
    const { fetch } = fakeJevFetch({ kind: "answer", usage: { input_tokens: 10, output_tokens: 1 } });

    const result = await new JevDecider({ env: withKey, fetch }).decide(request);

    expect(result).not.toHaveProperty("costUsd");
  });
});

describe("JevDecider errors", () => {
  it.each([
    [401, "jev: API key rejected (HTTP 401)"],
    [403, "jev: API key rejected (HTTP 403)"],
    [429, "jev: rate limited (HTTP 429)"],
    [500, "jev: HTTP 500"],
  ])("maps HTTP %i to a short message", async (status, message) => {
    const { fetch } = fakeJevFetch({ kind: "status", status });

    await expect(new JevDecider({ env: withKey, fetch }).decide(request)).rejects.toThrow(message);
  });

  it("says how long it waited on timeout", async () => {
    const { fetch } = fakeJevFetch({ kind: "hang" });

    await expect(new JevDecider({ env: withKey, fetch, timeoutMs: 30 }).decide(request)).rejects.toThrow(
      "jev: timed out after 30 ms",
    );
  });

  it("without a key: not ready, and says which variable to set", async () => {
    const decider = new JevDecider({ env: {}, apiKeyEnv: "MY_JEV_KEY" });

    expect(decider.isReady).toBe(false);
    await expect(decider.warmup()).rejects.toThrow("jev: MY_JEV_KEY is not set");
    await expect(decider.decide(request)).rejects.toThrow("jev: MY_JEV_KEY is not set");
  });
});

describe("JevDecider inside Pi's TUI", () => {
  it("never writes to the console, and keeps diagnostics in recentLogs", async () => {
    const spies = (["log", "info", "warn", "error", "debug"] as const).map((m) => vi.spyOn(console, m));
    const { fetch } = fakeJevFetch({ kind: "status", status: 500 });
    const decider = new JevDecider({ env: withKey, fetch });

    await decider.decide(request).catch(() => {});

    for (const spy of spies) expect(spy).not.toHaveBeenCalled();
    expect(decider.recentLogs.some((line) => line.includes("HTTP 500"))).toBe(true);
  });

  it("never logs the prompt, even with TYPESAFE_LOG_LEVEL=debug", async () => {
    const { fetch } = fakeJevFetch({ kind: "status", status: 500 });
    const decider = new JevDecider({ env: { ...withKey, TYPESAFE_LOG_LEVEL: "debug" }, fetch });
    const previous = process.env.TYPESAFE_LOG_LEVEL;
    process.env.TYPESAFE_LOG_LEVEL = "debug";
    try {
      await decider.decide({ ...request, text: "deploy with token sk-live-secret" }).catch(() => {});
    } finally {
      if (previous === undefined) delete process.env.TYPESAFE_LOG_LEVEL;
      else process.env.TYPESAFE_LOG_LEVEL = previous;
    }

    expect(decider.recentLogs.join("\n")).not.toContain("sk-live-secret");
  });

  it("names the model before the first call", () => {
    expect(new JevDecider({ env: withKey }).model).toBe("jev-latest");
    expect(new JevDecider({ env: withKey, model: "jev-1.13.0" }).model).toBe("jev-1.13.0");
  });
});
