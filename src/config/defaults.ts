/**
 * Built-in configuration: what pignon does with no config file.
 */

import type { ModelSpec, QuestionWording, RouterConfig, Thresholds } from "../types.js";
import type { TierFile } from "./schema.js";

/**
 * Named models, by role. A config file can redefine any of them (e.g. point
 * `reasoner` at another model) without rewriting the tier list.
 */
export const DEFAULT_MODELS: Readonly<Record<string, ModelSpec>> = {
  fast: { provider: "openrouter", modelId: "deepseek/deepseek-v4-flash-0731", thinking: "off" },
  balanced: { provider: "openrouter", modelId: "deepseek/deepseek-v4.1-flash", thinking: "low" },
  // Reasoner: spends its budget before acting.
  reasoner: { provider: "openrouter", modelId: "z-ai/glm-5.3", thinking: "high" },
  // Agent: spreads its budget over many small tool turns.
  agent: { provider: "openrouter", modelId: "tencent/hy4-preview", thinking: "low" },
};

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

const spec = (name: string): ModelSpec => DEFAULT_MODELS[name]!;

/** The defaults, resolved. Kept in sync with DEFAULT_TIERS by a test. */
export const DEFAULT_CONFIG: RouterConfig = {
  deciders: null,
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
