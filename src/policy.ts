/**
 * Pure routing policy.
 *
 * No I/O, no Pi dependencies — the only thing to unit-test.
 */

import {
  type Form,
  type ModelSpec,
  type PolicyInput,
  type PolicyOutput,
  type Price,
  type Profile,
  type RoutingDecision,
  type RoutingTable,
  TIER_ORDER,
  FORMS,
  DEFAULT_CONFIG,
  DEFAULT_THRESHOLDS,
} from "./types.js";

/** Derive the task form from a Laya decision. */
export function formOf(
  decision: RoutingDecision,
  minConfidenceForm = DEFAULT_THRESHOLDS.minConfidenceForm,
): Form {
  if (!decision.needsExploration && decision.explorationConfidence >= minConfidenceForm) {
    return "direct";
  }
  return "exploration";
}

/**
 * Given a Laya decision, the current profile, and context metadata,
 * decide whether to switch models and to which profile.
 *
 * Upgrades are quality-driven: only tier confidence gates them. Every other
 * switch (downgrade, lateral, or moving in from a model outside the table)
 * must also get past the cooldown and the switch-cost check, because it
 * throws away the current prompt cache.
 *
 * Fail-open: any missing or ambiguous signal keeps the current model.
 */
export function decide(input: PolicyInput): PolicyOutput {
  const { decision, current, contextTokens, promptsSinceSwitch, config = DEFAULT_CONFIG } = input;
  const { tiers, thresholds } = config;

  // Fail-open : no usable decision -> do nothing.
  if (!decision || decision.tier === null) {
    return { target: null, reason: "no decision" };
  }

  const form = formOf(decision, thresholds.minConfidenceForm);
  let tier = decision.tier;

  // Exploration forbids the lowest tier regardless of reasoning demand,
  // because the tool loop will be long.
  if (form === "exploration" && tier === "trivial") {
    tier = "standard";
  }

  const target: Profile = { tier, form };
  const targetSpec = tiers[tier][form];

  // Several cells may share a model: compare what would actually run.
  if (current && sameSpec(tiers[current.tier][current.form], targetSpec)) {
    return { target: null, reason: "already on target model" };
  }

  const move = !current
    ? "enter"
    : TIER_ORDER.indexOf(tier) > TIER_ORDER.indexOf(current.tier)
      ? "upgrade"
      : TIER_ORDER.indexOf(tier) < TIER_ORDER.indexOf(current.tier)
        ? "downgrade"
        : "lateral";
  const label = current ? `${current.tier} -> ${tier} (${form})` : `${tier}/${form}`;

  if (move === "upgrade") {
    if (decision.tierConfidence < thresholds.minConfidenceUpgrade) {
      return {
        target: null,
        reason: `confidence ${decision.tierConfidence.toFixed(2)} < upgrade threshold`,
      };
    }
    return { target, reason: `upgrade ${label}` };
  }

  // Moving in from an unrouted model may be an upgrade or a downgrade: apply
  // the stricter (downgrade) threshold.
  if (move !== "lateral" && decision.tierConfidence < thresholds.minConfidenceDowngrade) {
    const threshold = move === "enter" ? "entry" : "downgrade";
    return {
      target: null,
      reason: `confidence ${decision.tierConfidence.toFixed(2)} < ${threshold} threshold`,
    };
  }

  // Hysteresis: do not flap between models on consecutive prompts.
  if (promptsSinceSwitch !== undefined && promptsSinceSwitch < thresholds.minPromptsBetweenSwitches) {
    return {
      target: null,
      reason: `cooldown: ${promptsSinceSwitch} prompt(s) since last switch`,
    };
  }

  const contextK = `${Math.round(contextTokens / 1_000)}k`;

  // Lateral switches are about fit, not price: only the flat guard applies.
  if (move === "lateral") {
    if (contextTokens > thresholds.cacheGuardTokens) {
      return { target: null, reason: `lateral blocked: context ${contextK}` };
    }
    return { target, reason: `lateral ${current!.form} -> ${form}` };
  }

  const currentPrice = knownPrice(input.currentPrice);
  const targetPrice = knownPrice(input.priceOf?.(targetSpec));

  if (currentPrice && targetPrice) {
    const payback = paybackRequests(
      currentPrice,
      targetPrice,
      contextTokens,
      thresholds.assumedOutputTokensPerRequest,
    );
    if (payback > thresholds.maxPaybackRequests) {
      const detail = Number.isFinite(payback)
        ? `pays back in ${payback.toFixed(1)} requests > ${thresholds.maxPaybackRequests}`
        : "target is not cheaper";
      return { target: null, reason: `context ${contextK}: ${detail}` };
    }
    return { target, reason: `${move} ${label}, pays back in ${payback.toFixed(1)} requests` };
  }

  // Prices unknown: fall back to the flat context guard.
  if (contextTokens > thresholds.cacheGuardTokens) {
    return { target: null, reason: `context ${contextK}: cache protected` };
  }
  return {
    target,
    reason: move === "enter" ? `enter ${label} from unrouted model` : `downgrade ${label}`,
  };
}

/**
 * How many LLM requests a switch takes to pay for itself.
 *
 * The first request on the new model reads the whole context uncached (or
 * writes it to cache, whichever is dearer) instead of at the cache-read rate.
 * Each later request saves the difference in cache-read price on the context
 * plus the difference in output price. Returns Infinity when nothing is saved.
 */
export function paybackRequests(
  current: Price,
  target: Price,
  contextTokens: number,
  outputTokensPerRequest: number,
): number {
  const missPrice = Math.max(target.input, target.cacheWrite);
  const premium = contextTokens * (missPrice - target.cacheRead);
  const savingPerRequest =
    contextTokens * (current.cacheRead - target.cacheRead) +
    outputTokensPerRequest * (current.output - target.output);
  if (savingPerRequest <= 0) return Infinity;
  return premium / savingPerRequest;
}

/** Treat an all-zero price (common for unpriced registry entries) as unknown. */
function knownPrice(price: Price | undefined): Price | undefined {
  if (!price) return undefined;
  return price.input > 0 || price.output > 0 ? price : undefined;
}

function sameSpec(a: ModelSpec, b: ModelSpec): boolean {
  return a.provider === b.provider && a.modelId === b.modelId && a.thinking === b.thinking;
}

/**
 * Resolve a (provider, modelId) pair to a Profile by scanning the routing
 * table. When several cells share the model, the first match is returned;
 * `decide` compares specs, so which of those cells is picked does not matter.
 */
export function profileFromModel(
  provider: string,
  modelId: string,
  tiers: RoutingTable,
): Profile | null {
  for (const tier of TIER_ORDER) {
    for (const form of FORMS) {
      const spec = tiers[tier][form];
      if (spec.provider === provider && spec.modelId === modelId) {
        return { tier, form };
      }
    }
  }
  return null;
}
