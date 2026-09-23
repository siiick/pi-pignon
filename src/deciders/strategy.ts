/**
 * Several deciders behind one: the `strategy` setting.
 *
 * - sequential: ask them in order, moving on when one is not ready, fails,
 *   or answers with tier confidence below `escalateBelow`. Remote deciders
 *   are only called when needed.
 * - parallel: ask every ready decider at once, then route on one answer
 *   (`pick`). Every answer is recorded, which is how deciders are compared.
 *
 * Every attempt is returned in `DeciderResult.attempts`, so both modes log
 * the same data. A shared `budgetMs` bounds the wall time of one decision.
 */

import type { DeciderAttempt, RoutingDecision, StrategyConfig } from "../types.js";
import { type Decider, type DeciderResult, type DecisionRequest, type RawAnswers, DeciderError } from "./types.js";

/** Reads answers the way the router will (tier ids, confidence source). */
export type ParseAnswers = (answers: RawAnswers, latencyMs: number) => RoutingDecision;

interface Answered {
  index: number;
  result: DeciderResult;
  decision: RoutingDecision;
}

export class StrategyDecider implements Decider {
  readonly id: string;
  readonly remote: boolean;

  /** Warmups in flight, so a decider that is not ready is warmed once, not once per prompt. */
  private readonly warming = new Map<Decider, Promise<void>>();

  constructor(
    private readonly deciders: readonly Decider[],
    private readonly strategy: StrategyConfig,
    private readonly parse: ParseAnswers,
  ) {
    if (deciders.length < 2) throw new Error("StrategyDecider needs at least two deciders");
    this.id = `${strategy.mode}(${deciders.map((d) => d.id).join(",")})`;
    this.remote = deciders.some((d) => d.remote);
  }

  /** Ready when any decider can answer: the others are skipped. */
  get isReady(): boolean {
    return this.deciders.some((d) => d.isReady);
  }

  get model(): string | undefined {
    const models = this.deciders.map((d) => d.model ?? d.id);
    return models.join(this.strategy.mode === "sequential" ? " → " : " + ");
  }

  get recentLogs(): readonly string[] {
    return this.deciders.flatMap((d) => d.recentLogs.map((line) => `[${d.id}] ${line}`));
  }

  /**
   * Warm every decider up; resolves as soon as one is ready, so a fast
   * decider can route while a slow one (the local model) keeps loading.
   */
  async warmup(signal?: AbortSignal): Promise<void> {
    const pending = this.deciders.filter((d) => !d.isReady).map((d) => this.warm(d, signal));
    if (pending.length === this.deciders.length) {
      try {
        await Promise.any(pending);
      } catch (err) {
        const reasons = err instanceof AggregateError ? err.errors : [err];
        throw new DeciderError(reasons.map((e) => (e instanceof Error ? e.message : String(e))).join("; "), err);
      }
    } else {
      // Something is ready already; keep loading the rest in the background.
      for (const p of pending) p.catch(() => {});
    }
  }

  async decide(request: DecisionRequest, signal?: AbortSignal): Promise<DeciderResult> {
    // The router only warms us up while nothing is ready; bring back a
    // decider that is still loading or crashed without holding this prompt.
    for (const d of this.deciders) if (!d.isReady) this.warm(d).catch(() => {});

    const started = Date.now();
    const budget = AbortSignal.timeout(this.strategy.budgetMs);
    const bounded = signal ? AbortSignal.any([signal, budget]) : budget;
    const attempts: DeciderAttempt[] = this.deciders.map((d) => ({
      decider: d.id,
      remote: d.remote,
      outcome: d.isReady ? "not-asked" : "not-ready",
      used: false,
    }));

    const answered =
      this.strategy.mode === "sequential"
        ? await this.sequential(request, bounded, budget, attempts)
        : await this.parallel(request, bounded, budget, attempts);

    const chosen = this.choose(answered);
    if (!chosen) {
      const reasons = attempts.map((a) => `${a.decider}: ${a.error ?? a.outcome}`).join("; ");
      throw new DeciderError(`no decider answered (${reasons})`);
    }
    attempts[chosen.index]!.used = true;
    return {
      ...chosen.result,
      // What the user waited for, not only the chosen decider's share.
      latencyMs: Date.now() - started,
      remote: attempts.some((a) => a.remote && (a.outcome === "answered" || a.outcome === "failed")),
      attempts,
      ...(sumCost(attempts) !== undefined ? { costUsd: sumCost(attempts) } : {}),
    };
  }

