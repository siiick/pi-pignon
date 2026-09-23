/**
 * Shape of the config file (`~/.pi/agent/pignon.json`), as a TypeBox schema.
 *
 * TypeBox schemas are plain JSON Schema, so this one module gives the file's
 * TS types, the runtime checks (`load.ts`) and `schema/config.schema.json`
 * for editor autocompletion.
 */

import Type, { type Static } from "typebox";

import { THINKING_LEVELS } from "../types.js";
import { PRESETS, PRESET_NAMES } from "./presets.js";

const ThinkingSchema = Type.Enum([...THINKING_LEVELS], {
  description: "Pi thinking level to set with the model. Pi clamps it to what the model supports.",
});

export const ModelSpecSchema = Type.Object(
  {
    provider: Type.String({ minLength: 1, description: "Pi provider id, e.g. `openrouter` or `anthropic`." }),
    modelId: Type.String({ minLength: 1, description: "Model id within the provider. Check with `pi --list-models`." }),
    thinking: ThinkingSchema,
  },
  { additionalProperties: false },
);

/** A model: the name of an entry in `models`, or an inline model. */
const modelRef = (description: string) =>
  Type.Union([Type.String({ minLength: 1, description: "Name of an entry in `models`." }), ModelSpecSchema], {
    description,
  });

export const ModelRefSchema = modelRef("A name from `models`, or an inline { provider, modelId, thinking }.");

export const TierFileSchema = Type.Object(
  {
    id: Type.String({
      pattern: "^[a-z][a-z0-9_-]*$",
      description: "Tier name, shown on decision cards. Lowercase letters, digits, `-` and `_`.",
    }),
    criterion: Type.String({
      minLength: 1,
      description: "How to recognize a task of this tier. This text is what the decision model reads.",
    }),
    model: Type.Optional(modelRef("Model for every task of this tier. Use it, or both `direct` and `exploration`.")),
    direct: Type.Optional(modelRef("Model for tasks that can be done without exploring the codebase.")),
    exploration: Type.Optional(modelRef("Model for tasks that need to explore the codebase first.")),
    explorationAllowed: Type.Optional(
      Type.Boolean({
        description: "Set false to send tasks that need exploration to the next tier up. Default true.",
      }),
    ),
  },
  { additionalProperties: false },
);

export const TiersSchema = Type.Array(TierFileSchema, {
  minItems: 2,
  maxItems: 8,
  description: "Difficulty tiers, easiest first. Replaces the default list as a whole.",
});

export const QuestionsSchema = Type.Object(
  {
    version: Type.Optional(
      Type.String({
        minLength: 1,
        description: "Label stored with each decision. Change it whenever you edit the wording or the tier criteria.",
      }),
    ),
    tierInstructions: Type.Optional(Type.String({ minLength: 1 })),
    explorationInstructions: Type.Optional(Type.String({ minLength: 1 })),
    explorationCriteria: Type.Optional(
      Type.Object(
        { yes: Type.Optional(Type.String({ minLength: 1 })), no: Type.Optional(Type.String({ minLength: 1 })) },
        { additionalProperties: false },
      ),
    ),
  },
  { additionalProperties: false, description: "Wording of the questions sent to the decision model." },
);

const threshold = (description: string) => Type.Optional(Type.Number({ minimum: 0, description }));

export const ThresholdsSchema = Type.Object(
  {
    minConfidenceDowngrade: threshold("Confidence needed to downgrade, or to move in from a model outside the table."),
    minConfidenceUpgrade: threshold("Confidence needed to upgrade."),
    minConfidenceForm: threshold("Confidence needed to call a task direct rather than exploration."),
    cacheGuardTokens: threshold("Context size above which lateral switches (and downgrades, when prices are unknown) are refused."),
    minPromptsBetweenSwitches: threshold("Prompts to wait after a switch before the next downgrade or lateral switch."),
    maxPaybackRequests: threshold("A downgrade must recoup its cache-miss cost within this many LLM requests."),
    assumedOutputTokensPerRequest: threshold("Output per request assumed when estimating what a downgrade saves."),
    layaTimeoutMs: threshold("Timeout for one decision from the local Laya worker, in milliseconds."),
  },
  { additionalProperties: false },
);

export const ConfidenceSourceSchema = Type.Enum(["reported", "top-probability"], {
  description:
    "`reported`: the decision model's confidence. `top-probability`: the probability of the chosen answer, for checkpoints whose confidence is uncalibrated.",
});

const timeoutMs = (description: string) => Type.Optional(Type.Number({ exclusiveMinimum: 0, description }));

