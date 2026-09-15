/**
 * runners/orca-browser.ts — the `orca-browser` verify runner (Orca's embedded browser, plan §5.8, H8).
 *
 *   flows: [{ name, url, steps: [{ action: goto|click|fill|eval|screenshot|snapshot, selector, text, code, capture }] }]
 *
 * Each flow opens a tab (`orca tab create`), navigates (`orca tab goto`), drives the steps
 * (`orca tab click|fill|eval`), and captures evidence: `screenshot` → screenshot-<flow>-<n>.png,
 * `snapshot` → snapshot-<flow>-<n>.txt (the accessibility snapshot on stdout), `eval` with
 * `capture: console|network` → console-log / network-log files. Every step must exit 0 for
 * the flow to pass; the runner passes when every flow passed and at least one screenshot
 * or snapshot was hashed. `orca` not on PATH → unavailable. The argument builder (orcaArgs)
 * is the one place P8's /local-dev-verify adjusts when the CLI's flags differ.
 *
 * Probe first: this machine's Orca build only offers `orca tab list|show|current|switch|
 * create|profile|close` (no goto/snapshot/click/fill/screenshot/eval — `orca computer` is
 * accessibility computer-use without screenshots), so the runner reads `orca tab --help`
 * and drives nothing unless the usage text names both `goto` and `screenshot`; otherwise
 * it is `unavailable` with the subcommands it did find, and no further exec call is made.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import type { EvidenceArtifact, EvidenceKind } from "../evidence.ts";
import { failed, type Runner, saveText, unavailable } from "./index.ts";

export const ORCA_BINARY = "orca";

export interface OrcaStep {
	action: "goto" | "click" | "fill" | "eval" | "screenshot" | "snapshot";
	selector?: string;
	text?: string;
	code?: string;
	url?: string;
	capture?: "console" | "network";
	name?: string;
}
export interface OrcaFlow {
	name?: string;
	url: string;
	steps?: OrcaStep[];
}

/** `orca tab <verb> …` argv for one step (file = where a screenshot goes). */
export function orcaArgs(tab: string, step: OrcaStep, file?: string): string[] {
	switch (step.action) {
		case "goto":
			return ["tab", "goto", tab, step.url ?? ""];
		case "click":
			return ["tab", "click", tab, step.selector ?? ""];
		case "fill":
			return ["tab", "fill", tab, step.selector ?? "", step.text ?? ""];
		case "eval":
			return ["tab", "eval", tab, step.code ?? ""];
		case "screenshot":
			return ["tab", "screenshot", tab, ...(file ? ["--path", file] : [])];
		case "snapshot":
			return ["tab", "snapshot", tab];
	}
}

const safe = (text: string) => text.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "flow";

export const ORCA_REQUIRED_VERBS = ["goto", "screenshot"];
const KNOWN_VERBS = ["list", "show", "current", "switch", "create", "profile", "close", "goto", "snapshot", "click", "fill", "screenshot", "eval"];

/** Subcommand names in an `orca tab --help` usage text (indented "  name   description" rows, or a "Commands:" list). */
export function orcaTabVerbs(usage: string): string[] {
	const found = new Set<string>();
	for (const line of usage.split(/\r?\n/)) {
		const row = /^\s{2,}([a-z][a-z-]*)\b/.exec(line);
		if (row && KNOWN_VERBS.includes(row[1])) found.add(row[1]);
	}
	if (!found.size) for (const verb of KNOWN_VERBS) if (new RegExp(`\\b${verb}\\b`).test(usage)) found.add(verb);
	return [...found];
}

/** Does this Orca build automate the browser? Requires both `goto` and `screenshot` under `orca tab`. */
export async function probeOrcaTab(ctx: Parameters<Runner>[1]): Promise<{ ok: boolean; found: string[]; reason?: string }> {
	const help = await ctx.exec(ORCA_BINARY, ["tab", "--help"], { timeoutMs: Math.min(ctx.timeoutMs, 15_000) });
	const found = orcaTabVerbs(`${help.stdout}\n${help.stderr}`);
	const missing = ORCA_REQUIRED_VERBS.filter((verb) => !found.includes(verb));
	if (help.code !== 0 && !found.length) return { ok: false, found, reason: `orca tab --help failed (exit ${help.code})` };
	if (missing.length) return { ok: false, found, reason: `orca tab has no ${missing.join("/")} automation in this Orca build (found: ${found.join(", ") || "nothing"})` };
	return { ok: true, found };
}

