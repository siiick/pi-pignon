/**
 * Optional user configuration: `~/.pi/agent/pignon.json`, or the file named
 * by PIGNON_CONFIG. The laya-router file of earlier versions is still read
 * when there is none.
 *
 *   {
 *     "models": { "reasoner": { "provider": "anthropic", "modelId": "…", "thinking": "high" } },
 *     "thresholds": { "minConfidenceDowngrade": 0.9 }
 *   }
 *
 * Every key is optional and merged over the defaults. Each section is checked
 * on its own: an invalid section is reported and falls back to its default,
 * it never prevents the extension from loading.
 */

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import { Compile } from "typebox/compile";
import type { TLocalizedValidationError } from "typebox/error";

import {
  type ConfidenceSource,
  type DeciderSpec,
  type Form,
  type ModelSpec,
  type QuestionWording,
  type RouterConfig,
  type RoutingTable,
  type StrategyConfig,
  type Thresholds,
  type TierSpec,
  FORMS,
} from "../types.js";
import {
  DEFAULT_CONFIG,
  DEFAULT_MODELS,
  DEFAULT_QUESTIONS,
  DEFAULT_STRATEGY,
  DEFAULT_THRESHOLDS,
  DEFAULT_TIERS,
} from "./defaults.js";
import { PRESETS, PRESET_NAMES, isPresetName } from "./presets.js";
import {
  type ModelRef,
  type TierFile,
  ConfidenceSourceSchema,
  ConfigFileSchema,
  DECIDER_SCHEMAS,
  ModelSpecSchema,
  QuestionsSchema,
  StrategySchema,
  ThresholdsSchema,
  TiersSchema,
} from "./schema.js";

export interface LoadedConfig {
  config: RouterConfig;
  /** Where the config was read from, or null when the defaults are used. */
  source: string | null;
  /** Problems found in the file; the affected sections fall back to defaults. */
  errors: string[];
  /** Things that work but should be changed (legacy file name or format). */
  warnings: string[];
  /** Whether the file uses the laya-router name or format, which `/pignon config migrate` converts. */
  legacy: boolean;
}

export interface ConfigPaths {
  /** Where pignon reads its config. */
  path: string;
  /** Config of earlier (laya-router) versions, read when `path` does not exist. */
  legacyPath: string;
}

/** Pi's config directory: PI_CODING_AGENT_DIR, else `~/.pi/agent`. */
export function agentDir(env: NodeJS.ProcessEnv = process.env): string {
  return env.PI_CODING_AGENT_DIR || join(homedir(), ".pi", "agent");
}

export function configPaths(env: NodeJS.ProcessEnv = process.env): ConfigPaths {
  const dir = agentDir(env);
  return {
    path: env.PIGNON_CONFIG ?? join(dir, "pignon.json"),
    legacyPath: env.LAYA_ROUTER_CONFIG ?? join(dir, "laya-router.json"),
  };
}

/** Read and validate the config file. A missing file means defaults. */
export function loadConfig(paths: ConfigPaths = configPaths()): LoadedConfig {
  const primary = readJson(paths.path);
  if (primary.kind !== "missing") return fromFile(paths.path, primary, false);

  const legacy = readJson(paths.legacyPath);
  if (legacy.kind === "missing") {
    return { config: DEFAULT_CONFIG, source: null, errors: [], warnings: [], legacy: false };
  }
  const loaded = fromFile(paths.legacyPath, legacy, true);
  loaded.warnings.unshift(
    `${paths.legacyPath}: laya-router config file; run /pignon config migrate to write ${paths.path}`,
  );
  return loaded;
}

type ReadResult = { kind: "missing" } | { kind: "error"; error: string } | { kind: "ok"; raw: unknown };

/** Read a JSON file; `missing` only when it does not exist. */
export function readJson(path: string): ReadResult {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return { kind: "missing" };
    return { kind: "error", error: String(err) };
  }
  try {
    return { kind: "ok", raw: JSON.parse(text) };
  } catch (err) {
    return { kind: "error", error: String(err) };
  }
}

function fromFile(path: string, read: Exclude<ReadResult, { kind: "missing" }>, legacyName: boolean): LoadedConfig {
  if (read.kind === "error") {
    return { config: DEFAULT_CONFIG, source: null, errors: [`${path}: ${read.error}`], warnings: [], legacy: false };
  }
  const parsed = parseConfig(read.raw);
  return {
    config: parsed.config,
    source: path,
    errors: parsed.errors.map((e) => `${path}: ${e}`),
    warnings: parsed.warnings.map((w) => `${path}: ${w}`),
    legacy: legacyName || parsed.legacy,
  };
}

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

