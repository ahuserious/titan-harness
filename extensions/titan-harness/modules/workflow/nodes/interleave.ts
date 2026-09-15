/**
 * nodes/interleave.ts — `interleave: {segments, by, synthesize, reauthor, prompt}` nodes
 * (plan A10, P4).
 *
 * The work is split into segments (a count 2–16, or a list of 2–16 labels) by
 * files | sections | hypotheses. Segment i runs in its OWN fresh session (callsign
 * `<node>-s<i>`, concurrent up to the child cap) with a prompt that contains only its
 * segment: the literal tokens `$SEGMENT` (its label) and `$SEGMENT_COUNT` are replaced
 * before the ordinary substitution, and a "Segment i of N" header is prepended — no
 * segment ever sees another's text (acceptance A10: 4 segments ⇒ 4 sessions + 1
 * synthesis, no cross-contamination). Every segment output is archived under
 * artifacts/nodes/<id>/segments/<i>.md. With `synthesize` (default true) one synthesizer
 * turn (role architect, read-only) merges the segment outputs; the synthesis text is the
 * node output. `synthesize: false` returns the segment texts as an array.
 *
 * Fail closed: any failed segment fails the node (error lists them); with
 * `reauthor: true` the outcome also carries meta.reauthor = true and is not retried, so
 * the on_fail path can hand the escalation report to the architect (plan D11). A failed
 * synthesis fails the node the same way.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import type { AgentRequest, AgentResult, NodeContext, NodeHandler, NodeOutcome } from "../executor.ts";
import { runLimited } from "../executor.ts";
import type { InterleaveSpec } from "../schema.ts";
import { buildAgentRequest } from "./ai.ts";

export const INTERLEAVE_MIN = 2;
export const INTERLEAVE_MAX = 16;

export interface Segment {
	index: number;
	label: string;
	callsign: string;
	ok: boolean;
	text: string;
	error?: string;
	sessionRef?: string;
	usage?: AgentResult["usage"];
}

const emptyUsage = (): AgentResult["usage"] => ({ tokensIn: 0, tokensOut: 0, costUsd: 0, tpsSeconds: 0 });
const addUsage = (acc: AgentResult["usage"], usage?: AgentResult["usage"]): void => {
	if (!usage) return;
	acc.tokensIn += usage.tokensIn || 0;
	acc.tokensOut += usage.tokensOut || 0;
	acc.costUsd += usage.costUsd || 0;
	acc.tpsSeconds += usage.tpsSeconds || 0;
};

/** Segment labels from `segments`: a count → "1".."N", a list → its strings (trimmed, non-empty). */
export function segmentLabels(segments: InterleaveSpec["segments"]): string[] {
	if (Array.isArray(segments)) return segments.map((s) => String(s).trim()).filter(Boolean);
	const n = Math.floor(Number(segments));
	if (!Number.isFinite(n) || n < 1) return [];
	return Array.from({ length: n }, (_, i) => String(i + 1));
}

/** The prompt one segment sees: its header plus the template with `$SEGMENT` / `$SEGMENT_COUNT` filled in (nothing else). */
export function segmentPrompt(template: string, index: number, label: string, count: number, by: InterleaveSpec["by"]): string {
	const body = template.replace(/\$SEGMENT_COUNT\b/g, String(count)).replace(/\$SEGMENT\b/g, label);
	const kind = by ? ` (${by})` : "";
	return `Segment ${index} of ${count}${kind}: ${label}\nWork only on this segment.\n\n${body}`;
}

/** The synthesizer's brief over every segment output. */
export function synthesisPrompt(nodeId: string, by: InterleaveSpec["by"], segments: Array<{ index: number; label: string; text: string }>): string {
	const lines = [
		`Synthesize the ${segments.length} segment results below (interleave node "${nodeId}"${by ? `, split by ${by}` : ""}) into one coherent deliverable.`,
		"Keep every concrete finding, resolve overlaps, flag contradictions explicitly, and do not invent results that no segment produced.",
		"",
	];
	for (const segment of segments) lines.push(`## Segment ${segment.index}: ${segment.label}`, "", segment.text.trim(), "");
	return lines.join("\n");
}

