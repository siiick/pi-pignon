/**
 * `laya-local` decider (experimental): long-lived stdio client for pignon's
 * own Laya worker (`worker/`, not published). The supported way to run Laya
 * locally is the official `laya-serve` (see `laya-serve.ts`).
 *
 * Spawns `worker/laya_worker.py`, speaks newline-delimited JSON over
 * stdin/stdout, and keeps the process (and its resident MLX model) warm across
 * prompts. No port and no server to keep alive: the extension owns the
 * lifecycle.
 *
 * Zero Pi dependencies — fully testable in Node.js/Vitest.
 */

import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { accessSync, constants, existsSync, realpathSync, statSync } from "node:fs";
import { delimiter, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createInterface } from "node:readline";

import { DEFAULT_THRESHOLDS } from "../config/defaults.js";
import type { LayaDecisionResponse, LayaHealthResponse } from "../types.js";
import {
  type Decider,
  type DeciderResult,
  type DecisionRequest,
  DeciderError,
} from "./types.js";

// ---------------------------------------------------------------------------
// Default worker resolution
// ---------------------------------------------------------------------------

/** Injectable spawn function (defaults to node:child_process `spawn`). */
export type SpawnFn = typeof spawn;

/**
 * Locate the directory containing `laya_worker.py`.
 *
 * The extension is commonly installed as a symlink (e.g.
 * `~/.pi/agent/extensions/laya-ll-router -> <repo>`). Depending on the loader,
 * `import.meta.url` may keep the symlinked path, so fall back to the realpath
 * of this module before giving up.
 */
export function resolveWorkerDir(env: NodeJS.ProcessEnv = process.env): string {
  if (env.LAYA_WORKER_DIR) return env.LAYA_WORKER_DIR;

  // This module lives in <root>/src/deciders/.
  const rootOf = (modulePath: string) => resolve(dirname(modulePath), "..", "..");
  const candidates = [join(rootOf(fileURLToPath(import.meta.url)), "worker")];
  try {
    const realRoot = rootOf(realpathSync(fileURLToPath(import.meta.url)));
    candidates.push(join(realRoot, "worker"));
  } catch {
    // realpath unavailable — keep the direct candidate only
  }

  for (const candidate of candidates) {
    if (existsSync(join(candidate, "laya_worker.py"))) return resolve(candidate);
  }
  return resolve(candidates[0]);
}

/** The worker's command name, once installed from the repo's `worker/` directory. */
export const WORKER_PACKAGE = "pignon-laya";

/** Worker protocol (`PROTOCOL_VERSION` in laya_worker.py) this extension speaks: 0.3.x. */
export const SUPPORTED_PROTOCOL = { major: 0, minor: 3 } as const;

/** How to start the worker, and where that came from. */
export interface WorkerLaunch {
  command: string;
  args: string[];
  cwd?: string;
  source: "config" | "env" | "checkout" | "path";
}

/**
 * Find the worker, in this order:
 * 1. `command` from the config (e.g. a development checkout);
 * 2. LAYA_PYTHON, running `laya_worker.py` from the worker directory;
 * 3. a source checkout with its `uv sync` environment (`worker/.venv`);
 * 4. `pignon-laya` on PATH (`uv tool install ./worker` from a checkout).
 */
export function resolveLaunch(
  env: NodeJS.ProcessEnv = process.env,
  command?: readonly string[],
): WorkerLaunch | { reason: string } {
  if (command && command.length > 0) return { command: command[0]!, args: command.slice(1), source: "config" };

  const workerDir = resolveWorkerDir(env);
  const script = env.LAYA_WORKER_SCRIPT ?? join(workerDir, "laya_worker.py");
  if (env.LAYA_PYTHON) return { command: env.LAYA_PYTHON, args: [script], cwd: workerDir, source: "env" };

  const venvPython = join(workerDir, ".venv", "bin", "python");
  if (existsSync(venvPython) && existsSync(script)) {
    return { command: venvPython, args: [script], cwd: workerDir, source: "checkout" };
  }

  const installed = which(WORKER_PACKAGE, env);
  if (installed) return { command: installed, args: [], source: "path" };

  return {
    reason: "the experimental Laya worker is not installed (see worker/README.md in the pignon repository)",
  };
}

/** First executable named `name` on PATH. */
export function which(name: string, env: NodeJS.ProcessEnv = process.env): string | undefined {
  for (const dir of (env.PATH ?? "").split(delimiter)) {
    if (!dir) continue;
    const candidate = join(dir, name);
    try {
      accessSync(candidate, constants.X_OK);
      if (statSync(candidate).isFile()) return candidate;
    } catch {
      // not here
    }
  }
  return undefined;
}

