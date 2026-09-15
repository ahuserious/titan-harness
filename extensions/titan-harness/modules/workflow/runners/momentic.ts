/**
 * runners/momentic.ts — the `momentic` verify runner (Momentic AI E2E, plan §5.8).
 *
 * Momentic stays `disabled: true` in the catalog. The runner is SKIPPED unless the
 * operator both keyed it (MOMENTIC_API_KEY, or MOMENTIC_CONFIG naming a config) and
 * enabled it on the node (`enabled: true`) — a skipped lane is reported as such, never as
 * a pass. When enabled it calls `spec.tool` (default momentic_run_step) with `spec.args`
 * (objective merged in) through deps.mcpTool, stores the reply, and harvests what the run
 * left under `.momentic-mcp/`. No MCP bridge while enabled → unavailable.
 */
import * as path from "node:path";
import { harvestDir, isPassStatus, type Runner, saveText, skipped, snapshotFiles, specString, unavailable } from "./index.ts";

export const MOMENTIC_SERVER = "momentic";
export const MOMENTIC_DEFAULT_TOOL = "momentic_run_step";
export const MOMENTIC_ARTIFACT_DIR = ".momentic-mcp";

export const momenticEnabled = (spec: { enabled?: unknown }, env: Record<string, string>): { enabled: boolean; reason?: string } => {
	const keyed = Boolean(env.MOMENTIC_API_KEY?.trim()) || Boolean(env.MOMENTIC_CONFIG?.trim());
	if (spec.enabled !== true) return { enabled: false, reason: "momentic disabled on this node (set verify.enabled: true)" };
	if (!keyed) return { enabled: false, reason: "momentic not keyed (MOMENTIC_API_KEY or MOMENTIC_CONFIG missing; name only, value never read here)" };
	return { enabled: true };
};

let counter = 0;

export const momenticRunner: Runner = async (spec, ctx) => {
	const gate = momenticEnabled(spec as { enabled?: unknown }, ctx.env);
	if (!gate.enabled) return skipped(gate.reason ?? "momentic skipped");
	if (!ctx.mcpTool) return unavailable("momentic: no MCP bridge in this runtime (deps.mcpTool absent; enable the titan_harness__momentic server)");
	const tool = typeof spec.tool === "string" && spec.tool.trim() ? spec.tool : MOMENTIC_DEFAULT_TOOL;
	const objective = specString(spec, "objective");
	const args = { ...(spec.args && typeof spec.args === "object" ? (spec.args as Record<string, unknown>) : {}), ...(objective ? { objective } : {}) };
	const artifactRoot = path.join(ctx.cwd, MOMENTIC_ARTIFACT_DIR);
	const before = snapshotFiles(artifactRoot);
	let reply: unknown;
	try {
		reply = await ctx.mcpTool(MOMENTIC_SERVER, tool, args);
	} catch (error) {
		return unavailable(`momentic ${tool}: ${error instanceof Error ? error.message : String(error)}`);
	}
	counter += 1;
	const artifacts = [await saveText(ctx, `momentic-${counter}-${tool.replace(/[^A-Za-z0-9._-]+/g, "-")}.json`, `${JSON.stringify(reply, null, 2)}\n`, "report", "momentic"), ...(await harvestDir(ctx, artifactRoot, before, "momentic"))];
	const record = reply && typeof reply === "object" ? (reply as Record<string, unknown>) : {};
	const status = record.status ?? record.state ?? record.result;
	const ok = !record.error && record.isError !== true && (status === undefined || isPassStatus(status));
	const screenshots = artifacts.filter((artifact) => artifact.kind === "screenshot" && artifact.sha256).length;
	if (!ok) return { status: "fail", artifacts, checks: { userFlowsPassed: false, testsPass: false }, summary: `momentic ${tool}: ${String(record.error ?? status ?? "failed")}`, reason: String(record.error ?? status ?? "failed"), raw: reply };
	return { status: "pass", artifacts, checks: { userFlowsPassed: true, testsPass: true, screenshotPresent: screenshots > 0 }, summary: `momentic ${tool}: ${typeof status === "string" ? status : "ok"} · ${artifacts.length} artifact(s)`, raw: reply };
};
