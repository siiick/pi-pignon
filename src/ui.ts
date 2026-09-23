/**
 * TUI pieces for the Laya LLM Router: the "deciding" spinner widget and the
 * decision card rendered in the transcript for each decision entry.
 *
 * Card text is built by pure functions over a minimal theme so it can be
 * tested without a terminal.
 */

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Box, Loader, Text } from "@earendil-works/pi-tui";

import type { RouterLogEntry } from "./types.js";

/** The subset of Pi's theme the card uses. */
export interface CardTheme {
  fg(color: "accent" | "success" | "warning" | "error" | "muted" | "dim" | "text", text: string): string;
  bold(text: string): string;
}

export const DECIDING_WIDGET = "pignon-deciding";

// ---------------------------------------------------------------------------
// Spinner
// ---------------------------------------------------------------------------

/** Show an animated "deciding" line above the editor until `hideDeciding`. */
export function showDeciding(ctx: ExtensionContext, deciderModel: string): void {
  if (!ctx.hasUI) return;
  ctx.ui.setWidget(DECIDING_WIDGET, (tui, theme) => {
    const loader = new Loader(
      tui,
      (s) => theme.fg("accent", s),
      (s) => theme.fg("muted", s),
      `pignon is choosing a model… ${theme.fg("dim", `(${deciderModel})`)}`,
    );
    return Object.assign(loader, { dispose: () => loader.stop() });
  });
}

export function hideDeciding(ctx: ExtensionContext): void {
  if (ctx.hasUI) ctx.ui.setWidget(DECIDING_WIDGET, undefined);
}

// ---------------------------------------------------------------------------
// Decision card
// ---------------------------------------------------------------------------

const BAR_WIDTH = 10;

/** Short names on the card; ☁ is added for remote deciders. */
const DECIDER_LABELS: Record<string, string> = { "laya-local": "laya", jev: "jev" };

export function confidenceBar(confidence: number, theme: CardTheme): string {
  const clamped = Math.min(1, Math.max(0, confidence));
  const filled = Math.round(clamped * BAR_WIDTH);
  const color = clamped >= 0.85 ? "success" : clamped >= 0.6 ? "warning" : "error";
  return (
    theme.fg(color, "█".repeat(filled)) +
    theme.fg("dim", "░".repeat(BAR_WIDTH - filled)) +
    ` ${clamped.toFixed(2)}`
  );
}

function formatTokens(n: number): string {
  return n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n);
}

function profileLabel(tier: string | null, form: string | null): string {
  return tier ? `${tier}/${form ?? "?"}` : "unknown";
}

/** What happened to the verdict, as one styled phrase. */
function outcome(entry: RouterLogEntry, theme: CardTheme): string {
  if (entry.error !== undefined) return theme.fg("error", `✗ ${entry.error}`);
  const target = profileLabel(entry.targetTier, entry.targetForm);
  const model = entry.targetModel ?? target;
  const thinking = entry.targetThinking ? theme.fg("dim", ` · thinking ${entry.targetThinking}`) : "";
  if (entry.applied) return theme.fg("success", `⚡ switched to ${theme.bold(model)}`) + thinking;
  if (entry.targetTier) {
    return entry.mode === "shadow"
      ? theme.fg("warning", `👁 would switch to ${model}`) + thinking
      : theme.fg("warning", `! could not switch to ${model}`);
  }
  return theme.fg("muted", "· kept current model");
}

/** One line per decision with several deciders: who answered what, and which answer was used (✓). */
function attemptsLine(entry: RouterLogEntry, theme: CardTheme): string | undefined {
  const asked = (entry.attempts ?? []).filter((a) => a.outcome !== "not-asked");
  if (asked.length < 2) return undefined;
  const parts = asked.map((a) => {
    const name = `${DECIDER_LABELS[a.decider] ?? a.decider}${a.remote ? " ☁" : ""}`;
    switch (a.outcome) {
      case "answered": {
        const text = `${name} ${a.tier ?? "?"} ${(a.tierConfidence ?? 0).toFixed(2)}`;
        return a.used ? theme.fg("text", `${text} ✓`) : theme.fg("dim", text);
      }
      case "failed":
        return theme.fg("error", `${name} ✗ ${(a.error ?? "failed").slice(0, 40)}`);
      default:
        return theme.fg("muted", `${name} ⏳ not ready`);
    }
  });
  return `  ${parts.join(theme.fg("dim", " · "))}`;
}

/** Lines of the decision card; the first line is the collapsed view. */
export function decisionCardLines(entry: RouterLogEntry, expanded: boolean, theme: CardTheme): string[] {
  const decider = entry.decider ? ` ${DECIDER_LABELS[entry.decider] ?? entry.decider}${entry.remote ? " ☁" : ""}` : "";
  const head = theme.fg("accent", theme.bold("pignon")) + theme.fg("muted", decider);
  const profile = entry.tier ? theme.bold(profileLabel(entry.tier, entry.form)) : theme.fg("muted", "no decision");
  const facts = [
    entry.tierConfidence !== null ? `p=${entry.tierConfidence.toFixed(2)}` : null,
    entry.latencyMs !== null ? `${Math.round(entry.latencyMs)} ms` : null,
  ].filter((f): f is string => f !== null);
  const summary = facts.length ? theme.fg("dim", ` ${facts.join(" · ")}`) : "";

  const lines = [`${head} ${profile}${summary}  ${outcome(entry, theme)}`];
  if (entry.error === undefined) lines.push(theme.fg("dim", `  ${entry.reason}`));
  const attempts = attemptsLine(entry, theme);
  if (attempts) lines.push(attempts);
  if (!expanded) return lines;

  const label = (s: string) => theme.fg("muted", `  ${s.padEnd(12)}`);
  if (entry.tierConfidence !== null) {
    lines.push(`${label("tier")}${confidenceBar(entry.tierConfidence, theme)}  ${entry.tier ?? "?"}`);
  }
  if (entry.explorationConfidence !== null) {
    const explores = entry.needsExploration ? "needs exploration" : "direct";
    lines.push(`${label("exploration")}${confidenceBar(entry.explorationConfidence, theme)}  ${explores}`);
  }
  const current = entry.currentModel
    ? `${entry.currentModel} (${profileLabel(entry.currentTier, entry.currentForm)})`
    : profileLabel(entry.currentTier, entry.currentForm);
  lines.push(`${label("current")}${current} · context ${formatTokens(entry.contextTokens)} tokens`);
  lines.push(
    `${label("run")}` +
      theme.fg("dim", `mode ${entry.mode} · ${entry.deciderModel ?? entry.layaModel ?? "?"}${entry.questionsVersion ? ` · questions ${entry.questionsVersion}` : ""}${entry.costUsd !== undefined ? ` · $${entry.costUsd.toFixed(6)}` : ""} · prompt #${entry.promptHash} (${entry.promptLength} chars)`),
  );
  return lines;
}

/** Entry renderer for decision entries (`pignon-decision`, and `laya-decision` from older sessions). */
export function renderDecisionCard(
  entry: { data?: RouterLogEntry },
  options: { expanded: boolean },
  theme: CardTheme & { bg(color: "customMessageBg", text: string): string },
) {
  if (!entry.data) return undefined;
  const box = new Box(1, 0, (text) => theme.bg("customMessageBg", text));
  box.addChild(new Text(decisionCardLines(entry.data, options.expanded, theme).join("\n"), 0, 0));
  return box;
}
