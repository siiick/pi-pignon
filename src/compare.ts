/**
 * `/pignon-stats compare` and `/pignon-stats export`: how two deciders agree,
 * over the decisions where both answered (parallel strategy, or sequential
 * escalations).
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { agentDir } from "./config/load.js";

import type { DeciderAttempt, RouterLogEntry, RoutingTable } from "./types.js";

type Answered = DeciderAttempt & { outcome: "answered" };

const answeredBy = (row: RouterLogEntry, decider: string): Answered | undefined =>
  row.attempts?.find((a): a is Answered => a.decider === decider && a.outcome === "answered");

/** The two deciders that answered most often, in order of first appearance. */
export function comparedPair(rows: RouterLogEntry[]): [string, string] | null {
  const counts = new Map<string, number>();
  for (const row of rows) {
    for (const a of row.attempts ?? []) {
      if (a.outcome === "answered") counts.set(a.decider, (counts.get(a.decider) ?? 0) + 1);
    }
  }
  const top = [...counts].sort((x, y) => y[1] - x[1]).slice(0, 2);
  if (top.length < 2) return null;
  const order = [...counts.keys()];
  const [a, b] = top.map(([id]) => id).sort((x, y) => order.indexOf(x) - order.indexOf(y));
  return [a!, b!];
}

export function buildCompareLines(rows: RouterLogEntry[], table: RoutingTable): string[] | null {
  const pair = comparedPair(rows);
  if (!pair) return null;
  const [a, b] = pair;
  const both = rows
    .map((row) => ({ a: answeredBy(row, a), b: answeredBy(row, b) }))
    .filter((p): p is { a: Answered; b: Answered } => p.a !== undefined && p.b !== undefined);
  if (both.length === 0) return null;

  const pct = (n: number) => `${Math.round((100 * n) / both.length)}%`;
  const tierAgree = both.filter((p) => p.a.tier === p.b.tier).length;
  const formAgree = both.filter((p) => p.a.needsExploration === p.b.needsExploration).length;

  // Confusion matrix over the tiers seen, in table order first.
  const seen = new Set(both.flatMap((p) => [p.a.tier ?? "?", p.b.tier ?? "?"]));
  const tiers = [...table.map((t) => t.id).filter((id) => seen.has(id)), ...[...seen].filter((id) => !table.some((t) => t.id === id))];
  const width = Math.max(10, ...tiers.map((t) => t.length + 2));
  const corner = `${a} ↓  ${b} →`;
  const matrix = [
    `${corner.padEnd(Math.max(corner.length + 2, width))}${tiers.map((t) => t.padStart(width)).join("")}`,
    ...tiers.map((row) => {
      const cells = tiers.map((col) => both.filter((p) => (p.a.tier ?? "?") === row && (p.b.tier ?? "?") === col).length);
      return `${row.padEnd(Math.max(corner.length + 2, width))}${cells.map((n) => String(n).padStart(width)).join("")}`;
    }),
  ];

  const perDecider = (id: string) => {
    const attempts = rows.flatMap((r) => r.attempts ?? []).filter((x) => x.decider === id);
    const answered = attempts.filter((x): x is Answered => x.outcome === "answered");
    const latencies = answered.map((x) => x.latencyMs ?? 0).sort((x, y) => x - y);
    const confidences = answered.map((x) => x.tierConfidence ?? 0);
    const cost = attempts.reduce((sum, x) => sum + (x.costUsd ?? 0), 0);
    return {
      confidence: confidences.length ? (confidences.reduce((x, y) => x + y, 0) / confidences.length).toFixed(2) : "—",
      latency: latencies.length ? `${percentile(latencies, 0.5)}/${percentile(latencies, 0.95)} ms` : "—",
      failures: String(attempts.filter((x) => x.outcome === "failed").length),
      cost: cost > 0 ? `$${cost.toFixed(5)}` : "—",
      used: String(attempts.filter((x) => x.used).length),
    };
  };
  const stats = [perDecider(a), perDecider(b)];
  const col = Math.max(12, a.length + 2, b.length + 2);
  const row = (label: string, key: keyof ReturnType<typeof perDecider>) =>
    `${label.padEnd(18)}${stats.map((s) => s[key].padStart(col)).join("")}`;

  return [
    `pignon compare — ${a} vs ${b} · ${both.length} decisions answered by both`,
    `tier agreement ${pct(tierAgree)} · exploration agreement ${pct(formAgree)}`,
    ...matrix,
    `${"".padEnd(18)}${[a, b].map((id) => id.padStart(col)).join("")}`,
    row("mean confidence", "confidence"),
    row("latency p50/p95", "latency"),
    row("failures", "failures"),
    row("cost", "cost"),
    row("routed on", "used"),
    "(/pignon-stats clear to hide)",
  ];
}

function percentile(sorted: number[], p: number): number {
  return Math.round(sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))]!);
}

/** Default export location: outside any project, next to Pi's own files. */
export function defaultExportPath(now = new Date(), env: NodeJS.ProcessEnv = process.env): string {
  const stamp = now.toISOString().replace(/[:.]/g, "-");
  return join(agentDir(env), "pignon-exports", `decisions-${stamp}.jsonl`);
}

/**
 * Write one JSON line per decision. Entries hold a prompt hash and length,
 * never the prompt, so the file is safe to share.
 */
export function exportDecisions(rows: RouterLogEntry[], path: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, rows.map((row) => JSON.stringify(row)).join("\n") + "\n");
}
