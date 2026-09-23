/**
 * `/laya-stats`: tier x form x confidence histogram over a session's decisions.
 */

import { type RouterLogEntry, FORMS, TIER_ORDER } from "./types.js";

export function buildStatsLines(rows: RouterLogEntry[]): string[] {
  const buckets = ["<0.5", "0.5-0.7", "0.7-0.85", "0.85-0.95", ">=0.95"];
  const bucketOf = (c: number) =>
    c < 0.5 ? 0 : c < 0.7 ? 1 : c < 0.85 ? 2 : c < 0.95 ? 3 : 4;

  const grid: Record<string, number[]> = {};
  for (const tier of TIER_ORDER) {
    for (const form of FORMS) {
      grid[`${tier}/${form}`] = [0, 0, 0, 0, 0];
    }
  }

  let applied = 0;
  const latencies: number[] = [];

  for (const row of rows) {
    const cell = row.tier && row.form ? `${row.tier}/${row.form}` : null;
    if (cell && grid[cell]) grid[cell][bucketOf(row.tierConfidence ?? 0)]++;
    // Failed decisions have no latency; counting them as 0 ms skews the mean.
    if (typeof row.latencyMs === "number") latencies.push(row.latencyMs);
    if (row.applied) applied++;
  }

  const avgLatency = latencies.length
    ? `${Math.round(latencies.reduce((a, b) => a + b, 0) / latencies.length)} ms`
    : "n/a";

  return [
    `laya — ${rows.length} decisions, ${applied} applied`,
    `${"profile".padEnd(22)}${buckets.map((b) => b.padStart(9)).join("")}`,
    ...Object.entries(grid).map(
      ([cell, counts]) =>
        `${cell.padEnd(22)}${counts.map((n) => String(n).padStart(9)).join("")}`,
    ),
    `avg latency ${avgLatency}`,
    `(/laya-stats clear to hide)`,
  ];
}