export const orcaBrowserRunner: Runner = async (spec, ctx) => {
	if (!ctx.which(ORCA_BINARY)) return unavailable(`${ORCA_BINARY} not on PATH (the Orca app's CLI drives its embedded browser)`);
	const flows = Array.isArray(spec.flows) ? (spec.flows as OrcaFlow[]).filter((flow) => flow && typeof flow.url === "string") : [];
	if (!flows.length) return failed("orca-browser runner needs verify.flows: [{url, steps}]");
	const probe = await probeOrcaTab(ctx);
	if (!probe.ok) return unavailable(probe.reason ?? "orca tab cannot automate the browser", { raw: { found: probe.found } });
	fs.mkdirSync(ctx.evidenceDir, { recursive: true, mode: 0o700 });
	const artifacts: EvidenceArtifact[] = [];
	const flowStatus: Record<string, "pass" | "fail" | "unavailable"> = {};
	const missing: string[] = [];
	let counter = 0;
	for (const [index, flow] of flows.entries()) {
		const label = safe(flow.name ?? `flow-${index + 1}`);
		if (ctx.signal.aborted) return failed("orca-browser: aborted", { artifacts, devices: flowStatus });
		const created = await ctx.exec(ORCA_BINARY, ["tab", "create"], { timeoutMs: ctx.timeoutMs });
		const tab = created.stdout.trim().split("\n")[0]?.trim();
		if (created.code !== 0 || !tab) {
			flowStatus[label] = "fail";
			missing.push(`${label}: orca tab create failed (exit ${created.code})`);
			continue;
		}
		const steps: OrcaStep[] = [{ action: "goto", url: flow.url }, ...(flow.steps ?? [])];
		let ok = true;
		for (const step of steps) {
			counter += 1;
			const stepName = safe(step.name ?? `${label}-${counter}`);
			const file = step.action === "screenshot" ? path.join(ctx.evidenceDir, `screenshot-${stepName}.png`) : undefined;
			const result = await ctx.exec(ORCA_BINARY, orcaArgs(tab, step, file), { timeoutMs: ctx.timeoutMs });
			if (result.code !== 0) {
				ok = false;
				missing.push(`${label}: ${step.action} failed (exit ${result.code}${result.stderr.trim() ? `: ${result.stderr.trim().slice(0, 200)}` : ""})`);
				break;
			}
			if (step.action === "screenshot" && file) artifacts.push(await ctx.hash(file, "screenshot", "orca", { device: label }));
			else if (step.action === "snapshot") artifacts.push(await saveText(ctx, `snapshot-${stepName}.txt`, result.stdout, "snapshot", "orca", { device: label }));
			else if (step.action === "eval" && step.capture) {
				const kind: EvidenceKind = step.capture === "console" ? "console-log" : "network-log";
				artifacts.push(await saveText(ctx, `${step.capture}-${stepName}.log`, result.stdout, kind, "orca", { device: label }));
			}
		}
		flowStatus[label] = ok ? "pass" : "fail";
	}
	const captured = artifacts.filter((artifact) => artifact.sha256 && (artifact.kind === "screenshot" || artifact.kind === "snapshot")).length;
	const passed = Object.values(flowStatus).filter((status) => status === "pass").length;
	const checks = { userFlowsPassed: passed === flows.length, screenshotPresent: artifacts.some((artifact) => artifact.kind === "screenshot" && artifact.sha256), logsPresent: artifacts.some((artifact) => artifact.kind === "console-log" && artifact.sha256) };
	if (passed !== flows.length) return failed(`orca-browser: ${passed}/${flows.length} flow(s) passed`, { artifacts, checks, devices: flowStatus, missing });
	if (!captured) return failed("orca-browser: flows passed but captured no screenshot or snapshot (a pass without evidence is a claim)", { artifacts, checks, devices: flowStatus, missing: ["no screenshot or snapshot step in any flow"] });
	return { status: "pass", artifacts, checks, summary: `orca-browser: ${passed}/${flows.length} flow(s) passed · ${captured} capture(s)`, devices: flowStatus };
};
