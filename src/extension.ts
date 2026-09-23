/**
 * Laya LLM Router — Pi agent extension.
 *
 * Routes user prompts to the best matching LLM model by asking a decider
 * (today: the local Laya System-1 model, via a stdio worker it spawns and
 * supervises) how hard each prompt is.
 *
 *   /laya           -> show current mode
 *   /laya live      -> apply decisions
 *   /laya shadow    -> observe only (default)
 *   /laya off       -> stop calling the decider
 *   /laya unpin     -> re-enable routing after manual model selection
 *   /laya log       -> recent decider diagnostics
 *   /laya log clear -> hide diagnostics widget
 *   /laya-stats     -> session statistics
 *   /laya-stats clear -> hide statistics widget
 *
 * This module only wires Pi to the router; the routing itself is in
 * `router.ts`, the policy in `policy.ts`, and the deciders in `deciders/`.
 */

import type {
  ExtensionAPI,
  ExtensionContext,
  SessionEntry,
} from "@earendil-works/pi-coding-agent";

import { loadConfig } from "./config.js";
import { LayaWorker } from "./deciders/laya-local.js";
import type { Decider } from "./deciders/types.js";
import { type RouterHost, routePrompt } from "./router.js";
import { buildStatsLines } from "./stats.js";
import type { RouterConfig, RouterLogEntry, RouterMode } from "./types.js";
import { hideDeciding, renderDecisionCard, showDeciding } from "./ui.js";

/** Decider log lines shown by `/laya log`. */
const LOG_WIDGET_LINES = 30;

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

/** Adapt Pi's API and a context to what the router needs. */
function piHost(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  switchModel: (model: PiModel) => Promise<boolean>,
): RouterHost<PiModel> {
  return {
    get model() {
      return ctx.model;
    },
    get contextTokens() {
      return ctx.getContextUsage()?.tokens ?? 0;
    },
    get signal() {
      return ctx.signal;
    },
    findModel: (provider, modelId) => ctx.modelRegistry.find(provider, modelId),
    switchModel,
    setThinkingLevel: (level) => pi.setThinkingLevel(level),
    status: (text) => renderStatus(ctx, text),
    notify: (text, level) => notify(ctx, text, level),
    showDeciding: (deciderModel) => showDeciding(ctx, deciderModel),
    hideDeciding: () => hideDeciding(ctx),
  };
}

function isLayaEntry(entry: SessionEntry): boolean {
  return entry.type === "custom" && (entry as { customType?: string }).customType === "laya-decision";
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

export interface ExtensionOptions {
  /** Builds the decider from the loaded config. Defaults to the local Laya worker. */
  createDecider?: (config: RouterConfig) => Decider;
}

const defaultDecider = (config: RouterConfig): Decider =>
  new LayaWorker({ timeoutMs: config.thresholds.layaTimeoutMs });

/** Build the extension; tests inject their own decider. */
export function createExtension(options: ExtensionOptions = {}): (pi: ExtensionAPI) => void {
  const createDecider = options.createDecider ?? defaultDecider;

  return (pi) => {
    let mode: RouterMode = "shadow";
    let manualPin = false;
    let promptsSinceSwitch: number | undefined;

    // A small synchronous file read; the decider only starts work later.
    const { config, source: configSource, errors: configErrors } = loadConfig();

    const decider = createDecider(config);

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

    // --- Decision cards ---------------------------------------------------

    pi.registerEntryRenderer<RouterLogEntry>("laya-decision", renderDecisionCard);

    // Routing runs in before_agent_start, before Pi posts the user message.
    // The entry is held until that message is in so its card renders below
    // the prompt it describes, not above it.
    let pendingEntry: RouterLogEntry | undefined;
    const flushPendingEntry = () => {
      if (!pendingEntry) return;
      pi.appendEntry("laya-decision", pendingEntry);
      pendingEntry = undefined;
    };

    // --- Session lifecycle ------------------------------------------------

    // Warming up can take a while (the first run downloads the model), so it
    // runs in the background: neither session start nor a prompt waits for it.
    let sessionActive = false;
    let warming: Promise<void> | undefined;
    const warmUp = (ctx: ExtensionContext) => {
      if (warming) return;
      warming = decider
        .warmup()
        .then(
          () => {
            if (sessionActive) renderStatus(ctx, `laya ${mode} · ${decider.model ?? "unknown model"}`);
          },
          (err) => {
            const msg = err instanceof Error ? err.message : String(err);
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
      decider.stop();
    });

    // --- Routing hook -----------------------------------------------------

    pi.on("before_agent_start", async (event, ctx) => {
      flushPendingEntry();
      if (mode === "off") return;
      if (manualPin) {
        renderStatus(ctx, "laya ⏸ pinned");
        return;
      }
      // Fail open while the decider loads (or reloads after a crash): route
      // nothing rather than hold the prompt.
      if (!decider.isReady) {
        renderStatus(ctx, "laya ⏳ model loading — prompt not routed");
        warmUp(ctx);
        return;
      }

      if (promptsSinceSwitch !== undefined) promptsSinceSwitch++;
      const { applied, entry } = await routePrompt(
        piHost(pi, ctx, switchModel),
        { decider, config, mode, promptsSinceSwitch },
        event.prompt,
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

    // --- Manual model selection guard -------------------------------------

    pi.on("model_select", async (event, ctx) => {
      if (event.source === "set" && !routerSwitching) {
        manualPin = true;
        renderStatus(ctx, "laya ⏸ pinned");
      }
    });

    // --- Commands ---------------------------------------------------------

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
          const lines = decider.recentLogs.slice(-LOG_WIDGET_LINES);
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
  };
}

export default createExtension();
