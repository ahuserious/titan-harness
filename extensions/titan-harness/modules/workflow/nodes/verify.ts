/**
 * nodes/verify.ts — `verify: {runner, objective, devices, …}` nodes (plan §5.1–5.2, §5.8, D9, P4).
 *
 * A verify node runs one runner adapter (runners/*.ts: bash, kane, testmu, momentic,
 * cursor-cloud, orca-browser, verifier) and turns what it observed into an evidence
 * package: artifacts/evidence/<nodeId>/ holds the files, evidence/<nodeId>/evidence.json
 * (store.writeEvidence) holds the hashed rows, checks and the derived status. The
 * requirement is the tier's kinds (titan.tier / node.tier → tiers.ts) plus the node's own
 * `evidence.require`. Fail closed at every step:
 *
 *   runner pass ∧ package matched            → node success, output.status "pass"
 *   runner pass ∧ package current-unverified → node failed ("evidence incomplete: …")
 *   runner fail                              → node failed (retryable unless the runner says the failure is deterministic)
 *   runner unavailable                       → node failed, never retried
 *   runner skipped                           → node failed unless `verify.optional: true`
 *
 * String fields of the spec (objective, input, ref, repo) are substituted in prompt mode,
 * `command` in bash mode, before the runner sees them. RunnerContext.exec is built over
 * deps.bash with single-quoted arguments (no new deps surface); fetch is the injectable
 * runner fetch; the verifier's agent seam is nodes/ai.ts callAgent with role verifier;
 * credentials are read by name from the process environment merged with the node env and
 * never written anywhere. Events: evidence.captured {status, kinds, sha256}.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import type { NodeHandler, NodeOutcome } from "../executor.ts";
import { buildEvidence, type CitationDoc, type EvidenceArtifact, type EvidenceKind, type EvidenceSource, hashArtifact, writeEvidencePackage } from "../evidence.ts";
import { isRunnerName, type RunnerContext, type RunnerResult, RUNNERS, runnerFetch } from "../runners/index.ts";
import type { JsonSchema, SlotRole, VerifySpec } from "../schema.ts";
import { evidenceRequirement, tierFor } from "../tiers.ts";
import { callAgent } from "./ai.ts";

const SUBSTITUTED_PROMPT_FIELDS = ["objective", "input", "ref", "repo", "api_base"];

/** Single-quote one argv element for `bash -c`. */
export const shellQuote = (value: string): string => `'${value.replace(/'/g, `'\\''`)}'`;

/** Grounding docs for the verifier: vision.md, intent.md, .titan/terraform/*.md (when present). */
export function groundingDocs(cwd: string): CitationDoc[] {
	const docs: CitationDoc[] = [];
	const read = (file: string, name: string) => {
		try {
			const text = fs.readFileSync(file, "utf8");
			if (text.trim()) docs.push({ name, text });
		} catch {}
	};
	for (const name of ["vision.md", "intent.md", "VISION.md", "INTENT.md"]) read(path.join(cwd, name), name);
	const terraform = path.join(cwd, ".titan", "terraform");
	try {
		for (const entry of fs.readdirSync(terraform).sort()) if (/\.md$/i.test(entry)) read(path.join(terraform, entry), `terraform/${entry}`);
	} catch {}
	return docs;
}

/** First executable named `binary` on PATH (plus the usual user bins). */
export function whichBinary(binary: string, env: Record<string, string>): string | undefined {
	const home = env.HOME ?? process.env.HOME ?? "";
	const dirs = [...(env.PATH ?? process.env.PATH ?? "").split(path.delimiter).filter(Boolean), path.join(home, ".local", "bin"), path.join(home, ".bun", "bin"), path.join(home, ".orca", "bin")];
	for (const dir of dirs) {
		const candidate = path.join(dir, binary);
		try {
			fs.accessSync(candidate, fs.constants.X_OK);
			return candidate;
		} catch {}
	}
	return undefined;
}

/** The evidence directory of a node: artifacts/evidence/<safe id>/ (created). */
export function evidenceDirFor(artifactsDir: string, nodeId: string): string {
	const safe = nodeId.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^[.-]+/, "").replace(/-+$/, "") || "node";
	const dir = path.join(artifactsDir, "evidence", safe);
	fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
	return dir;
}

const stringEnv = (source: Record<string, string | undefined>): Record<string, string> => Object.fromEntries(Object.entries(source).filter((entry): entry is [string, string] => typeof entry[1] === "string"));

export const runVerifyNode: NodeHandler = async (ctx): Promise<NodeOutcome> => {
	const raw = (ctx.node as { verify?: VerifySpec }).verify;
	if (!raw || typeof raw !== "object") return { status: "failed", output: undefined, error: "verify node has no verify: mapping", retryable: false };
	if (!isRunnerName(raw.runner)) return { status: "failed", output: undefined, error: `verify.runner ${JSON.stringify(raw.runner)} is not a runner (bash, kane, testmu, momentic, cursor-cloud, orca-browser, verifier)`, retryable: false };
	const spec: VerifySpec = { ...raw };
	for (const field of SUBSTITUTED_PROMPT_FIELDS) if (typeof spec[field] === "string") spec[field] = ctx.subst(spec[field] as string, "prompt");
	if (typeof spec.command === "string") spec.command = ctx.subst(spec.command, "bash");
	const tier = tierFor(ctx.doc, ctx.node);
	const requirement = evidenceRequirement(tier, ctx.node);
	const evidenceDir = evidenceDirFor(ctx.deps.artifactsDir, ctx.node.id);
	const env = { ...stringEnv(process.env as Record<string, string | undefined>), ...ctx.env };
	const timeoutMs = ctx.timeoutMs("process");
	const runnerCtx: RunnerContext = {
		runId: ctx.deps.runId,
		nodeId: ctx.node.id,
		cwd: ctx.deps.cwd,
		env,
		artifactsDir: ctx.deps.artifactsDir,
		evidenceDir,
		exec: (command, args, opts) => ctx.deps.bash([command, ...args].map(shellQuote).join(" "), { cwd: opts?.cwd ?? ctx.deps.cwd, timeoutMs: opts?.timeoutMs ?? timeoutMs, env: { ...ctx.env, ...(opts?.env ?? {}) }, signal: ctx.signal }),
		fetch: runnerFetch(),
		mcpTool: ctx.deps.mcpTool,
		agent: async (prompt: string, opts?: { role?: SlotRole; outputSchema?: JsonSchema }) => {
			const call = await callAgent(ctx, prompt, { role: opts?.role ?? "verifier", outputSchema: opts?.outputSchema, label: `${ctx.deps.workflowId}/${ctx.node.id}/verifier` });
			return { ok: call.ok, text: call.text, value: call.value, error: call.error };
		},
		notify: (text, level) => ctx.notify(`${ctx.node.id}: ${text}`, level),
		signal: ctx.signal,
		timeoutMs,
		hash: (file: string, kind: EvidenceKind, source: EvidenceSource, extra?: Partial<EvidenceArtifact>) => hashArtifact(file, kind, source, extra),
		which: (binary: string) => whichBinary(binary, env),
		docs: groundingDocs(ctx.deps.cwd),
	};
	let result: RunnerResult;
	try {
		result = await RUNNERS[spec.runner](spec, runnerCtx);
	} catch (error) {
		if (ctx.signal.aborted) throw error;
		result = { status: "fail", artifacts: [], checks: {}, summary: `${spec.runner} threw: ${error instanceof Error ? error.message : String(error)}`, reason: error instanceof Error ? error.message : String(error) };
	}
	const pkg = buildEvidence(
		{ runId: ctx.deps.runId, nodeId: ctx.node.id, tier: tier?.name, modes: [spec.runner], artifacts: result.artifacts, checks: result.checks, summary: result.summary, missingInformation: [...(result.missing ?? []), ...(result.status === "skipped" || result.status === "unavailable" ? [`${spec.runner}: ${result.reason ?? result.status}`] : [])] },
		requirement,
	);
	const written = writeEvidencePackage(ctx.deps.store, ctx.deps.runDir, pkg);
	const kinds = [...new Set(pkg.artifacts.filter((artifact) => artifact.sha256).map((artifact) => artifact.kind))];
	ctx.log("evidence.captured", { runner: spec.runner, runnerStatus: result.status, status: pkg.status, kinds, artifacts: pkg.artifacts.length, sha256: written.sha256, evidencePath: written.path, missing: pkg.missingInformation });
	const output = { status: result.status, evidence: pkg.status, evidencePath: written.path, checks: pkg.checks, artifacts: pkg.artifacts.length, kinds, missing: pkg.missingInformation, devices: result.devices, summary: result.summary, tier: tier?.name };
	const meta: Record<string, unknown> = { verification: { runner: spec.runner, runnerStatus: result.status, evidenceStatus: pkg.status, missing: pkg.missingInformation, evidencePath: written.path, evidenceSha256: written.sha256 } };
	const rawResult = result.raw && typeof result.raw === "object" ? (result.raw as Record<string, unknown>) : undefined;
	if (rawResult?.provider === "cursor") meta.externalLedger = { provider: "cursor", source: "external", origin: "cursor", costUsd: typeof rawResult.externalCostUsd === "number" ? rawResult.externalCostUsd : 0, agentId: rawResult.agentId };
	const text = `${result.summary}\nevidence: ${pkg.status}${pkg.missingInformation.length ? `\n${pkg.missingInformation.map((line) => `- ${line}`).join("\n")}` : ""}`;
	if (result.status === "skipped") {
		if (spec.optional === true) return { status: "success", output, text, meta };
		return { status: "failed", output, text, error: `${spec.runner} skipped: ${result.reason ?? "disabled"} (set verify.optional: true to allow a skipped lane)`, retryable: false, meta };
	}
	if (result.status === "unavailable") return { status: "failed", output, text, error: `${spec.runner} unavailable: ${result.reason ?? result.summary}`, retryable: false, meta };
	if (result.status === "fail") return { status: "failed", output, text, error: `${spec.runner} failed: ${result.reason ?? result.summary}`, retryable: result.retryable !== false, meta };
	if (pkg.status !== "matched") return { status: "failed", output, text, error: `${spec.runner} passed but evidence is ${pkg.status}: ${pkg.missingInformation.join("; ")}`, retryable: false, meta };
	return { status: "success", output, text, meta };
};
