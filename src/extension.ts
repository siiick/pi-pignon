/**
 * Laya LLM Router — Pi agent extension.
 *
 * Routes user prompts to the best matching LLM model by consulting a local
 * Laya System-1 decision model via a stdio worker it spawns and supervises.
 *
 *   /laya           -> show current mode
 *   /laya live      -> apply decisions
 *   /laya shadow    -> observe only (default)
 *   /laya off       -> stop calling Laya
 *   /laya unpin     -> re-enable routing after manual model selection
 *   /laya log       -> recent worker diagnostics
 *   /laya log clear -> hide diagnostics widget
 *   /laya-stats     -> session statistics
 *   /laya-stats clear -> hide statistics widget
 */

import { createHash } from "node:crypto";

import type {
  ExtensionAPI,
  ExtensionContext,
  SessionEntry,
} from "@earendil-works/pi-coding-agent";

import {
  type LayaDecisionRequest,
  type LayaHealthResponse,
  type LayaRoutingDecision,
  type PolicyOutput,
  type Profile,
  type RouterConfig,
  type RouterLogEntry,
  type RouterMode,
  FORMS,
  TIER_ORDER,
} from "./types.js";

import { loadConfig } from "./config.js";
import { LayaWorker, LayaWorkerError } from "./laya-worker.js";
import { decide, formOf, profileFromModel } from "./policy.js";
import { hideDeciding, renderDecisionCard, showDeciding } from "./ui.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Worker log lines shown by `/laya log`. */
const LOG_WIDGET_LINES = 30;

/**
 * Laya reads at most ~320 tokens of the prompt (512-token window minus the
 * question header) from the start and ignores the rest, so sending more only
 * costs tokenization time.
 */
const MAX_PROMPT_CHARS = 4_000;

const QUESTIONS: LayaDecisionRequest["questions"] = {
  reasoning_demand: {
    type: "choice",
    instructions: "How much reasoning does solving this request demand, regardless of how long the answer should be?",
    criteria: {
      trivial: "Mechanical edit, rename, formatting, or a single factual lookup",
      standard: "Localized change across a few files with clear intent",
      hard: "Multi-step investigation, debugging with unclear cause, or cross-cutting design",
    },
  },
  needs_exploration: {
    type: "choice",
    instructions: "Does answering require exploring the codebase before acting?",
    criteria: {
      yes: "The target files or cause are not identified in the request",
      no: "The request names what to change and where",
    },
  },
};

type PiModel = Parameters<ExtensionAPI["setModel"]>[0];

// ---------------------------------------------------------------------------
// UI helpers (no-ops without a UI, e.g. print or RPC mode)
// ---------------------------------------------------------------------------

function renderStatus(ctx: ExtensionContext, text: string): void {
  if (ctx.hasUI) ctx.ui.setStatus("laya", text);
}

function notify(ctx: ExtensionContext, text: string, level: "info" | "warning" | "error" = "info"): void {
  if (ctx.hasUI) ctx.ui.notify(text, level);
}

function showWidget(ctx: ExtensionContext, name: string, lines: string[] | undefined): void {
  if (ctx.hasUI) ctx.ui.setWidget(name, lines);
}

// ---------------------------------------------------------------------------
// Log entries
// ---------------------------------------------------------------------------

/** Short, stable fingerprint of a prompt; the text itself is never stored. */
export function hashPrompt(prompt: string): string {
  return createHash("sha256").update(prompt).digest("hex").slice(0, 16);
}

interface LogEntryInput {
  mode: RouterMode;
  tiers: RouterConfig["tiers"];
  currentModel: string | undefined;
  layaModel: string;
  prompt: string;
  decision: LayaRoutingDecision | null;
  current: Profile | null;
  contextTokens: number;
  verdict: PolicyOutput;
  applied: boolean;
  error?: string;
  minConfidenceForm: number;
}

function buildLogEntry(input: LogEntryInput): RouterLogEntry {
  const { decision, current, verdict } = input;
  const spec = verdict.target ? input.tiers[verdict.target.tier][verdict.target.form] : undefined;
  return {
    ts: Date.now(),
    mode: input.mode,
    layaModel: input.layaModel,
    promptHash: hashPrompt(input.prompt),
    promptLength: input.prompt.length,
    tier: decision?.tier ?? null,
    tierConfidence: decision?.tierConfidence ?? null,
    needsExploration: decision?.needsExploration ?? null,
    explorationConfidence: decision?.explorationConfidence ?? null,
    form: decision ? formOf(decision, input.minConfidenceForm) : null,
    latencyMs: decision?.latencyMs ?? null,
    currentTier: current?.tier ?? null,
    currentForm: current?.form ?? null,
    ...(input.currentModel !== undefined ? { currentModel: input.currentModel } : {}),
    contextTokens: input.contextTokens,
    targetTier: verdict.target?.tier ?? null,
    targetForm: verdict.target?.form ?? null,
    ...(spec ? { targetModel: `${spec.provider}/${spec.modelId}`, targetThinking: spec.thinking } : {}),
    reason: verdict.reason,
    applied: input.applied,
    ...(input.error !== undefined ? { error: input.error } : {}),
  };
}