/** Why a worker's protocol version cannot be used, or undefined when it can. */
export function protocolProblem(version: unknown): string | undefined {
  const needed = `${SUPPORTED_PROTOCOL.major}.${SUPPORTED_PROTOCOL.minor}.x`;
  const upgradeWorker = "update it (`uv sync` in worker/, or `uv tool install --force ./worker`)";
  if (typeof version !== "string") return `the Laya worker is too old (no protocol version, pignon needs ${needed}); ${upgradeWorker}`;
  const [major, minor] = version.split(".").map(Number);
  if (major === undefined || minor === undefined || Number.isNaN(major) || Number.isNaN(minor)) {
    return `the Laya worker reports an invalid protocol version "${version}"`;
  }
  // Before 1.0, a minor version change is a breaking change.
  const compatible =
    major === SUPPORTED_PROTOCOL.major && (major > 0 || minor === SUPPORTED_PROTOCOL.minor);
  if (compatible) return undefined;
  const older = major < SUPPORTED_PROTOCOL.major || (major === SUPPORTED_PROTOCOL.major && minor < SUPPORTED_PROTOCOL.minor);
  return `the Laya worker speaks protocol ${version}, pignon needs ${needed}; ${older ? upgradeWorker : "upgrade pignon"}`;
}

/**
 * Whether the local worker can run here: laya-mlx needs an Apple Silicon Mac,
 * and the worker needs a Python environment (`uv sync` in the worker dir, or
 * LAYA_PYTHON).
 */
export type LayaRuntimeStatus = { ok: true; launch?: WorkerLaunch } | { ok: false; reason: string };

export function layaRuntimeStatus(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
  arch: string = process.arch,
  command?: readonly string[],
): LayaRuntimeStatus {
  if (platform !== "darwin" || arch !== "arm64") {
    return { ok: false, reason: "the local Laya model needs an Apple Silicon Mac" };
  }
  const launch = resolveLaunch(env, command);
  return "reason" in launch ? { ok: false, reason: launch.reason } : { ok: true, launch };
}

// ---------------------------------------------------------------------------
// Worker environment
// ---------------------------------------------------------------------------

/** Variables the worker needs: process basics, locale, proxies and CA bundles. */
const ENV_NAMES = new Set([
  "PATH",
  "HOME",
  "USER",
  "LOGNAME",
  "TMPDIR",
  "TMP",
  "TEMP",
  "LANG",
  "XDG_CACHE_HOME",
  "XDG_CONFIG_HOME",
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "NO_PROXY",
  "ALL_PROXY",
  "http_proxy",
  "https_proxy",
  "no_proxy",
  "all_proxy",
  "SSL_CERT_FILE",
  "SSL_CERT_DIR",
  "REQUESTS_CA_BUNDLE",
  "CURL_CA_BUNDLE",
]);

/** Prefixes for the worker's own settings, Hugging Face Hub, MLX and locale. */
const ENV_PREFIXES = ["LAYA_", "HF_", "HUGGINGFACE_", "MLX_", "LC_"];

/**
 * Environment passed to the worker.
 *
 * The worker runs third-party Python packages, so it gets an allowlist rather
 * than the host's whole environment (which holds provider API keys).
 */
export function workerEnv(source: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [name, value] of Object.entries(source)) {
    if (value === undefined) continue;
    if (ENV_NAMES.has(name) || ENV_PREFIXES.some((prefix) => name.startsWith(prefix))) {
      env[name] = value;
    }
  }
  return env;
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

/** Error raised when the worker cannot be started or a request fails. */
export class LayaWorkerError extends DeciderError {
  constructor(message: string, cause?: unknown) {
    super(message, cause);
    this.name = "LayaWorkerError";
  }
}

// ---------------------------------------------------------------------------
// Wire protocol
// ---------------------------------------------------------------------------

interface WorkerReady {
  type: "ready";
  /** `PROTOCOL_VERSION` of the worker; absent before pignon. */
  protocol?: string;
  model?: string;
  backend?: string;
}

interface WorkerFatal {
  type: "fatal";
  error: string;
}

interface WorkerSuccess {
  id: number | null;
  ok: true;
  result: unknown;
}

interface WorkerFailure {
  id: number | null;
  ok: false;
  error: string;
}

type WorkerMessage = WorkerReady | WorkerFatal | WorkerSuccess | WorkerFailure;

interface Pending {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
  signal?: AbortSignal;
  onAbort?: () => void;
}

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

