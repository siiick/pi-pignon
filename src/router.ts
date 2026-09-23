/**
 * Per-prompt routing: ask the decider, run the policy, apply the verdict.
 *
 * Pi-free: everything it needs from the host (current model, registry, model
 * switching, UI feedback) goes through `RouterHost`, so it can be tested with
 * plain fakes.
 */

import { createHash } from "node:crypto";

import { parseDecision } from "./deciders/parse.js";
import { buildQuestions } from "./deciders/questions.js";
import type { Decider } from "./deciders/types.js";
import { decide, formOf, profileFromModel, specOf } from "./policy.js";
import type {
  PolicyOutput,
  Price,
  Profile,
  RouterConfig,
  RouterLogEntry,
  RouterMode,
  RoutingDecision,
  ThinkingLevel,
} from "./types.js";

/**
 * Laya reads at most ~320 tokens of the prompt (512-token window minus the
 * question header) from the start and ignores the rest, so sending more only
 * costs tokenization time (and, for remote deciders, money and privacy).
 */
export const MAX_PROMPT_CHARS = 4_000;

/** The part of a host model the router reads. */
export interface HostModel {
  provider: string;
  id: string;
  cost?: Price;
}

/** What the router needs from the agent it runs in (Pi, or a test fake). */
export interface RouterHost<M extends HostModel = HostModel> {
  /** Model the prompt would run on now. */
  readonly model: M | undefined;
  readonly contextTokens: number;
  /** Cancellation of the current agent run. */
  readonly signal: AbortSignal | undefined;
  findModel(provider: string, modelId: string): M | undefined;
  /** Switch model without the switch being taken for a manual pin. Resolves false without auth. */
  switchModel(model: M): Promise<boolean>;
  setThinkingLevel(level: ThinkingLevel): void;
  status(text: string): void;
  notify(text: string, level: "info" | "warning" | "error"): void;
  showDeciding(deciderModel: string): void;
  hideDeciding(): void;
}

export interface RoutePromptOptions {
  decider: Decider;
  config: RouterConfig;
  mode: Exclude<RouterMode, "off">;
  /** Prompts since the router last switched models; undefined if it never has. */
  promptsSinceSwitch: number | undefined;
}

export interface RouteResult {
  /** Whether the model was switched. */
  applied: boolean;
  entry: RouterLogEntry;
}

/** Ask the decider about one prompt and apply the verdict. Never throws. */
export async function routePrompt<M extends HostModel>(
  host: RouterHost<M>,
  options: RoutePromptOptions,
  prompt: string,
): Promise<RouteResult> {
  const { decider, config, mode, promptsSinceSwitch } = options;
  const { table, thresholds } = config;
  const model = host.model;
  const current = model ? profileFromModel(model.provider, model.id, table) : null;
  const contextTokens = host.contextTokens;
  const currentModel = model ? `${model.provider}/${model.id}` : undefined;
  const entryBase = { mode, config, decider, currentModel, prompt, current, contextTokens };

  try {
    host.status("pignon is deciding...");
    host.showDeciding(decider.model ?? "unknown");
    let result;
    try {
      result = await decider.decide(
        { text: prompt.slice(0, MAX_PROMPT_CHARS), questions: buildQuestions(config) },
        host.signal,
      );
    } finally {
      host.hideDeciding();
    }
    const decision = parseDecision(result.answers, result.latencyMs, config);

    const verdict = decide({
      decision,
      current,
      contextTokens,
      promptsSinceSwitch,
      currentPrice: model?.cost,
      priceOf: (spec) => host.findModel(spec.provider, spec.modelId)?.cost,
      config,
    });

    let applied = false;
    if (mode === "live" && verdict.target) {
      const spec = specOf(table, verdict.target)!;
      const target = host.findModel(spec.provider, spec.modelId);
      if (!target) {
        host.notify(`pignon: ${spec.provider}/${spec.modelId} is not in the model registry`, "warning");
      } else if (await host.switchModel(target)) {
        host.setThinkingLevel(spec.thinking);
        applied = true;
      } else {
        host.notify(`pignon: no auth for ${spec.provider}/${spec.modelId}`, "warning");
      }
    }

    const entry = buildLogEntry({
      ...entryBase,
      deciderModel: result.model,
      ...(result.costUsd !== undefined ? { costUsd: result.costUsd } : {}),
      decision,
      verdict,
      applied,
    });

    const badge = mode === "live" ? (applied ? "⚡" : "·") : "👁";
    const label = `${decision.tier ?? "?"}/${formOf(decision, thresholds.minConfidenceForm)} p=${decision.tierConfidence.toFixed(2)}`;
    host.status(`pignon ${badge} ${label} — ${verdict.reason}`);
    return { applied, entry };
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    host.status(`pignon ✗ ${error.slice(0, 80)}`);
    const entry = buildLogEntry({
      ...entryBase,
      deciderModel: decider.model ?? "unknown",
      decision: null,
      verdict: { target: null, reason: "error" },
      applied: false,
      error,
    });
    return { applied: false, entry };
  }
}

// ---------------------------------------------------------------------------
// Log entries
// ---------------------------------------------------------------------------

/** Short, stable fingerprint of a prompt; the text itself is never stored. */
export function hashPrompt(prompt: string): string {
  return createHash("sha256").update(prompt).digest("hex").slice(0, 16);
}

interface LogEntryInput {
  mode: RouterMode;
  config: RouterConfig;
  decider: Decider;
  costUsd?: number;
  currentModel: string | undefined;
  deciderModel: string;
  prompt: string;
  decision: RoutingDecision | null;
  current: Profile | null;
  contextTokens: number;
  verdict: PolicyOutput;
  applied: boolean;
  error?: string;
}

function buildLogEntry(input: LogEntryInput): RouterLogEntry {
  const { decision, current, verdict } = input;
  const spec = verdict.target ? specOf(input.config.table, verdict.target) : undefined;
  return {
    ts: Date.now(),
    mode: input.mode,
    decider: input.decider.id,
    remote: input.decider.remote,
    ...(input.costUsd !== undefined ? { costUsd: input.costUsd } : {}),
    deciderModel: input.deciderModel,
    questionsVersion: input.config.questions.version,
    promptHash: hashPrompt(input.prompt),
    promptLength: input.prompt.length,
    tier: decision?.tier ?? null,
    tierConfidence: decision?.tierConfidence ?? null,
    needsExploration: decision?.needsExploration ?? null,
    explorationConfidence: decision?.explorationConfidence ?? null,
    form: decision ? formOf(decision, input.config.thresholds.minConfidenceForm) : null,
    latencyMs: decision?.latencyMs ?? null,
    currentTier: current?.tier ?? null,
    currentForm: current?.form ?? null,
    ...(input.currentModel !== undefined ? { currentModel: input.currentModel } : {}),
    contextTokens: input.contextTokens,
    targetTier: verdict.target?.tier ?? null,
    targetForm: verdict.target?.form ?? null,
    ...(spec ? { targetModel: `${spec.provider}/${spec.modelId}`, targetThinking: spec.thinking } : {}),
    reason: verdict.reason,
    applied: input.applied,
    ...(input.error !== undefined ? { error: input.error } : {}),
  };
}
