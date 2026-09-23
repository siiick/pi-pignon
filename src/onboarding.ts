/**
 * `/pignon init` and `/pignon doctor`: get a working setup, and find out
 * what is wrong with one.
 *
 * Pi-free: the model registry is reached through `ModelLookup`.
 */

import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

import { type PresetName, PRESETS, PRESET_NAMES } from "./config/presets.js";
import { CONFIG_SCHEMA_URL } from "./config/schema.js";
import { DEFAULT_API_KEY_ENV } from "./deciders/jev.js";
import { layaRuntimeStatus } from "./deciders/laya-local.js";
import { StrategyDecider } from "./deciders/strategy.js";
import { type Decider, DeciderError } from "./deciders/types.js";
import { buildQuestions } from "./deciders/questions.js";
import type { DeciderSpec, ModelSpec, RouterConfig } from "./types.js";

/** The part of Pi's model registry pignon checks models against. */
export interface ModelLookup<M = unknown> {
  find(provider: string, modelId: string): M | undefined;
  hasConfiguredAuth(model: M): boolean;
}

export type ModelStatus = "ok" | "missing" | "no-auth";

export function modelStatus<M>(spec: ModelSpec, lookup: ModelLookup<M>): ModelStatus {
  const model = lookup.find(spec.provider, spec.modelId);
  if (model === undefined) return "missing";
  return lookup.hasConfiguredAuth(model) ? "ok" : "no-auth";
}

// ---------------------------------------------------------------------------
// init
// ---------------------------------------------------------------------------

/**
 * The preset to start from: the first whose four models all exist and have
 * credentials in Pi, else the one with the most usable models.
 */
export function choosePreset<M>(lookup: ModelLookup<M>): PresetName {
  const usable = (name: PresetName) =>
    Object.values(PRESETS[name].models).filter((spec) => modelStatus(spec, lookup) === "ok").length;
  return PRESET_NAMES.reduce((best, name) => (usable(name) > usable(best) ? name : best), PRESET_NAMES[0]!);
}

/** Deciders that can run here: the local model, else Jev when its key is set. */
export function detectDeciders(
  env: NodeJS.ProcessEnv = process.env,
  layaStatus: typeof layaRuntimeStatus = layaRuntimeStatus,
): DeciderSpec[] {
  if (layaStatus(env).ok) return [{ type: "laya-local" }];
  if (env[DEFAULT_API_KEY_ENV]?.trim()) return [{ type: "jev" }];
  return [];
}

/**
 * A starter config: the preset's models written out (so they are easy to
 * edit), the deciders that can run here, and the built-in tiers.
 */
export function starterConfig(preset: PresetName, deciders: DeciderSpec[]): Record<string, unknown> {
  return {
    $schema: CONFIG_SCHEMA_URL,
    version: 2,
    ...(deciders.length > 0 ? { deciders } : {}),
    models: PRESETS[preset].models,
  };
}

export type InitResult = { ok: true; path: string } | { ok: false; message: string };

/** Write a starter config; never replaces an existing file. */
export function writeStarterConfig(path: string, config: Record<string, unknown>): InitResult {
  if (existsSync(path)) {
    return { ok: false, message: `${path} already exists; edit it, or move it away to start over` };
  }
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(config, null, 2)}\n`, { flag: "wx" });
  return { ok: true, path };
}

// ---------------------------------------------------------------------------
// doctor
// ---------------------------------------------------------------------------

export interface DoctorInput<M> {
  config: RouterConfig;
  configSource: string | null;
  configErrors: readonly string[];
  decider: Decider;
  lookup: ModelLookup<M>;
  env?: NodeJS.ProcessEnv;
  layaStatus?: typeof layaRuntimeStatus;
}

/** A fixed, harmless prompt for the decider round trip. */
const PROBE_PROMPT = "Rename the variable `cnt` to `count` in src/stats.ts";

/**
 * One ✓/⚠/✗ line per check: config file, each decider (with one real
 * decision when it is ready), and each model of the routing table.
 */
export async function runDoctor<M>(input: DoctorInput<M>): Promise<string[]> {
  const { config, decider, lookup } = input;
  const env = input.env ?? process.env;
  const lines: string[] = ["pignon doctor"];
  const ok = (text: string) => lines.push(`  ✓ ${text}`);
  const warn = (text: string) => lines.push(`  ⚠ ${text}`);
  const fail = (text: string) => lines.push(`  ✗ ${text}`);

  lines.push("config");
  if (input.configErrors.length > 0) {
    fail(`${input.configSource ?? "config"}: ${input.configErrors.length} problem(s), defaults used for those parts`);
    for (const error of input.configErrors) lines.push(`      ${error}`);
  } else {
    ok(input.configSource ?? "no config file: built-in defaults (/pignon init writes one)");
  }

  lines.push("deciders");
  const members = decider instanceof StrategyDecider ? decider.members : [decider];
  if (members.length > 1) ok(`${config.strategy.mode} strategy over ${members.map((d) => d.id).join(", ")}`);
  for (const member of members) {
    await checkDecider(member, config, env, input.layaStatus ?? layaRuntimeStatus, { ok, warn, fail });
  }

  lines.push("models");
  const seen = new Set<string>();
  for (const tier of config.table) {
    for (const spec of [tier.models.direct, tier.models.exploration]) {
      const name = `${spec.provider}/${spec.modelId}`;
      if (seen.has(name)) continue;
      seen.add(name);
      const status = modelStatus(spec, lookup);
      if (status === "ok") ok(`${name} (${tier.id})`);
      else if (status === "no-auth") warn(`${name} (${tier.id}): no credentials in Pi (/login, or the provider's API key variable)`);
      else fail(`${name} (${tier.id}): not in Pi's model registry (check the id with pi --list-models)`);
    }
  }
  return lines;
}

async function checkDecider(
  decider: Decider,
  config: RouterConfig,
  env: NodeJS.ProcessEnv,
  layaStatus: typeof layaRuntimeStatus,
  report: { ok: (t: string) => void; warn: (t: string) => void; fail: (t: string) => void },
): Promise<void> {
  const name = `${decider.id}${decider.remote ? " (remote)" : ""}`;
  if (decider.id === "laya-local") {
    const status = layaStatus(env);
    if (!status.ok) return report.fail(`${name}: ${status.reason}`);
  }
  if (!decider.isReady) {
    if (decider.id === "laya-local") {
      // Loading takes seconds to minutes (first run downloads the model): start it, don't wait.
      decider.warmup().catch(() => {});
      return report.warn(`${name}: model not loaded yet; loading now, run /pignon doctor again in a moment`);
    }
    try {
      await decider.warmup();
    } catch (err) {
      return report.fail(`${name}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  try {
    const result = await decider.decide({ text: PROBE_PROMPT, questions: buildQuestions(config) }, AbortSignal.timeout(15_000));
    const cost = result.costUsd !== undefined ? ` · $${result.costUsd.toFixed(6)}` : "";
    report.ok(`${name}: ${result.model} answered a test prompt in ${result.latencyMs} ms${cost}`);
  } catch (err) {
    const message = err instanceof DeciderError || err instanceof Error ? err.message : String(err);
    report.fail(`${name}: ${message}`);
  }
}