export interface LayaWorkerOptions {
  /** Executable to run. Defaults to what `resolveLaunch()` finds. */
  command?: string;
  /** Arguments. Defaults to the worker script (override with LAYA_WORKER_SCRIPT). */
  args?: string[];
  /** Working directory for the worker. Defaults to `resolveWorkerDir()`. */
  cwd?: string;
  /** Extra environment variables merged over the `workerEnv()` allowlist. */
  env?: NodeJS.ProcessEnv;
  /** Per-request timeout in milliseconds. */
  timeoutMs?: number;
  /** How long to wait for the model to load and report `ready`. */
  startupTimeoutMs?: number;
  /** Command from the config (`deciders[].command`), tried before anything else. */
  launchCommand?: readonly string[];
  /** Spawn implementation injection (used by tests). */
  spawnFn?: SpawnFn;
}

/**
 * Generous because the first start may download the checkpoint from Hugging
 * Face; prompts never wait on startup, so this only bounds a hung worker.
 */
const DEFAULT_STARTUP_TIMEOUT_MS = 300_000;

/** How long `stop()` waits after SIGTERM before sending SIGKILL. */
const STOP_GRACE_MS = 500;

/** Worker diagnostics kept in memory for `/laya log`. */
const LOG_CAPACITY = 200;
const LOG_LINE_MAX = 500;

// ---------------------------------------------------------------------------
// Client
// ---------------------------------------------------------------------------

/**
 * Client for the local Laya stdio worker.
 *
 * The process starts lazily on the first request and is reused afterwards.
 * All methods accept an optional `AbortSignal` so callers can bound latency
 * and respect Pi session cancellation.
 */
export class LayaWorker implements Decider {
  readonly id = "laya-local";
  readonly remote = false;

  private readonly command: string;
  private readonly args: string[];
  private readonly cwd?: string;
  private readonly env: NodeJS.ProcessEnv;
  private readonly timeoutMs: number;
  private readonly startupTimeoutMs: number;
  private readonly spawnFn: SpawnFn;

  /** Why the worker cannot be started here, when no launcher was found. */
  private readonly unavailable?: string;
  private child?: ChildProcessWithoutNullStreams;
  private ready = false;
  private starting?: Promise<void>;
  private stopped = false;
  private nextId = 1;
  private lastModel?: string;
  private readonly pending = new Map<number, Pending>();
  private readonly logLines: string[] = [];

  constructor(options: LayaWorkerOptions = {}) {
    // Resolved here rather than at import time, so env overrides set before
    // construction apply and importing the module has no side effects.
    let launch: WorkerLaunch | { reason: string };
    if (options.command !== undefined) {
      launch = { command: options.command, args: options.args ?? [], source: "config" };
    } else {
      launch = resolveLaunch(process.env, options.launchCommand);
    }
    if ("reason" in launch) {
      this.unavailable = launch.reason;
      launch = { command: "", args: [], source: "config" };
    }
    this.command = launch.command;
    this.args = launch.args;
    this.cwd = options.cwd ?? launch.cwd;
    this.env = { ...workerEnv(), ...options.env };
    this.timeoutMs = options.timeoutMs ?? DEFAULT_THRESHOLDS.layaTimeoutMs;
    this.startupTimeoutMs = options.startupTimeoutMs ?? DEFAULT_STARTUP_TIMEOUT_MS;
    this.spawnFn = options.spawnFn ?? spawn;
  }

  /** Model repo reported by the worker once ready. */
  get model(): string | undefined {
    return this.lastModel;
  }

  /** Whether the worker process is currently running and warmed up. */
  get isReady(): boolean {
    return this.ready && this.child !== undefined;
  }

  /**
   * Most recent worker diagnostics (stderr and protocol errors), oldest first.
   *
   * Kept in memory instead of written to the host's stderr, which would draw
   * over Pi's TUI.
   */
  get recentLogs(): readonly string[] {
    return this.logLines;
  }

  /** Worker health and loaded model. */
  async health(signal?: AbortSignal): Promise<LayaHealthResponse> {
    const result = await this.request("health", {}, signal);
    if (!isHealthResponse(result)) {
      throw new LayaWorkerError("Laya worker returned a malformed health response");
    }
    return result;
  }

  /** Ask the worker the request's questions; answers are parsed by the caller. */
  async decide(request: DecisionRequest, signal?: AbortSignal): Promise<DeciderResult> {
    const started = Date.now();

    const response = await this.request(
      "decide",
      { text: request.text, questions: request.questions },
      signal,
    );
    if (!isDecisionResponse(response)) {
      throw new LayaWorkerError("Laya worker returned a malformed decision");
    }

    return {
      deciderId: this.id,
      model: typeof response.model === "string" ? response.model : (this.lastModel ?? "unknown"),
      answers: response.answers,
      latencyMs: Date.now() - started,
    };
  }

