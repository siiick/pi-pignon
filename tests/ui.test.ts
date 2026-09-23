import { describe, expect, it } from "vitest";
import { confidenceBar, decisionCardLines, type CardTheme } from "../src/ui.js";
import type { RouterLogEntry } from "../src/types.js";

// Plain theme: no ANSI codes, so assertions read the visible text.
const theme: CardTheme = { fg: (_color, text) => text, bold: (text) => text };

const entry = (overrides: Partial<RouterLogEntry> = {}): RouterLogEntry => ({
  ts: 0,
  mode: "live",
  layaModel: "laya-small",
  promptHash: "abcd1234abcd1234",
  promptLength: 42,
  tier: "hard",
  tierConfidence: 0.92,
  needsExploration: true,
  explorationConfidence: 0.64,
  form: "exploration",
  latencyMs: 143.4,
  currentTier: "standard",
  currentForm: "direct",
  currentModel: "openrouter/deepseek/deepseek-v4.1-flash",
  contextTokens: 12_345,
  targetTier: "hard",
  targetForm: "exploration",
  targetModel: "openrouter/tencent/hy4-preview",
  targetThinking: "low",
  reason: "upgrade",
  applied: true,
  ...overrides,
});

describe("decisionCardLines", () => {
  it("summarises a switch in two collapsed lines", () => {
    const lines = decisionCardLines(entry(), false, theme);
    expect(lines).toEqual([
      "laya hard/exploration p=0.92 · 143 ms  ⚡ switched to openrouter/tencent/hy4-preview · thinking low",
      "  upgrade",
    ]);
  });

  it("says what shadow mode would have done", () => {
    const [head] = decisionCardLines(entry({ mode: "shadow", applied: false }), false, theme);
    expect(head).toContain("👁 would switch to openrouter/tencent/hy4-preview");
  });

  it("says when the current model is kept", () => {
    const [head] = decisionCardLines(
      entry({ applied: false, targetTier: null, targetForm: null, targetModel: undefined }),
      false,
      theme,
    );
    expect(head).toContain("· kept current model");
  });

  it("shows the error instead of a reason", () => {
    const lines = decisionCardLines(
      entry({ tier: null, tierConfidence: null, latencyMs: null, applied: false, targetTier: null, error: "timeout", reason: "error" }),
      false,
      theme,
    );
    expect(lines).toEqual(["laya no decision  ✗ timeout"]);
  });

  it("adds confidence bars and context when expanded", () => {
    const lines = decisionCardLines(entry(), true, theme);
    expect(lines).toContain("  tier        █████████░ 0.92  hard");
    expect(lines).toContain("  exploration ██████░░░░ 0.64  needs exploration");
    expect(lines).toContain(
      "  current     openrouter/deepseek/deepseek-v4.1-flash (standard/direct) · context 12.3k tokens",
    );
  });

  it("renders entries written before model names were recorded", () => {
    const [head] = decisionCardLines(entry({ targetModel: undefined, targetThinking: undefined }), false, theme);
    expect(head).toContain("⚡ switched to hard/exploration");
  });
});

describe("confidenceBar", () => {
  it("clamps out-of-range confidences", () => {
    expect(confidenceBar(1.5, theme)).toBe("██████████ 1.00");
    expect(confidenceBar(-1, theme)).toBe("░░░░░░░░░░ 0.00");
  });
});