export const LayaLocalDeciderSchema = Type.Object(
  {
    type: Type.Literal("laya-local", { description: "The local Laya model (Apple Silicon, laya-mlx)." }),
    timeoutMs: timeoutMs("Timeout for one decision, in milliseconds. Default: thresholds.layaTimeoutMs."),
    command: Type.Optional(
      Type.Array(Type.String({ minLength: 1 }), {
        minItems: 1,
        description:
          "Command that starts the worker, e.g. [\"uv\", \"run\", \"--project\", \"/path/to/pignon/worker\", \"pignon-laya\"]. Default: found automatically (checkout, pignon-laya on PATH, then uvx).",
      }),
    ),
  },
  { additionalProperties: false },
);

export const JevDeciderSchema = Type.Object(
  {
    type: Type.Literal("jev", { description: "TypeSafe's hosted Jev model. Sends each routed prompt (first 4000 characters) to the API." }),
    model: Type.Optional(Type.String({ minLength: 1, description: "Jev model to pin, e.g. `jev-1.13.0`. Default: jev-latest." })),
    baseURL: Type.Optional(
      Type.String({ minLength: 1, description: "API root. `https://openrouter.ai/api` goes through OpenRouter. Default: TypeSafe." }),
    ),
    apiKeyEnv: Type.Optional(
      Type.String({ minLength: 1, description: "Environment variable holding the API key. Default: TYPESAFE_API_KEY." }),
    ),
    timeoutMs: timeoutMs("Timeout for one decision, in milliseconds. Default: 1500."),
    maxRetries: Type.Optional(Type.Integer({ minimum: 0, maximum: 3, description: "Retries after a failed attempt. Default: 0." })),
  },
  { additionalProperties: false },
);

export const DECIDER_SCHEMAS = { "laya-local": LayaLocalDeciderSchema, jev: JevDeciderSchema } as const;

export const DecidersSchema = Type.Array(Type.Union([LayaLocalDeciderSchema, JevDeciderSchema]), {
  minItems: 1,
  maxItems: 4,
  description: "Decision models, in the order to try them. Default: laya-local when its worker is installed, else jev when TYPESAFE_API_KEY is set.",
});

export const StrategySchema = Type.Object(
  {
    mode: Type.Optional(
      Type.Enum(["sequential", "parallel"], {
        description:
          "`sequential` (default): ask the deciders in order until one is confident enough. `parallel`: ask them all at once, e.g. to compare them.",
      }),
    ),
    escalateBelow: Type.Optional(
      Type.Number({ minimum: 0, maximum: 1, description: "Sequential: ask the next decider when tier confidence is below this. Default 0.75." }),
    ),
    pick: Type.Optional(
      Type.Enum(["most-confident", "first"], {
        description:
          "Parallel: route on the most confident answer (default), or on the first decider in the list that answered (the others are only recorded).",
      }),
    ),
    budgetMs: Type.Optional(
      Type.Number({ exclusiveMinimum: 0, description: "Wall-time limit for one decision, all deciders included. Default 3000." }),
    ),
  },
  { additionalProperties: false, description: "How several deciders are combined." },
);

export const ConfigFileSchema = Type.Object(
  {
    $schema: Type.Optional(Type.String()),
    version: Type.Optional(Type.Literal(2, { description: "Config format version." })),
    extends: Type.Optional(
      Type.Enum([...PRESET_NAMES], {
        description: `Model preset for the built-in names, applied before \`models\`: ${PRESET_NAMES.map((n) => `\`${n}\` (${PRESETS[n].description})`).join("; ")}.`,
      }),
    ),
    deciders: Type.Optional(DecidersSchema),
    strategy: Type.Optional(StrategySchema),
    models: Type.Optional(
      Type.Record(Type.String({ pattern: "^[A-Za-z0-9][A-Za-z0-9._-]*$" }), ModelSpecSchema, {
        description: "Named models, referenced from `tiers`. Merged over the built-in names (fast, balanced, reasoner, agent).",
      }),
    ),
    tiers: Type.Optional(TiersSchema),
    questions: Type.Optional(QuestionsSchema),
    confidenceSource: Type.Optional(ConfidenceSourceSchema),
    thresholds: Type.Optional(ThresholdsSchema),
  },
  { additionalProperties: false, title: "pignon configuration" },
);

export type ModelRef = Static<typeof ModelRefSchema>;
export type TierFile = Static<typeof TierFileSchema>;
export type ConfigFile = Static<typeof ConfigFileSchema>;

/** Where the published JSON Schema lives, for the `$schema` key of config files. */
export const CONFIG_SCHEMA_URL = "https://unpkg.com/pignon/schema/config.schema.json";
