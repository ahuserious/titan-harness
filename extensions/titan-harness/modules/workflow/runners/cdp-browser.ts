/**
 * runners/cdp-browser.ts — the `cdp-browser` verify runner: simulated-user flows driven
 * through a headless Chromium over the DevTools Protocol (plan H8 / §5.8 sim-user lane, P8).
 *
 *   verify:
 *     runner: cdp-browser
 *     flows: [{ name, url, steps: [{goto|click|fill|press|wait|screenshot|snapshot|eval|expect}] }]
 *     flows_file: flows.json        # instead of flows: a JSON file (relative paths resolve
 *                                   # against the run's artifacts dir) holding {flows:[…]} or [...]
 *     video: true                   # default: stitch step frames with ffmpeg when available
 *
 * Each flow runs through scripts/cdp-browser.mjs (one fresh browser per flow) into
 * evidenceDir/<flow>/: step-<n>.png (screenshot), snapshot-<n>.txt + snapshot-final.txt
 * (snapshot), console.json (console-log), network.json (network-log), flow-result.json
 * (report), flow.json (script). Every file is hashed with source "cdp" — a simulated-user
 * source, so production-swe's video-or-screenshot rule is satisfied by these captures.
 * `video` (WebM/VP8) comes from scripts/stitch-video.mjs; when ffmpeg is absent the package carries
 * `missingInformation: ["video: unavailable (ffmpeg not found)"]` instead of a claim.
 *
 * Fail closed: no Chromium → unavailable (never a silent pass); a flow whose steps failed →
 * fail (its failure screenshot is still evidence); pass only when every flow-result is ok.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { findChromium } from "../../cdp-browser.ts";
import type { EvidenceArtifact, EvidenceChecks, EvidenceKind } from "../evidence.ts";
import type { Runner, RunnerResult } from "./index.ts";

// Local copies of index.ts's helpers: a value import would make this module depend on the
// registry at evaluation time (the registry imports us), and a test that loads this file
// first would hit the TDZ. Types only cross that boundary.
const unavailable = (reason: string, extra: Partial<RunnerResult> = {}): RunnerResult => ({ status: "unavailable", artifacts: [], checks: {}, summary: reason, reason, ...extra });
const failed = (reason: string, extra: Partial<RunnerResult> = {}): RunnerResult => ({ status: "fail", artifacts: [], checks: {}, summary: reason, reason, ...extra });

export interface CdpFlowInput {
	name: string;
	url?: string;
	description?: string;
	steps: unknown[];
}

/** `<package>/scripts/<name>` resolved from this module's location. */
export function scriptPath(name: string): string {
	return path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..", "..", "scripts", name);
}

/** A safe directory name for a flow. */
export const flowSlug = (name: string, index: number): string => {
	const slug = name
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "")
		.slice(0, 48);
	return `${String(index + 1).padStart(2, "0")}-${slug || "flow"}`;
};

/** Evidence kind of one file the driver wrote. */
export function kindForDriverFile(file: string): EvidenceKind {
	const base = path.basename(file);
	if (/^step-.*\.png$/.test(base)) return "screenshot";
	if (/^snapshot-.*\.txt$/.test(base)) return "snapshot";
	if (base === "console.json") return "console-log";
	if (base === "network.json") return "network-log";
	if (base === "flow-result.json") return "report";
	if (base === "flow.json") return "script";
	if (/\.(mp4|webm)$/.test(base)) return "video";
	return "log";
}

