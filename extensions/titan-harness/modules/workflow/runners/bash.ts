/**
 * runners/bash.ts — the `bash` verify runner (web-general and platform-update checks, H3a/H3e).
 *
 * Runs `spec.command` (already substituted in bash mode by the node) with EVIDENCE_DIR and
 * ARTIFACTS_DIR in its environment. Evidence is what the command WROTE under the evidence
 * directory — every new or modified file is hashed and classified by name (db-op-log*.json,
 * http-status*, payload-hash*, screenshot*.png, coverage*.json, probe*, rollback*, diff*,
 * migration*, …). Checks: exitCode, coverage (from a coverage report), rowCounts (from a
 * db-op-log), httpStatuses. Fail closed: exit 0 with no evidence file is `unavailable` (the
 * write → read round trip never happened), a non-zero exit is `fail`.
 */
import * as fs from "node:fs";
import { checksFromArtifacts, failed, harvestDir, type Runner, snapshotFiles, specString, unavailable } from "./index.ts";

export const bashRunner: Runner = async (spec, ctx) => {
	const command = specString(spec, "command");
	if (!command) return failed("bash runner needs verify.command");
	fs.mkdirSync(ctx.evidenceDir, { recursive: true, mode: 0o700 });
	const before = snapshotFiles(ctx.evidenceDir);
	const result = await ctx.exec("bash", ["-c", command], { timeoutMs: ctx.timeoutMs, env: { EVIDENCE_DIR: ctx.evidenceDir, ARTIFACTS_DIR: ctx.artifactsDir } });
	const artifacts = await harvestDir(ctx, ctx.evidenceDir, before, "bash");
	const checks = checksFromArtifacts(artifacts, { exitCode: result.code });
	const tail = (text: string) => (text.trim().length > 400 ? `…${text.trim().slice(-400)}` : text.trim());
	if (result.code !== 0) {
		return failed(`bash check exited ${result.code}${result.stderr.trim() ? `: ${tail(result.stderr)}` : ""}`, { artifacts, checks: { ...checks, testsPass: false }, raw: { stdout: tail(result.stdout), stderr: tail(result.stderr) } });
	}
	if (!artifacts.some((artifact) => artifact.sha256)) {
		return unavailable("bash check wrote no evidence under EVIDENCE_DIR (a claim without a file is not evidence)", { checks, raw: { stdout: tail(result.stdout) } });
	}
	return { status: "pass", artifacts, checks: { ...checks, testsPass: true }, summary: `bash check passed with ${artifacts.length} evidence file(s)`, raw: { stdout: tail(result.stdout) } };
};