export interface ParsedConfig {
  config: RouterConfig;
  errors: string[];
  warnings: string[];
  /** Whether `tiers` uses the laya-router (v1) format. */
  legacy: boolean;
}

const checkModelSpec = Compile(ModelSpecSchema);
const checkTiers = Compile(TiersSchema);
const checkQuestions = Compile(QuestionsSchema);
const checkConfidenceSource = Compile(ConfidenceSourceSchema);
const checkStrategy = Compile(StrategySchema);
const checkDecider = {
  "laya-local": Compile(DECIDER_SCHEMAS["laya-local"]),
  jev: Compile(DECIDER_SCHEMAS.jev),
};

/** Merge a parsed JSON value over the defaults, collecting validation errors. */
export function parseConfig(raw: unknown): ParsedConfig {
  if (!isRecord(raw)) {
    return { config: DEFAULT_CONFIG, errors: ["expected a JSON object"], warnings: [], legacy: false };
  }
  const errors: string[] = [];
  const warnings: string[] = [];

  for (const key of Object.keys(raw)) {
    if (!(key in ConfigFileSchema.properties)) errors.push(`${key}: unknown setting`);
  }
  if (raw.version !== undefined && raw.version !== 2) errors.push("version: expected 2");

  const deciders = parseDeciders(raw.deciders, errors);
  let strategy: StrategyConfig = DEFAULT_STRATEGY;
  if (raw.strategy !== undefined) {
    if (checkStrategy.Check(raw.strategy)) strategy = { ...DEFAULT_STRATEGY, ...raw.strategy };
    else errors.push(...formatErrors("strategy", checkStrategy.Errors(raw.strategy)));
  }
  const thresholds = parseThresholds(raw.thresholds, errors);
  let base: Readonly<Record<string, ModelSpec>> = DEFAULT_MODELS;
  if (raw.extends !== undefined) {
    if (isPresetName(raw.extends)) base = { ...DEFAULT_MODELS, ...PRESETS[raw.extends].models };
    else errors.push(`extends: expected one of ${PRESET_NAMES.join(", ")}`);
  }
  const models = parseModels(raw.models, base, errors);
  const questions = parseQuestions(raw.questions, errors);

  let confidenceSource: ConfidenceSource = DEFAULT_CONFIG.confidenceSource;
  if (raw.confidenceSource !== undefined) {
    if (checkConfidenceSource.Check(raw.confidenceSource)) confidenceSource = raw.confidenceSource;
    else errors.push(...formatErrors("confidenceSource", checkConfidenceSource.Errors(raw.confidenceSource)));
  }

  // Built-in tiers over the (possibly redefined) models. parseModels rejects
  // invalid entries, so every built-in name still resolves.
  const defaultTable = resolveTable(DEFAULT_TIERS, models).table ?? DEFAULT_CONFIG.table;

  const legacy = isRecord(raw.tiers);
  let table = defaultTable;
  if (legacy) {
    warnings.push("`tiers` uses the laya-router format; run /pignon config migrate to convert it");
    table = migrateTiers(raw.tiers as Record<string, unknown>, defaultTable, errors);
  } else if (raw.tiers !== undefined) {
    table = parseTiers(raw.tiers, models, errors) ?? defaultTable;
  }

  return { config: { deciders, strategy, table, thresholds, questions, confidenceSource }, errors, warnings, legacy };
}

/**
 * Deciders are checked one by one (by `type`, for precise messages); invalid
 * ones are skipped. None valid means automatic choice, as with no section.
 */
function parseDeciders(raw: unknown, errors: string[]): DeciderSpec[] | null {
  if (raw === undefined) return null;
  if (!Array.isArray(raw) || raw.length === 0) {
    errors.push("deciders: expected a non-empty list");
    return null;
  }
  if (raw.length > 4) errors.push("deciders: at most 4 deciders; the rest are ignored");
  const deciders: DeciderSpec[] = [];
  raw.slice(0, 4).forEach((entry, index) => {
    const at = `deciders[${index}]`;
    const type = isRecord(entry) ? entry.type : undefined;
    if (type !== "laya-local" && type !== "jev") {
      errors.push(`${at}.type: expected one of laya-local, jev`);
    } else if (isRecord(entry) && "apiKey" in entry) {
      errors.push(`${at}.apiKey: keep secrets out of the config file; name the environment variable with apiKeyEnv`);
    } else if (!checkDecider[type].Check(entry)) {
      errors.push(...formatErrors(at, checkDecider[type].Errors(entry)));
    } else if (deciders.some((d) => d.type === type)) {
      errors.push(`${at}: ${type} is already listed`);
    } else {
      deciders.push({ ...(entry as DeciderSpec) });
    }
  });
  return deciders.length > 0 ? deciders : null;
}

