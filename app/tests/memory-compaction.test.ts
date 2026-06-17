/**
 * Memory compaction — the injected memory block is kept lean while stored turns
 * stay full. Tests the pure helpers: extractSummary (reuse the agent's recap as
 * the mid-tier summary, #4) and compactReply (strip markers + truncate artifacts
 * for the verbatim recent-turn block, #1).
 */

import { describe, it, expect } from "vitest";
import { extractSummary, compactReply } from "@/lib/persona-memory";

describe("extractSummary", () => {
  it("pulls the [[SUMMARY]] recap content", () => {
    const reply = "Did the work in detail.\n\n[[SUMMARY]]\nI added the gate and tests.\n[[/SUMMARY]]\n[[NEXT label=\"x\" | prompt=\"y\"]]";
    expect(extractSummary(reply)).toBe("I added the gate and tests.");
  });

  it("supports the legacy [[SPEAK]] alias", () => {
    expect(extractSummary("[[SPEAK]]\nshort recap\n[[/SPEAK]]")).toBe("short recap");
  });

  it("returns empty string when there's no recap block", () => {
    expect(extractSummary("Just a plain reply with no markers.")).toBe("");
  });
});

describe("compactReply", () => {
  it("drops the recap block and UI markers", () => {
    const reply = 'Here is the detailed answer about the auth flow and how it works across modules.\n\n[[SUMMARY]]\nspoken recap\n[[/SUMMARY]]\n[[NEXT label="Do X" | prompt="run x"]]\n[[FLOW goal="z"]]';
    const out = compactReply(reply);
    expect(out).not.toMatch(/\[\[/);                 // no markers survive
    expect(out).not.toContain("spoken recap");       // recap block removed
    expect(out).toContain("auth flow");              // real prose kept
  });

  it("truncates large fenced code blocks to a reference", () => {
    const big = "```ts\n" + "const x = 1;\n".repeat(80) + "```";
    const reply = `Implemented it across the module with care here.\n\n${big}`;
    const out = compactReply(reply);
    expect(out).toContain("[code omitted from memory");
    expect(out.length).toBeLessThan(big.length);
  });

  it("keeps small code blocks intact", () => {
    const reply = "See `foo()` below as a quick illustration of the idea here.\n\n```\nfoo()\n```";
    expect(compactReply(reply)).toContain("foo()");
  });

  it("caps very long replies", () => {
    const reply = "x".repeat(5000);
    const out = compactReply(reply);
    expect(out.length).toBeLessThanOrEqual(1600 + 40);
    expect(out).toMatch(/trimmed for memory/);
  });

  it("falls back to the recap when the detail is essentially empty (voice-first concise turn)", () => {
    const reply = "[[SUMMARY]]\nAll done — shipped the fix.\n[[/SUMMARY]]\n[[NEXT label=\"More details\" | prompt=\"...\"]]";
    expect(compactReply(reply)).toBe("All done — shipped the fix.");
  });

  it("leaves a normal prose reply (minus markers) intact and uncapped", () => {
    const reply = "The unit test checks one function in isolation; the integration test checks the seam.";
    expect(compactReply(reply)).toBe(reply);
  });

  it("keeps prose after a marker whose prompt contains a literal ] (regression)", () => {
    // A [[NEXT]] prompt is free text and routinely contains ] (arr[0], [x](y), [ ]).
    const reply = 'Important context the model must keep about the rollback plan.\n\n[[NEXT label="Fix" | prompt="check arr[0] and items[2]"]]\nMore real prose after the marker that must survive.';
    const out = compactReply(reply);
    expect(out).toContain("rollback plan");
    expect(out).toContain("must survive");          // trailing prose not eaten
    expect(out).not.toMatch(/\[\[NEXT/);             // marker still removed
  });
});
