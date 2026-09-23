/**
 * pignon — Pi agent extension.
 *
 * Shifts to the right model for each prompt by asking a decider (today: the
 * local Laya System-1 model, via a stdio worker it spawns and supervises) how
 * hard the prompt is, then looking the answer up in the routing table.
 *
 *   /pignon                -> show current mode
 *   /pignon live           -> apply decisions
 *   /pignon shadow         -> observe only (default)
 *   /pignon off            -> stop calling the decider
 *   /pignon unpin          -> re-enable routing after manual model selection
 *   /pignon log [clear]    -> recent decider diagnostics
 *   /pignon config [clear] -> routing table and settings in use
 *   /pignon config migrate -> convert a laya-router config file
 *   /pignon-stats [clear]  -> session statistics
 *
 * `/laya` and `/laya-stats` remain as aliases for one release.
 *
 * This module only wires Pi to the router; the routing itself is in
 * `router.ts`, the policy in `policy.ts`, and the deciders in `deciders/`.
 */

import type {
  ExtensionAPI,
  ExtensionContext,
  SessionEntry,
} from "@earendil-works/pi-coding-agent";

import { describeConfig } from "./config/describe.js";
import { loadConfig } from "./config/load.js";
import { migrateConfigFile } from "./config/migrate.js";
import { LayaWorker } from "./deciders/laya-local.js";
import type { Decider } from "./deciders/types.js";
import { type RouterHost, routePrompt } from "./router.js";
import { buildStatsLines } from "./stats.js";
import type { RouterConfig, RouterLogEntry, RouterMode } from "./types.js";
import { hideDeciding, renderDecisionCard, showDeciding } from "./ui.js";

/** Decider log lines shown by `/pignon log`. */
const LOG_WIDGET_LINES = 30;

/** Custom entry type of decision cards. */
const ENTRY_TYPE = "pignon-decision";
/** Entry type written by laya-router; still rendered and counted. */
const LEGACY_ENTRY_TYPE = "laya-decision";

const SUBCOMMANDS = ["shadow", "live", "off", "unpin", "log", "log clear", "config", "config clear", "config migrate"];

type PiModel = Parameters<ExtensionAPI["setModel"]>[0];

// ---------------------------------------------------------------------------
// UI helpers (no-ops without a UI, e.g. print or RPC mode)
// ---------------------------------------------------------------------------

