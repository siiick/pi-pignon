/**
 * Core type definitions for the Laya LLM Router extension.
 *
 * This module contains zero runtime dependencies and is fully testable.
 */

// ---------------------------------------------------------------------------
// Worker protocol types (see worker/laya_worker.py)
// ---------------------------------------------------------------------------

/** JSON-compatible values. */
export type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };

/** A choice question for the Laya model. */
export interface LayaChoiceQuestion {
  type: "choice";
  instructions?: string | null;
  criteria: Record<string, string>;
}

/** A score question for the Laya model. */
export interface LayaScoreQuestion {
  type: "score";
  instructions?: string | null;
  criteria: readonly string[];
}

/** A noul (yes/no) question for the Laya model. */
export interface LayaNoulQuestion {
  type: "noul";
  instructions?: string | null;
  criteria?: { true?: string | null; false?: string | null } | null;
}

/** Any question type accepted by Laya. */
export type LayaQuestion = LayaChoiceQuestion | LayaScoreQuestion | LayaNoulQuestion;

/** Parameters of the worker's `decide` method. */
export interface LayaDecisionRequest {
  /** Observation text (alternative to state). */
  text?: string;
  /** Observation: string, JSON object, or conversation list. */
  state?: string | JsonValue;
  /** Laya question map with type, instructions, criteria. */
  questions: Record<string, LayaQuestion>;
}

/** A single answer from the Laya decision engine. */
export interface LayaChoiceAnswer {
  type: "choice";
  choice: string;
  confidence: number;
  probabilities: Record<string, number>;
}

export interface LayaScoreAnswer {
  type: "score";
  score: number;
  confidence: number;
  legend: Record<string, string>;
  probabilities: Record<string, number>;
}

export interface LayaNoulAnswer {
  type: "noul";
  noul: number;
}

export type LayaAnswer = LayaChoiceAnswer | LayaScoreAnswer | LayaNoulAnswer;

/** Result of the worker's `decide` method. */
export interface LayaDecisionResponse {
  answers: Record<string, LayaAnswer>;
  model: string;
}

/** Result of the worker's `health` method. */
export interface LayaHealthResponse {
  status: string;
  version: string;
  backend: string;
  loaded_model: string | null;
  ready: boolean;
}

// ---------------------------------------------------------------------------
// Router domain types
// ---------------------------------------------------------------------------

/** How much reasoning a task demands. */
export type Tier = "trivial" | "standard" | "hard";

/** What form a task takes: direct (fits in head) or exploration (needs iteration). */
export type Form = "direct" | "exploration";

/** Pi thinking level (mirrored from ExtensionAPI["setThinkingLevel"] param). */
export type ThinkingLevel = "off" | "low" | "medium" | "high" | "xhigh";

/** Specification for a target LLM model. */
export interface ModelSpec {
  provider: string;
  modelId: string;
  thinking: ThinkingLevel;
}

/** Model routing table: one ModelSpec per tier x form cell. */
export type RoutingTable = Readonly<Record<Tier, Readonly<Record<Form, ModelSpec>>>>;

/** Routing profile: a cell in the tier x form matrix. */
export interface Profile {
  tier: Tier;
  form: Form;
}

