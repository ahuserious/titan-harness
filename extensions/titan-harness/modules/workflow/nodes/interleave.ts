/**
 * nodes/interleave.ts — `interleave: {segments, by, synthesize, reauthor, prompt}` nodes
 * (P4 stub).
 *
 * P3 ships the node type so workflows validate and schedule; every run ends "failed" with
 * "not implemented until P4" and is never retried. P4 fills in the pattern: the work is
 * split into `segments` (a count or named list) by files | sections | hypotheses, each
 * segment runs in its own fresh session with no cross-contamination (acceptance A10:
 * 4 segments ⇒ 4 sessions + 1 synthesis), an optional synthesis turn merges the segment
 * artifacts, and `reauthor` hands a failed synthesis back to the architect (plan D11).
 */
import type { NodeHandler } from "../executor.ts";

export const NOT_IMPLEMENTED = "not implemented until P4";

export const runInterleaveNode: NodeHandler = async () => ({ status: "failed", output: undefined, error: `interleave: ${NOT_IMPLEMENTED}`, retryable: false });