function parseThresholds(raw: unknown, errors: string[]): Thresholds {
  const thresholds: Thresholds = { ...DEFAULT_THRESHOLDS };
  if (raw === undefined) return thresholds;
  if (!isRecord(raw)) {
    errors.push("thresholds: expected an object");
    return thresholds;
  }
  for (const [key, value] of Object.entries(raw)) {
    if (!(key in ThresholdsSchema.properties)) {
      errors.push(`thresholds.${key}: unknown setting`);
    } else if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
      errors.push(`thresholds.${key}: expected a non-negative number`);
    } else {
      thresholds[key as keyof Thresholds] = value;
    }
  }
  return thresholds;
}

/** Built-in (or preset) models with the file's entries merged over them. Invalid entries are skipped. */
function parseModels(
  raw: unknown,
  base: Readonly<Record<string, ModelSpec>>,
  errors: string[],
): Record<string, ModelSpec> {
  const models: Record<string, ModelSpec> = { ...base };
  if (raw === undefined) return models;
  if (!isRecord(raw)) {
    errors.push("models: expected an object");
    return models;
  }
  for (const [name, spec] of Object.entries(raw)) {
    if (checkModelSpec.Check(spec)) models[name] = { provider: spec.provider, modelId: spec.modelId, thinking: spec.thinking };
    else errors.push(...formatErrors(`models.${name}`, checkModelSpec.Errors(spec)));
  }
  return models;
}

function parseQuestions(raw: unknown, errors: string[]): QuestionWording {
  if (raw === undefined) return DEFAULT_QUESTIONS;
  if (!checkQuestions.Check(raw)) {
    errors.push(...formatErrors("questions", checkQuestions.Errors(raw)));
    return DEFAULT_QUESTIONS;
  }
  return {
    version: raw.version ?? DEFAULT_QUESTIONS.version,
    tierInstructions: raw.tierInstructions ?? DEFAULT_QUESTIONS.tierInstructions,
    explorationInstructions: raw.explorationInstructions ?? DEFAULT_QUESTIONS.explorationInstructions,
    explorationCriteria: { ...DEFAULT_QUESTIONS.explorationCriteria, ...raw.explorationCriteria },
  };
}

/** A user tier list replaces the default one as a whole, or not at all (null). */
function parseTiers(raw: unknown, models: Record<string, ModelSpec>, errors: string[]): RoutingTable | null {
  if (!checkTiers.Check(raw)) {
    errors.push(...formatErrors("tiers", checkTiers.Errors(raw)));
    return null;
  }
  const resolved = resolveTable(raw, models);
  errors.push(...resolved.errors);
  return resolved.table;
}

/** Turn file tiers into a routing table, resolving model names. */
export function resolveTable(
  tiers: readonly TierFile[],
  models: Readonly<Record<string, ModelSpec>>,
): { table: RoutingTable | null; errors: string[] } {
  const errors: string[] = [];
  const seen = new Set<string>();
  const table: TierSpec[] = [];

  tiers.forEach((tier, index) => {
    const at = `tiers[${index}] (${tier.id})`;
    if (seen.has(tier.id)) errors.push(`${at}: duplicate tier id`);
    seen.add(tier.id);

    if (tier.model !== undefined && (tier.direct !== undefined || tier.exploration !== undefined)) {
      errors.push(`${at}: use either \`model\` or \`direct\` + \`exploration\`, not both`);
      return;
    }
    const refs: Partial<Record<Form, ModelRef>> =
      tier.model !== undefined
        ? { direct: tier.model, exploration: tier.model }
        : { direct: tier.direct, exploration: tier.exploration };

    const resolved: Partial<Record<Form, ModelSpec>> = {};
    for (const form of FORMS) {
      const ref = refs[form];
      if (ref === undefined) {
        errors.push(`${at}: missing \`${form}\` model (or set \`model\` for both)`);
      } else if (typeof ref === "string") {
        const spec = models[ref];
        if (spec) resolved[form] = spec;
        else errors.push(`${at}: unknown model name "${ref}" (define it under \`models\`)`);
      } else {
        resolved[form] = { provider: ref.provider, modelId: ref.modelId, thinking: ref.thinking };
      }
    }
    if (resolved.direct && resolved.exploration) {
      table.push({
        id: tier.id,
        criterion: tier.criterion,
        models: { direct: resolved.direct, exploration: resolved.exploration },
        explorationAllowed: tier.explorationAllowed ?? true,
      });
    }
  });

  if (errors.length === 0 && !table.some((t) => t.explorationAllowed)) {
    errors.push("tiers: at least one tier must allow exploration");
  }
  // A bad name in `model` fails both forms the same way: report it once.
  const unique = [...new Set(errors)];
  return unique.length === 0 ? { table, errors: unique } : { table: null, errors: unique };
}

