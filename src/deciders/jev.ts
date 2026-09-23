/**
 * `jev` decider: TypeSafe's hosted Jev System-One model, through the official
 * TypeScript SDK (`@typesafe-ai/sdk`).
 *
 * Remote: the prompt (already capped by the router) leaves the machine. The
 * SDK is hardened for use inside Pi's TUI:
 * - its logger writes to `recentLogs` (for `/pignon log`), never the console,
 *   and never at `debug` level, which would log request bodies (prompts);
 * - retries are off by default: the SDK's timeout applies per attempt with no
 *   total budget, and a routing decision that arrives late is useless.
 */

import {
  type Fetch,
  type Logger,
  type Question,
  APIConnectionError,
  APIError,
  APITimeoutError,
  APIUserAbortError,
  AuthenticationError,
  PermissionDeniedError,
  RateLimitError,
  TypeSafeClient,
  TypeSafeError,
} from "@typesafe-ai/sdk";

import type { LayaQuestion } from "../types.js";
import { type Decider, type DeciderResult, type DecisionRequest, DeciderError } from "./types.js";

/** Environment variable holding the API key unless `apiKeyEnv` names another. */
export const DEFAULT_API_KEY_ENV = "TYPESAFE_API_KEY";

/** Jev answers in 70–500 ms; a decision later than this is not worth waiting for. */
export const DEFAULT_JEV_TIMEOUT_MS = 1_500;

const LOG_CAPACITY = 200;

export interface JevDeciderOptions {
  /** Environment variable that holds the API key. Defaults to TYPESAFE_API_KEY. */
  apiKeyEnv?: string;
  /** API root, e.g. `https://openrouter.ai/api` to go through OpenRouter. Defaults to the SDK's (TypeSafe). */
  baseURL?: string;
  /** Jev model to pin, e.g. `jev-1.13.0`. Defaults to the SDK's (`jev-latest`). */
  model?: string;
  /** Timeout for one decision, in milliseconds. */
  timeoutMs?: number;
  /** Retries after a failed attempt. Each gets the full timeout. */
  maxRetries?: number;
  /** Where to read the API key and SDK settings. Defaults to `process.env`. */
  env?: NodeJS.ProcessEnv;
  /** HTTP implementation (tests). */
  fetch?: Fetch;
}

export class JevDecider implements Decider {
  readonly id = "jev";
  readonly remote = true;

  private readonly options: JevDeciderOptions;
  private readonly apiKeyEnv: string;
  private readonly timeoutMs: number;
  private readonly logLines: string[] = [];
  private client?: TypeSafeClient;
  private stopped = false;

  constructor(options: JevDeciderOptions = {}) {
    this.options = options;
    this.apiKeyEnv = options.apiKeyEnv ?? DEFAULT_API_KEY_ENV;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_JEV_TIMEOUT_MS;
  }

  /** Ready as soon as an API key is available; there is nothing to load. */
  get isReady(): boolean {
    return !this.stopped && this.apiKey() !== undefined;
  }

  get model(): string | undefined {
    return this.client?.defaultModel ?? this.options.model ?? this.env().TYPESAFE_DEFAULT_MODEL ?? "jev-latest";
  }

  get recentLogs(): readonly string[] {
    return this.logLines;
  }

  /** Check the API key and build the client. No network call. */
  async warmup(): Promise<void> {
    this.ensureClient();
  }

  async decide(request: DecisionRequest, signal?: AbortSignal): Promise<DeciderResult> {
    const client = this.ensureClient();
    const started = Date.now();
    try {
      const result = await client.systemOne(
        { state: request.text, questions: toSdkQuestions(request.questions) },
        { signal, timeout: this.timeoutMs, retry: { maxRetries: this.options.maxRetries ?? 0 } },
      );
      // The API reports the price at runtime; the SDK does not declare it yet.
      const cost = (result.usage as { cost?: unknown } | undefined)?.cost;
      return {
        deciderId: this.id,
        model: result.model,
        answers: result.answers,
        latencyMs: Date.now() - started,
        ...(typeof cost === "number" && Number.isFinite(cost) ? { costUsd: cost } : {}),
      };
    } catch (err) {
      const error = describeError(err, this.timeoutMs);
      this.log(`decide failed: ${error}`);
      throw new DeciderError(`jev: ${error}`, err);
    }
  }

  stop(): void {
    this.stopped = true;
    this.client = undefined;
  }

  // -------------------------------------------------------------------------

  private env(): NodeJS.ProcessEnv {
    return this.options.env ?? process.env;
  }

  private apiKey(): string | undefined {
    const key = this.env()[this.apiKeyEnv]?.trim();
    return key ? key : undefined;
  }

  private ensureClient(): TypeSafeClient {
    if (this.stopped) throw new DeciderError("jev: decider is stopped");
    if (this.client) return this.client;
    const apiKey = this.apiKey();
    if (!apiKey) throw new DeciderError(`jev: ${this.apiKeyEnv} is not set`);

    const env = this.env();
    try {
      this.client = new TypeSafeClient({
        apiKey,
        baseURL: this.options.baseURL ?? env.TYPESAFE_BASE_URL,
        defaultModel: this.options.model ?? env.TYPESAFE_DEFAULT_MODEL,
        logger: this.logger(),
        // `debug` logs request bodies, which hold the prompt.
        logLevel: "warn",
        timeout: this.timeoutMs,
        ...(this.options.fetch ? { fetch: this.options.fetch } : {}),
      });
    } catch (err) {
      throw new DeciderError(`jev: ${err instanceof Error ? err.message : String(err)}`, err);
    }
    return this.client;
  }

  private logger(): Logger {
    const write = (level: string) => (message: string) => this.log(`${level}: ${message}`);
    return { debug: write("debug"), info: write("info"), warn: write("warn"), error: write("error") };
  }

  private log(line: string): void {
    this.logLines.push(line);
    if (this.logLines.length > LOG_CAPACITY) this.logLines.shift();
  }
}

/** Our question shapes are the Jev wire format; only the score tuple type differs. */
function toSdkQuestions(questions: DecisionRequest["questions"]): Record<string, Question> {
  return Object.fromEntries(Object.entries(questions).map(([name, q]) => [name, toSdkQuestion(q)]));
}

function toSdkQuestion(question: LayaQuestion): Question {
  if (question.type === "score") {
    if (question.criteria.length < 2) throw new DeciderError("jev: a score question needs at least two criteria");
    return { ...question, criteria: question.criteria as unknown as readonly [string, string, ...string[]] };
  }
  return question;
}

/** One short line per failure, for the status bar and decision card. */
export function describeError(err: unknown, timeoutMs: number): string {
  if (err instanceof AuthenticationError || err instanceof PermissionDeniedError) {
    return `API key rejected (HTTP ${err.status})`;
  }
  if (err instanceof RateLimitError) return "rate limited (HTTP 429)";
  if (err instanceof APIError) return `HTTP ${err.status}${err.requestId ? ` (request ${err.requestId})` : ""}`;
  if (err instanceof APITimeoutError) return `timed out after ${timeoutMs} ms`;
  if (err instanceof APIUserAbortError) return "aborted";
  if (err instanceof APIConnectionError) return `cannot reach the API: ${err.message}`;
  if (err instanceof TypeSafeError || err instanceof Error) return err.message;
  return String(err);
}
