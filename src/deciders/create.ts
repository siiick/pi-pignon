/**
 * Build the decider described by the config.
 *
 * With no `deciders` section, pignon picks one: the experimental Laya worker
 * when it is installed, else Jev when its API key is set. laya-serve is never
 * picked here, since that would need a network probe at startup; `/pignon init`
 * probes for it and writes it into the config. When neither is possible it
 * returns an `UnavailableDecider` whose warmup error says what to install.
 */

import { type StoredKey, TYPESAFE_CREDENTIAL, credentialsPath, readStoredKey } from "../credentials.js";
import type { DeciderSpec, RouterConfig } from "../types.js";
import { DEFAULT_API_KEY_ENV, JevDecider } from "./jev.js";
import { LayaWorker, layaRuntimeStatus } from "./laya-local.js";
import { createLayaServeDecider } from "./laya-serve.js";
import { parseDecision } from "./parse.js";
import { StrategyDecider } from "./strategy.js";
import { type Decider, type DeciderResult, DeciderError } from "./types.js";

export interface CreatedDecider {
  decider: Decider;
  /** Things to tell the user once, at session start. */
  notes: string[];
}

export interface CreateDeciderDeps {
  env?: NodeJS.ProcessEnv;
  /** Whether the local worker can run here (tests replace the platform check). */
  layaStatus?: typeof layaRuntimeStatus;
  /** Reads a key saved by `/pignon login`. Defaults to the credentials file. */
  storedKey?: (name: string) => StoredKey;
}

export function createDecider(config: RouterConfig, deps: CreateDeciderDeps = {}): CreatedDecider {
  const env = deps.env ?? process.env;
  const storedKey = deps.storedKey ?? ((name: string) => readStoredKey(name, credentialsPath(env)));
  const notes: string[] = [];
  let specs = config.deciders;

  if (specs === null) {
    const laya = (deps.layaStatus ?? layaRuntimeStatus)(env);
    if (laya.ok) {
      specs = [{ type: "laya-local" }];
    } else if (env[DEFAULT_API_KEY_ENV]?.trim() || storedKey(TYPESAFE_CREDENTIAL).kind !== "missing") {
      specs = [{ type: "jev" }];
    } else {
      return {
        decider: new UnavailableDecider(
          `no decider configured: start laya-serve (see pignon's README) and run /pignon init, or run /pignon login (or set ${DEFAULT_API_KEY_ENV}) for Jev`,
        ),
        notes,
      };
    }
  }

  const deciders = specs.map((spec) => build(spec, config, env, storedKey));
  if (deciders.length === 1) return { decider: deciders[0]!, notes };
  return {
    decider: new StrategyDecider(deciders, config.strategy, (answers, latencyMs) => parseDecision(answers, latencyMs, config)),
    notes,
  };
}

function build(spec: DeciderSpec, config: RouterConfig, env: NodeJS.ProcessEnv, storedKey: (name: string) => StoredKey): Decider {
  switch (spec.type) {
    case "laya-serve":
      return createLayaServeDecider(spec, env);
    case "laya-local":
      return new LayaWorker({
        timeoutMs: spec.timeoutMs ?? config.thresholds.layaTimeoutMs,
        ...(spec.command ? { launchCommand: spec.command } : {}),
      });
    case "jev":
      return new JevDecider({
        env,
        // The stored key is TypeSafe's: only for TypeSafe's own endpoint and variable.
        ...(spec.apiKeyEnv === undefined && spec.baseURL === undefined
          ? { storedKey: () => storedKey(TYPESAFE_CREDENTIAL) }
          : {}),
        ...(spec.model !== undefined ? { model: spec.model } : {}),
        ...(spec.baseURL !== undefined ? { baseURL: spec.baseURL } : {}),
        ...(spec.apiKeyEnv !== undefined ? { apiKeyEnv: spec.apiKeyEnv } : {}),
        ...(spec.timeoutMs !== undefined ? { timeoutMs: spec.timeoutMs } : {}),
        ...(spec.maxRetries !== undefined ? { maxRetries: spec.maxRetries } : {}),
      });
  }
}

/** Stands in when no decider can run: never ready, and says why. */
export class UnavailableDecider implements Decider {
  readonly id = "none";
  readonly remote = false;
  readonly isReady = false;
  readonly model = undefined;
  readonly recentLogs: readonly string[];

  constructor(private readonly reason: string) {
    this.recentLogs = [reason];
  }

  async warmup(): Promise<void> {
    throw new DeciderError(this.reason);
  }

  async decide(): Promise<DeciderResult> {
    throw new DeciderError(this.reason);
  }

  stop(): void {}
}