async function runSegment(ctx: NodeContext, spec: InterleaveSpec, index: number, label: string, count: number): Promise<Segment> {
	const callsign = `${ctx.node.id}-s${index}`;
	const prompt = ctx.subst(segmentPrompt(spec.prompt, index, label, count, spec.by), "prompt");
	const request: AgentRequest = { ...buildAgentRequest(ctx, prompt, { context: "fresh", label: `${ctx.deps.workflowId}/${ctx.node.id}/segment-${index}` }), callsign };
	const result = await ctx.runAgent(request);
	const text = result.text ?? "";
	return { index, label, callsign, ok: result.ok && text.trim().length > 0, text, error: result.ok ? undefined : (result.error ?? "agent failed"), sessionRef: result.sessionRef, usage: result.usage };
}

function archive(ctx: NodeContext, segments: Segment[]): string {
	const dir = path.join(ctx.deps.artifactsDir, "nodes", ctx.node.id, "segments");
	fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
	for (const segment of segments) {
		const body = segment.ok ? segment.text : `[failed] ${segment.error ?? ""}\n`;
		fs.writeFileSync(path.join(dir, `${segment.index}.md`), body.endsWith("\n") ? body : `${body}\n`, { mode: 0o600 });
	}
	return dir;
}

/** `interleave:` nodes. */
export const runInterleaveNode: NodeHandler = async (ctx): Promise<NodeOutcome> => {
	const spec = (ctx.node as { interleave: InterleaveSpec }).interleave;
	if (!spec || typeof spec.prompt !== "string" || !spec.prompt.trim()) {
		return { status: "failed", output: undefined, error: "interleave: prompt is required", retryable: false };
	}
	const labels = segmentLabels(spec.segments);
	if (labels.length < INTERLEAVE_MIN || labels.length > INTERLEAVE_MAX) {
		return { status: "failed", output: undefined, error: `interleave: segments must be ${INTERLEAVE_MIN}–${INTERLEAVE_MAX} (got ${labels.length})`, retryable: false };
	}
	const count = labels.length;
	const usage = emptyUsage();
	const segments: Segment[] = [];
	let aborted: unknown;
	await runLimited(
		labels.map((label, i) => async () => {
			try {
				const segment = await runSegment(ctx, spec, i + 1, label, count);
				segments.push(segment);
				addUsage(usage, segment.usage);
			} catch (error) {
				aborted ??= error;
				throw error;
			}
		}),
		ctx.deps.settings.maxConcurrentChildren ?? 8,
	);
	if (aborted) throw aborted;
	segments.sort((a, b) => a.index - b.index);
	const archiveDir = archive(ctx, segments);
	const failed = segments.filter((s) => !s.ok);
	ctx.log("interleave.segments", { segments: count, ok: count - failed.length, failed: failed.map((s) => s.index), archive: archiveDir });
	const baseMeta = { segments: count, by: spec.by ?? null, labels, archive: archiveDir };
	if (failed.length) {
		const reauthor = spec.reauthor === true;
		return {
			status: "failed",
			output: undefined,
			error: `interleave: ${failed.length} of ${count} segments failed (${failed.map((s) => `${s.index}: ${s.error ?? "?"}`).join("; ")})${reauthor ? "; reauthor requested" : ""}`,
			usage,
			retryable: !reauthor,
			meta: { ...baseMeta, failed: failed.map((s) => s.index), reauthor },
		};
	}
	if (spec.synthesize === false) {
		const texts = segments.map((s) => s.text);
		return { status: "success", output: texts, text: texts.map((t, i) => `## Segment ${i + 1}: ${labels[i]}\n\n${t.trim()}`).join("\n\n"), usage, meta: { ...baseMeta, synthesized: false } };
	}
	const brief = synthesisPrompt(ctx.node.id, spec.by, segments);
	const request: AgentRequest = { ...buildAgentRequest(ctx, brief, { role: "architect", context: "fresh", label: `${ctx.deps.workflowId}/${ctx.node.id}/synthesis` }), callsign: `${ctx.node.id}-synth` };
	const synthesis = await ctx.runAgent(request);
	addUsage(usage, synthesis.usage);
	if (!synthesis.ok || !synthesis.text.trim()) {
		const reauthor = spec.reauthor === true;
		return { status: "failed", output: undefined, error: `interleave: synthesis failed (${synthesis.error ?? "empty answer"})${reauthor ? "; reauthor requested" : ""}`, usage, retryable: !reauthor, meta: { ...baseMeta, synthesized: false, reauthor } };
	}
	ctx.log("interleave.synthesis", { segments: count, sessionRef: synthesis.sessionRef });
	return { status: "success", output: synthesis.text, text: synthesis.text, usage, sessionRef: synthesis.sessionRef, meta: { ...baseMeta, synthesized: true } };
};
