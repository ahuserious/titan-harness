/**
 * nodes/loop.ts — `loop:` nodes: the prompt is sent up to max_iterations times with
 * $LOOP_COUNT (1-based) and $LOOP_USER_INPUT substituted. An iteration completes the loop
 * when the `until` token appears in the answer (`<promise>TOKEN</promise>` or the bare
 * token at word boundaries) or, failing that, when `until_bash` (bash-mode substitution)
 * exits 0. `fresh_context: true` starts every iteration in a fresh session; otherwise
 * each iteration resumes the previous one (the first follows the node's own `context`).
 * `interactive: true` pauses after every non-completing iteration on deps.approval with
 * the gate_message: the reply feeds the next $LOOP_USER_INPUT (a reply carrying the
 * `until` token ends the loop), a rejection cancels the run. Exhausting max_iterations
 * fails the node without retries — that count is the mechanical budget of plan D11, and
 * `on_fail` runs only after it.
 */
import type { AgentResult, NodeHandler, NodeOutcome } from "../executor.ts";
import type { LoopSpec } from "../schema.ts";
import { type AgentCallResult, callAgent } from "./ai.ts";

const escapeRegex = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** `<promise>TOKEN</promise>` (whitespace tolerant) or the bare token between non-word characters. */
export function hasCompletionToken(text: string, token: string): boolean {
	const t = token.trim();
	if (!t) return false;
	const esc = escapeRegex(t);
	if (new RegExp(`<promise>\\s*${esc}\\s*</promise>`).test(text)) return true;
	return new RegExp(`(^|[^A-Za-z0-9_])${esc}(?=$|[^A-Za-z0-9_])`, "m").test(text);
}

export const runLoopNode: NodeHandler = async (ctx) => {
	const spec = (ctx.node as { loop: LoopSpec }).loop;
	const max = Math.max(1, Math.floor(spec.max_iterations || 1));
	const usage: AgentResult["usage"] = { tokensIn: 0, tokensOut: 0, costUsd: 0, tpsSeconds: 0 };
	let last: AgentCallResult | undefined;
	let userInput: string | undefined;
	const done = (iteration: number, note?: string): NodeOutcome => ({
		status: "success",
		output: last?.text ?? "",
		text: last?.text,
		usage,
		sessionRef: last?.sessionRef,
		meta: { iterations: iteration, completedBy: note },
	});
	for (let i = 1; i <= max; i++) {
		const prompt = ctx.subst(spec.prompt, "prompt", { loopCount: i, loopUserInput: userInput });
		const call = await callAgent(ctx, prompt, {
			label: `${ctx.deps.workflowId}/${ctx.node.id} iteration ${i}/${max}`,
			context: spec.fresh_context ? "fresh" : undefined,
			resume: spec.fresh_context ? undefined : last?.sessionRef,
		});
		usage.tokensIn += call.usage.tokensIn;
		usage.tokensOut += call.usage.tokensOut;
		usage.costUsd += call.usage.costUsd;
		usage.tpsSeconds += call.usage.tpsSeconds;
		last = call;
		if (!call.ok) {
			return { status: "failed", output: undefined, text: call.text, error: `iteration ${i}/${max} failed: ${call.error ?? "agent failed"}`, usage, sessionRef: call.sessionRef, retryable: false, meta: { iterations: i } };
		}
		if (spec.until && hasCompletionToken(call.text, spec.until)) return done(i, "until");
		if (spec.until_bash) {
			const command = ctx.subst(spec.until_bash, "bash", { loopCount: i, loopUserInput: userInput });
			const check = await ctx.deps.bash(command, { cwd: ctx.deps.cwd, timeoutMs: ctx.timeoutMs("process"), env: ctx.env, signal: ctx.signal });
			if (check.code === 0) return done(i, "until_bash");
			ctx.notify(`${ctx.node.id}: until_bash exit ${check.code} after iteration ${i}/${max}`, i < max ? "info" : "warning");
		}
		if (spec.interactive && i < max) {
			const gate = await ctx.deps.approval(ctx.subst(spec.gate_message ?? "Continue the loop?", "prompt", { loopCount: i }), { captureResponse: true });
			if (!gate.approved) {
				return { status: "cancelled", output: call.text, text: call.text, error: `loop stopped by the user at iteration ${i}/${max}`, cancelRun: `${ctx.node.id}: loop stopped by the user at iteration ${i}/${max}`, usage, sessionRef: call.sessionRef, meta: { iterations: i } };
			}
			userInput = gate.response ?? "";
			if (spec.until && userInput && hasCompletionToken(userInput, spec.until)) return done(i, "user");
		}
	}
	return { status: "failed", output: last?.text, text: last?.text, error: `loop did not complete within ${max} iteration${max === 1 ? "" : "s"}`, usage, sessionRef: last?.sessionRef, retryable: false, meta: { iterations: max } };
};