  /** Start the worker and load its model without sending a real decision. */
  async warmup(signal?: AbortSignal): Promise<void> {
    await this.health(signal);
  }

  /**
   * Stop the worker and reject any in-flight requests.
   *
   * Safe to call multiple times; the client cannot be restarted afterwards.
   */
  stop(): void {
    if (this.stopped) return;
    this.stopped = true;

    const child = this.child;
    this.failAll(new LayaWorkerError("Laya worker stopped"));
    this.child = undefined;
    this.ready = false;

    if (child) {
      try {
        child.stdin.end();
      } catch {
        // stdin may already be closed
      }
      child.kill("SIGTERM");
      // `child.killed` only means a signal was delivered; check whether the
      // process has actually exited before escalating.
      const timer = setTimeout(() => {
        if (child.exitCode === null && child.signalCode === null) {
          try {
            child.kill("SIGKILL");
          } catch {
            // already gone
          }
        }
      }, STOP_GRACE_MS);
      timer.unref?.();
    }
  }

  // -------------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------------

  private async request(
    method: string,
    params: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<unknown> {
    if (this.stopped) {
      throw new LayaWorkerError("Laya worker is stopped");
    }

    await this.ensureStarted();

    if (signal?.aborted) {
      throw new LayaWorkerError("Laya worker request aborted");
    }

    const child = this.child;
    if (!child) {
      throw new LayaWorkerError("Laya worker is not running");
    }

    const id = this.nextId++;

    return new Promise<unknown>((resolve, reject) => {
      const cleanup = () => {
        clearTimeout(timer);
        if (onAbort) signal?.removeEventListener("abort", onAbort);
      };

      const timer = setTimeout(() => {
        this.pending.delete(id);
        cleanup();
        reject(new LayaWorkerError(`Laya worker request timed out after ${this.timeoutMs}ms`));
      }, this.timeoutMs);

      const onAbort = signal
        ? () => {
            this.pending.delete(id);
            cleanup();
            reject(new LayaWorkerError("Laya worker request aborted"));
          }
        : undefined;

      if (onAbort) signal!.addEventListener("abort", onAbort, { once: true });

      this.pending.set(id, { resolve, reject, timer, signal, onAbort });

      try {
        // The worker drops requests whose deadline passed while they were
        // queued, so a backlog of timed-out requests cannot build up.
        const deadline_ms = Date.now() + this.timeoutMs;
        child.stdin.write(JSON.stringify({ id, method, deadline_ms, ...params }) + "\n");
      } catch (err) {
        this.pending.delete(id);
        cleanup();
        reject(new LayaWorkerError("Failed to write to Laya worker", err));
      }
    });
  }

  private ensureStarted(): Promise<void> {
    if (this.unavailable) return Promise.reject(new LayaWorkerError(this.unavailable));
    if (this.ready && this.child) return Promise.resolve();
    if (!this.starting) {
      this.starting = this.startProcess().finally(() => {
        this.starting = undefined;
      });
    }
    return this.starting;
  }

  private startProcess(): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      let settled = false;
      let startTimer: ReturnType<typeof setTimeout> | undefined;
      const settleReady = () => {
        if (settled) return;
        settled = true;
        if (startTimer) clearTimeout(startTimer);
        this.ready = true;
        resolve();
      };
      const settleError = (err: LayaWorkerError) => {
        if (settled) return;
        settled = true;
        if (startTimer) clearTimeout(startTimer);
        reject(err);
      };

      let child: ChildProcessWithoutNullStreams;
      try {
        child = this.spawnFn(this.command, this.args, {
          cwd: this.cwd,
          env: this.env,
          stdio: ["pipe", "pipe", "pipe"],
        }) as ChildProcessWithoutNullStreams;
      } catch (err) {
        settleError(new LayaWorkerError(`Failed to spawn Laya worker: ${String(err)}`, err));
        return;
      }

      this.child = child;
      this.ready = false;

      startTimer = setTimeout(() => {
        settleError(
          new LayaWorkerError(`Laya worker not ready after ${this.startupTimeoutMs}ms`),
        );
        // Do not leave a half-started process (and its model) running: the
        // next request would spawn another one next to it.
        if (this.child === child) {
          this.child = undefined;
          this.ready = false;
        }
        child.kill("SIGKILL");
      }, this.startupTimeoutMs);

      const rl = createInterface({ input: child.stdout });
      // A worker this extension cannot talk to must not stay up holding its model.
      const rejectWorker = (err: LayaWorkerError) => {
        settleError(err);
        this.log(err.message);
        if (this.child === child) {
          this.child = undefined;
          this.ready = false;
        }
        child.kill("SIGKILL");
      };
      rl.on("line", (line) => this.handleLine(line, settleReady, settleError, rejectWorker));

      // Split on "\n" only: readline would also split on the "\r" progress
      // bars use to redraw, turning one bar into hundreds of log lines.
      let stderrBuffer = "";
      child.stderr.setEncoding("utf8");
      child.stderr.on("data", (chunk: string) => {
        stderrBuffer += chunk;
        const lines = stderrBuffer.split("\n");
        stderrBuffer = lines.pop() ?? "";
        for (const line of lines) this.log(line);
      });

      // A replaced child (e.g. killed after a startup timeout) must not tear
      // down the current one or fail its pending requests.
      child.on("error", (err) => {
        if (this.child === child) {
          this.handleExit(new LayaWorkerError(`Laya worker process error: ${err.message}`, err));
        }
        settleError(new LayaWorkerError(`Laya worker process error: ${err.message}`, err));
      });

      child.on("exit", (code, signal) => {
        rl.close();
        this.log(stderrBuffer);
        this.log(`exited (code=${code ?? "null"}, signal=${signal ?? "null"})`);
        if (this.child === child) {
          this.handleExit(
            new LayaWorkerError(`Laya worker exited (code=${code ?? "null"}, signal=${signal ?? "null"})`),
          );
        }
        settleError(
          new LayaWorkerError(`Laya worker exited before ready (code=${code ?? "null"})`),
        );
      });
    });
  }

  private handleLine(
    line: string,
    settleReady: () => void,
    settleError: (err: LayaWorkerError) => void,
    rejectWorker: (err: LayaWorkerError) => void,
  ): void {
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      return; // ignore non-protocol noise
    }
    // Stray stdout output can still be valid JSON (`42`, `null`, `[]`).
    if (!isWorkerMessage(parsed)) return;
    const message = parsed;

    if ("type" in message) {
      if (message.type === "ready") {
        const problem = protocolProblem(message.protocol);
        if (problem) {
          rejectWorker(new LayaWorkerError(problem));
          return;
        }
        this.lastModel = message.model;
        settleReady();
      } else if (message.type === "fatal") {
        settleError(new LayaWorkerError(`Laya worker failed to load model: ${message.error}`));
      }
      return;
    }

    if (message.id === null) {
      this.log(`protocol error: ${message.ok ? "" : message.error}`);
      return;
    }

    const pending = this.pending.get(message.id);
    if (!pending) return;

    this.pending.delete(message.id);
    clearTimeout(pending.timer);
    if (pending.onAbort && pending.signal) {
      pending.signal.removeEventListener("abort", pending.onAbort);
    }

    if (message.ok) {
      pending.resolve(message.result);
    } else {
      pending.reject(new LayaWorkerError(message.error));
    }
  }

  private log(line: string): void {
    const text = line.trimEnd();
    if (!text) return;
    // Progress bars redraw with carriage returns; keep only the final state.
    const last = text.slice(text.lastIndexOf("\r") + 1);
    this.logLines.push(last.length > LOG_LINE_MAX ? `${last.slice(0, LOG_LINE_MAX)}…` : last);
    if (this.logLines.length > LOG_CAPACITY) this.logLines.shift();
  }

  private handleExit(err: Error): void {
    this.child = undefined;
    this.ready = false;
    this.failAll(err);
  }

  private failAll(err: Error): void {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      if (pending.onAbort && pending.signal) {
        pending.signal.removeEventListener("abort", pending.onAbort);
      }
      pending.reject(err);
    }
    this.pending.clear();
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isHealthResponse(value: unknown): value is LayaHealthResponse {
  return isRecord(value) && typeof value.ready === "boolean";
}

/** Only `answers` is required; `parseDecision` checks each answer it reads. */
function isDecisionResponse(value: unknown): value is LayaDecisionResponse {
  return isRecord(value) && isRecord(value.answers);
}

/** Shape check for a line read from the worker's stdout. */
function isWorkerMessage(value: unknown): value is WorkerMessage {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  if ("type" in record) return record.type === "ready" || record.type === "fatal";
  return (
    (typeof record.id === "number" || record.id === null) &&
    typeof record.ok === "boolean"
  );
}

