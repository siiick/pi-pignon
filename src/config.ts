/**
 * Optional user configuration: `~/.pi/agent/laya-router.json`, or the file
 * named by LAYA_ROUTER_CONFIG.
 *
 *   {
 *     "thresholds": { "minConfidenceDowngrade": 0.9 },
 *     "tiers": { "hard": { "direct": { "provider": "openrouter", "modelId": "…", "thinking": "high" } } }
 *   }
 *
 * Every key is optional and merged over DEFAULT_CONFIG. Invalid entries are
 * skipped and reported; they never prevent the extension from loading.
 */

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import {
  type Form,
  type ModelSpec,
  type RouterConfig,
  type Thresholds,
  type Tier,
  DEFAULT_CONFIG,
  FORMS,
  THINKING_LEVELS,
  TIER_ORDER,
} from "./types.js";

export interface LoadedConfig {
  config: RouterConfig;
  /** Where the config was read from, or null when the defaults are used. */
  source: string | null;
  /** Problems found in the file; the affected entries fall back to defaults. */
  errors: string[];
}

export function defaultConfigPath(env: NodeJS.ProcessEnv = process.env): string {
  return env.LAYA_ROUTER_CONFIG ?? join(homedir(), ".pi", "agent", "laya-router.json");
}

/** Read and validate the config file. A missing file means defaults. */
export function loadConfig(path = defaultConfigPath()): LoadedConfig {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return { config: DEFAULT_CONFIG, source: null, errors: [] };
    }
    return { config: DEFAULT_CONFIG, source: null, errors: [`${path}: ${String(err)}`] };
  }

  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (err) {
    return { config: DEFAULT_CONFIG, source: null, errors: [`${path}: ${String(err)}`] };
  }

  const { config, errors } = parseConfig(raw);
  return { config, source: path, errors: errors.map((e) => `${path}: ${e}`) };
}

/** Merge a parsed JSON value over DEFAULT_CONFIG, collecting validation errors. */
export function parseConfig(raw: unknown): { config: RouterConfig; errors: string[] } {
  const errors: string[] = [];
  if (!isRecord(raw)) {
    return { config: DEFAULT_CONFIG, errors: ["expected a JSON object"] };
  }

  const thresholds: Thresholds = { ...DEFAULT_CONFIG.thresholds };
  if (raw.thresholds !== undefined) {
    if (!isRecord(raw.thresholds)) {
      errors.push("thresholds: expected an object");
    } else {
      for (const [key, value] of Object.entries(raw.thresholds)) {
        if (!(key in thresholds)) {
          errors.push(`thresholds.${key}: unknown setting`);
        } else if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
          errors.push(`thresholds.${key}: expected a non-negative number`);
        } else {
          thresholds[key as keyof Thresholds] = value;
        }
      }
    }
  }

  const tiers = structuredClone(DEFAULT_CONFIG.tiers) as Record<Tier, Record<Form, ModelSpec>>;
  if (raw.tiers !== undefined) {
    if (!isRecord(raw.tiers)) {
      errors.push("tiers: expected an object");
    } else {
      for (const [tier, forms] of Object.entries(raw.tiers)) {
        if (!TIER_ORDER.includes(tier as Tier)) {
          errors.push(`tiers.${tier}: unknown tier`);
          continue;
        }
        if (!isRecord(forms)) {
          errors.push(`tiers.${tier}: expected an object`);
          continue;
        }
        for (const [form, spec] of Object.entries(forms)) {
          if (!FORMS.includes(form as Form)) {
            errors.push(`tiers.${tier}.${form}: unknown form`);
          } else if (!isModelSpec(spec)) {
            errors.push(`tiers.${tier}.${form}: expected { provider, modelId, thinking }`);
          } else {
            tiers[tier as Tier][form as Form] = { ...spec };
          }
        }
      }
    }
  }

  return { config: { tiers, thresholds }, errors };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isModelSpec(value: unknown): value is ModelSpec {
  return (
    isRecord(value) &&
    typeof value.provider === "string" &&
    value.provider !== "" &&
    typeof value.modelId === "string" &&
    value.modelId !== "" &&
    THINKING_LEVELS.includes(value.thinking as ModelSpec["thinking"])
  );
}