function renderStatus(ctx: ExtensionContext, text: string): void {
  if (ctx.hasUI) ctx.ui.setStatus("pignon", text);
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

function isDecisionEntry(entry: SessionEntry): boolean {
  if (entry.type !== "custom") return false;
  const type = (entry as { customType?: string }).customType;
  return type === ENTRY_TYPE || type === LEGACY_ENTRY_TYPE;
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
    const loaded = loadConfig();
    const { config } = loaded;

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

    pi.registerEntryRenderer<RouterLogEntry>(ENTRY_TYPE, renderDecisionCard);
    pi.registerEntryRenderer<RouterLogEntry>(LEGACY_ENTRY_TYPE, renderDecisionCard);

    // Routing runs in before_agent_start, before Pi posts the user message.
    // The entry is held until that message is in so its card renders below
    // the prompt it describes, not above it.
    let pendingEntry: RouterLogEntry | undefined;
    const flushPendingEntry = () => {
      if (!pendingEntry) return;
      pi.appendEntry(ENTRY_TYPE, pendingEntry);
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
            if (sessionActive) renderStatus(ctx, `pignon ${mode} · ${decider.model ?? "unknown model"}`);
          },
          (err) => {
            const msg = err instanceof Error ? err.message : String(err);
            if (sessionActive) renderStatus(ctx, `pignon ${mode} · ⚠ ${msg.slice(0, 60)} (/pignon log)`);
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
      if (loaded.errors.length > 0) {
        notify(ctx, `pignon: config problems, using defaults for:\n${loaded.errors.join("\n")}`, "warning");
      }
      if (loaded.warnings.length > 0) notify(ctx, `pignon: ${loaded.warnings.join("\n")}`, "warning");
      renderStatus(ctx, `pignon ${mode} · loading model`);
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
        renderStatus(ctx, "pignon ⏸ pinned");
        return;
      }
      // Fail open while the decider loads (or reloads after a crash): route
      // nothing rather than hold the prompt.
      if (!decider.isReady) {
        renderStatus(ctx, "pignon ⏳ model loading — prompt not routed");
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
        renderStatus(ctx, "pignon ⏸ pinned");
      }
    });

    // --- Commands ---------------------------------------------------------

    const modeCommand = async (args: string, ctx: ExtensionContext) => {
      const arg = args.trim();
      if (arg === "log clear") {
        showWidget(ctx, "pignon-log", undefined);
        return;
      }
      if (arg === "log") {
        const lines = decider.recentLogs.slice(-LOG_WIDGET_LINES);
        if (lines.length === 0) {
          notify(ctx, "pignon: no decider output yet");
          return;
        }
        showWidget(ctx, "pignon-log", [...lines, "(/pignon log clear to hide)"]);
        return;
      }
      if (arg === "config clear") {
        showWidget(ctx, "pignon-config", undefined);
        return;
      }
      if (arg === "config") {
        showWidget(ctx, "pignon-config", describeConfig(config, loaded.source));
        return;
      }
      if (arg === "config migrate") {
        if (!loaded.legacy) {
          notify(ctx, "pignon: config is already in the pignon format");
          return;
        }
        const result = migrateConfigFile();
        if (!result.ok) {
          notify(ctx, `pignon: ${result.message}`, "error");
          return;
        }
        const backup = result.backup ? ` (previous file kept as ${result.backup})` : "";
        notify(ctx, `pignon: wrote ${result.to} from ${result.from}${backup}; /reload to use it`);
        return;
      }
      if (arg === "unpin") {
        manualPin = false;
        notify(ctx, "pignon: routing re-enabled");
        renderStatus(ctx, `pignon ${mode}`);
        return;
      }
      if (arg === "shadow" || arg === "live" || arg === "off") {
        mode = arg;
        manualPin = false;
        notify(ctx, `pignon: mode ${mode}`);
        renderStatus(ctx, `pignon ${mode}`);
        return;
      }
      const pinned = manualPin ? " (model pinned manually)" : "";
      const configNote = loaded.source ? ` · config ${loaded.source}` : "";
      notify(ctx, `pignon: mode ${mode}${pinned}${configNote}`);
    };

    const statsCommand = async (args: string, ctx: ExtensionContext) => {
      if (args.trim() === "clear") {
        showWidget(ctx, "pignon-stats", undefined);
        return;
      }

      const rows = ctx.sessionManager
        .getEntries()
        .filter(isDecisionEntry)
        .map((e) => (e as { data?: RouterLogEntry }).data)
        .filter((d): d is RouterLogEntry => d !== undefined);

      if (rows.length === 0) {
        notify(ctx, "pignon: no decisions in this session");
        return;
      }

      showWidget(ctx, "pignon-stats", buildStatsLines(rows, config.table));
    };

    const completions = (prefix: string) =>
      SUBCOMMANDS.filter((v) => v.startsWith(prefix)).map((v) => ({ value: v, label: v }));

    pi.registerCommand("pignon", {
      description: "pignon mode (shadow | live | off | unpin | log | config)",
      getArgumentCompletions: completions,
      handler: modeCommand,
    });
    pi.registerCommand("pignon-stats", {
      description: "Tier x form x confidence breakdown for this session",
      handler: statsCommand,
    });
    pi.registerCommand("laya", {
      description: "Alias of /pignon (deprecated)",
      getArgumentCompletions: completions,
      handler: modeCommand,
    });
    pi.registerCommand("laya-stats", {
      description: "Alias of /pignon-stats (deprecated)",
      handler: statsCommand,
    });
  };
}

export default createExtension();
