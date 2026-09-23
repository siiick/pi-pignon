/**
 * Model presets: the four built-in model names (`fast`, `balanced`,
 * `reasoner`, `agent`) filled from one provider. A config file selects one
 * with `"extends": "<name>"`; `/pignon init <name>` copies one into a new
 * config file.
 *
 * Ids are Pi model ids (`pi --list-models`). They are starting points, not
 * recommendations: check prices and quality for your own work.
 */

import type { ModelSpec } from "../types.js";

export interface Preset {
  description: string;
  models: Readonly<Record<"fast" | "balanced" | "reasoner" | "agent", ModelSpec>>;
}

export const PRESETS = {
  openrouter: {
    description: "OpenRouter: DeepSeek flash models, GLM for reasoning, HY4 as agent (the built-in table)",
    models: {
      fast: { provider: "openrouter", modelId: "deepseek/deepseek-v4-flash-0731", thinking: "off" },
      balanced: { provider: "openrouter", modelId: "deepseek/deepseek-v4.1-flash", thinking: "low" },
      reasoner: { provider: "openrouter", modelId: "z-ai/glm-5.3", thinking: "high" },
      agent: { provider: "openrouter", modelId: "tencent/hy4-preview", thinking: "low" },
    },
  },
  anthropic: {
    description: "Anthropic: Haiku for small edits, Sonnet for the rest, Opus for hard reasoning",
    models: {
      fast: { provider: "anthropic", modelId: "claude-haiku-4-5", thinking: "off" },
      balanced: { provider: "anthropic", modelId: "claude-sonnet-5", thinking: "low" },
      reasoner: { provider: "anthropic", modelId: "claude-opus-5-5", thinking: "high" },
      agent: { provider: "anthropic", modelId: "claude-sonnet-5", thinking: "medium" },
    },
  },
  openai: {
    description: "OpenAI: GPT-6 Luna for small edits, GPT-5.6 Terra for the rest, GPT-6 Sol for reasoning, Codex as agent",
    models: {
      fast: { provider: "openai", modelId: "gpt-6-luna", thinking: "off" },
      balanced: { provider: "openai", modelId: "gpt-5.6-terra", thinking: "low" },
      reasoner: { provider: "openai", modelId: "gpt-6-sol", thinking: "high" },
      agent: { provider: "openai", modelId: "gpt-5.3-codex", thinking: "medium" },
    },
  },
} as const satisfies Record<string, Preset>;

export type PresetName = keyof typeof PRESETS;

export const PRESET_NAMES = Object.keys(PRESETS) as PresetName[];

export function isPresetName(value: unknown): value is PresetName {
  return typeof value === "string" && value in PRESETS;
}
