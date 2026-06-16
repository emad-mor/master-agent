/**
 * Memory ingestion gate — unit tests for the pure predicate that decides
 * whether a finished flow is substantial enough to write to memory.
 *
 * Gate (env-tunable; defaults): write only if
 *   successfulSteps >= 2  AND  (totalCostUsd >= 0.02  OR  totalTokens >= 8000)
 *
 * costUsd is a notional CLI estimate that is frequently undefined on a
 * subscription, which is why the token floor is an OR-fallback, never an AND.
 */

import { describe, it, expect } from "vitest";
import { shouldMemorizeFlow, normalizeForDedup } from "@/lib/orchestrator";

type T = Parameters<typeof shouldMemorizeFlow>[0][number];
const tok = (input: number, output: number) => ({ input, output, cacheRead: 0, cacheWrite: 0 });
const step = (over: Partial<T> = {}): T => ({ status: "done", ...over });

describe("shouldMemorizeFlow", () => {
  it("gates a trivial one-shot flow (1 done step, no cost/tokens)", () => {
    const g = shouldMemorizeFlow([step({ costUsd: 0, tokens: tok(0, 0) })]);
    expect(g.ok).toBe(false);
    expect(g.successCount).toBe(1);
  });

  it("memorizes a 2-step flow that clears the token floor even with zero cost", () => {
    // costUsd undefined (typical on a subscription) but real token usage → memorize.
    const g = shouldMemorizeFlow([
      step({ tokens: tok(6000, 5000) }),
      step({ tokens: tok(0, 0) }),
    ]);
    expect(g.ok).toBe(true);
    expect(g.totalCostUsd).toBe(0);
    expect(g.totalTokens).toBe(11000);
  });

  it("memorizes a 2-step flow that clears the cost floor", () => {
    const g = shouldMemorizeFlow([
      step({ costUsd: 0.025 }),
      step({ costUsd: 0.01 }),
    ]);
    expect(g.ok).toBe(true);
    expect(g.totalCostUsd).toBeCloseTo(0.035);
  });

  it("gates a 2-step flow that clears NEITHER floor (undefined cost + tiny tokens)", () => {
    const g = shouldMemorizeFlow([
      step({ tokens: tok(100, 100) }),
      step({ tokens: tok(50, 50) }),
    ]);
    expect(g.ok).toBe(false);
    expect(g.totalTokens).toBe(300);
  });

  it("counts only `done` steps toward the step floor (1 done + 1 error → gated)", () => {
    const g = shouldMemorizeFlow([
      step({ status: "done", costUsd: 5 }),
      step({ status: "error", costUsd: 5 }),
    ]);
    expect(g.successCount).toBe(1);
    expect(g.ok).toBe(false);            // only 1 successful step, below MIN_STEPS=2
    expect(g.totalCostUsd).toBe(5);      // error step's cost excluded
  });

  it("treats missing costUsd and tokens as zero (no NaN)", () => {
    const g = shouldMemorizeFlow([step(), step()]);
    expect(g.totalCostUsd).toBe(0);
    expect(g.totalTokens).toBe(0);
    expect(g.ok).toBe(false);
  });
});

describe("normalizeForDedup", () => {
  it("lowercases, strips punctuation, collapses whitespace", () => {
    expect(normalizeForDedup("The  Auth Flow: uses JWTs!")).toBe("the auth flow uses jwts");
  });

  it("makes re-runs of the same distillation compare equal", () => {
    const a = "Researched the auth flow — it uses JWTs in cookies.";
    const b = "Researched the auth flow  it uses JWTs in cookies";
    expect(normalizeForDedup(a)).toBe(normalizeForDedup(b));
  });

  it("keeps genuinely different distillations distinct", () => {
    expect(normalizeForDedup("Researched auth")).not.toBe(normalizeForDedup("Researched billing"));
  });
});
