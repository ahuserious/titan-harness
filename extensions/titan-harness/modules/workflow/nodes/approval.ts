/**
 * nodes/approval.ts — `approval:` nodes: the run pauses on deps.approval (TUI confirm or
 * input; headless runtimes answer approved:false). Approved → success, with the reply as
 * the output when capture_response is set (else ""). Rejected → with `on_reject`, the
 * rework prompt runs as an AI turn of this node ($REJECTION_REASON = the reply, each
 * rework resuming the previous rework's session) and the gate is asked again, at most
 * on_reject.max_attempts (1–10, default 3) reworks; then, or without `on_reject`, the
 * node ends "cancelled" and so does the run. Approval nodes are never retried by the
 * executor.
 *
 * Content presets (P4, plan §5.6): with `preset_key` the preset is loaded (presets.ts) and
 * every decision writes an approval-receipt under <artifacts>/receipts/<key>/ for the
 * sha256 of `content` (a `$draft.output` reference; default the message). The output is
 * then `{approved, receipts, required, presetKey, contentSha256, reviewers}` where
 * `receipts` counts distinct approve receipts for that content, so a ship node's
 * `when: $gate.output.receipts >= 3` gates on receipts, never on prose. An unknown or
 * invalid preset fails the node without retries.
 */
import { sha256 } from "../../hash-chain.ts";
import type { AgentResult, NodeHandler } from "../executor.ts";
import { type ContentPreset, countApprovals, parseReviewResponse, presetByKey, receiptsDirFor, writeReceipt } from "../presets.ts";
import type { ApprovalSpec } from "../schema.ts";
import { type AgentCallResult, callAgent } from "./ai.ts";

export const DEFAULT_REJECT_ATTEMPTS = 3;

export const runApprovalNode: NodeHandler = async (ctx) => {
	const spec = (ctx.node as { approval: ApprovalSpec }).approval;
	const max = spec.on_reject ? Math.min(10, Math.max(1, Math.floor(spec.on_reject.max_attempts ?? DEFAULT_REJECT_ATTEMPTS))) : 0;
	const usage: AgentResult["usage"] = { tokensIn: 0, tokensOut: 0, costUsd: 0, tpsSeconds: 0 };
	let preset: ContentPreset | undefined;
	if (spec.preset_key) {
		try {
			preset = presetByKey(ctx.deps.cwd, spec.preset_key);
		} catch (error) {
			return { status: "failed", output: undefined, error: `preset ${spec.preset_key}: ${error instanceof Error ? error.message : String(error)}`, retryable: false };
		}
		if (!preset) return { status: "failed", output: undefined, error: `preset "${spec.preset_key}" not found (.titan/presets/content/${spec.preset_key}.yaml or the package catalog)`, retryable: false };
	}
	const contentText = preset ? (spec.content ? ctx.subst(spec.content, "raw") : ctx.subst(spec.message, "prompt")) : undefined;
	const contentSha256 = contentText === undefined ? undefined : sha256(contentText);
	const receiptsDir = preset ? receiptsDirFor(ctx.deps.artifactsDir, preset) : undefined;
	const receipt = (decision: "approve" | "reject", response: string | undefined): string | undefined => {
		if (!preset || !receiptsDir || !contentSha256) return undefined;
		const parsed = parseReviewResponse(response);
		const file = writeReceipt(receiptsDir, { presetKey: preset.key, reviewer: parsed.reviewer, decision, rubricScores: parsed.rubricScores, ts: new Date().toISOString(), contentSha256, runId: ctx.deps.runId, nodeId: ctx.node.id, response: response?.trim() || undefined });
		ctx.log("evidence.captured", { kind: "approval-receipt", presetKey: preset.key, decision, reviewer: parsed.reviewer, contentSha256, path: file });
		return file;
	};
	let reworks = 0;
	let lastRework: AgentCallResult | undefined;
	for (;;) {
		const message = ctx.subst(spec.message, "prompt");
		const gate = await ctx.deps.approval(message, { captureResponse: Boolean(spec.capture_response || spec.on_reject || preset) });
		if (gate.approved) {
			const file = receipt("approve", gate.response);
			if (preset && receiptsDir && contentSha256) {
				const tally = countApprovals(receiptsDir, contentSha256);
				return {
					status: "success",
					output: { approved: true, receipts: tally.approve, required: preset.reviewers.human_min, presetKey: preset.key, contentSha256, reviewers: tally.reviewers, response: gate.response ?? "" },
					text: lastRework?.text,
					usage,
					sessionRef: lastRework?.sessionRef,
					meta: { reworks, presetKey: preset.key, receipt: file, receipts: tally.approve, required: preset.reviewers.human_min, contentSha256 },
				};
			}
			return {
				status: "success",
				output: spec.capture_response ? (gate.response ?? "") : "",
				text: lastRework?.text,
				usage,
				sessionRef: lastRework?.sessionRef,
				meta: { reworks, presetKey: spec.preset_key, response: spec.capture_response ? gate.response : undefined },
			};
		}
		receipt("reject", gate.response);
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
