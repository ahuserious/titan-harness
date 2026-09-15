/**
 * cmd-cloud-sim.ts — `/cloud-simulated-users`, the cloud sim-user lanes (plan §2 H9, §5.8, P8).
 *
 *   /cloud-simulated-users [probe]                     the provider matrix: ready or vacant, missing pieces by NAME
 *   /cloud-simulated-users setup <provider>            a read-only worker child loads the provider's skill and writes
 *                                                      setup advice; the HOST persists it under .titan/terraform/
 *                                                      remote-testing.md (the child never writes; installs are printed,
 *                                                      never run without deps.confirm)
 *   /cloud-simulated-users run <provider> --objective "<text>" [--devices a,b] [--ref <branch>]
 *                                                      one-node verify workflow through the P4 runner; every step lands
 *                                                      in the store as cloud-sim.* events; the panel names the evidence
 *                                                      package hash (never a credential)
 *   /cloud-simulated-users advice                      print .titan/terraform/remote-testing.md
 *
 * Fail closed: a vacant provider refuses `run` and names what is missing; a run whose
 * evidence package is not `matched` is reported failed. Everything pi-specific arrives
 * through CloudSimDeps (the lead's factory); the pure parts (arg parsing, the workflow doc,
 * the advice persistence, the panels) are exported for tests.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { CLOUD_PROVIDERS, type CloudProvider, envProbe, formatProbeMatrix, probeAll, probeProvider, type ProbeDeps, type ProbeResult, providerByName } from "./cloud-providers.ts";
import type { runChild as RunChild } from "./child-runner.ts";
import { sha256 } from "./hash-chain.ts";
import { RunStore, type RunStatus } from "./run-store.ts";
import { fmtSecs, newRun, READONLY_TOOLS, runOk, truncateChars } from "./runtime.ts";
import { executeWorkflow, type ResolvedRole, type RunResult, type WorkflowRuntimeDeps } from "./workflow/executor.ts";
import type { LoadedWorkflow } from "./workflow/loader.ts";
import type { NodeDoc, WorkflowDoc } from "./workflow/schema.ts";
import { validateWorkflow } from "./workflow/validator.ts";

export const CLOUD_SIM_COMMAND = "cloud-simulated-users";
export const CLOUD_SIM_EVENT = "cloud-sim";
export const ADVICE_FILE = path.join(".titan", "terraform", "remote-testing.md");
export const CURSOR_CONFIG_FILE = path.join(".titan", "cursor.yaml");
export const SETUP_TIMEOUT_MS = 300_000;
export const CLOUD_SIM_VERBS = ["probe", "setup", "run", "advice", "help"] as const;
export type CloudSimVerb = (typeof CLOUD_SIM_VERBS)[number];

export interface CloudSimDeps {
	cwd(ctx: any): string;
	store(): RunStore;
	notify(ctx: any, text: string, level?: "info" | "warning" | "error"): void;
	panel(ctx: any, title: string, markdown: string): void;
	/** The host's workflow runtime factory (the same one /workflow run uses). */
	runtime(ctx: any, loaded: LoadedWorkflow, runId: string, runDir: string): WorkflowRuntimeDeps;
	confirm(ctx: any, title: string, body: string): Promise<boolean>;
	which(binary: string): string | undefined;
	/** Presence only — never the value. */
	env(name: string): boolean;
	mcpEnabled(server: string): boolean;
	runChild: typeof RunChild;
	/** The worker seat the setup agent runs on. */
	workerSeat(): ResolvedRole;
	childTimeoutMs?(): number;
	/** Poll interval for lanes that poll (tests shorten it); default: the runner's own. */
	pollMs?(): number;
	/** Override for tests: the provider skill's text. Default reads <package>/skills/<skill>/SKILL.md. */
	skillText?(skill: string): string | undefined;
}

export interface CloudSimArgs {
	verb: CloudSimVerb;
	provider?: string;
	objective?: string;
	devices?: string[];
	ref?: string;
	errors: string[];
}

