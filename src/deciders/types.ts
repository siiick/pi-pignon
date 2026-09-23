/**
 * The seam between the router and whatever classifies a prompt.
 *
 * A decider answers typed questions (Laya/Jev format) about a prompt. It may
 * run locally (the Laya stdio worker) or remotely (TypeSafe's Jev); the router
 * only sees this interface, and `parse.ts` turns the raw answers into a
 * `RoutingDecision`.
 */

import type { LayaQuestion } from "../types.js";

/** What a decider is asked about one prompt. */
export interface DecisionRequest {
  /** The prompt, already truncated by the router. */
  text: string;
  /** Typed questions keyed by name; see `questions.ts`. */
  questions: Readonly<Record<string, LayaQuestion>>;
}

/**
 * Answers keyed by question name, as the decider returned them.
 *
 * Deliberately untyped: answers come from another process or the network and
 * are validated by `parseDecision`.
 */
export type RawAnswers = Readonly<Record<string, unknown>>;

/** One decider's reply to a `DecisionRequest`. */
export interface DeciderResult {
  /** `Decider.id` of the decider that answered. */
  deciderId: string;
  /** Checkpoint or remote model version that produced the answers. */
  model: string;
  answers: RawAnswers;
  /** Wall time of the call as seen by the caller. */
  latencyMs: number;
  /** Price of the call in USD, for remote deciders that report it. */
  costUsd?: number;
}

export interface Decider {
  /** Stable identifier, e.g. `laya-local`. */
  readonly id: string;
  /** Whether prompts leave the machine. */
  readonly remote: boolean;
  /** Whether a `decide` call can be answered now without waiting to load. */
  readonly isReady: boolean;
  /** Model in use once known, for status lines and log entries. */
  readonly model: string | undefined;
  /** Recent diagnostics, oldest first, for `/laya log`. */
  readonly recentLogs: readonly string[];

  /** Prepare the decider (load a model, check credentials). */
  warmup(signal?: AbortSignal): Promise<void>;
  decide(request: DecisionRequest, signal?: AbortSignal): Promise<DeciderResult>;
  /** Release resources. The decider cannot be used afterwards. */
  stop(): void;
}

/** Error raised by a decider that could not produce answers. */
export class DeciderError extends Error {
  constructor(message: string, cause?: unknown) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = "DeciderError";
  }
}
