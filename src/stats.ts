/**
 * `/pignon-stats`: tier x form x confidence histogram over a session's decisions.
 */

import { DEFAULT_CONFIG } from "./config/defaults.js";
import { type RouterLogEntry, type RoutingTable, FORMS } from "./types.js";

/** Rows follow the table; decisions for tiers no longer in it are not counted. */
export function buildStatsLines(rows: RouterLogEntry[], table: RoutingTable = DEFAULT_CONFIG.table): string[] {
  const buckets = ["<0.5", "0.5-0.7", "0.7-0.85", "0.85-0.95", ">=0.95"];
  const bucketOf = (c: number) =>
    c < 0.5 ? 0 : c < 0.7 ? 1 : c < 0.85 ? 2 : c < 0.95 ? 3 : 4;

  const grid: Record<string, number[]> = {};
  for (const { id } of table) {
    for (const form of FORMS) {
      grid[`${id}/${form}`] = [0, 0, 0, 0, 0];
    }
  }

  let applied = 0;
  const latencies: number[] = [];
  const byDecider = new Map<string, number>();
  let cost = 0;

  for (const row of rows) {
    const cell = row.tier && row.form ? `${row.tier}/${row.form}` : null;
    if (cell && grid[cell]) grid[cell][bucketOf(row.tierConfidence ?? 0)]++;
    // Failed decisions have no latency; counting them as 0 ms skews the mean.
    if (typeof row.latencyMs === "number") latencies.push(row.latencyMs);
    if (row.applied) applied++;
    if (row.decider) byDecider.set(row.decider, (byDecider.get(row.decider) ?? 0) + 1);
    cost += row.costUsd ?? 0;
  }

  const avgLatency = latencies.length
    ? `${Math.round(latencies.reduce((a, b) => a + b, 0) / latencies.length)} ms`
    : "n/a";

  return [
    `pignon — ${rows.length} decisions, ${applied} applied`,
    `${"profile".padEnd(22)}${buckets.map((b) => b.padStart(9)).join("")}`,
    ...Object.entries(grid).map(
      ([cell, counts]) =>
        `${cell.padEnd(22)}${counts.map((n) => String(n).padStart(9)).join("")}`,
    ),
    `avg latency ${avgLatency}`,
    ...(byDecider.size > 0
      ? [
          `deciders ${[...byDecider].map(([id, n]) => `${id} ${n}`).join(" · ")}` +
            (cost > 0 ? ` · cost $${cost.toFixed(5)}` : ""),
        ]
      : []),
    `(/pignon-stats clear to hide)`,
  ];
}
