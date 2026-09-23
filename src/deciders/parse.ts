/**
 * Turn raw decider answers into the routing-relevant `RoutingDecision`.
 *
 * Shared by every decider, so the policy never sees decider-specific shapes.
 * Tolerant of malformed input: a missing or invalid answer reads as "no
 * signal", which the policy treats as fail-open.
 */

import { type RoutingDecision, type Tier, TIER_ORDER } from "../types.js";
import { EXPLORATION_QUESTION, TIER_QUESTION } from "./questions.js";
import type { RawAnswers } from "./types.js";

export function parseDecision(answers: RawAnswers, latencyMs: number): RoutingDecision {
  const tierAnswer = choiceOf(answers[TIER_QUESTION]);
  const tier = tierAnswer && isTier(tierAnswer.choice) ? tierAnswer.choice : null;

  const explorationAnswer = choiceOf(answers[EXPLORATION_QUESTION]);

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
function choiceOf(value: unknown): { choice: string; confidence: number } | null {
  if (!isRecord(value) || typeof value.choice !== "string") return null;
  if (value.type !== undefined && value.type !== "choice") return null;
  const confidence = value.confidence;
  return {
    choice: value.choice,
    confidence: typeof confidence === "number" && Number.isFinite(confidence) ? confidence : 0,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isTier(value: string): value is Tier {
  return TIER_ORDER.includes(value as Tier);
}
