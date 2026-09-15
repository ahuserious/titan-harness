/**
 * nodes/cancel.ts — `cancel:` nodes end the run "cancelled" with the (substituted)
 * reason as the node's output and the run's error. Typically the target of an
 * `all_done` / `when` route; between P4 and P7 it is also the hand-off that carries the
 * escalation report path when a run must be re-authored (plan D11).
 */
import type { NodeHandler } from "../executor.ts";

export const runCancelNode: NodeHandler = async (ctx) => {
	const reason = ctx.subst((ctx.node as { cancel: string }).cancel, "prompt").trim() || `cancelled by ${ctx.node.id}`;
	return { status: "cancelled", output: reason, text: reason, error: reason, cancelRun: reason };
};
