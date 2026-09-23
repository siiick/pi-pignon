/**
 * Build the decider described by the config.
 *
 * With no `deciders` section, pignon picks one: the local Laya worker when it
 * can run here, else Jev when its API key is set. When neither is possible it
 * returns an `UnavailableDecider` whose warmup error says what to install.
 */

import type { DeciderSpec, RouterConfig } from "../types.js";
import { DEFAULT_API_KEY_ENV, JevDecider } from "./jev.js";
import { LayaWorker, layaRuntimeStatus } from "./laya-local.js";
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
}

export function createDecider(config: RouterConfig, deps: CreateDeciderDeps = {}): CreatedDecider {
  const env = deps.env ?? process.env;
  const notes: string[] = [];
  let specs = config.deciders;

  if (specs === null) {
    const laya = (deps.layaStatus ?? layaRuntimeStatus)(env);
    if (laya.ok) {
      specs = [{ type: "laya-local" }];
    } else if (env[DEFAULT_API_KEY_ENV]?.trim()) {
      specs = [{ type: "jev" }];
    } else {
      return {
        decider: new UnavailableDecider(`no decider available: ${laya.reason}, and ${DEFAULT_API_KEY_ENV} is not set for Jev`),
        notes,
      };
    }
  }

  if (specs.length > 1) {
    notes.push(`only the first decider (${specs[0]!.type}) is used for now; the others are ignored`);
  }
  return { decider: build(specs[0]!, config, env), notes };
}

function build(spec: DeciderSpec, config: RouterConfig, env: NodeJS.ProcessEnv): Decider {
  switch (spec.type) {
    case "laya-local":
      return new LayaWorker({ timeoutMs: spec.timeoutMs ?? config.thresholds.layaTimeoutMs });
    case "jev":
      return new JevDecider({
        env,
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
