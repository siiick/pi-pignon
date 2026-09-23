/**
 * `/pignon config`: the routing table and settings in use, as widget lines.
 */

import type { ModelSpec, RouterConfig } from "../types.js";

export function describeConfig(config: RouterConfig, source: string | null): string[] {
  const model = (spec: ModelSpec) => `${spec.provider}/${spec.modelId} · ${spec.thinking}`;
  const rows = config.table.map((tier, index) => {
    const direct = model(tier.models.direct);
    let exploration = model(tier.models.exploration);
    if (!tier.explorationAllowed) {
      const next = config.table.find((t, i) => i > index && t.explorationAllowed);
      exploration = `→ ${next?.id ?? "(none)"}`;
    } else if (exploration === direct) {
      exploration = "same";
    }
    return [tier.id, direct, exploration];
  });

  const widths = [0, 1].map((col) => Math.max(...[["tier", "direct"], ...rows].map((r) => r[col]!.length)));
  const line = (cells: string[]) => `  ${cells[0]!.padEnd(widths[0]! + 2)}${cells[1]!.padEnd(widths[1]! + 2)}${cells[2]}`;

  return [
    `pignon config · ${source ?? "built-in defaults"}`,
    line(["tier", "direct", "exploration"]),
    ...rows.map(line),
    `  questions ${config.questions.version} · confidence ${config.confidenceSource}`,
    "(/pignon config clear to hide)",
  ];
}
