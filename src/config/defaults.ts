/**
 * Built-in configuration: what pignon does with no config file.
 */

import type { ModelSpec, QuestionWording, RouterConfig, StrategyConfig, Thresholds } from "../types.js";
import { PRESETS } from "./presets.js";
import type { TierFile } from "./schema.js";

/**
 * Named models, by role: `fast` and `balanced` for easy work, `reasoner`
 * (spends its budget before acting) and `agent` (spreads it over many small
 * tool turns) for hard work. A config file can redefine any of them, or take
 * a whole set from a preset with `extends`, without rewriting the tier list.
 */
export const DEFAULT_MODELS: Readonly<Record<string, ModelSpec>> = PRESETS.openrouter.models;

/** Difficulty tiers, easiest first, in config-file form. */
export const DEFAULT_TIERS: readonly TierFile[] = [
  {
    id: "trivial",
    criterion: "Mechanical edit, rename, formatting, or a single factual lookup",
    model: "fast",
    explorationAllowed: false,
  },
  {
    id: "standard",
    criterion: "Localized change across a few files with clear intent",
    model: "balanced",
  },
  {
    id: "hard",
    criterion: "Multi-step investigation, debugging with unclear cause, or cross-cutting design",
    direct: "reasoner",
    exploration: "agent",
  },
];

export const DEFAULT_QUESTIONS: QuestionWording = {
  version: "q1",
  tierInstructions: "How much reasoning does solving this request demand, regardless of how long the answer should be?",
  explorationInstructions: "Does answering require exploring the codebase before acting?",
  explorationCriteria: {
    yes: "The target files or cause are not identified in the request",
    no: "The request names what to change and where",
  },
};

export const DEFAULT_THRESHOLDS: Readonly<Thresholds> = {
  minConfidenceDowngrade: 0.85,
  minConfidenceUpgrade: 0.5,
  minConfidenceForm: 0.6,
  cacheGuardTokens: 60_000,
  minPromptsBetweenSwitches: 2,
  maxPaybackRequests: 3,
  assumedOutputTokensPerRequest: 1_000,
  layaTimeoutMs: 2_500,
};

export const DEFAULT_STRATEGY: StrategyConfig = {
  mode: "sequential",
  escalateBelow: 0.75,
  pick: "most-confident",
  budgetMs: 3_000,
};

const spec = (name: string): ModelSpec => DEFAULT_MODELS[name]!;

/** The defaults, resolved. Kept in sync with DEFAULT_TIERS by a test. */
export const DEFAULT_CONFIG: RouterConfig = {
  deciders: null,
  strategy: DEFAULT_STRATEGY,
  table: [
    {
      id: "trivial",
      criterion: DEFAULT_TIERS[0]!.criterion,
      models: { direct: spec("fast"), exploration: spec("fast") },
      explorationAllowed: false,
    },
    {
      id: "standard",
      criterion: DEFAULT_TIERS[1]!.criterion,
      models: { direct: spec("balanced"), exploration: spec("balanced") },
      explorationAllowed: true,
    },
    {
      id: "hard",
      criterion: DEFAULT_TIERS[2]!.criterion,
      models: { direct: spec("reasoner"), exploration: spec("agent") },
      explorationAllowed: true,
    },
  ],
  thresholds: DEFAULT_THRESHOLDS,
  questions: DEFAULT_QUESTIONS,
  confidenceSource: "reported",
};