// ---------------------------------------------------------------------------
// Per-prompt routing
// ---------------------------------------------------------------------------

interface RoutePromptOptions {
  pi: ExtensionAPI;
  worker: LayaWorker;
  config: RouterConfig;
  mode: Exclude<RouterMode, "off">;
  promptsSinceSwitch: number | undefined;
  lastHealth: LayaHealthResponse | undefined;
  /** Switches model without the change being taken for a manual pin. */
  switchModel: (model: PiModel) => Promise<boolean>;
}

interface RouteResult {
  /** Whether the model was switched. */
  applied: boolean;
  entry: RouterLogEntry;
}

/** Ask Laya about one prompt and apply the verdict. */
async function routePrompt(
  options: RoutePromptOptions,
  prompt: string,
  ctx: ExtensionContext,
): Promise<RouteResult> {
  const { pi, worker, config, mode } = options;
  const { tiers, thresholds } = config;
  const layaModel = () => worker.loadedModel ?? options.lastHealth?.loaded_model ?? "unknown";
  const model = ctx.model;
  const current = model ? profileFromModel(model.provider, model.id, tiers) : null;
  const contextTokens = ctx.getContextUsage()?.tokens ?? 0;
  const currentModel = model ? `${model.provider}/${model.id}` : undefined;

  try {
    renderStatus(ctx, "laya is deciding...");
    showDeciding(ctx, layaModel());
    let decision: LayaRoutingDecision;
    try {
      decision = await worker.decide(
        { text: prompt.slice(0, MAX_PROMPT_CHARS), questions: QUESTIONS },
        ctx.signal,
      );
    } finally {
      hideDeciding(ctx);
    }

    const verdict = decide({
      decision,
      current,
      contextTokens,
      promptsSinceSwitch: options.promptsSinceSwitch,
      currentPrice: model?.cost,
      priceOf: (spec) => ctx.modelRegistry.find(spec.provider, spec.modelId)?.cost,
      config,
    });

    let applied = false;
    if (mode === "live" && verdict.target) {
      const spec = tiers[verdict.target.tier][verdict.target.form];
      const target = ctx.modelRegistry.find(spec.provider, spec.modelId);
      if (!target) {
        notify(ctx, `laya: ${spec.provider}/${spec.modelId} is not in the model registry`, "warning");
      } else if (await options.switchModel(target)) {
        pi.setThinkingLevel(spec.thinking);
        applied = true;
      } else {
        notify(ctx, `laya: no auth for ${spec.provider}/${spec.modelId}`, "warning");
      }
    }

    const entry = buildLogEntry({
      mode,
      tiers,
      currentModel,
      layaModel: layaModel(),
      prompt,
      decision,
      current,
      contextTokens,
      verdict,
      applied,
      minConfidenceForm: thresholds.minConfidenceForm,
    });

    const badge = mode === "live" ? (applied ? "⚡" : "·") : "👁";
    const label = `${decision.tier ?? "?"}/${formOf(decision, thresholds.minConfidenceForm)} p=${decision.tierConfidence.toFixed(2)}`;
    renderStatus(ctx, `laya ${badge} ${label} — ${verdict.reason}`);
    return { applied, entry };
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    renderStatus(ctx, `laya ✗ ${error.slice(0, 80)}`);
    const entry = buildLogEntry({
      mode,
      tiers,
      currentModel,
      layaModel: layaModel(),
      prompt,
      decision: null,
      current,
      contextTokens,
      verdict: { target: null, reason: "error" },
      applied: false,
      error,
      minConfidenceForm: thresholds.minConfidenceForm,
    });
    return { applied: false, entry };
  }
}

// ---------------------------------------------------------------------------
// Stats command helper
// ---------------------------------------------------------------------------

function isLayaEntry(entry: SessionEntry): boolean {
  return entry.type === "custom" && (entry as { customType?: string }).customType === "laya-decision";
}

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

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

