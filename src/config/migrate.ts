/**
 * `/pignon config migrate`: rewrite a laya-router config as a pignon (v2)
 * config file.
 *
 * Only the format changes: thresholds and models carry over as they are, and
 * the per-cell overrides of v1 `tiers` become an explicit tier list.
 */

import { copyFileSync, existsSync, writeFileSync } from "node:fs";

import { FORMS, type ModelSpec } from "../types.js";
import { DEFAULT_TIERS } from "./defaults.js";
import { type ConfigPaths, configPaths, readJson } from "./load.js";
import { type ModelRef, type TierFile, CONFIG_SCHEMA_URL } from "./schema.js";

/** The v2 document equivalent to a laya-router (or already v2) document. */
export function migrateDocument(raw: Record<string, unknown>): Record<string, unknown> {
  const { $schema: _schema, version: _version, tiers, ...rest } = raw;
  const doc: Record<string, unknown> = { $schema: CONFIG_SCHEMA_URL, version: 2, ...rest };
  if (isRecord(tiers)) doc.tiers = migrateTiers(tiers);
  else if (tiers !== undefined) doc.tiers = tiers;
  return doc;
}

/** v1 per-cell overrides applied to the default tier list. Invalid cells are dropped, as when loading. */
function migrateTiers(v1: Record<string, unknown>): TierFile[] {
  return DEFAULT_TIERS.map((tier) => {
    const overrides = v1[tier.id];
    if (!isRecord(overrides)) return { ...tier };
    const refs: Record<string, ModelRef | undefined> = {
      direct: tier.model ?? tier.direct,
      exploration: tier.model ?? tier.exploration,
    };
    let changed = false;
    for (const form of FORMS) {
      const spec = overrides[form];
      if (isModelSpec(spec)) {
        refs[form] = { provider: spec.provider, modelId: spec.modelId, thinking: spec.thinking };
        changed = true;
      }
    }
    if (!changed) return { ...tier };
    const { model: _model, ...base } = tier;
    return { ...base, direct: refs.direct!, exploration: refs.exploration! };
  });
}

export type MigrateResult = { ok: true; from: string; to: string; backup?: string } | { ok: false; message: string };

/**
 * Write the migrated config to `paths.path`. Reads the pignon file when it
 * exists (it may still use the v1 tier format), else the laya-router file.
 * An existing pignon file is backed up to `<path>.bak` before being replaced.
 */
export function migrateConfigFile(paths: ConfigPaths = configPaths()): MigrateResult {
  const fromPrimary = existsSync(paths.path);
  const from = fromPrimary ? paths.path : paths.legacyPath;
  const read = readJson(from);
  if (read.kind === "missing") return { ok: false, message: `no config file to migrate (${paths.path}, ${paths.legacyPath})` };
  if (read.kind === "error") return { ok: false, message: `${from}: ${read.error}` };
  if (!isRecord(read.raw)) return { ok: false, message: `${from}: expected a JSON object` };

  const doc = migrateDocument(read.raw);
  let backup: string | undefined;
  if (fromPrimary) {
    backup = `${paths.path}.bak`;
    copyFileSync(paths.path, backup);
  }
  writeFileSync(paths.path, `${JSON.stringify(doc, null, 2)}\n`);
  return { ok: true, from, to: paths.path, ...(backup ? { backup } : {}) };
}

function isModelSpec(value: unknown): value is ModelSpec {
  return (
    isRecord(value) &&
    typeof value.provider === "string" &&
    value.provider !== "" &&
    typeof value.modelId === "string" &&
    value.modelId !== "" &&
    typeof value.thinking === "string"
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