// ═══ Arguments ══════════════════════════════════════════════════════════════

function tokenize(text: string): string[] {
	const out: string[] = [];
	let current = "";
	let quote: string | undefined;
	let has = false;
	for (const ch of text) {
		if (quote) {
			if (ch === quote) quote = undefined;
			else current += ch;
			continue;
		}
		if (ch === '"' || ch === "'") {
			quote = ch;
			has = true;
			continue;
		}
		if (/\s/.test(ch)) {
			if (current || has) out.push(current);
			current = "";
			has = false;
			continue;
		}
		current += ch;
	}
	if (current || has) out.push(current);
	return out;
}

export function parseCloudSimArgs(text: string): CloudSimArgs {
	const tokens = tokenize(text ?? "");
	const errors: string[] = [];
	const verbToken = (tokens[0] ?? "probe").toLowerCase();
	const verb: CloudSimVerb = (CLOUD_SIM_VERBS as readonly string[]).includes(verbToken) ? (verbToken as CloudSimVerb) : "help";
	if (!(CLOUD_SIM_VERBS as readonly string[]).includes(verbToken)) errors.push(`unknown subcommand "${tokens[0]}"`);
	const args: CloudSimArgs = { verb, errors };
	const rest = tokens.slice(1);
	if (verb === "setup" || verb === "run") {
		args.provider = rest.shift();
		if (!args.provider) errors.push(`${verb} needs a provider (${CLOUD_PROVIDERS.map((p) => p.name).join(" | ")})`);
	}
	const positional: string[] = [];
	for (let i = 0; i < rest.length; i++) {
		const token = rest[i];
		const [flag, inline] = token.startsWith("--") && token.includes("=") ? [token.slice(0, token.indexOf("=")), token.slice(token.indexOf("=") + 1)] : [token, undefined];
		const value = () => inline ?? rest[++i];
		if (flag === "--objective") args.objective = value();
		else if (flag === "--devices") args.devices = (value() ?? "").split(",").map((d) => d.trim()).filter(Boolean);
		else if (flag === "--ref") args.ref = value();
		else if (token.startsWith("--")) errors.push(`unknown flag ${token}`);
		else positional.push(token);
	}
	if (verb === "run" && !args.objective && positional.length) args.objective = positional.join(" ");
	if (verb === "run" && !args.objective) errors.push('run needs --objective "<text>"');
	return args;
}

// ═══ The one-node verify workflow ═══════════════════════════════════════════

