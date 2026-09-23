/**
 * Turn raw decider answers into the routing-relevant `RoutingDecision`.
 *
 * Shared by every decider, so the policy never sees decider-specific shapes.
 * Tolerant of malformed input: a missing or invalid answer reads as "no
 * signal", which the policy treats as fail-open.
 */

import { DEFAULT_CONFIG } from "../config/defaults.js";
import type { ConfidenceSource, RouterConfig, RoutingDecision } from "../types.js";
import { EXPLORATION_QUESTION, TIER_QUESTION } from "./questions.js";
import type { RawAnswers } from "./types.js";

export function parseDecision(
  answers: RawAnswers,
  latencyMs: number,
  config: Pick<RouterConfig, "table" | "confidenceSource"> = DEFAULT_CONFIG,
): RoutingDecision {
  const tierAnswer = choiceOf(answers[TIER_QUESTION], config.confidenceSource);
  const tier = tierAnswer && config.table.some((t) => t.id === tierAnswer.choice) ? tierAnswer.choice : null;

  const explorationAnswer = choiceOf(answers[EXPLORATION_QUESTION], config.confidenceSource);

  return {
    tier,
    tierConfidence: tier ? tierAnswer!.confidence : 0,
    needsExploration: explorationAnswer?.choice === "yes",
    explorationConfidence: explorationAnswer?.confidence ?? 0,
    latencyMs,
  };
}

/**
 * Extract a choice answer. The Laya worker tags answers with `type`, the
 * TypeSafe SDK does not, so the tag is only checked when present.
 */
function choiceOf(value: unknown, source: ConfidenceSource): { choice: string; confidence: number } | null {
  if (!isRecord(value) || typeof value.choice !== "string") return null;
  if (value.type !== undefined && value.type !== "choice") return null;
  const choice = value.choice;
  const confidence =
    source === "top-probability" && isRecord(value.probabilities) ? value.probabilities[choice] : value.confidence;
  return { choice, confidence: typeof confidence === "number" && Number.isFinite(confidence) ? confidence : 0 };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
