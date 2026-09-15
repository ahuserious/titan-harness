/**
 * nodes/hypothesis.ts — `hypothesis: {hypotheses[], decide_by}` nodes (P4 stub).
 *
 * P3 ships the node type so workflows validate and schedule; every run ends "failed" with
 * "not implemented until P4" and is never retried. P4 fills in the pattern: each
 * hypothesis {id, claim, predicts} is tested in its own session, the predictions are
 * checked against observed evidence links (never chat claims), `decide_by` names the
 * evidence or verdict that settles the question (acceptance A11: decide_by resolves from
 * evidence links), results land in hypotheses.jsonl (plan §6.2) and the winning
 * hypothesis id is the node output.
 */
import type { NodeHandler } from "../executor.ts";

export const NOT_IMPLEMENTED = "not implemented until P4";

export const runHypothesisNode: NodeHandler = async () => ({ status: "failed", output: undefined, error: `hypothesis: ${NOT_IMPLEMENTED}`, retryable: false });
