import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { buildCompareLines, comparedPair, defaultExportPath, exportDecisions } from "../src/compare.js";
import { DEFAULT_CONFIG } from "../src/config/defaults.js";
import type { DeciderAttempt, RouterLogEntry } from "../src/types.js";

const answered = (decider: string, tier: string, tierConfidence: number, extra: Partial<DeciderAttempt> = {}): DeciderAttempt => ({
  decider,
  remote: decider === "jev",
  outcome: "answered",
  used: false,
  tier,
  tierConfidence,
  needsExploration: false,
  latencyMs: decider === "jev" ? 400 : 20,
  ...extra,
});

const row = (...attempts: DeciderAttempt[]) => ({ promptHash: "h", attempts }) as unknown as RouterLogEntry;

describe("comparedPair", () => {
  it("picks the two deciders that answered most, in order of appearance", () => {
    const rows = [row(answered("laya-local", "hard", 0.1), answered("jev", "hard", 0.9))];
    expect(comparedPair(rows)).toEqual(["laya-local", "jev"]);
  });

  it("needs two deciders", () => {
    expect(comparedPair([row(answered("jev", "hard", 0.9))])).toBeNull();
    expect(comparedPair([{ promptHash: "h" } as RouterLogEntry])).toBeNull();
  });
});

describe("buildCompareLines", () => {
  const rows = [
    row(answered("laya-local", "standard", 0.05), answered("jev", "hard", 0.93, { used: true, costUsd: 0.00003 })),
    row(answered("laya-local", "hard", 0.2), answered("jev", "hard", 0.91, { used: true, needsExploration: true })),
    row(answered("laya-local", "trivial", 0.9, { used: true }), answered("jev", "trivial", 0.99)),
    row(answered("laya-local", "trivial", 0.9, { used: true }), { decider: "jev", remote: true, outcome: "failed", used: false, error: "x" }),
  ];

  it("summarises agreement over the decisions both answered", () => {
    const lines = buildCompareLines(rows, DEFAULT_CONFIG.table)!;

    expect(lines[0]).toBe("pignon compare — laya-local vs jev · 3 decisions answered by both");
    expect(lines[1]).toBe("tier agreement 67% · exploration agreement 67%");
  });

  it("builds a confusion matrix in table order", () => {
    const lines = buildCompareLines(rows, DEFAULT_CONFIG.table)!;
    const matrix = lines.slice(2, 6).map((l) => l.trim().split(/\s+/));

    expect(matrix[1]).toEqual(["trivial", "1", "0", "0"]);
    expect(matrix[2]).toEqual(["standard", "0", "0", "1"]);
    expect(matrix[3]).toEqual(["hard", "0", "0", "1"]);
  });

  it("reports confidence, failures, cost and how often each was routed on", () => {
    const lines = buildCompareLines(rows, DEFAULT_CONFIG.table)!;
    const cells = (label: string) => lines.find((l) => l.startsWith(label))!.slice(18).trim().split(/\s{2,}/);

    expect(cells("mean confidence")).toEqual(["0.51", "0.94"]);
    expect(cells("failures")).toEqual(["0", "1"]);
    expect(cells("cost")).toEqual(["—", "$0.00003"]);
    expect(cells("routed on")).toEqual(["2", "2"]);
  });

  it("returns null without decisions answered by two deciders", () => {
    expect(buildCompareLines([row(answered("jev", "hard", 0.9))], DEFAULT_CONFIG.table)).toBeNull();
  });
});

describe("exportDecisions", () => {
  it("writes one JSON line per decision, creating the folder", () => {
    const dir = mkdtempSync(join(tmpdir(), "pignon-export-"));
    try {
      const path = join(dir, "nested", "out.jsonl");
      const rows = [row(answered("jev", "hard", 0.9)), row(answered("jev", "trivial", 0.8))];

      exportDecisions(rows, path);

      const lines = readFileSync(path, "utf8").trim().split("\n");
      expect(lines.map((l) => JSON.parse(l))).toEqual(rows);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("defaults to a timestamped file under ~/.pi/agent", () => {
    expect(defaultExportPath(new Date("2026-09-23T10:00:00.000Z"))).toMatch(
      /\.pi\/agent\/pignon-exports\/decisions-2026-09-23T10-00-00-000Z\.jsonl$/,
    );
  });
});
