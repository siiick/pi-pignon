import { describe, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";

import { existsSync } from "node:fs";
import { join } from "node:path";

import { LayaWorker, LayaWorkerError, resolveWorkerDir, workerEnv } from "../src/deciders/laya-local.js";
import { parseDecision } from "../src/deciders/parse.js";
import { DeciderError } from "../src/deciders/types.js";

// ---------------------------------------------------------------------------
// Fake worker process
// ---------------------------------------------------------------------------

interface FakeChild extends EventEmitter {
  stdout: PassThrough;
  stderr: PassThrough;
  stdin: PassThrough;
  pid: number;
  killed: boolean;
  exitCode: number | null;
  signalCode: string | null;
  kill: (signal?: string) => boolean;
}

function send(child: FakeChild, message: unknown): void {
  child.stdout.write(JSON.stringify(message) + "\n");
}

const healthResult = {
  status: "ok",
  version: "0.2.0",
  backend: "laya-mlx",
  loaded_model: "aac6fef/laya-mlx",
  ready: true,
};

const hardAnswers = {
  reasoning_demand: {
    type: "choice",
    choice: "hard",
    confidence: 0.92,
    probabilities: { trivial: 0.02, standard: 0.06, hard: 0.92 },
  },
  needs_exploration: {
    type: "choice",
    choice: "yes",
    confidence: 0.88,
    probabilities: { yes: 0.88, no: 0.12 },
  },
};

/** Default responder emulating `laya_worker.py`. */
function defaultRespond(request: Record<string, unknown>, child: FakeChild): void {
  if (request.method === "health") {
    send(child, { id: request.id, ok: true, result: healthResult });
    return;
  }
  if (request.method === "decide") {
    send(child, {
      id: request.id,
      ok: true,
      result: { answers: hardAnswers, model: "aac6fef/laya-mlx" },
    });
    return;
  }
  send(child, { id: request.id, ok: false, error: `Unknown method: ${request.method}` });
}

function createFakeChild(
  respond: (request: Record<string, unknown>, child: FakeChild) => void = defaultRespond,
): FakeChild {
  const child = new EventEmitter() as FakeChild;
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.stdin = new PassThrough();
  child.pid = 4242;
  child.killed = false;
  child.exitCode = null;
  child.signalCode = null;
  child.kill = vi.fn((signal?: string) => {
    child.killed = true;
    child.exitCode = 0;
    child.emit("exit", 0, signal ?? "SIGTERM");
    return true;
  });

  let buffer = "";
  child.stdin.on("data", (chunk: Buffer) => {
    buffer += chunk.toString();
    let index: number;
    while ((index = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, index).trim();
      buffer = buffer.slice(index + 1);
      if (line) respond(JSON.parse(line), child);
    }
  });

  return child;
}

interface HarnessOptions {
  respond?: (request: Record<string, unknown>, child: FakeChild) => void;
  /** Whether a spawned child reports `ready`; a function decides per spawn index. */
  ready?: boolean | ((index: number) => boolean);
  timeoutMs?: number;
  startupTimeoutMs?: number;
}

function makeHarness(options: HarnessOptions = {}) {
  const children: FakeChild[] = [];

  const spawnFn = vi.fn(() => {
    const child = createFakeChild(options.respond);
    const index = children.push(child) - 1;
    const ready = typeof options.ready === "function" ? options.ready(index) : options.ready !== false;
    if (ready) {
      // Emit `ready` after startProcess has attached its listeners.
      queueMicrotask(() => send(child, { type: "ready", model: "aac6fef/laya-mlx", backend: "laya-mlx" }));
    }
    return child as unknown as ReturnType<typeof import("node:child_process").spawn>;
  });

  const worker = new LayaWorker({
    command: "python3",
    args: ["laya_worker.py"],
    timeoutMs: options.timeoutMs ?? 1_000,
    startupTimeoutMs: options.startupTimeoutMs ?? 1_000,
    spawnFn: spawnFn as never,
  });

  return {
    worker,
    spawnFn,
    children,
    child: () => children[children.length - 1],
  };
}

const decideRequest = {
  text: "debug a race condition",
  questions: {
    reasoning_demand: {
      type: "choice" as const,
      instructions: "How much reasoning?",
      criteria: { trivial: "easy", standard: "medium", hard: "hard" },
    },
    needs_exploration: {
      type: "choice" as const,
      instructions: "Explore?",
      criteria: { yes: "yes", no: "no" },
    },
  },
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("LayaWorker", () => {
  it("starts lazily and returns health status", async () => {
    const { worker, spawnFn } = makeHarness();

    expect(spawnFn).not.toHaveBeenCalled();
    const result = await worker.health();

    expect(result).toEqual(healthResult);
    expect(spawnFn).toHaveBeenCalledTimes(1);
    expect(worker.isReady).toBe(true);
    expect(worker.model).toBe("aac6fef/laya-mlx");
  });

  it("reuses one process across requests", async () => {
    const { worker, spawnFn } = makeHarness();

    await worker.health();
    await worker.health();

    expect(spawnFn).toHaveBeenCalledTimes(1);
  });

  it("returns the worker's answers as a decider result", async () => {
    const { worker } = makeHarness();

    const raw = await worker.decide(decideRequest);

    expect(raw).toMatchObject({ deciderId: "laya-local", model: "aac6fef/laya-mlx" });
    const result = parseDecision(raw.answers, raw.latencyMs);

    expect(result.tier).toBe("hard");
    expect(result.tierConfidence).toBe(0.92);
    expect(result.needsExploration).toBe(true);
    expect(result.explorationConfidence).toBe(0.88);
    expect(result.latencyMs).toBeGreaterThanOrEqual(0);
  });

  it("falls back to null tier when reasoning_demand is missing", async () => {
    const { worker } = makeHarness({
      respond: (request, child) =>
        send(child, {
          id: request.id,
          ok: true,
          result: {
            answers: {
              needs_exploration: {
                type: "choice",
                choice: "no",
                confidence: 0.7,
                probabilities: { yes: 0.3, no: 0.7 },
              },
            },
            model: "aac6fef/laya-mlx",
          },
        }),
    });

    const raw = await worker.decide({ text: "test", questions: {} });
    const result = parseDecision(raw.answers, raw.latencyMs);

    expect(result.tier).toBeNull();
    expect(result.needsExploration).toBe(false);
  });

  it("ignores invalid tier strings", async () => {
    const { worker } = makeHarness({
      respond: (request, child) =>
        send(child, {
          id: request.id,
          ok: true,
          result: {
            answers: {
              reasoning_demand: {
                type: "choice",
                choice: "impossible",
                confidence: 0.99,
                probabilities: { impossible: 0.99 },
              },
            },
            model: "aac6fef/laya-mlx",
          },
        }),
    });

    const raw = await worker.decide({ text: "test", questions: {} });

    expect(parseDecision(raw.answers, raw.latencyMs).tier).toBeNull();
  });

  it("rejects when the worker reports a failure", async () => {
    const { worker } = makeHarness({
      respond: (request, child) =>
        send(child, { id: request.id, ok: false, error: "Model not loaded" }),
    });

    await expect(worker.decide({ text: "test", questions: {} })).rejects.toThrow(
      "Model not loaded",
    );
  });

  it("rejects when a request times out", async () => {
    const { worker } = makeHarness({
      timeoutMs: 20,
      respond: () => {
        // Never respond.
      },
    });

    await expect(worker.health()).rejects.toThrow("timed out");
  });

  it("respects an external AbortSignal", async () => {
    const { worker } = makeHarness({
      respond: () => {
        // Never respond.
      },
    });

    const controller = new AbortController();
    const promise = worker.decide(decideRequest, controller.signal);
    controller.abort();

    await expect(promise).rejects.toThrow(/abort/i);
  });

  it("rejects when the worker reports a fatal load error", async () => {
    const worker = new LayaWorker({
      command: "python3",
      args: ["laya_worker.py"],
      timeoutMs: 100,
      startupTimeoutMs: 100,
      spawnFn: (() => {
        const child = createFakeChild();
        queueMicrotask(() => send(child, { type: "fatal", error: "no metal device" }));
        return child as never;
      }) as never,
    });

    await expect(worker.health()).rejects.toThrow("no metal device");
  });

  it("times out if the worker never becomes ready", async () => {
    const { worker } = makeHarness({ ready: false, startupTimeoutMs: 20 });

    await expect(worker.health()).rejects.toThrow("not ready");
  });

  it("kills a worker that never becomes ready, then starts a fresh one", async () => {
    const { worker, spawnFn, children } = makeHarness({
      ready: (index) => index > 0,
      startupTimeoutMs: 20,
    });

    await expect(worker.health()).rejects.toThrow("not ready");
    expect(children[0].kill).toHaveBeenCalledWith("SIGKILL");

    await expect(worker.health()).resolves.toEqual(healthResult);
    expect(spawnFn).toHaveBeenCalledTimes(2);
  });

  it("ignores a late exit from a replaced worker", async () => {
    const { worker, children } = makeHarness({
      ready: (index) => index > 0,
      startupTimeoutMs: 20,
      respond: (request, child) => {
        // Answer later so the request is still pending when the old child exits.
        setTimeout(() => defaultRespond(request, child), 20);
      },
    });

    await expect(worker.health()).rejects.toThrow("not ready");
    // The timed-out child takes its time to die.
    const stale = children[0];
    await expect(worker.health()).resolves.toEqual(healthResult);

    const pending = worker.decide(decideRequest);
    await new Promise((resolve) => setTimeout(resolve, 0));
    stale.emit("exit", null, "SIGKILL");

    await expect(pending).resolves.toMatchObject({ answers: { reasoning_demand: { choice: "hard" } } });
    expect(worker.isReady).toBe(true);
  });

  it("ignores stdout lines that are valid JSON but not protocol messages", async () => {
    const { worker } = makeHarness({
      respond: (request, child) => {
        for (const noise of ["42", "null", "[]", '"text"', '{"unrelated":true}']) {
          child.stdout.write(noise + "\n");
        }
        defaultRespond(request, child);
      },
    });

    await expect(worker.health()).resolves.toEqual(healthResult);
  });

  it("restarts the worker after a crash", async () => {
    const { worker, spawnFn, children } = makeHarness();

    await worker.health();
    expect(spawnFn).toHaveBeenCalledTimes(1);

    children[0].exitCode = 1;
    children[0].emit("exit", 1, null);

    const result = await worker.health();
    expect(result).toEqual(healthResult);
    expect(spawnFn).toHaveBeenCalledTimes(2);
  });

  it("stop() kills the process and rejects in-flight requests", async () => {
    const { worker, child } = makeHarness({
      respond: () => {
        // Never respond, so the request stays pending.
      },
    });

    const pending = worker.decide(decideRequest);
    // Let ensureStarted resolve and the request be written.
    await new Promise((resolve) => setTimeout(resolve, 0));

    worker.stop();

    await expect(pending).rejects.toThrow("stopped");
    expect(child().kill).toHaveBeenCalled();

    await expect(worker.health()).rejects.toThrow("stopped");
  });

  it("surfaces a spawn error as LayaWorkerError", async () => {
    const worker = new LayaWorker({
      command: "definitely-not-a-real-binary",
      args: [],
      spawnFn: (() => {
        throw new Error("ENOENT");
      }) as never,
    });

    await expect(worker.health()).rejects.toThrow(LayaWorkerError);
  });

  it("escalates to SIGKILL when the worker ignores SIGTERM", async () => {
    const { worker, child } = makeHarness();
    await worker.health();

    const stubborn = child();
    stubborn.kill = vi.fn(() => {
      stubborn.killed = true; // signal delivered, process still running
      return true;
    });

    vi.useFakeTimers();
    try {
      worker.stop();
      expect(stubborn.kill).toHaveBeenCalledWith("SIGTERM");
      vi.advanceTimersByTime(500);
      expect(stubborn.kill).toHaveBeenCalledWith("SIGKILL");
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not SIGKILL a worker that exited on SIGTERM", async () => {
    const { worker, child } = makeHarness();
    await worker.health();

    vi.useFakeTimers();
    try {
      worker.stop();
      vi.advanceTimersByTime(500);
      expect(child().kill).toHaveBeenCalledTimes(1);
      expect(child().kill).toHaveBeenCalledWith("SIGTERM");
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps worker stderr in recentLogs instead of the host's stderr", async () => {
    const hostStderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    try {
      const { worker, child } = makeHarness();
      await worker.health();

      child().stderr.write("[laya-worker] loading model\npartial ");
      child().stderr.write("line\nDownloading: 10%\rDownloading: 100%\n");
      send(child(), { id: null, ok: false, error: "Invalid JSON" });
      await new Promise((resolve) => setTimeout(resolve, 0));

      expect(worker.recentLogs).toEqual([
        "[laya-worker] loading model",
        "partial line",
        "Downloading: 100%",
        "protocol error: Invalid JSON",
      ]);
      expect(hostStderr).not.toHaveBeenCalled();
    } finally {
      hostStderr.mockRestore();
    }
  });

  it("caps recentLogs at the most recent 200 lines", async () => {
    const { worker, child } = makeHarness();
    await worker.health();

    child().stderr.write(Array.from({ length: 250 }, (_, i) => `line ${i}`).join("\n") + "\n");
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(worker.recentLogs).toHaveLength(200);
    expect(worker.recentLogs[0]).toBe("line 50");
    expect(worker.recentLogs[199]).toBe("line 249");
  });

  it("spawns the worker without unrelated environment variables", async () => {
    process.env.OPENROUTER_API_KEY = "sk-secret";
    try {
      const { worker, spawnFn } = makeHarness();
      await worker.health();

      const env = (spawnFn.mock.calls[0] as unknown[])[2] as { env: NodeJS.ProcessEnv };
      expect(env.env.OPENROUTER_API_KEY).toBeUndefined();
      expect(env.env.PATH).toBe(process.env.PATH);
    } finally {
      delete process.env.OPENROUTER_API_KEY;
    }
  });
});

describe("wire format", () => {
  it("sends a deadline and no model override with each request", async () => {
    const seen: Record<string, unknown>[] = [];
    const { worker } = makeHarness({
      timeoutMs: 2_500,
      respond: (request, child) => {
        seen.push(request);
        defaultRespond(request, child);
      },
    });

    const before = Date.now();
    await worker.decide(decideRequest);

    const decide = seen.find((r) => r.method === "decide")!;
    expect(Object.keys(decide).sort()).toEqual(["deadline_ms", "id", "method", "questions", "text"]);
    expect(decide.deadline_ms).toBeGreaterThanOrEqual(before + 2_500);
    expect(decide.deadline_ms).toBeLessThanOrEqual(Date.now() + 2_500);
  });

  it("rejects a decision without an answers object", async () => {
    const { worker } = makeHarness({
      respond: (request, child) => {
        if (request.method === "decide") send(child, { id: request.id, ok: true, result: { model: "m" } });
        else defaultRespond(request, child);
      },
    });

    await expect(worker.decide(decideRequest)).rejects.toThrow("malformed decision");
  });

  it("rejects a malformed health response", async () => {
    const { worker } = makeHarness({
      respond: (request, child) => send(child, { id: request.id, ok: true, result: "fine" }),
    });

    await expect(worker.health()).rejects.toThrow("malformed health");
  });

  it("keeps the underlying error as the standard cause", () => {
    const root = new Error("EPIPE");
    const error = new LayaWorkerError("write failed", root);
    expect(error.cause).toBe(root);
    expect("cause" in new LayaWorkerError("no cause")).toBe(false);
  });

  it("is a DeciderError, so the router can treat every decider alike", () => {
    expect(new LayaWorkerError("x")).toBeInstanceOf(DeciderError);
  });
});

describe("resolveWorkerDir", () => {
  it("finds the bundled worker script from the decider's own location", () => {
    const dir = resolveWorkerDir({});
    expect(existsSync(join(dir, "laya_worker.py"))).toBe(true);
  });

  it("prefers LAYA_WORKER_DIR", () => {
    expect(resolveWorkerDir({ LAYA_WORKER_DIR: "/opt/laya" })).toBe("/opt/laya");
  });
});

describe("workerEnv", () => {
  it("keeps the allowlist and drops everything else", () => {
    const env = workerEnv({
      PATH: "/usr/bin",
      HOME: "/Users/me",
      HTTPS_PROXY: "http://proxy:3128",
      LAYA_MODEL: "aac6fef/laya-mlx",
      HF_TOKEN: "hf_x",
      HF_HOME: "/cache/hf",
      MLX_METAL_DEBUG: "1",
      LC_ALL: "en_US.UTF-8",
      OPENROUTER_API_KEY: "sk-or",
      ANTHROPIC_API_KEY: "sk-ant",
      AWS_SECRET_ACCESS_KEY: "aws",
      GITHUB_TOKEN: "gh",
      PYTHONPATH: "/tmp/evil",
      NODE_OPTIONS: "--require x",
    });

    expect(env).toEqual({
      PATH: "/usr/bin",
      HOME: "/Users/me",
      HTTPS_PROXY: "http://proxy:3128",
      LAYA_MODEL: "aac6fef/laya-mlx",
      HF_TOKEN: "hf_x",
      HF_HOME: "/cache/hf",
      MLX_METAL_DEBUG: "1",
      LC_ALL: "en_US.UTF-8",
    });
  });
});
