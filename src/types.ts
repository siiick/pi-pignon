/**
 * Core type definitions for pignon.
 *
 * Types and a few constants only: no runtime dependencies. Defaults live in
 * `config/defaults.ts`.
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

/**
 * Id of a difficulty tier, as named in the config (`trivial`, `standard`…).
 * Tiers are ordered by the routing table, easiest first.
 */
export type Tier = string;

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

/** One difficulty tier and the models that serve it. */
export interface TierSpec {
  id: Tier;
  /** How the decider recognizes a task of this tier. */
  criterion: string;
  models: Readonly<Record<Form, ModelSpec>>;
  /**
   * When false, a task that needs exploration never runs at this tier: it
   * moves up to the next tier that allows exploration (the tool loop will be
   * long, so the cheapest models are a poor fit).
   */
  explorationAllowed: boolean;
}

/** Tiers, easiest first. Position is rank: moving to a later tier is an upgrade. */
export type RoutingTable = readonly TierSpec[];

/** Wording of the two questions every decider is asked (see `deciders/questions.ts`). */
export interface QuestionWording {
  /**
   * Label stored with each decision. Change it whenever the wording or the
   * tier criteria change: thresholds calibrated on one wording do not carry
   * over to another.
   */
  version: string;
  tierInstructions: string;
  explorationInstructions: string;
  explorationCriteria: Readonly<{ yes: string; no: string }>;
}

/**
 * Which number to route on:
 * - `reported`: the answer's `confidence` field (Laya/Jev calibrated confidence);
 * - `top-probability`: the probability of the chosen option, for checkpoints
 *   whose reported confidence is uncalibrated.
 */
export type ConfidenceSource = "reported" | "top-probability";

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

/** The local Laya worker (Apple Silicon). */
export interface LayaLocalDeciderSpec {
  type: "laya-local";
  /** Timeout for one decision; defaults to `thresholds.layaTimeoutMs`. */
  timeoutMs?: number;
  /** Command that starts the worker, instead of finding it (e.g. a development checkout). */
  command?: string[];
}

/** TypeSafe's hosted Jev model. The API key is read from an environment variable, never the config. */
export interface JevDeciderSpec {
  type: "jev";
  model?: string;
  baseURL?: string;
  apiKeyEnv?: string;
  timeoutMs?: number;
  maxRetries?: number;
}

export type DeciderSpec = LayaLocalDeciderSpec | JevDeciderSpec;

/** How several deciders are combined (see `deciders/strategy.ts`). */
export interface StrategyConfig {
  /** `sequential`: in order, until one is confident enough. `parallel`: all at once. */
  mode: "sequential" | "parallel";
  /** Sequential: move to the next decider when tier confidence is below this. */
  escalateBelow: number;
  /** Parallel: route on the most confident answer, or on the first decider in the list that answered. */
  pick: "most-confident" | "first";
  /** Wall-time limit for one decision, all deciders included. */
  budgetMs: number;
}

/** What happened to one decider during one decision. */
export interface DeciderAttempt {
  decider: string;
  remote: boolean;
  /** `not-ready`: still loading or missing a key. `not-asked`: an earlier decider was confident enough. */
  outcome: "answered" | "failed" | "not-ready" | "not-asked";
  /** Whether this answer is the one routed on. */
  used: boolean;
  model?: string;
  tier?: Tier | null;
  tierConfidence?: number;
  needsExploration?: boolean;
  explorationConfidence?: number;
  latencyMs?: number;
  costUsd?: number;
  error?: string;
}

/** Full, resolved router configuration. */
export interface RouterConfig {
  /** Deciders in the order to try them, or null to pick one automatically. */
  deciders: readonly DeciderSpec[] | null;
  strategy: StrategyConfig;
  table: RoutingTable;
  thresholds: Thresholds;
  questions: QuestionWording;
  confidenceSource: ConfidenceSource;
}

/** Routing-relevant reading of a decider's answers (see `deciders/parse.ts`). */
export interface RoutingDecision {
  tier: Tier | null;
  tierConfidence: number;
  needsExploration: boolean;
  explorationConfidence: number;
  latencyMs: number;
}

/** Inputs to the routing policy. */
export interface PolicyInput {
  decision: RoutingDecision | null;
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
  /** `Decider.id` of the decider asked. Absent in entries written before pignon. */
  decider?: string;
  /** Whether the prompt was sent off the machine to decide. */
  remote?: boolean;
  /** Price of the decision in USD, for remote deciders that report it. */
  costUsd?: number;
  /** Every decider tried, when several are configured. */
  attempts?: DeciderAttempt[];
  /** Model of the decider that answered. */
  deciderModel?: string;
  /** Same as `deciderModel`, in entries written before pignon. */
  layaModel?: string;
  /** `QuestionWording.version` the decision was made with. Absent in older entries. */
  questionsVersion?: string;
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

export const FORMS: readonly Form[] = ["direct", "exploration"];
export const THINKING_LEVELS: readonly ThinkingLevel[] = ["off", "low", "medium", "high", "xhigh"];
