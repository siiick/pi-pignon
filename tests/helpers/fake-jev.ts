/**
 * A fake Jev API behind the SDK's injectable `fetch`: no network in tests.
 */

import { vi } from "vitest";

import { hardAnswers } from "./fake-worker.js";

export interface JevCall {
  url: string;
  headers: Record<string, string>;
  body: Record<string, unknown>;
}

export type JevBehavior =
  | { kind: "answer"; answers?: unknown; model?: string; usage?: unknown }
  | { kind: "status"; status: number; body?: unknown; headers?: Record<string, string> }
  | { kind: "hang" };

/** A fetch that records each call and replies as told (the last behavior repeats). */
export function fakeJevFetch(...behaviors: JevBehavior[]) {
  const calls: JevCall[] = [];
  const fetch = vi.fn(async (input: string, init?: RequestInit): Promise<Response> => {
    calls.push({
      url: input,
      headers: Object.fromEntries(new Headers(init?.headers).entries()),
      body: JSON.parse(String(init?.body ?? "{}")),
    });
    const behavior = behaviors[Math.min(calls.length - 1, behaviors.length - 1)] ?? { kind: "answer" };
    switch (behavior.kind) {
      case "answer":
        return Response.json({
          model: behavior.model ?? "jev-1.13.0",
          answers: behavior.answers ?? stripTypes(hardAnswers),
          usage: behavior.usage ?? { input_tokens: 275, output_tokens: 20, cost: 0.00003 },
        });
      case "status":
        return Response.json(behavior.body ?? { error: "boom" }, { status: behavior.status, headers: behavior.headers });
      case "hang":
        return new Promise<Response>((_resolve, reject) => {
          const signal = init?.signal;
          signal?.addEventListener("abort", () => reject(signal.reason ?? new Error("aborted")), { once: true });
        });
    }
  });
  return { fetch, calls };
}

/** Jev answers carry no `type` tag, unlike the local worker's. */
function stripTypes(answers: Record<string, Record<string, unknown>>): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(answers).map(([name, { type: _type, ...rest }]) => [name, rest]),
  );
}
