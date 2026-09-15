/**
 * runners/testmu.ts — the `testmu` verify runner (TestMu AI cloud triage, plan §5.8).
 *
 * TestMu is triage only: HyperExecute job status, command/network/console logs, SmartUI
 * diffs and WCAG audits arrive through the package-local MCP server (pi-mcp-adapter names
 * it `titan_harness__testmu`); Kane runs the flows. The runner calls `spec.tool` (default
 * `hyperexecute_job_status`) with `spec.args` through deps.mcpTool, stores the JSON reply
 * as testmu-<n>.json (kind report, observed because the bytes are hashed here) and passes
 * when the reply carries no error and no failing status. No MCP bridge → unavailable.
 */
import { isPassStatus, type Runner, saveText, unavailable } from "./index.ts";

export const TESTMU_SERVER = "testmu";
export const TESTMU_DEFAULT_TOOL = "hyperexecute_job_status";

let counter = 0;

export const testmuRunner: Runner = async (spec, ctx) => {
	if (!ctx.mcpTool) return unavailable("testmu: no MCP bridge in this runtime (deps.mcpTool absent; enable the titan_harness__testmu server)");
	const tool = typeof spec.tool === "string" && spec.tool.trim() ? spec.tool : TESTMU_DEFAULT_TOOL;
	const args = spec.args && typeof spec.args === "object" ? (spec.args as Record<string, unknown>) : {};
	let reply: unknown;
	try {
		reply = await ctx.mcpTool(TESTMU_SERVER, tool, args);
	} catch (error) {
		return unavailable(`testmu ${tool}: ${error instanceof Error ? error.message : String(error)}`);
	}
	counter += 1;
	const artifact = await saveText(ctx, `testmu-${counter}-${tool.replace(/[^A-Za-z0-9._-]+/g, "-")}.json`, `${JSON.stringify(reply, null, 2)}\n`, "report", "testmu");
	const record = reply && typeof reply === "object" ? (reply as Record<string, unknown>) : {};
	const status = record.status ?? record.state ?? record.result;
	const errored = Boolean(record.error) || record.isError === true;
	const failing = typeof status === "string" && !isPassStatus(status) && /fail|error|broken|reject/i.test(status);
	if (errored || failing) return { status: "fail", artifacts: [artifact], checks: { testsPass: false }, summary: `testmu ${tool}: ${errored ? String(record.error ?? "error") : `status ${String(status)}`}`, reason: errored ? String(record.error ?? "error") : `status ${String(status)}`, raw: reply };
	return { status: "pass", artifacts: [artifact], checks: { testsPass: true, logsPresent: true }, summary: `testmu ${tool}: ${typeof status === "string" ? status : "ok"}`, raw: reply };
};