/** Model prices per million tokens (the shape of Pi's `Model.cost`). */
export interface Price {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

/** Tunable routing thresholds. */
export interface Thresholds {
  /** Minimum confidence to downgrade tier, or to move in from a model outside the table. */
  minConfidenceDowngrade: number;
  /** Minimum confidence to upgrade tier. */
  minConfidenceUpgrade: number;
  /** Minimum confidence to declare a task as "direct" rather than "exploration". */
  minConfidenceForm: number;
  /**
   * Context size above which lateral switches are refused, and downgrades too
   * when model prices are unknown (a switch re-reads the context uncached).
   */
  cacheGuardTokens: number;
  /** Prompts to wait after a switch before the next downgrade or lateral switch. */
  minPromptsBetweenSwitches: number;
  /** A downgrade must recoup its cache-miss cost within this many LLM requests. */
  maxPaybackRequests: number;
  /** Output tokens per LLM request assumed when estimating what a downgrade saves. */
  assumedOutputTokensPerRequest: number;
  /** Timeout for one request to the local Laya worker. */
  layaTimeoutMs: number;
}

/** Full router configuration. */
export interface RouterConfig {
  tiers: RoutingTable;
  thresholds: Thresholds;
}

/** The raw decision returned by the Laya service for a prompt. */
export interface LayaRoutingDecision {
  tier: Tier | null;
  tierConfidence: number;
  needsExploration: boolean;
  explorationConfidence: number;
  latencyMs: number;
}

/** Inputs to the routing policy. */
export interface PolicyInput {
  decision: LayaRoutingDecision | null;
  /** Profile of the current model, or null when it is not in the routing table. */
  current: Profile | null;
  contextTokens: number;
  /** Prompts since the router last switched models; undefined if it never has. */
  promptsSinceSwitch?: number;
  /** Price of the current model, when known. */
  currentPrice?: Price;
  /** Price lookup for a routing-table model, when known. */
  priceOf?: (spec: ModelSpec) => Price | undefined;
  /** Defaults to DEFAULT_CONFIG. */
  config?: RouterConfig;
}

/** Output of the routing policy. */
export interface PolicyOutput {
  /** Target profile, or null if the current one should be kept. */
  target: Profile | null;
  reason: string;
}

/** Runtime mode for the extension. */
export type RouterMode = "shadow" | "live" | "off";

/** A persisted log entry written to the session store. */
export interface RouterLogEntry {
  ts: number;
  mode: RouterMode;
  layaModel: string;
  /** SHA-256 prefix of the prompt: lets you correlate entries without storing the text. */
  promptHash: string;
  promptLength: number;
  tier: Tier | null;
  tierConfidence: number | null;
  needsExploration: boolean | null;
  explorationConfidence: number | null;
  form: Form | null;
  latencyMs: number | null;
  currentTier: Tier | null;
  currentForm: Form | null;
  /** "provider/modelId" of the model active when the prompt arrived. Absent in older entries. */
  currentModel?: string;
  contextTokens: number;
  targetTier: Tier | null;
  targetForm: Form | null;
  /** "provider/modelId" of the routing-table model for the target profile. Absent in older entries. */
  targetModel?: string;
  targetThinking?: ThinkingLevel;
  reason: string;
  applied: boolean;
  error?: string;
}

// ---------------------------------------------------------------------------
// Configuration constants
// ---------------------------------------------------------------------------

export const TIER_ORDER: readonly Tier[] = ["trivial", "standard", "hard"];
export const FORMS: readonly Form[] = ["direct", "exploration"];
export const THINKING_LEVELS: readonly ThinkingLevel[] = ["off", "low", "medium", "high", "xhigh"];

/** Default model routing table. */
export const DEFAULT_TIERS: RoutingTable = {
  trivial: {
    direct: { provider: "openrouter", modelId: "deepseek/deepseek-v4-flash-0731", thinking: "off" },
    exploration: { provider: "openrouter", modelId: "deepseek/deepseek-v4-flash-0731", thinking: "off" },
  },
  standard: {
    direct: { provider: "openrouter", modelId: "deepseek/deepseek-v4.1-flash", thinking: "low" },
    exploration: { provider: "openrouter", modelId: "deepseek/deepseek-v4.1-flash", thinking: "low" },
  },
  hard: {
    direct: { provider: "openrouter", modelId: "z-ai/glm-5.3", thinking: "high" },
    exploration: { provider: "openrouter", modelId: "tencent/hy4-preview", thinking: "low" },
  },
};

/** Default thresholds. */
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

export const DEFAULT_CONFIG: RouterConfig = {
  tiers: DEFAULT_TIERS,
  thresholds: DEFAULT_THRESHOLDS,
};