/**
 * laya-router (v1) tiers: `{ "hard": { "direct": { provider, modelId, thinking } } }`,
 * merged cell by cell over the default table. Invalid cells are skipped.
 */
function migrateTiers(raw: Record<string, unknown>, base: RoutingTable, errors: string[]): RoutingTable {
  const table = base.map((tier) => ({ ...tier, models: { ...tier.models } }));
  for (const [id, forms] of Object.entries(raw)) {
    const tier = table.find((t) => t.id === id);
    if (!tier) {
      errors.push(`tiers.${id}: unknown tier`);
      continue;
    }
    if (!isRecord(forms)) {
      errors.push(`tiers.${id}: expected an object`);
      continue;
    }
    for (const [form, spec] of Object.entries(forms)) {
      if (!FORMS.includes(form as Form)) {
        errors.push(`tiers.${id}.${form}: unknown form`);
      } else if (!checkModelSpec.Check(spec)) {
        errors.push(`tiers.${id}.${form}: expected { provider, modelId, thinking }`);
      } else {
        tier.models[form as Form] = { provider: spec.provider, modelId: spec.modelId, thinking: spec.thinking };
      }
    }
  }
  return table;
}

// ---------------------------------------------------------------------------
// Error messages
// ---------------------------------------------------------------------------

/**
 * Turn TypeBox errors into one readable line per problem, e.g.
 * `tiers[1].direct: expected a model name or { provider, modelId, thinking }`.
 */
export function formatErrors(prefix: string, errors: Iterable<TLocalizedValidationError>): string[] {
  const all = [...errors];
  // "boolean" errors repeat what "additionalProperties" already says.
  const list = all.filter((e) => e.keyword !== "boolean");
  // A union (the only one in the schema is "model name or inline model")
  // reports each branch that failed. TypeBox stops collecting after 8 errors
  // and may cut the "anyOf" error itself, so two "type" errors on one path
  // also mark a union.
  const typeErrors = new Map<string, number>();
  for (const e of list) if (e.keyword === "type") typeErrors.set(e.instancePath, (typeErrors.get(e.instancePath) ?? 0) + 1);
  const unionPaths = new Set([
    ...list.filter((e) => e.keyword === "anyOf").map((e) => e.instancePath),
    ...[...typeErrors].filter(([, n]) => n > 1).map(([path]) => path),
  ]);
  const lines: string[] = [];
  for (const error of list) {
    const path = prefix + toDotted(error.instancePath);
    const params = error.params as Record<string, unknown>;
    if (unionPaths.has(error.instancePath)) {
      // Errors inside a branch say what is wrong; without them, one summary line.
      if (!list.some((e) => e.instancePath.startsWith(`${error.instancePath}/`))) {
        lines.push(`${path}: expected a model name or { provider, modelId, thinking }`);
      }
    } else if (error.keyword === "additionalProperties") {
      for (const key of params.additionalProperties as string[]) lines.push(`${path}.${key}: unknown setting`);
    } else if (error.keyword === "enum") {
      lines.push(`${path}: expected one of ${(params.allowedValues as unknown[]).join(", ")}`);
    } else {
      lines.push(`${path}: ${error.message}`);
    }
  }
  if (all.length >= MAX_TYPEBOX_ERRORS) lines.push(`${prefix}: more problems may follow; fix these first`);
  return [...new Set(lines)];
}

/** TypeBox's default `maxErrors`: it stops collecting after this many. */
const MAX_TYPEBOX_ERRORS = 8;

/** `/0/direct` → `[0].direct`, `/fast` → `.fast` (JSON Pointer to readable path). */
function toDotted(pointer: string): string {
  return pointer
    .split("/")
    .slice(1)
    .map((part) => (/^\d+$/.test(part) ? `[${part}]` : `.${part.replace(/~1/g, "/").replace(/~0/g, "~")}`))
    .join("");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
