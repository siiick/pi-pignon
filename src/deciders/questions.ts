/**
 * The two questions every decider is asked about a prompt.
 *
 * Changing their wording changes what the confidences mean, so thresholds
 * calibrated on one wording do not carry over to another.
 */

import type { DecisionRequest } from "./types.js";

/** Question whose choice is the tier (`Tier`). */
export const TIER_QUESTION = "reasoning_demand";

/** Question whose `yes` choice means the task needs exploration. */
export const EXPLORATION_QUESTION = "needs_exploration";

export const ROUTING_QUESTIONS: DecisionRequest["questions"] = {
  [TIER_QUESTION]: {
    type: "choice",
    instructions: "How much reasoning does solving this request demand, regardless of how long the answer should be?",
    criteria: {
      trivial: "Mechanical edit, rename, formatting, or a single factual lookup",
      standard: "Localized change across a few files with clear intent",
      hard: "Multi-step investigation, debugging with unclear cause, or cross-cutting design",
    },
  },
  [EXPLORATION_QUESTION]: {
    type: "choice",
    instructions: "Does answering require exploring the codebase before acting?",
    criteria: {
      yes: "The target files or cause are not identified in the request",
      no: "The request names what to change and where",
    },
  },
};