/** The flows a spec names: inline `flows`, or a `flows_file` ({flows:[…]} or an array). */
export function flowsFromSpec(spec: Record<string, unknown>, artifactsDir: string): { flows: CdpFlowInput[]; error?: string } {
	const inline = spec.flows;
	let raw: unknown = inline;
	if (raw === undefined && typeof spec.flows_file === "string") {
		const file = path.isAbsolute(spec.flows_file) ? spec.flows_file : path.join(artifactsDir, spec.flows_file);
		try {
			raw = JSON.parse(fs.readFileSync(file, "utf8"));
		} catch (error) {
			return { flows: [], error: `flows_file ${file}: ${error instanceof Error ? error.message : String(error)}` };
		}
	}
	if (raw && typeof raw === "object" && !Array.isArray(raw) && Array.isArray((raw as { flows?: unknown }).flows)) raw = (raw as { flows: unknown[] }).flows;
	if (!Array.isArray(raw)) return { flows: [], error: "verify.flows (or flows_file) must be a list of {name, url, steps}" };
	const flows: CdpFlowInput[] = [];
	for (const [i, entry] of raw.entries()) {
		if (!entry || typeof entry !== "object") return { flows: [], error: `flow ${i + 1} is not an object` };
		const flow = entry as Partial<CdpFlowInput>;
		if (typeof flow.name !== "string" || !flow.name.trim()) return { flows: [], error: `flow ${i + 1} has no name` };
		if (!Array.isArray(flow.steps) || !flow.steps.length) return { flows: [], error: `flow ${JSON.stringify(flow.name)} has no steps` };
		flows.push({ name: flow.name.trim(), url: typeof flow.url === "string" ? flow.url : typeof spec.url === "string" ? spec.url : undefined, description: typeof flow.description === "string" ? flow.description : undefined, steps: flow.steps });
	}
	return { flows };
}

const tail = (text: string, max = 400): string => (text.trim().length > max ? `…${text.trim().slice(-max)}` : text.trim());

