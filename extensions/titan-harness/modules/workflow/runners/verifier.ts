/**
 * runners/verifier.ts — the `verifier` runner: an AI verifier for the research-planning
 * tier (plan §5.2 H3b) with a deterministic citation check in front of it.
 *
 * Input = the text under review (`spec.input`, else `spec.objective`, both substituted by
 * the node) and the project's grounding docs (vision.md, intent.md, .titan/terraform/*.md).
 * checkCitations() runs first: any cited section that does not exist is a hard finding no
 * model can talk away. Then the verifier seat (role verifier, read-only, the
 * SYSTEM_PROMPT_VERIFIER contract) answers a fixed schema: {ok, alignment[], executionClaims[],
 * summary}. Evidence written: alignment-table (the verdict JSON), plan-digest (sha256 of
 * the reviewed text), source-digests (sha256 per doc). Pass iff ok ∧ no missing citation ∧
 * no execution claim. No docs → unavailable (a plan cannot align with nothing); no agent
 * seam → unavailable.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { sha256 } from "../../hash-chain.ts";
import { checkCitations } from "../evidence.ts";
import type { JsonSchema } from "../schema.ts";
import { type Runner, saveText, specString, unavailable } from "./index.ts";

export const VERIFIER_SCHEMA: JsonSchema = {
	type: "object",
	properties: {
		ok: { type: "boolean" },
		alignment: {
			type: "array",
			items: {
				type: "object",
				properties: { claim: { type: "string" }, source: { type: "string" }, section: { type: "string" }, status: { type: "string", enum: ["aligned", "missing", "contradicted"] } },
				required: ["claim", "status"],
			},
		},
		executionClaims: { type: "array", items: { type: "string" } },
		summary: { type: "string" },
	},
	required: ["ok", "alignment", "executionClaims", "summary"],
};

const PROMPT_FILE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "prompts", "SYSTEM_PROMPT_VERIFIER.md");

/** The verifier contract text (falls back to a one-paragraph contract if the prompt file is missing). */
export function verifierContract(): string {
	try {
		return fs.readFileSync(PROMPT_FILE, "utf8");
	} catch {
		return "You are the verifier. Compare the text under review with the grounding documents. Report every claim as aligned, missing or contradicted with its source and section; list every sentence that claims something was executed, tested or deployed; set ok only when nothing is missing or contradicted and there are no execution claims.";
	}
}

const EXECUTION_CLAIM = /\b(tests? (?:pass|passed|are green)|deployed|shipped to production|ran the (?:suite|tests)|verified in production|all checks pass)\b/i;

export const verifierRunner: Runner = async (spec, ctx) => {
	const input = specString(spec, "input") ?? specString(spec, "objective");
	if (!input) return { status: "fail", artifacts: [], checks: {}, summary: "verifier runner needs verify.input (the text under review)", reason: "verifier runner needs verify.input" };
	const docs = ctx.docs ?? [];
	if (!docs.length) return unavailable("verifier: no grounding docs (vision.md, intent.md or .titan/terraform/*.md) — run /terraform or add them");
	if (!ctx.agent) return unavailable("verifier: no agent seam in this runtime");
	const citations = checkCitations(input, docs);
	const grounding = docs.map((doc) => `### ${doc.name}\n${doc.text}`).join("\n\n");
	const prompt = [
		verifierContract().trim(),
		"",
		"## Grounding documents",
		grounding,
		"",
		"## Text under review",
		input,
		"",
		citations.missing.length ? `## Mechanical findings (already established)\nThese citations point at sections that do not exist: ${citations.missing.join(", ")}. Treat them as missing.` : "",
	]
		.filter((part) => part !== "")
		.join("\n");
	const answer = await ctx.agent(prompt, { role: "verifier", outputSchema: VERIFIER_SCHEMA });
	if (!answer.ok || !answer.value || typeof answer.value !== "object") return unavailable(`verifier seat failed: ${answer.error ?? "no structured answer"}`);
	const verdict = answer.value as { ok: boolean; alignment: Array<{ claim: string; source?: string; section?: string; status: string }>; executionClaims: string[]; summary: string };
	const mechanicalClaims = input
		.split(/(?<=[.!?])\s+|\n/)
		.map((line) => line.trim())
		.filter((line) => EXECUTION_CLAIM.test(line));
	const executionClaims = [...new Set([...(verdict.executionClaims ?? []), ...mechanicalClaims])];
	const missingAlignment = (verdict.alignment ?? []).filter((row) => row.status !== "aligned");
	const artifacts = [
		await saveText(ctx, "alignment-table.json", `${JSON.stringify({ ...verdict, executionClaims, citations }, null, 2)}\n`, "alignment-table", "verifier"),
		await saveText(ctx, "plan-digest.txt", `${sha256(input)}  reviewed-text\n`, "plan-digest", "verifier"),
		await saveText(ctx, "source-digests.json", `${JSON.stringify(docs.map((doc) => ({ name: doc.name, sha256: sha256(doc.text), bytes: Buffer.byteLength(doc.text) })), null, 2)}\n`, "source-digests", "verifier"),
	];
	const problems = [...citations.missing.map((c) => `citation not found: ${c}`), ...missingAlignment.map((row) => `${row.status}: ${row.claim}${row.section ? ` (${row.source ?? "doc"} › ${row.section})` : ""}`), ...executionClaims.map((claim) => `execution claim: ${claim}`)];
	const ok = verdict.ok === true && problems.length === 0;
	const checks = { orgRulesMet: ok, designMatch: missingAlignment.length === 0 };
	if (!ok) return { status: "fail", artifacts, checks, summary: `verifier: ${problems.length} problem(s) — ${problems.slice(0, 3).join("; ")}${problems.length > 3 ? " …" : ""}`, reason: problems.join("; "), raw: verdict, missing: problems, retryable: false };
	return { status: "pass", artifacts, checks, summary: `verifier: aligned (${(verdict.alignment ?? []).length} claims checked, ${citations.cited.length} citations resolved)`, raw: verdict };
};
