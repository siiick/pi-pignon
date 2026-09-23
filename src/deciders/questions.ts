/**
 * The two questions every decider is asked about a prompt, built from the
 * config: the tier criteria come from the routing table, the rest from
 * `config.questions`.
 *
 * Changing the wording changes what the confidences mean, so thresholds
 * calibrated on one wording do not carry over to another; see
 * `QuestionWording.version`.
 */

import type { RouterConfig } from "../types.js";
import type { DecisionRequest } from "./types.js";

/** Question whose choice is the tier id. */
export const TIER_QUESTION = "reasoning_demand";

/** Question whose `yes` choice means the task needs exploration. */
export const EXPLORATION_QUESTION = "needs_exploration";

export function buildQuestions(config: Pick<RouterConfig, "table" | "questions">): DecisionRequest["questions"] {
  const { table, questions } = config;
  return {
    [TIER_QUESTION]: {
      type: "choice",
      instructions: questions.tierInstructions,
      criteria: Object.fromEntries(table.map((tier) => [tier.id, tier.criterion])),
    },
    [EXPLORATION_QUESTION]: {
      type: "choice",
      instructions: questions.explorationInstructions,
      criteria: { yes: questions.explorationCriteria.yes, no: questions.explorationCriteria.no },
    },
  };
}
