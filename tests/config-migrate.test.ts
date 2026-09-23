import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { DEFAULT_CONFIG } from "../src/config/defaults.js";
import { describeConfig } from "../src/config/describe.js";
import { parseConfig } from "../src/config/load.js";
import { migrateConfigFile, migrateDocument } from "../src/config/migrate.js";
import { CONFIG_SCHEMA_URL } from "../src/config/schema.js";

const OPUS = { provider: "anthropic", modelId: "claude-opus-5-5", thinking: "high" } as const;
const V1 = {
  thresholds: { minConfidenceDowngrade: 0.9 },
  tiers: { hard: { direct: OPUS }, standard: { sideways: {} } },
};

describe("migrateDocument", () => {
  it("turns v1 cell overrides into an explicit tier list", () => {
    const doc = migrateDocument(V1);

    expect(doc).toMatchObject({ $schema: CONFIG_SCHEMA_URL, version: 2, thresholds: { minConfidenceDowngrade: 0.9 } });
    expect(doc.tiers).toEqual([
      expect.objectContaining({ id: "trivial", model: "fast" }),
      expect.objectContaining({ id: "standard", model: "balanced" }),
      expect.objectContaining({ id: "hard", direct: OPUS, exploration: "agent" }),
    ]);
  });

  it("routes exactly like the v1 file it came from, without warnings", () => {
    const before = parseConfig(V1);
    const after = parseConfig(migrateDocument(V1));

    expect(after.config).toEqual(before.config);
    expect(after.errors).toEqual([]);
    expect(after.warnings).toEqual([]);
    expect(after.legacy).toBe(false);
  });

  it("splits a shared `model` when only one form is overridden", () => {
    const doc = migrateDocument({ tiers: { standard: { exploration: OPUS } } });
    const standard = (doc.tiers as Record<string, unknown>[])[1]!;

    expect(standard).toEqual({ id: "standard", criterion: expect.any(String), direct: "balanced", exploration: OPUS });
  });
});

describe("migrateConfigFile", () => {
  let dir: string;
  let paths: { path: string; legacyPath: string };

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "pignon-migrate-"));
    paths = { path: join(dir, "pignon.json"), legacyPath: join(dir, "laya-router.json") };
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("writes pignon.json from the laya-router file and leaves that file alone", () => {
    writeFileSync(paths.legacyPath, JSON.stringify(V1));

    const result = migrateConfigFile(paths);

    expect(result).toEqual({ ok: true, from: paths.legacyPath, to: paths.path });
    expect(JSON.parse(readFileSync(paths.path, "utf8")).version).toBe(2);
    expect(JSON.parse(readFileSync(paths.legacyPath, "utf8"))).toEqual(V1);
  });

  it("backs up a pignon.json still in the v1 format before rewriting it", () => {
    writeFileSync(paths.path, JSON.stringify(V1));

    const result = migrateConfigFile(paths);

    expect(result).toEqual({ ok: true, from: paths.path, to: paths.path, backup: `${paths.path}.bak` });
    expect(JSON.parse(readFileSync(`${paths.path}.bak`, "utf8"))).toEqual(V1);
    expect(JSON.parse(readFileSync(paths.path, "utf8")).version).toBe(2);
  });

  it("reports when there is nothing to migrate", () => {
    const result = migrateConfigFile(paths);

    expect(result.ok).toBe(false);
    expect(existsSync(paths.path)).toBe(false);
  });
});

describe("describeConfig", () => {
  it("shows each tier's models, sharing and exploration moves", () => {
    const lines = describeConfig(DEFAULT_CONFIG, null);

    expect(lines[0]).toBe("pignon config · built-in defaults");
    expect(lines.find((l) => l.trim().startsWith("trivial"))).toMatch(/deepseek-v4-flash-0731 · off\s+→ standard$/);
    expect(lines.find((l) => l.trim().startsWith("standard"))).toMatch(/deepseek-v4\.1-flash · low\s+same$/);
    expect(lines.find((l) => l.trim().startsWith("hard"))).toMatch(/glm-5\.3 · high\s+openrouter\/tencent\/hy4-preview · low$/);
    expect(lines).toContain("  questions q1 · confidence reported");
  });
});
