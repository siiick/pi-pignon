import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { describe, expect, it } from "vitest";

import { isLoopbackURL } from "../src/deciders/jev.js";
import { LAYA_SERVE_DEFAULT_URL, createLayaServeDecider, probeLayaServe } from "../src/deciders/laya-serve.js";
import { fakeJevFetch } from "./helpers/fake-jev.js";

const request = {
  text: "rename the parser module",
  questions: {
    reasoning_demand: { type: "choice" as const, instructions: "How hard?", criteria: { trivial: "a", hard: "b" } },
  },
};

describe("laya-serve decider", () => {
  it("posts to laya-serve's default address, as a local decider", async () => {
    const { fetch, calls } = fakeJevFetch({ kind: "answer", model: "laya-rl-agent" });
    const decider = createLayaServeDecider({}, {}, fetch);

    const result = await decider.decide(request);

    expect(decider.id).toBe("laya-serve");
    expect(decider.remote).toBe(false);
    expect(calls[0]!.url).toBe(`${LAYA_SERVE_DEFAULT_URL}/v1/systemone`);
    expect(result).toMatchObject({ deciderId: "laya-serve", model: "laya-rl-agent" });
    expect(decider.model).toBe("laya-rl-agent");
  });

  it("is ready without any key", () => {
    expect(createLayaServeDecider({}, {}).isReady).toBe(true);
  });

  it("never sends the TypeSafe key or model settings to the server", async () => {
    const { fetch, calls } = fakeJevFetch({ kind: "answer" });
    const env = { TYPESAFE_API_KEY: "sk-secret", TYPESAFE_DEFAULT_MODEL: "jev-1.13.0", TYPESAFE_BASE_URL: "https://elsewhere" };
    const decider = createLayaServeDecider({}, env, fetch);

    await decider.decide(request);

    expect(calls[0]!.url).toBe(`${LAYA_SERVE_DEFAULT_URL}/v1/systemone`);
    expect(calls[0]!.headers.authorization).not.toContain("sk-secret");
    expect(JSON.stringify(calls[0]!.body)).not.toContain("jev-1.13.0");
  });

  it("sends the server's own key and checkpoint when configured", async () => {
    const { fetch, calls } = fakeJevFetch({ kind: "answer" });
    const decider = createLayaServeDecider(
      { url: "http://127.0.0.1:9000", apiKeyEnv: "LAYA_API_KEY", model: "multilingual" },
      { LAYA_API_KEY: "local-key" },
      fetch,
    );

    await decider.decide(request);

    expect(calls[0]!.url).toBe("http://127.0.0.1:9000/v1/systemone");
    expect(calls[0]!.headers.authorization).toBe("Bearer local-key");
    expect(calls[0]!.body).toMatchObject({ model: "multilingual" });
  });

  it("is remote when the server is on another machine", () => {
    expect(createLayaServeDecider({ url: "http://gpu-box:8000" }, {}).remote).toBe(true);
  });

  it("fails within milliseconds when the server is not running, and says so", async () => {
    // Port 9 (discard) on loopback: nothing listens, the connection is refused.
    const decider = createLayaServeDecider({ url: "http://127.0.0.1:9" }, {});
    const started = Date.now();

    await expect(decider.decide(request)).rejects.toThrow(
      /laya-serve: cannot reach the API.*is laya-serve running at http:\/\/127\.0\.0\.1:9\?/,
    );
    expect(Date.now() - started).toBeLessThan(1_000);
  });
});

describe("isLoopbackURL", () => {
  it.each([
    ["http://127.0.0.1:8000", true],
    ["http://localhost:8000", true],
    ["http://[::1]:8000", true],
    ["http://127.4.5.6", true],
    ["http://192.168.1.2:8000", false],
    ["https://api.typesafe.ai", false],
    ["not a url", false],
  ])("%s → %s", (url, expected) => {
    expect(isLoopbackURL(url)).toBe(expected);
  });
});

describe("probeLayaServe", () => {
  it("is true when /health reports ok", async () => {
    const server = createServer((req, res) => {
      res.setHeader("content-type", "application/json");
      res.end(req.url === "/health" ? JSON.stringify({ status: "ok", loaded: ["english"] }) : "{}");
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    try {
      const { port } = server.address() as AddressInfo;
      expect(await probeLayaServe(`http://127.0.0.1:${port}/`)).toBe(true);
    } finally {
      server.close();
    }
  });

  it("is false when nothing listens, or something else answers", async () => {
    expect(await probeLayaServe("http://127.0.0.1:9")).toBe(false);
    const notLaya = (async () => new Response("<html>", { status: 200 })) as typeof fetch;
    expect(await probeLayaServe(LAYA_SERVE_DEFAULT_URL, 500, notLaya)).toBe(false);
  });
});
