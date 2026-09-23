/**
 * A fake `laya_worker.py` process: speaks the worker's JSON-lines protocol
 * over in-memory streams, so LayaWorker can be tested without Python.
 */

import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { vi } from "vitest";

import { LayaWorker } from "../../src/deciders/laya-local.js";

// ---------------------------------------------------------------------------
// Fake worker process
// ---------------------------------------------------------------------------

export interface FakeChild extends EventEmitter {
  stdout: PassThrough;
  stderr: PassThrough;
  stdin: PassThrough;
  pid: number;
  killed: boolean;
  exitCode: number | null;
  signalCode: string | null;
  kill: (signal?: string) => boolean;
}

export function send(child: FakeChild, message: unknown): void {
  child.stdout.write(JSON.stringify(message) + "\n");
}

export const healthResult = {
  status: "ok",
  version: "0.2.0",
  backend: "laya-mlx",
  loaded_model: "aac6fef/laya-mlx",
  ready: true,
};

export const hardAnswers = {
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
export function defaultRespond(request: Record<string, unknown>, child: FakeChild): void {
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

export function createFakeChild(
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

export interface HarnessOptions {
  respond?: (request: Record<string, unknown>, child: FakeChild) => void;
  /** Whether a spawned child reports `ready`; a function decides per spawn index. */
  ready?: boolean | ((index: number) => boolean);
  timeoutMs?: number;
  startupTimeoutMs?: number;
}

export function makeHarness(options: HarnessOptions = {}) {
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
