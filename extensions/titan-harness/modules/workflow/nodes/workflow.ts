/**
 * nodes/workflow.ts — `workflow: {name, fan_out?, isolation?}` nodes run another workflow
 * through deps.runWorkflow (the extension opens a child run with parentRunId and executes
 * it with the same runtime). Without fan_out the child gets this run's inputs and its
 * `returns` value is the node output. With `fan_out: {source, as, join}` the source
 * reference must resolve to an array: one child per item with `{…inputs, [as]: item}`,
 * run concurrently, joined by the trigger rule (default all_success) — the output is the
 * array of child returns (null where a child did not complete). `isolation: worktree` is
 * forwarded to the runtime through the input `__isolation` (P4 wires worktrees). A
 * runtime without deps.runWorkflow fails the node without retries.
 */
import type { NodeHandler, RunResult } from "../executor.ts";
import type { TriggerRule } from "../schema.ts";
import { resolveReference } from "../substitute.ts";

/** Fold child run statuses under a trigger rule. */
export function joinChildren(children: RunResult[], rule: TriggerRule = "all_success"): { ok: boolean; reason?: string } {
	const completed = children.filter((c) => c.status === "completed").length;
	const failed = children.filter((c) => c.status === "failed" || c.status === "cancelled").length;
	switch (rule) {
		case "all_done":
			return { ok: true };
		case "one_success":
			return completed > 0 ? { ok: true } : { ok: false, reason: "no child workflow completed" };
		case "none_failed_min_one_success":
			if (failed > 0) return { ok: false, reason: `${failed} child workflow${failed === 1 ? "" : "s"} failed` };
			return completed > 0 ? { ok: true } : { ok: false, reason: "no child workflow completed" };
		default:
			return failed === 0 && completed === children.length ? { ok: true } : { ok: false, reason: `${children.length - completed}/${children.length} child workflows did not complete` };
	}
}

export const runWorkflowNode: NodeHandler = async (ctx) => {
	const spec = (ctx.node as { workflow: { name: string; fan_out?: { source: string; as: string; join?: TriggerRule }; isolation?: "worktree" } }).workflow;
	const run = ctx.deps.runWorkflow;
	if (!run) return { status: "failed", output: undefined, error: `workflow ${spec.name}: this runtime cannot run child workflows (deps.runWorkflow is absent)`, retryable: false };
	const baseInputs: Record<string, unknown> = { ...ctx.inputs };
	if (spec.isolation) baseInputs.__isolation = spec.isolation;
	if (!spec.fan_out) {
		const child = await run(spec.name, baseInputs);
		const text = typeof child.returns === "string" ? child.returns : child.returns === undefined ? "" : `${JSON.stringify(child.returns, null, 2)}\n`;
		if (child.status === "completed") return { status: "success", output: child.returns, text, meta: { childRunId: child.runId } };
		return { status: "failed", output: undefined, text, error: `child workflow ${spec.name} ${child.status}${child.error ? `: ${child.error}` : ""}`, meta: { childRunId: child.runId } };
	}
	const source = resolveReference(spec.fan_out.source, ctx.substitution());
	if (!source.found || source.rest || !Array.isArray(source.value)) {
		return { status: "failed", output: undefined, error: `fan_out.source ${spec.fan_out.source} did not resolve to an array`, retryable: false };
	}
	const children = await Promise.all(source.value.map((item) => run(spec.name, { ...baseInputs, [spec.fan_out!.as]: item })));
	const joined = joinChildren(children, spec.fan_out.join);
	const output = children.map((c) => (c.status === "completed" ? (c.returns ?? null) : null));
	const text = `${JSON.stringify(output, null, 2)}\n`;
	const meta = { childRunIds: children.map((c) => c.runId), join: spec.fan_out.join ?? "all_success", fanOut: children.length };
	if (joined.ok) return { status: "success", output, text, meta };
	return { status: "failed", output: undefined, text, error: `fan-out of ${spec.name}: ${joined.reason}`, meta };
};
