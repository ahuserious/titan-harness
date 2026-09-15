/**
 * runners/kane.ts — the `kane` verify runner (TestMu KaneAI terminal agent, plan §5.8).
 *
 *   kane-cli run "<objective>" --agent --headless [--max-steps N] [--remote --device-name D]
 *
 * One run per device (`spec.devices`, default ["default"]; `--remote` when a device is
 * named or `spec.remote` is set). The NDJSON stream on stdout is parsed for
 * `run_end {status, final_state, test_url}`; the stream itself is saved as
 * kane-<device>.ndjson (kind log) and everything the run left under `.testmuai/evidence/`
 * is hashed (screenshots, videos, logs, an evidence-pack row per directory listing).
 * Fail closed: kane-cli not on PATH → unavailable; a device without run_end → fail; every
 * device must report a passing status. Tests replay a recorded stream through ctx.exec.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import type { EvidenceArtifact } from "../evidence.ts";
import { harvestDir, isPassStatus, type Runner, type RunnerResult, saveText, snapshotFiles, specString, unavailable } from "./index.ts";

export const KANE_BINARY = "kane-cli";
export const KANE_EVIDENCE_DIR = path.join(".testmuai", "evidence");

export interface KaneRunEnd {
	status?: string;
	final_state?: string;
	test_url?: string;
	[k: string]: unknown;
}

/** The run_end event of a kane-cli NDJSON stream, if any (last one wins). */
export function parseKaneStream(stdout: string): { runEnd?: KaneRunEnd; events: number; steps: number } {
	let runEnd: KaneRunEnd | undefined;
	let events = 0;
	let steps = 0;
	for (const line of stdout.split("\n")) {
		const trimmed = line.trim();
		if (!trimmed.startsWith("{")) continue;
		let event: Record<string, unknown>;
		try {
			event = JSON.parse(trimmed);
		} catch {
			continue;
		}
		events += 1;
		const type = event.type ?? event.event;
		if (type === "run_end") runEnd = (event.data && typeof event.data === "object" ? { ...(event.data as object), ...event } : event) as KaneRunEnd;
		if (type === "step" || type === "step_end" || type === "action") steps += 1;
	}
	return { runEnd, events, steps };
}

export function kaneArgs(objective: string, spec: { max_steps?: unknown; headless?: boolean; remote?: unknown; variables?: unknown }, device: string): string[] {
	const args = ["run", objective, "--agent"];
	if (spec.headless !== false) args.push("--headless");
	if (typeof spec.max_steps === "number") args.push("--max-steps", String(spec.max_steps));
	if (device !== "default" || spec.remote === true) {
		args.push("--remote");
		if (device !== "default") args.push("--device-name", device);
	}
	if (spec.variables && typeof spec.variables === "object") {
		for (const [key, value] of Object.entries(spec.variables as Record<string, unknown>)) args.push("--variables", `${key}=${String(value)}`);
	}
	return args;
}

export const kaneRunner: Runner = async (spec, ctx) => {
	const objective = specString(spec, "objective");
	if (!objective) return { status: "fail", artifacts: [], checks: {}, summary: "kane runner needs verify.objective", reason: "kane runner needs verify.objective" };
	if (!ctx.which(KANE_BINARY)) return unavailable(`${KANE_BINARY} not on PATH (npm i -g @testmuai/kane-cli, then kane-cli login)`);
	const devices = Array.isArray(spec.devices) && spec.devices.length ? spec.devices.map(String) : ["default"];
	const evidenceRoot = path.join(ctx.cwd, KANE_EVIDENCE_DIR);
	const artifacts: EvidenceArtifact[] = [];
	const deviceStatus: Record<string, "pass" | "fail" | "unavailable"> = {};
	const missing: string[] = [];
	const urls: Record<string, string> = {};
	for (const device of devices) {
		if (ctx.signal.aborted) return unavailable("aborted", { artifacts, devices: deviceStatus });
		const before = snapshotFiles(evidenceRoot);
		const result = await ctx.exec(KANE_BINARY, kaneArgs(objective, spec as { max_steps?: unknown; headless?: boolean; remote?: unknown; variables?: unknown }, device), { timeoutMs: ctx.timeoutMs, cwd: ctx.cwd });
		const parsed = parseKaneStream(result.stdout);
		artifacts.push(await saveText(ctx, `kane-${device.replace(/[^A-Za-z0-9._-]+/g, "-")}.ndjson`, result.stdout, "log", "kane", { device }));
		if (fs.existsSync(evidenceRoot)) {
			const harvested = await harvestDir(ctx, evidenceRoot, before, "kane", { device });
			artifacts.push(...harvested);
			if (harvested.length) artifacts.push({ path: evidenceRoot, kind: "evidence-pack", capturedBy: "inferred", source: "kane", ts: new Date().toISOString(), device, note: `${harvested.length} file(s) harvested from ${KANE_EVIDENCE_DIR}` });
		}
		if (!parsed.runEnd) {
			deviceStatus[device] = result.code === 127 ? "unavailable" : "fail";
			missing.push(`${device}: no run_end in the kane-cli stream (exit ${result.code})`);
			continue;
		}
		if (typeof parsed.runEnd.test_url === "string") urls[device] = parsed.runEnd.test_url;
		deviceStatus[device] = isPassStatus(parsed.runEnd.status) ? "pass" : "fail";
		if (deviceStatus[device] === "fail") missing.push(`${device}: run_end status ${String(parsed.runEnd.status)}${parsed.runEnd.final_state ? ` (${String(parsed.runEnd.final_state)})` : ""}`);
	}
	const passed = devices.filter((device) => deviceStatus[device] === "pass");
	const screenshots = artifacts.filter((artifact) => artifact.kind === "screenshot" && artifact.sha256).length;
	const checks = { userFlowsPassed: passed.length === devices.length, screenshotPresent: screenshots > 0, logsPresent: true, testsPass: passed.length === devices.length };
	const base: RunnerResult = { status: "fail", artifacts, checks, summary: "", devices: deviceStatus, missing, raw: { urls } };
	if (Object.values(deviceStatus).every((status) => status === "unavailable")) return { ...base, status: "unavailable", summary: "kane-cli produced no run_end on any device", reason: missing.join("; ") };
	if (passed.length !== devices.length) return { ...base, summary: `kane: ${passed.length}/${devices.length} device(s) passed`, reason: missing.join("; ") };
	return { ...base, status: "pass", summary: `kane: ${devices.length}/${devices.length} device(s) passed · ${screenshots} screenshot(s)` };
};
