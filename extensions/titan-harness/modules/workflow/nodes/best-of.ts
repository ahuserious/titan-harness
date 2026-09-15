/**
 * nodes/best-of.ts — `best_of: {n, judge, criteria, prompt}` nodes (P4 stub).
 *
 * P3 ships the node type so workflows validate and schedule; every run ends "failed" with
 * "not implemented until P4" and is never retried. P4 fills in the pattern: n (2–8)
 * candidates of the prompt in fresh, mutually anonymous sessions (callsigns, never model
 * names), a judge turn on the `judge` slot scoring them against `criteria` with a
 * structured verdict, the winner's text as the node output, all-fail delivering nothing
 * (acceptance A4), one ledger row per candidate plus the judge's `origin: judge` row.
 */
import type { NodeHandler } from "../executor.ts";

export const NOT_IMPLEMENTED = "not implemented until P4";

export const runBestOfNode: NodeHandler = async () => ({ status: "failed", output: undefined, error: `best_of: ${NOT_IMPLEMENTED}`, retryable: false });