  stop(): void {
    for (const d of this.deciders) d.stop();
  }

  // -------------------------------------------------------------------------

  private warm(decider: Decider, signal?: AbortSignal): Promise<void> {
    let pending = this.warming.get(decider);
    if (!pending) {
      pending = decider.warmup(signal).finally(() => this.warming.delete(decider));
      this.warming.set(decider, pending);
    }
    return pending;
  }

  private async sequential(
    request: DecisionRequest,
    signal: AbortSignal,
    budget: AbortSignal,
    attempts: DeciderAttempt[],
  ): Promise<Answered[]> {
    const answered: Answered[] = [];
    for (const [index, decider] of this.deciders.entries()) {
      if (signal.aborted) break;
      if (!decider.isReady) continue;
      const answer = await this.attempt(index, decider, request, signal, budget, attempts);
      if (!answer) continue;
      answered.push(answer);
      if (answer.decision.tier !== null && answer.decision.tierConfidence >= this.strategy.escalateBelow) break;
    }
    return answered;
  }

  private async parallel(
    request: DecisionRequest,
    signal: AbortSignal,
    budget: AbortSignal,
    attempts: DeciderAttempt[],
  ): Promise<Answered[]> {
    const results = await Promise.all(
      this.deciders.map((decider, index) =>
        decider.isReady ? this.attempt(index, decider, request, signal, budget, attempts) : Promise.resolve(null),
      ),
    );
    return results.filter((r): r is Answered => r !== null);
  }

  /** Call one decider and record the outcome. Never throws. */
  private async attempt(
    index: number,
    decider: Decider,
    request: DecisionRequest,
    signal: AbortSignal,
    budget: AbortSignal,
    attempts: DeciderAttempt[],
  ): Promise<Answered | null> {
    const started = Date.now();
    try {
      const result = await decider.decide(request, signal);
      const decision = this.parse(result.answers, result.latencyMs);
      attempts[index] = {
        decider: decider.id,
        remote: decider.remote,
        outcome: "answered",
        used: false,
        model: result.model,
        tier: decision.tier,
        tierConfidence: decision.tierConfidence,
        needsExploration: decision.needsExploration,
        explorationConfidence: decision.explorationConfidence,
        latencyMs: result.latencyMs,
        ...(result.costUsd !== undefined ? { costUsd: result.costUsd } : {}),
      };
      return { index, result, decision };
    } catch (err) {
      const error = budget.aborted
        ? `over the ${this.strategy.budgetMs} ms budget`
        : err instanceof Error
          ? err.message
          : String(err);
      attempts[index] = {
        decider: decider.id,
        remote: decider.remote,
        outcome: "failed",
        used: false,
        latencyMs: Date.now() - started,
        error,
      };
      return null;
    }
  }

  /** The answer to route on. Answers without a usable tier only win when nothing else answered. */
  private choose(answered: Answered[]): Answered | undefined {
    const usable = answered.filter((a) => a.decision.tier !== null);
    const pool = usable.length > 0 ? usable : answered;
    if (pool.length === 0) return undefined;
    // "first" (parallel): list order decides. Sequential keeps the most
    // confident answer, since a later decider may be less sure than an
    // earlier one it was asked to double-check.
    if (this.strategy.mode === "parallel" && this.strategy.pick === "first") return pool[0];
    return pool.reduce((best, a) => (a.decision.tierConfidence > best.decision.tierConfidence ? a : best));
  }
}

function sumCost(attempts: DeciderAttempt[]): number | undefined {
  const costs = attempts.map((a) => a.costUsd).filter((c): c is number => c !== undefined);
  return costs.length > 0 ? costs.reduce((a, b) => a + b, 0) : undefined;
}
