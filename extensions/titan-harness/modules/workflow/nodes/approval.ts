/**
 * nodes/approval.ts — `approval:` nodes: the run pauses on deps.approval (TUI confirm or
 * input; headless runtimes answer approved:false). Approved → success, with the reply as
 * the output when capture_response is set (else ""). Rejected → with `on_reject`, the
 * rework prompt runs as an AI turn of this node ($REJECTION_REASON = the reply, each
 * rework resuming the previous rework's session) and the gate is asked again, at most
 * on_reject.max_attempts (1–10, default 3) reworks; then, or without `on_reject`, the
 * node ends "cancelled" and so does the run. Approval nodes are never retried by the
 * executor. A `preset_key` (content presets, P4) is recorded in the artifact meta only.
 */
import type { AgentResult, NodeHandler } from "../executor.ts";
import type { ApprovalSpec } from "../schema.ts";
import { type AgentCallResult, callAgent } from "./ai.ts";

export const DEFAULT_REJECT_ATTEMPTS = 3;

export const runApprovalNode: NodeHandler = async (ctx) => {
	const spec = (ctx.node as { approval: ApprovalSpec }).approval;
	const max = spec.on_reject ? Math.min(10, Math.max(1, Math.floor(spec.on_reject.max_attempts ?? DEFAULT_REJECT_ATTEMPTS))) : 0;
	const usage: AgentResult["usage"] = { tokensIn: 0, tokensOut: 0, costUsd: 0, tpsSeconds: 0 };
	let reworks = 0;
	let lastRework: AgentCallResult | undefined;
	for (;;) {
		const message = ctx.subst(spec.message, "prompt");
		const gate = await ctx.deps.approval(message, { captureResponse: Boolean(spec.capture_response || spec.on_reject) });
		if (gate.approved) {
			return {
				status: "success",
				output: spec.capture_response ? (gate.response ?? "") : "",
				text: lastRework?.text,
				usage,
				sessionRef: lastRework?.sessionRef,
				meta: { reworks, presetKey: spec.preset_key, response: spec.capture_response ? gate.response : undefined },
			};
		}
		const reason = gate.response?.trim() || "rejected";
		if (!spec.on_reject || reworks >= max) {
			const error = spec.on_reject ? `approval rejected after ${reworks}/${max} rework attempts: ${reason}` : `approval rejected: ${reason}`;
			return { status: "cancelled", output: gate.response ?? "", text: lastRework?.text, error, cancelRun: `${ctx.node.id}: ${error}`, usage, sessionRef: lastRework?.sessionRef, meta: { reworks } };
		}
		reworks++;
		ctx.notify(`${ctx.node.id}: rejected (${reason}) — rework ${reworks}/${max}`, "warning");
		const prompt = ctx.subst(spec.on_reject.prompt, "prompt", { rejectionReason: reason });
		const call = await callAgent(ctx, prompt, { resume: lastRework?.sessionRef, label: `${ctx.deps.workflowId}/${ctx.node.id} rework ${reworks}/${max}` });
		usage.tokensIn += call.usage.tokensIn;
		usage.tokensOut += call.usage.tokensOut;
		usage.costUsd += call.usage.costUsd;
		usage.tpsSeconds += call.usage.tpsSeconds;
		lastRework = call;
		if (!call.ok) {
			return { status: "failed", output: undefined, text: call.text, error: `on_reject rework ${reworks} failed: ${call.error ?? "agent failed"}`, usage, sessionRef: call.sessionRef, retryable: false, meta: { reworks } };
		}
	}
};
