import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { loadConfig } from "../src/config/load.js";
import { CONFIG_SCHEMA_URL, ConfigFileSchema } from "../src/config/schema.js";

const root = join(import.meta.dirname, "..");
const schemaPath = join(root, "schema", "config.schema.json");

/** The published JSON Schema: TypeBox schemas are JSON Schema already. */
const expected = `${JSON.stringify(
  { $schema: "http://json-schema.org/draft-07/schema#", $id: CONFIG_SCHEMA_URL, ...ConfigFileSchema },
  null,
  2,
)}\n`;

describe("schema/config.schema.json", () => {
  it("matches the TypeBox schema (npm run schema regenerates it)", () => {
    if (process.env.UPDATE_SCHEMA) writeFileSync(schemaPath, expected);
    expect(readFileSync(schemaPath, "utf8")).toBe(expected);
  });
});

describe("examples", () => {
  it("examples/pignon.json loads without errors", () => {
    const path = join(root, "examples", "pignon.json");
    const loaded = loadConfig({ path, legacyPath: "/nonexistent" });

    expect(loaded.errors).toEqual([]);
    expect(loaded.warnings).toEqual([]);
    expect(loaded.config.table.map((t) => t.id)).toEqual(["trivial", "standard", "hard", "research"]);
  });
});