/** `.titan/cursor.yaml` → the spec fields the cursor runner reads (repo, ref, api_base). Values only, no credentials. */
export function readCursorConfig(cwd: string): { repo?: string; ref?: string; api_base?: string; env?: { type?: string; name?: string } } {
	try {
		const text = fs.readFileSync(path.join(cwd, CURSOR_CONFIG_FILE), "utf8");
		const out: Record<string, unknown> = {};
		let section: string | undefined;
		for (const raw of text.split(/\r?\n/)) {
			const line = raw.replace(/#.*$/, "").trimEnd();
			if (!line.trim()) continue;
			const top = /^([A-Za-z_]+):\s*(.*)$/.exec(line);
			if (top && !line.startsWith(" ")) {
				const [, key, value] = top;
				if (value === "") {
					section = key;
					out[key] = {};
				} else {
					section = undefined;
					out[key] = value.replace(/^["']|["']$/g, "");
				}
				continue;
			}
			const nested = /^\s+([A-Za-z_]+):\s*(.*)$/.exec(line);
			if (nested && section) (out[section] as Record<string, unknown>)[nested[1]] = nested[2].replace(/^["']|["']$/g, "");
		}
		const env = out.env && typeof out.env === "object" ? (out.env as { type?: string; name?: string }) : undefined;
		return { repo: typeof out.repo === "string" && out.repo ? out.repo : undefined, ref: typeof out.startingRef === "string" && out.startingRef ? out.startingRef : undefined, api_base: typeof out.api_base === "string" && out.api_base ? out.api_base : undefined, env };
	} catch {
		return {};
	}
}

export interface CloudRunSpec {
	provider: CloudProvider;
	objective: string;
	devices?: string[];
	ref?: string;
	runId: string;
	cwd: string;
	/** Poll interval for lanes that poll (tests shorten it). */
	pollMs?: number;
}

/** The workflow document `run <provider>` executes: one verify node on the provider's runner. */
export function cloudSimWorkflow(spec: CloudRunSpec): { doc: WorkflowDoc; loaded: LoadedWorkflow } {
	const name = `cloud-sim-${spec.provider.name}`;
	const verify: Record<string, unknown> = { runner: spec.provider.runner, objective: spec.objective };
	if (spec.provider.devices && spec.devices?.length) verify.devices = spec.devices;
	if (spec.provider.name === "kane-remote") verify.remote = true;
	if (spec.provider.name === "momentic") verify.enabled = true;
	if (typeof spec.pollMs === "number" && spec.pollMs > 0) verify.poll_ms = spec.pollMs;
	if (spec.provider.name === "cursor-cloud") {
		const config = readCursorConfig(spec.cwd);
		const ref = spec.ref ?? (config.ref ? config.ref.replace("<runId>", spec.runId) : undefined);
		if (ref) verify.ref = ref;
		if (config.repo) verify.repo = config.repo;
		if (config.api_base) verify.api_base = config.api_base;
	}
	const node = { id: "verify", verify, evidence: { require: [...spec.provider.requires] }, timeout: 900_000 } as unknown as NodeDoc;
	const doc: WorkflowDoc = { apiVersion: "titan.harness/v1", name, description: `${spec.provider.label}: ${spec.objective}`, version: 1, provider: "pi", returns: "verify", nodes: [node] };
	const validation = validateWorkflow(doc, { dir: "", commandDirs: [], scriptDirs: [] });
	const loaded: LoadedWorkflow = { doc, normalized: validation.normalized ?? doc, name, dir: spec.cwd, path: path.join(spec.cwd, `${name}.yaml`), sha256: sha256(JSON.stringify(doc)), source: "project", commands: {}, scripts: {}, validation };
	return { doc, loaded };
}

// ═══ Setup advice (the host persists; the child never writes) ═══════════════

export interface SetupResult {
	provider: string;
	advice_markdown: string;
	steps?: string[];
	installs?: string[];
	credentials_needed?: string[];
}

export const SETUP_SCHEMA = {
	type: "object",
	properties: {
		provider: { type: "string" },
		advice_markdown: { type: "string" },
		steps: { type: "array", items: { type: "string" } },
		installs: { type: "array", items: { type: "string" } },
		credentials_needed: { type: "array", items: { type: "string" } },
	},
	required: ["provider", "advice_markdown"],
} as const;

/** The last balanced `{…}` object in `text` that parses as a SetupResult; undefined otherwise. */
export function parseSetupResult(text: string): SetupResult | undefined {
	const spans: string[] = [];
	for (let start = text.indexOf("{"); start !== -1; start = text.indexOf("{", start + 1)) {
		let depth = 0;
		let inString = false;
		for (let i = start; i < text.length; i++) {
			const ch = text[i];
			if (inString) {
				if (ch === "\\") i++;
				else if (ch === '"') inString = false;
				continue;
			}
			if (ch === '"') inString = true;
			else if (ch === "{") depth++;
			else if (ch === "}") {
				depth--;
				if (depth === 0) {
					spans.push(text.slice(start, i + 1));
					break;
				}
			}
		}
	}
	for (const span of spans.reverse()) {
		try {
			const value = JSON.parse(span) as Record<string, unknown>;
			if (value && typeof value.advice_markdown === "string" && value.advice_markdown.trim()) {
				const list = (key: string): string[] | undefined => (Array.isArray(value[key]) ? (value[key] as unknown[]).filter((item): item is string => typeof item === "string") : undefined);
				return { provider: typeof value.provider === "string" ? value.provider : "", advice_markdown: value.advice_markdown, steps: list("steps"), installs: list("installs"), credentials_needed: list("credentials_needed") };
			}
		} catch {
			/* not this span */
		}
	}
	return undefined;
}

export function advicePath(cwd: string): string {
	return path.join(cwd, ADVICE_FILE);
}

const SECRET_LINE = /(api[_-]?key|token|secret|password)\s*[:=]\s*\S{12,}/i;

/**
 * Persist a provider's advice section into .titan/terraform/remote-testing.md — the ONLY
 * path this command ever writes. An existing section for the provider is replaced; lines
 * that look like a credential value are dropped (names are fine, values never).
 */
export function persistAdvice(cwd: string, provider: CloudProvider, result: SetupResult, probe: ProbeResult): { path: string; sha256: string; dropped: number } {
	const file = advicePath(cwd);
	fs.mkdirSync(path.dirname(file), { recursive: true });
	let existing = "";
	try {
		existing = fs.readFileSync(file, "utf8");
	} catch {
		existing = adviceSkeleton();
	}
	let dropped = 0;
	const clean = (text: string): string =>
		text
			.split("\n")
			.filter((line) => {
				if (SECRET_LINE.test(line)) {
					dropped++;
					return false;
				}
				return true;
			})
			.join("\n")
			.trim();
	const steps = (result.steps ?? []).map((step, i) => `${i + 1}. ${clean(step)}`).join("\n");
	const installs = (result.installs ?? []).map((cmd) => `- \`${clean(cmd)}\``).join("\n");
	// Credentials are kept by NAME: whatever follows `=`, `:` or a space is discarded before anything else looks at it.
	const credentials = (result.credentials_needed ?? [])
		.map((raw) => raw.trim().split(/[=:\s]/)[0])
		.filter(Boolean)
		.map((name) => `- ${name} (name only)`)
		.join("\n");
	const section = [
		`## ${provider.name} — ${provider.label}`,
		"",
		`_probe: ${probe.ready ? "ready" : `vacant — ${probe.needs.join(", ")}`} · runner \`${provider.runner}\` · skill \`${provider.skill}\` · ${new Date().toISOString()}_`,
		"",
		clean(result.advice_markdown),
		steps ? `\n### Steps\n${steps}` : "",
		installs ? `\n### Installs (printed, never run by titan without a confirm)\n${installs}` : "",
		credentials ? `\n### Credentials (names only)\n${credentials}` : "",
		`\nDocs: ${provider.docs}`,
	]
		.filter((part) => part !== "")
		.join("\n")
		.trim();
	const header = `## ${provider.name} — `;
	const lines = existing.split("\n");
	const start = lines.findIndex((line) => line.startsWith(header));
	let next: string;
	if (start === -1) next = `${existing.trimEnd()}\n\n${section}\n`;
	else {
		let end = lines.findIndex((line, i) => i > start && line.startsWith("## "));
		if (end === -1) end = lines.length;
		next = [...lines.slice(0, start), ...section.split("\n"), "", ...lines.slice(end)].join("\n").replace(/\n{3,}/g, "\n\n");
	}
	const tmp = `${file}.${process.pid}.tmp`;
	fs.writeFileSync(tmp, next, { mode: 0o600 });
	fs.renameSync(tmp, file);
	return { path: file, sha256: sha256(next), dropped };
}

export function adviceSkeleton(): string {
	return [
		"# Remote testing — cloud simulated users",
		"",
		"Advice written by `/cloud-simulated-users setup <provider>` (host-persisted; the setup agent is read-only).",
		"Credentials appear by NAME only. Probe the lanes with `/cloud-simulated-users probe`.",
		"",
	].join("\n");
}

const packageRoot = (): string => path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

export function defaultSkillText(skill: string): string | undefined {
	try {
		return fs.readFileSync(path.join(packageRoot(), "skills", skill, "SKILL.md"), "utf8");
	} catch {
		return undefined;
	}
}

/** The setup agent's prompt: provider facts, the probe, the skill text, and the exact JSON contract. */
export function setupPrompt(provider: CloudProvider, probe: ProbeResult, skillText: string | undefined, cwd: string): string {
	return [
		`You are setting up the "${provider.name}" cloud simulated-user lane (${provider.label}) for the project at ${cwd}.`,
		`Probe result: ${probe.reason}. Runner: ${provider.runner}. Docs: ${provider.docs}.`,
		`Known setup steps:\n${provider.setupSteps.map((step, i) => `${i + 1}. ${step}`).join("\n")}`,
		skillText ? `Provider skill (${provider.skill}):\n${truncateChars(skillText, 12_000)}` : `No skill text is available for ${provider.skill}; rely on the docs URL and the steps above.`,
		"You have read-only tools. Inspect the project (package.json, CI config, existing tests, .titan/) to tailor the advice: which flows to simulate, which devices matter, what the objective strings should say, how results feed titan's evidence packages.",
		"Never print, guess or request credential VALUES; refer to credentials by environment-variable NAME only. Do not run installs; list them.",
		"Answer with ONLY one JSON object (no fences) matching this schema:",
		JSON.stringify(SETUP_SCHEMA),
		'Example: {"provider":"kane-remote","advice_markdown":"…markdown…","steps":["…"],"installs":["npm i -g @testmuai/kane-cli"],"credentials_needed":["TESTMU_API_KEY"]}',
	].join("\n\n");
}

// ═══ Panels ═════════════════════════════════════════════════════════════════

export function formatRunOutcome(provider: CloudProvider, result: RunResult, opts: { runId: string; runDir: string; elapsedMs: number; evidence?: { sha256?: string; path?: string; status?: string; kinds?: string[]; missing?: string[] } }): string {
	const node = result.nodes.verify;
	const lines = [
		`**${provider.name}** · \`${opts.runId}\` · ${result.status === "completed" ? "✓ completed" : `✗ ${result.status}`} · ${fmtSecs(opts.elapsedMs)}`,
		"",
		`| lane | runner | node | evidence | package sha256 |`,
		`|---|---|---|---|---|`,
		`| ${provider.label} | ${provider.runner} | ${node?.status ?? "—"} | ${opts.evidence?.status ?? "—"} | ${opts.evidence?.sha256 ? `\`${opts.evidence.sha256.slice(0, 16)}…\`` : "—"} |`,
	];
	if (opts.evidence?.kinds?.length) lines.push("", `kinds: ${opts.evidence.kinds.join(", ")}`);
	if (opts.evidence?.missing?.length) lines.push("", `missing: ${opts.evidence.missing.join("; ")}`);
	if (node?.error) lines.push("", `**error:** ${node.error}`);
	if (opts.evidence?.path) lines.push("", `evidence: \`${opts.evidence.path}\``);
	lines.push(`run: \`${opts.runDir}\``);
	return lines.join("\n");
}

export function helpText(): string {
	return [
		"/cloud-simulated-users [probe]                                      provider matrix: ready or vacant, missing pieces by name",
		"/cloud-simulated-users setup <provider>                             read-only setup agent → .titan/terraform/remote-testing.md (host-persisted)",
		'/cloud-simulated-users run <provider> --objective "<text>" [--devices a,b] [--ref <branch>]   one-node verify workflow on the provider runner; cloud-sim.* events + evidence hash',
		"/cloud-simulated-users advice                                       print .titan/terraform/remote-testing.md",
		`providers: ${CLOUD_PROVIDERS.map((p) => `${p.name} (${p.aliases.filter((a) => a !== p.name).join(", ")})`).join(" · ")}`,
	].join("\n");
}

// ═══ Command ════════════════════════════════════════════════════════════════

const RUN_STATUS: Record<RunResult["status"], RunStatus> = { completed: "completed", failed: "failed", cancelled: "aborted", paused: "paused" };

export function registerCloudSimCommand(pi: ExtensionAPI, deps: CloudSimDeps): void {
	const probeDeps = (): ProbeDeps => ({ env: deps.env, which: deps.which, mcpEnabled: deps.mcpEnabled });
	let inFlight: { provider: string; runId: string } | undefined;

	const probe = (ctx: any) => {
		const results = probeAll(probeDeps());
		const ready = results.filter((r) => r.ready).length;
		deps.panel(ctx, `◆ CLOUD SIMULATED USERS — PROBE`, [`**${ready}/${results.length} lanes ready**`, "", formatProbeMatrix(results), "", "A vacant lane: `/cloud-simulated-users setup <provider>` writes tailored advice; nothing is installed or exported by titan."].join("\n"));
		return results;
	};

	const setup = async (ctx: any, providerName: string) => {
		const provider = providerByName(providerName);
		if (!provider) return deps.notify(ctx, `No provider named ${providerName}. Known: ${CLOUD_PROVIDERS.map((p) => p.name).join(", ")}.`, "error");
		const cwd = deps.cwd(ctx);
		const probed = probeProvider(provider, probeDeps());
		const seat = deps.workerSeat();
		const store = deps.store();
		const { runId, dir } = store.open({ projectSlug: RunStore.projectSlug(cwd), cwd, command: CLOUD_SIM_COMMAND, workflow: { name: `cloud-sim-setup-${provider.name}` }, status: "running" });
		store.appendEvent(dir, `${CLOUD_SIM_EVENT}.setup.start`, { provider: provider.name, ready: probed.ready, needs: probed.needs, seat: seat.callsign });
		const run = newRun("BUILDER", seat.model);
		const sessionDir = path.join(dir, "sessions");
		fs.mkdirSync(sessionDir, { recursive: true, mode: 0o700 });
		deps.notify(ctx, `cloud-sim: setup agent (${seat.callsign}) inspecting the project for ${provider.name}…`);
		try {
			await deps.runChild({
				run,
				prompt: setupPrompt(provider, probed, (deps.skillText ?? defaultSkillText)(provider.skill), cwd),
				systemPrompt: seat.systemPrompt,
				appendSystemPrompts: seat.appendSystemPrompts,
				tools: READONLY_TOOLS,
				thinking: seat.thinking as any,
				sessionDir,
				sessionId: `setup-${provider.name}-${runId}`,
				cwd,
				timeoutMs: deps.childTimeoutMs?.() ?? SETUP_TIMEOUT_MS,
			});
		} catch (error) {
			run.status = "failed";
			run.errorMessage = error instanceof Error ? error.message : String(error);
		}
		const parsed = run.status === "done" && runOk(run) ? parseSetupResult(run.text) : undefined;
		if (!parsed) {
			store.appendEvent(dir, `${CLOUD_SIM_EVENT}.setup.end`, { provider: provider.name, ok: false });
			store.updateRun(dir, { status: "failed", endedAt: new Date().toISOString() });
			return deps.notify(ctx, `cloud-sim: the setup agent returned no usable advice for ${provider.name} (${run.errorMessage ?? run.stopReason ?? "no JSON object in the answer"}). Nothing was written.`, "error");
		}
		const written = persistAdvice(cwd, provider, parsed, probed);
		store.appendEvent(dir, `${CLOUD_SIM_EVENT}.setup.end`, { provider: provider.name, ok: true, advice: written.path, sha256: written.sha256, dropped: written.dropped, installs: (parsed.installs ?? []).length });
		store.updateRun(dir, { status: "completed", endedAt: new Date().toISOString() });
		const installs = parsed.installs ?? [];
		let ran = false;
		if (installs.length) {
			ran = await deps.confirm(ctx, `Run ${installs.length} install command(s) for ${provider.name}?`, installs.join("\n"));
			if (ran) {
				const rt = deps.runtime(ctx, cloudSimWorkflow({ provider, objective: "setup", runId, cwd }).loaded, runId, dir);
				for (const command of installs) {
					const result = await rt.bash(command, { cwd, timeoutMs: 600_000 });
					store.appendEvent(dir, `${CLOUD_SIM_EVENT}.setup.install`, { command, code: result.code });
					deps.notify(ctx, `cloud-sim: ${command} → exit ${result.code}`, result.code === 0 ? "info" : "warning");
				}
			}
		}
		deps.panel(ctx, `◆ CLOUD SIMULATED USERS — SETUP ${provider.name}`, [`**${provider.label}** · advice written to \`${written.path}\` (sha256 \`${written.sha256.slice(0, 16)}…\`)${written.dropped ? ` · ${written.dropped} credential-looking line(s) dropped` : ""}`, "", parsed.advice_markdown.trim(), installs.length ? `\n**installs (${ran ? "run after confirm" : "printed, not run"})**\n${installs.map((c) => `- \`${c}\``).join("\n")}` : "", `\nrun: \`${dir}\``].filter(Boolean).join("\n"));
	};

	const runLane = async (ctx: any, args: CloudSimArgs) => {
		const provider = providerByName(args.provider);
		if (!provider) return deps.notify(ctx, `No provider named ${args.provider}. Known: ${CLOUD_PROVIDERS.map((p) => p.name).join(", ")}.`, "error");
		if (inFlight) return deps.notify(ctx, `A cloud-sim run is already in flight (${inFlight.provider} · ${inFlight.runId}).`, "warning");
		const probed = probeProvider(provider, probeDeps());
		if (!probed.ready) return deps.notify(ctx, `cloud-sim: ${provider.name} is vacant — missing ${probed.needs.join(", ")}. \`/cloud-simulated-users setup ${provider.name}\` writes the setup advice.`, "warning");
		const cwd = deps.cwd(ctx);
		const store = deps.store();
		const { runId, dir } = store.open({ projectSlug: RunStore.projectSlug(cwd), cwd, command: CLOUD_SIM_COMMAND, workflow: { name: `cloud-sim-${provider.name}` }, status: "running" });
		const { loaded } = cloudSimWorkflow({ provider, objective: args.objective ?? "", devices: args.devices, ref: args.ref, runId, cwd, pollMs: deps.pollMs?.() });
		if (!loaded.validation.ok) {
			store.updateRun(dir, { status: "failed", endedAt: new Date().toISOString() });
			return deps.notify(ctx, `cloud-sim: the generated verify workflow is invalid: ${loaded.validation.errors.map((e) => e.message).join("; ")}`, "error");
		}
		store.appendEvent(dir, `${CLOUD_SIM_EVENT}.preflight`, { provider: provider.name, runner: provider.runner, ready: true, devices: args.devices ?? [], objectiveSha256: sha256(args.objective ?? "") });
		const base = deps.runtime(ctx, loaded, runId, dir);
		const controller = new AbortController();
		if (base.signal) base.signal.addEventListener("abort", () => controller.abort(), { once: true });
		const rt: WorkflowRuntimeDeps = {
			...base,
			signal: controller.signal,
			bash: async (command, opts) => {
				store.appendEvent(dir, `${CLOUD_SIM_EVENT}.exec`, { command: command.slice(0, 200) });
				return base.bash(command, opts);
			},
			notify: (text, level) => {
				store.appendEvent(dir, `${CLOUD_SIM_EVENT}.progress`, { text: text.slice(0, 300), level: level ?? "info" });
				base.notify(text, level);
			},
		};
		inFlight = { provider: provider.name, runId };
		const startedAt = Date.now();
		store.appendEvent(dir, `${CLOUD_SIM_EVENT}.started`, { provider: provider.name, workflow: loaded.name });
		try {
			const result = await executeWorkflow(loaded, rt, {});
			const node = result.nodes.verify;
			const output = (node?.output && typeof node.output === "object" ? node.output : {}) as Record<string, unknown>;
			const captured = store.readRun(dir);
			const evidencePath = typeof output.evidencePath === "string" ? output.evidencePath : undefined;
			let evidenceSha: string | undefined;
			try {
				if (evidencePath) evidenceSha = sha256(fs.readFileSync(evidencePath));
			} catch {}
			const evidence = { sha256: evidenceSha, path: evidencePath, status: typeof output.evidence === "string" ? output.evidence : undefined, kinds: Array.isArray(output.kinds) ? (output.kinds as string[]) : undefined, missing: Array.isArray(output.missing) ? (output.missing as string[]) : undefined };
			store.appendEvent(dir, `${CLOUD_SIM_EVENT}.finished`, { provider: provider.name, status: result.status, node: node?.status ?? null, evidence: evidence.status ?? null, sha256: evidenceSha ?? null, elapsedMs: Date.now() - startedAt });
			store.updateRun(dir, { status: RUN_STATUS[result.status] ?? "failed", endedAt: new Date().toISOString(), totals: captured?.totals });
			deps.panel(ctx, `◆ CLOUD SIMULATED USERS — RUN ${provider.name} — ${result.status.toUpperCase()}`, formatRunOutcome(provider, result, { runId, runDir: dir, elapsedMs: Date.now() - startedAt, evidence }));
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			store.appendEvent(dir, `${CLOUD_SIM_EVENT}.finished`, { provider: provider.name, status: "failed", error: message });
			store.updateRun(dir, { status: "failed", endedAt: new Date().toISOString() });
			deps.notify(ctx, `cloud-sim: ${provider.name} run failed: ${message}`, "error");
		} finally {
			inFlight = undefined;
		}
	};

	const advice = (ctx: any) => {
		const file = advicePath(deps.cwd(ctx));
		let text: string | undefined;
		try {
			text = fs.readFileSync(file, "utf8");
		} catch {}
		if (!text) return deps.notify(ctx, `No ${ADVICE_FILE} yet — \`/cloud-simulated-users setup <provider>\` writes it.`, "info");
		deps.panel(ctx, `◆ CLOUD SIMULATED USERS — ADVICE`, text);
	};

	pi.registerCommand(CLOUD_SIM_COMMAND, {
		description: 'Cloud simulated users: probe the provider lanes (Cursor cloud, TestMu/HyperExecute, Kane --remote, Momentic), write setup advice, or run one lane through its verify runner. /cloud-simulated-users [probe|setup <provider>|run <provider> --objective "<text>" [--devices a,b]|advice]',
		getArgumentCompletions: (prefix: string) => {
			const items = [...CLOUD_SIM_VERBS.filter((verb) => verb !== "help"), ...CLOUD_PROVIDERS.map((p) => p.name)].filter((item) => item.startsWith(prefix.trim().toLowerCase())).map((item) => ({ value: item, label: item }));
			return items.length ? items : null;
		},
		handler: async (raw: string, ctx: any) => {
			const args = parseCloudSimArgs(raw ?? "");
			if (args.verb === "help" || (args.errors.length && args.verb !== "probe")) {
				if (args.errors.length) deps.notify(ctx, `Not run: ${args.errors.join("; ")}`, "warning");
				return deps.panel(ctx, "◆ CLOUD SIMULATED USERS — HELP", `\`\`\`\n${helpText()}\n\`\`\``);
			}
			switch (args.verb) {
				case "probe":
					probe(ctx);
					return;
				case "setup":
					await setup(ctx, args.provider!);
					return;
				case "run":
					await runLane(ctx, args);
					return;
				case "advice":
					advice(ctx);
					return;
			}
		},
	} as any);
}

/** Convenience for the lead's factory: a presence-only env probe over process.env. */
export const processEnvProbe = envProbe;
