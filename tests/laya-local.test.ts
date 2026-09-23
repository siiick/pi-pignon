import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { existsSync } from "node:fs";
import { join } from "node:path";

import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";

import {
  LayaWorker,
  LayaWorkerError,
  WORKER_REQUIREMENT,
  protocolProblem,
  resolveLaunch,
  resolveWorkerDir,
  which,
  workerEnv,
} from "../src/deciders/laya-local.js";
import { parseDecision } from "../src/deciders/parse.js";
import { DeciderError } from "../src/deciders/types.js";
import { type FakeChild, createFakeChild, defaultRespond, healthResult, makeHarness, send } from "./helpers/fake-worker.js";


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

describe("resolveLaunch", () => {
  let dir: string;
  const executable = (path: string) => {
    mkdirSync(join(path, ".."), { recursive: true });
    writeFileSync(path, "#!/bin/sh\n");
    chmodSync(path, 0o755);
  };

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "pignon-launch-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  const empty = () => ({ LAYA_WORKER_DIR: join(dir, "worker"), PATH: join(dir, "bin") });

  it("prefers the configured command", () => {
    expect(resolveLaunch(empty(), ["uv", "run", "pignon-laya"])).toEqual({ command: "uv", args: ["run", "pignon-laya"], source: "config" });
  });

  it("uses LAYA_PYTHON with the worker script", () => {
    const launch = resolveLaunch({ ...empty(), LAYA_PYTHON: "/opt/py" });
    expect(launch).toEqual({ command: "/opt/py", args: [join(dir, "worker", "laya_worker.py")], cwd: join(dir, "worker"), source: "env" });
  });

  it("uses a source checkout's uv environment", () => {
    executable(join(dir, "worker", ".venv", "bin", "python"));
    writeFileSync(join(dir, "worker", "laya_worker.py"), "");

    expect(resolveLaunch(empty())).toMatchObject({ command: join(dir, "worker", ".venv", "bin", "python"), source: "checkout" });
  });

  it("uses pignon-laya from PATH", () => {
    executable(join(dir, "bin", "pignon-laya"));

    expect(resolveLaunch(empty())).toEqual({ command: join(dir, "bin", "pignon-laya"), args: [], source: "path" });
  });

  it("falls back to uvx with a compatible version range", () => {
    executable(join(dir, "bin", "uvx"));

    expect(resolveLaunch(empty())).toEqual({
      command: join(dir, "bin", "uvx"),
      args: ["--from", WORKER_REQUIREMENT, "pignon-laya"],
      source: "uvx",
    });
  });

  it("explains what to install when nothing is found", () => {
    expect(resolveLaunch(empty())).toEqual({ reason: expect.stringContaining("uv tool install pignon-laya") });
  });

  it("which() skips directories and non-executables", () => {
    mkdirSync(join(dir, "bin", "uvx"), { recursive: true });
    writeFileSync(join(dir, "bin", "plain"), "");
    expect(which("uvx", { PATH: join(dir, "bin") })).toBeUndefined();
    expect(which("plain", { PATH: join(dir, "bin") })).toBeUndefined();
  });

  it("a worker with no launcher fails with the reason instead of spawning", async () => {
    const previous = { dir: process.env.LAYA_WORKER_DIR, path: process.env.PATH, python: process.env.LAYA_PYTHON };
    process.env.LAYA_WORKER_DIR = join(dir, "worker");
    process.env.PATH = join(dir, "bin");
    delete process.env.LAYA_PYTHON;
    try {
      const worker = new LayaWorker();
      await expect(worker.warmup()).rejects.toThrow("the Laya worker is not installed");
      expect(worker.isReady).toBe(false);
    } finally {
      process.env.LAYA_WORKER_DIR = previous.dir;
      process.env.PATH = previous.path;
      if (previous.python !== undefined) process.env.LAYA_PYTHON = previous.python;
      if (previous.dir === undefined) delete process.env.LAYA_WORKER_DIR;
    }
  });
});

describe("worker protocol", () => {
  it.each([
    ["0.3.0", undefined],
    ["0.3.7", undefined],
    ["0.2.0", "upgrade it"],
    ["0.4.0", "upgrade pignon"],
    ["1.0.0", "upgrade pignon"],
  ])("protocol %s", (version, problem) => {
    const result = protocolProblem(version);
    if (problem === undefined) expect(result).toBeUndefined();
    else expect(result).toContain(problem);
  });

  it("refuses a worker that does not report a protocol, and stops it", async () => {
    const { worker, child } = makeHarness({ protocol: null });

    await expect(worker.warmup()).rejects.toThrow("the Laya worker is too old");
    expect(child()!.kill).toHaveBeenCalledWith("SIGKILL");
    expect(worker.isReady).toBe(false);
  });

  it("refuses a newer protocol and says to upgrade pignon", async () => {
    const { worker } = makeHarness({ protocol: "0.9.0" });

    await expect(worker.warmup()).rejects.toThrow("pignon needs 0.3.x; upgrade pignon");
  });
});