export default function layaRouterExtension(pi: ExtensionAPI) {
  let mode: RouterMode = "shadow";
  let manualPin = false;
  let promptsSinceSwitch: number | undefined;
  let lastHealth: LayaHealthResponse | undefined;

  // A small synchronous file read; the worker process is only started later.
  const { config, source: configSource, errors: configErrors } = loadConfig();

  const worker = new LayaWorker({ timeoutMs: config.thresholds.layaTimeoutMs });

  // pi.setModel() emits model_select with source "set", exactly like a manual
  // /model choice. Flag our own switches so they do not pin the router.
  let routerSwitching = false;
  const switchModel = async (model: PiModel) => {
    routerSwitching = true;
    try {
      return await pi.setModel(model);
    } finally {
      routerSwitching = false;
    }
  };

  // --- Decision cards -----------------------------------------------------

  pi.registerEntryRenderer<RouterLogEntry>("laya-decision", renderDecisionCard);

  // Routing runs in before_agent_start, before Pi posts the user message. The
  // entry is held until that message is in so its card renders below the
  // prompt it describes, not above it.
  let pendingEntry: RouterLogEntry | undefined;
  const flushPendingEntry = () => {
    if (!pendingEntry) return;
    pi.appendEntry("laya-decision", pendingEntry);
    pendingEntry = undefined;
  };

  // --- Session lifecycle --------------------------------------------------

  // Loading the model can take a while (first run downloads it), so it runs in
  // the background: neither session start nor a prompt ever waits for it.
  let sessionActive = false;
  let warming: Promise<void> | undefined;
  const warmUp = (ctx: ExtensionContext) => {
    if (warming) return;
    warming = worker
      .warmup()
      .then(
        (health) => {
          lastHealth = health;
          if (sessionActive) {
            renderStatus(ctx, `laya ${mode} · ${health.loaded_model ?? "unknown model"}`);
          }
        },
        (err) => {
          const msg = err instanceof LayaWorkerError ? err.message : String(err);
          if (sessionActive) renderStatus(ctx, `laya ${mode} · ⚠ ${msg.slice(0, 60)} (/laya log)`);
        },
      )
      .finally(() => {
        warming = undefined;
      });
  };

  pi.on("session_start", async (_event, ctx) => {
    manualPin = false;
    promptsSinceSwitch = undefined;
    sessionActive = true;
    if (configErrors.length > 0) {
      notify(ctx, `laya: config problems, using defaults for:\n${configErrors.join("\n")}`, "warning");
    }
    renderStatus(ctx, `laya ${mode} · loading model`);
    warmUp(ctx);
  });

  pi.on("session_shutdown", () => {
    flushPendingEntry();
    sessionActive = false;
    worker.stop();
  });

  // --- Routing hook -------------------------------------------------------

  pi.on("before_agent_start", async (event, ctx) => {
    flushPendingEntry();
    if (mode === "off") return;
    if (manualPin) {
      renderStatus(ctx, "laya ⏸ pinned");
      return;
    }
    // Fail open while the model loads (or reloads after a crash): route
    // nothing rather than hold the prompt.
    if (!worker.isReady) {
      renderStatus(ctx, "laya ⏳ model loading — prompt not routed");
      warmUp(ctx);
      return;
    }

    if (promptsSinceSwitch !== undefined) promptsSinceSwitch++;
    const { applied, entry } = await routePrompt(
      { pi, worker, config, mode, promptsSinceSwitch, lastHealth, switchModel },
      event.prompt,
      ctx,
    );
    pendingEntry = entry;
    if (applied) promptsSinceSwitch = 0;
  });

  pi.on("message_end", async (event) => {
    if (event.message.role === "user") flushPendingEntry();
  });

  // Fallback for runs that end without posting a user message.
  pi.on("agent_end", async () => {
    flushPendingEntry();
  });

  // --- Manual model selection guard ---------------------------------------

  pi.on("model_select", async (event, ctx) => {
    if (event.source === "set" && !routerSwitching) {
      manualPin = true;
      renderStatus(ctx, "laya ⏸ pinned");
    }
  });

  // --- Commands -----------------------------------------------------------

  pi.registerCommand("laya", {
    description: "Laya router mode (shadow | live | off | unpin | log)",
    getArgumentCompletions: (prefix) =>
      ["shadow", "live", "off", "unpin", "log", "log clear"]
        .filter((v) => v.startsWith(prefix))
        .map((v) => ({ value: v, label: v })),
    handler: async (args, ctx) => {
      const arg = args.trim();
      if (arg === "log clear") {
        showWidget(ctx, "laya-log", undefined);
        return;
      }
      if (arg === "log") {
        const lines = worker.recentLogs.slice(-LOG_WIDGET_LINES);
        if (lines.length === 0) {
          notify(ctx, "laya: no worker output yet");
          return;
        }
        showWidget(ctx, "laya-log", [...lines, "(/laya log clear to hide)"]);
        return;
      }
      if (arg === "unpin") {
        manualPin = false;
        notify(ctx, "laya: routing re-enabled");
        renderStatus(ctx, `laya ${mode}`);
        return;
      }
      if (arg === "shadow" || arg === "live" || arg === "off") {
        mode = arg;
        manualPin = false;
        notify(ctx, `laya: mode ${mode}`);
        renderStatus(ctx, `laya ${mode}`);
        return;
      }
      const pinned = manualPin ? " (model pinned manually)" : "";
      const configNote = configSource ? ` · config ${configSource}` : "";
      notify(ctx, `laya: mode ${mode}${pinned}${configNote}`);
    },
  });

  pi.registerCommand("laya-stats", {
    description: "Tier x form x confidence breakdown for this session",
    handler: async (args, ctx) => {
      if (args.trim() === "clear") {
        showWidget(ctx, "laya-stats", undefined);
        return;
      }

      const rows = ctx.sessionManager
        .getEntries()
        .filter(isLayaEntry)
        .map((e) => (e as { data?: RouterLogEntry }).data)
        .filter((d): d is RouterLogEntry => d !== undefined);

      if (rows.length === 0) {
        notify(ctx, "laya: no decisions in this session");
        return;
      }

      showWidget(ctx, "laya-stats", buildStatsLines(rows));
    },
  });
}