export const cdpBrowserRunner: Runner = async (spec, ctx) => {
	// spec.chromium > TITAN_CHROMIUM (node env, then process env) > the machine's Chromium; an override that is not executable is a vacancy, not a crash.
	const override = typeof spec.chromium === "string" && spec.chromium.trim() ? spec.chromium.trim() : ctx.env.TITAN_CHROMIUM;
	const chromium = findChromium({ ...process.env, ...ctx.env, ...(override ? { TITAN_CHROMIUM: override } : {}) })?.path;
	if (!chromium) return unavailable(override ? `Chromium ${override} is not executable (TITAN_CHROMIUM / verify.chromium)` : "no Chromium (Playwright cache, brave-browser or chrome) on this machine — install one or set TITAN_CHROMIUM", { retryable: false });
	const { flows, error } = flowsFromSpec(spec as Record<string, unknown>, ctx.artifactsDir);
	if (error) return failed(`cdp-browser: ${error}`, { retryable: false });
	if (!flows.length) return failed("cdp-browser: no flows to run", { retryable: false });
	const wantVideo = spec.video !== false;
	const cli = scriptPath("cdp-browser.mjs");
	const stitch = scriptPath("stitch-video.mjs");
	fs.mkdirSync(ctx.evidenceDir, { recursive: true, mode: 0o700 });
	const artifacts: EvidenceArtifact[] = [];
	const missing: string[] = [];
	const perFlow: Record<string, "pass" | "fail" | "unavailable"> = {};
	let videoUnavailable: string | undefined;
	let stepsOk = 0;
	let stepsTotal = 0;
	for (const [index, flow] of flows.entries()) {
		if (ctx.signal.aborted) return failed("cdp-browser: aborted", { artifacts, retryable: false });
		const dir = path.join(ctx.evidenceDir, flowSlug(flow.name, index));
		fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
		const flowFile = path.join(dir, "flow.json");
		fs.writeFileSync(flowFile, `${JSON.stringify(flow, null, 2)}\n`, { mode: 0o600 });
		const result = await ctx.exec("node", [cli, "run", "--flow", flowFile, "--out", dir, "--chromium", chromium, "--timeout", String(Math.min(ctx.timeoutMs, 60_000))], { timeoutMs: ctx.timeoutMs, env: { TITAN_CHROMIUM: chromium } });
		if (result.code === 3) return unavailable(`cdp-browser: ${tail(result.stderr) || "no Chromium"}`, { artifacts, retryable: false });
		if (result.code === 2) return failed(`cdp-browser: ${tail(result.stderr) || "bad flow"}`, { artifacts, retryable: false });
		let report: { ok?: boolean; steps?: Array<{ ok: boolean; n: number; action: string; error?: string }>; error?: string } | undefined;
		try {
			report = JSON.parse(fs.readFileSync(path.join(dir, "flow-result.json"), "utf8"));
		} catch {}
		const flowSteps = report?.steps ?? [];
		stepsTotal += flowSteps.length;
		stepsOk += flowSteps.filter((step) => step.ok).length;
		const ok = result.code === 0 && report?.ok === true;
		perFlow[flow.name] = report ? (ok ? "pass" : "fail") : "unavailable";
		if (!report) missing.push(`${flow.name}: no flow-result.json (driver exit ${result.code}: ${tail(result.stderr, 200) || "no output"})`);
		else if (!ok) missing.push(`${flow.name}: ${report.error ?? flowSteps.filter((step) => !step.ok).map((step) => `step ${step.n} ${step.action}: ${step.error}`).join("; ") ?? "failed"}`);
		// Hash everything the driver wrote for this flow.
		let names: string[] = [];
		try {
			names = fs.readdirSync(dir).sort();
		} catch {}
		for (const name of names) {
			const file = path.join(dir, name);
			try {
				if (!fs.statSync(file).isFile()) continue;
			} catch {
				continue;
			}
			artifacts.push(await ctx.hash(file, kindForDriverFile(file), "cdp", { note: flow.name }));
		}
		if (wantVideo && flowSteps.length) {
			const out = path.join(dir, "flow.webm");
			const stitched = await ctx.exec("node", [stitch, "--frames", dir, "--out", out, "--fps", "2"], { timeoutMs: Math.min(ctx.timeoutMs, 120_000) });
			if (stitched.code === 0) {
				let produced = out;
				try {
					const reported = JSON.parse(stitched.stdout.trim().split("\n").at(-1) ?? "{}") as { out?: string };
					if (typeof reported.out === "string") produced = reported.out;
				} catch {}
				artifacts.push(await ctx.hash(produced, "video", "cdp", { note: flow.name }));
			}
			else if (stitched.code === 3) videoUnavailable = "video: unavailable (ffmpeg not found)";
			else videoUnavailable = `video: unavailable (stitch exited ${stitched.code}: ${tail(stitched.stderr, 200)})`;
		}
	}
	if (videoUnavailable) missing.push(videoUnavailable);
	const screenshots = artifacts.filter((artifact) => artifact.kind === "screenshot" && artifact.sha256).length;
	const checks: EvidenceChecks = {
		screenshotPresent: screenshots > 0,
		logsPresent: artifacts.some((artifact) => (artifact.kind === "console-log" || artifact.kind === "network-log") && artifact.sha256),
		userFlowsPassed: Object.values(perFlow).length > 0 && Object.values(perFlow).every((status) => status === "pass"),
		exitCode: Object.values(perFlow).every((status) => status === "pass") ? 0 : 1,
	};
	const passed = Object.values(perFlow).filter((status) => status === "pass").length;
	const summary = `${passed}/${flows.length} flow(s) passed · ${stepsOk}/${stepsTotal} steps · ${screenshots} screenshot(s)${videoUnavailable ? " · video unavailable" : artifacts.some((a) => a.kind === "video") ? " · video" : ""}`;
	const base: RunnerResult = { status: checks.userFlowsPassed ? "pass" : "fail", artifacts, checks, summary, devices: perFlow, missing: missing.length ? missing : undefined, raw: { chromium, flows: perFlow } };
	if (!checks.userFlowsPassed) return { ...base, reason: missing.filter((line) => !line.startsWith("video:")).join("; ") || "a flow failed", retryable: true };
	if (!screenshots) return { ...base, status: "fail", reason: "flows passed but no screenshot was captured", retryable: true };
	return base;
};
