/**
 * `laya-serve` decider: a Laya model served by the official `laya-serve`
 * (`pip install "laya[serve]"`), which speaks TypeSafe's Jev API on
 * `POST /v1/systemone`. It reuses the Jev client, pointed at the server.
 *
 * The user runs the server; pignon only connects. While it is down or still
 * loading, connections are refused within milliseconds, so a prompt is never
 * held: the decision fails and the prompt keeps the current model.
 */

import type { LayaServeDeciderSpec } from "../types.js";
import type { Fetch } from "@typesafe-ai/sdk";

import { JevDecider } from "./jev.js";

/** laya-serve's default port, on the loopback interface. */
export const LAYA_SERVE_DEFAULT_URL = "http://127.0.0.1:8000";

export function createLayaServeDecider(
  spec: Omit<LayaServeDeciderSpec, "type">,
  env: NodeJS.ProcessEnv = process.env,
  fetch?: Fetch,
): JevDecider {
  const url = spec.url ?? LAYA_SERVE_DEFAULT_URL;
  return new JevDecider({
    id: "laya-serve",
    baseURL: url,
    requireApiKey: false,
    unreachableHint: `is laya-serve running at ${url}?`,
    // Only the server's own key: never TYPESAFE_API_KEY or other TYPESAFE_* settings.
    env: spec.apiKeyEnv ? { [spec.apiKeyEnv]: env[spec.apiKeyEnv] } : {},
    ...(spec.apiKeyEnv ? { apiKeyEnv: spec.apiKeyEnv } : {}),
    ...(spec.model !== undefined ? { model: spec.model } : {}),
    ...(spec.timeoutMs !== undefined ? { timeoutMs: spec.timeoutMs } : {}),
    ...(fetch ? { fetch } : {}),
  });
}

/** Whether a laya-serve answers at `url` (GET /health), within `timeoutMs`. */
export async function probeLayaServe(
  url: string = LAYA_SERVE_DEFAULT_URL,
  timeoutMs = 500,
  fetchFn: typeof fetch = fetch,
): Promise<boolean> {
  try {
    const response = await fetchFn(`${url.replace(/\/+$/, "")}/health`, { signal: AbortSignal.timeout(timeoutMs) });
    if (!response.ok) return false;
    const body = (await response.json()) as { status?: unknown };
    return body.status === "ok";
  } catch {
    return false;
  }
}
