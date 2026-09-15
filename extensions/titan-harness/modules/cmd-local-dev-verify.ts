/**
 * cmd-local-dev-verify.ts — `/local-dev-verify`: simulated users against a locally running
 * app (plan H8, §5.8 sim-user lane, P8).
 *
 *   /local-dev-verify [--url <u>] [--start "<cmd>"] [--flows <file.json>] [--workers <n>]
 *                     [--no-video] [--port <n>] [--timeout <s>]
 *
 *   1. app start   `--start`, else a recipe by project type (package.json dev|start,
 *                  pyproject [project.scripts], Procfile web:, a bare index.html); the
 *                  process runs in its own group, its log lands in the run directory
 *   2. probe       fetch the URL (--url, the port the log announces, or localhost:3000)
 *                  until 2xx/3xx or the timeout → otherwise `unavailable`, never a pass
 *   3. driver      kane-cli on PATH → runner kane; else a headless Chromium → cdp-browser;
 *                  neither → `unavailable: no Kane, no Chromium`
 *   4. workers     N fresh-context sim-user prompts (USER_PROMPT_SIM_USER.md) write flows
 *                  as structured output; `--flows` replays a file instead
 *   5. verify      the runner replays every flow → evidence package (screenshot, snapshot,
 *                  console-log, network-log, video when ffmpeg exists)
 *   6. report      `inbox.architect` event + a panel with one row per flow; app stopped
 *
 * The whole thing is an in-memory workflow document executed by the engine (nodes probe →
 * snapshot → sim-user-<n> → collect → verify → report), so it lands in the run store like
 * any `/workflow run`. The host supplies the runtime factory, the store and the UI through
 * `LocalDevVerifyDeps`; every pure part (argument parsing, recipes, the probe, the driver
 * choice, the workflow builder, the panel) is exported and tested without pi.
 */
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { findChromium } from "./cdp-browser.ts";
import { fill } from "./prompt-library.ts";
import { RunStore } from "./run-store.ts";
import { fmtSecs } from "./runtime.ts";
import type { StackSettings } from "./stack-config.ts";
import { type EvidencePackage, readEvidencePackage } from "./workflow/evidence.ts";
import { executeWorkflow, type RunResult, type WorkflowRuntimeDeps } from "./workflow/executor.ts";
import type { LoadedWorkflow } from "./workflow/loader.ts";
import { scriptPath } from "./workflow/runners/cdp-browser.ts";
import type { JsonSchema, NodeDoc, WorkflowDoc } from "./workflow/schema.ts";
import { formatIssues, validateWorkflow } from "./workflow/validator.ts";

export const STATUS_KEY = "titan-local-dev-verify";
export const DEFAULT_URL = "http://localhost:3000";
export const DEFAULT_PROBE_TIMEOUT_MS = 60_000;
export const MAX_WORKERS = 5;
export const MAX_FLOWS = 12;
export const WORKFLOW_NAME = "local-dev-verify";
export const REQUIRED_KINDS = ["screenshot", "snapshot", "console-log", "network-log"] as const;

// ═══ Arguments ══════════════════════════════════════════════════════════════

export interface LocalDevArgs {
	url?: string;
	start?: string;
	flows?: string;
	workers?: number;
	video: boolean;
	port?: number;
	/** Probe timeout in ms (--timeout is seconds). */
	timeoutMs: number;
	errors: string[];
}

function tokenize(text: string): string[] {
	const out: string[] = [];
	const re = /"((?:[^"\\]|\\.)*)"|'((?:[^'\\]|\\.)*)'|(\S+)/g;
	for (const match of text.matchAll(re)) out.push(match[1] !== undefined ? match[1].replace(/\\(.)/g, "$1") : match[2] !== undefined ? match[2].replace(/\\(.)/g, "$1") : match[3]);
	return out;
}

export function parseLocalDevArgs(args: string): LocalDevArgs {
	const out: LocalDevArgs = { video: true, timeoutMs: DEFAULT_PROBE_TIMEOUT_MS, errors: [] };
	const tokens = tokenize(args ?? "");
	for (let i = 0; i < tokens.length; i++) {
		const token = tokens[i];
		const value = (): string | undefined => {
			const next = tokens[i + 1];
			if (next === undefined || next.startsWith("--")) return undefined;
			i++;
			return next;
		};
		switch (token) {
			case "--url": {
				const v = value();
				if (!v || !/^https?:\/\//.test(v)) out.errors.push("--url needs an http(s) URL");
				else out.url = v;
				break;
			}
			case "--start": {
				const v = value();
				if (!v) out.errors.push("--start needs a command");
				else out.start = v;
				break;
			}
			case "--flows": {
				const v = value();
				if (!v) out.errors.push("--flows needs a file");
				else out.flows = v;
				break;
			}
			case "--workers": {
				const v = Number(value());
				if (!Number.isInteger(v) || v < 1) out.errors.push("--workers needs a positive integer");
				else out.workers = Math.min(v, MAX_WORKERS);
				break;
			}
			case "--port": {
				const v = Number(value());
				if (!Number.isInteger(v) || v < 1 || v > 65535) out.errors.push("--port needs a port number");
				else out.port = v;
				break;
			}
			case "--timeout": {
				const v = Number(value());
				if (!Number.isFinite(v) || v <= 0) out.errors.push("--timeout needs seconds");
				else out.timeoutMs = Math.round(v * 1000);
				break;
			}
			case "--no-video":
				out.video = false;
				break;
			case "--video":
				out.video = true;
				break;
			default:
				out.errors.push(`unknown argument ${token}`);
		}
	}
	return out;
}

// ═══ Recipes ════════════════════════════════════════════════════════════════

export interface Recipe {
	kind: "npm-dev" | "npm-start" | "bun-dev" | "pnpm-dev" | "yarn-dev" | "uv" | "procfile" | "static";
	command: string;
	url?: string;
	note: string;
}

const readJson = (file: string): Record<string, unknown> | undefined => {
	try {
		return JSON.parse(fs.readFileSync(file, "utf8")) as Record<string, unknown>;
	} catch {
		return undefined;
	}
};

/** How to start this project, from what is on disk; undefined when nothing recognisable exists. */
export function detectRecipe(cwd: string, port?: number): Recipe | undefined {
	const pkg = readJson(path.join(cwd, "package.json"));
	const scripts = (pkg?.scripts ?? {}) as Record<string, string>;
	const has = (file: string) => fs.existsSync(path.join(cwd, file));
	if (typeof scripts.dev === "string") {
		if (has("bun.lockb") || has("bun.lock")) return { kind: "bun-dev", command: "bun run dev", note: "package.json scripts.dev (bun lockfile)" };
		if (has("pnpm-lock.yaml")) return { kind: "pnpm-dev", command: "pnpm dev", note: "package.json scripts.dev (pnpm lockfile)" };
		if (has("yarn.lock")) return { kind: "yarn-dev", command: "yarn dev", note: "package.json scripts.dev (yarn lockfile)" };
		return { kind: "npm-dev", command: "npm run dev", note: "package.json scripts.dev" };
	}
	if (typeof scripts.start === "string") return { kind: "npm-start", command: "npm start", note: "package.json scripts.start" };
	const procfile = path.join(cwd, "Procfile");
	if (fs.existsSync(procfile)) {
		const line = fs
			.readFileSync(procfile, "utf8")
			.split("\n")
			.map((l) => l.trim())
			.find((l) => /^web:/.test(l));
		if (line) return { kind: "procfile", command: line.replace(/^web:\s*/, ""), note: "Procfile web:" };
	}
	const pyproject = path.join(cwd, "pyproject.toml");
	if (fs.existsSync(pyproject)) {
		const text = fs.readFileSync(pyproject, "utf8");
		const section = text.match(/\[project\.scripts\]\s*\n([\s\S]*?)(?:\n\[|$)/);
		const entry = section?.[1].split("\n").find((l) => /^\s*[\w-]+\s*=/.test(l));
		const name = entry?.split("=")[0].trim();
		if (name) return { kind: "uv", command: `uv run ${name}`, note: `pyproject [project.scripts] ${name}` };
		if (/\b(fastapi|flask|django|uvicorn)\b/i.test(text)) return { kind: "uv", command: "uv run python -m app", note: "pyproject web framework dependency (guessed entry: python -m app)" };
	}
	if (has("index.html")) {
		const p = port ?? 8080;
		return { kind: "static", command: `python3 -m http.server ${p} --bind 127.0.0.1`, url: `http://127.0.0.1:${p}/`, note: "index.html at the project root" };
	}
	return undefined;
}

/** The first http://localhost:<port> or http://127.0.0.1:<port> an app log announces. */
export function discoverUrlFromLog(log: string): string | undefined {
	const match = log.match(/https?:\/\/(?:localhost|127\.0\.0\.1|0\.0\.0\.0)(?::\d+)?(?:\/[^\s"'<>)]*)?/i);
	return match ? match[0].replace("0.0.0.0", "127.0.0.1") : undefined;
}

// ═══ App process + probe ════════════════════════════════════════════════════

export interface AppHandle {
	pid?: number;
	logFile: string;
	readLog(): string;
	kill(): void;
	exited(): boolean;
}

/** Start `command` through bash in its own process group; stdout+stderr go to `logFile`. */
export function spawnApp(command: string, cwd: string, logFile: string, env: NodeJS.ProcessEnv = process.env): AppHandle {
	fs.mkdirSync(path.dirname(logFile), { recursive: true, mode: 0o700 });
	const out = fs.openSync(logFile, "a", 0o600);
	const proc = spawn("bash", ["-c", command], { cwd, detached: process.platform !== "win32", stdio: ["ignore", out, out], env: { ...env, FORCE_COLOR: "0", CI: "1", BROWSER: "none" } });
	let exited = false;
	proc.on("exit", () => {
		exited = true;
		try {
			fs.closeSync(out);
		} catch {}
	});
	proc.on("error", () => {
		exited = true;
	});
	return {
		pid: proc.pid,
		logFile,
		readLog: () => {
			try {
				return fs.readFileSync(logFile, "utf8");
			} catch {
				return "";
			}
		},
		kill: () => {
			if (exited) return;
			try {
				if (process.platform !== "win32" && proc.pid) process.kill(-proc.pid, "SIGTERM");
				else proc.kill("SIGTERM");
			} catch {}
			setTimeout(() => {
				if (exited) return;
				try {
					if (process.platform !== "win32" && proc.pid) process.kill(-proc.pid, "SIGKILL");
					else proc.kill("SIGKILL");
				} catch {}
			}, 2_000).unref();
		},
		exited: () => exited,
	};
}

export type ProbeFetch = (url: string, init?: { signal?: AbortSignal; redirect?: "manual" }) => Promise<{ status: number }>;

export interface ProbeResult {
	ok: boolean;
	url: string;
	status?: number;
	attempts: number;
	elapsedMs: number;
	error?: string;
}

/** Fetch `url` until it answers 2xx/3xx or `timeoutMs` passes; `log()` may reveal a better URL along the way. */
export async function probeUrl(url: string, opts: { timeoutMs: number; intervalMs?: number; fetch?: ProbeFetch; log?: () => string; /** Switch to the URL the app log announces (when the user gave none). */ discover?: boolean; appExited?: () => boolean; signal?: AbortSignal }): Promise<ProbeResult> {
	const fetchFn: ProbeFetch | undefined = opts.fetch ?? ((globalThis as { fetch?: ProbeFetch }).fetch ? (input, init) => (globalThis as unknown as { fetch: ProbeFetch }).fetch(input, init) : undefined);
	if (!fetchFn) return { ok: false, url, attempts: 0, elapsedMs: 0, error: "no fetch available in this Node" };
	const started = Date.now();
	const interval = opts.intervalMs ?? 1_000;
	let attempts = 0;
	let target = url;
	let lastError: string | undefined;
	while (Date.now() - started < opts.timeoutMs) {
		if (opts.signal?.aborted) return { ok: false, url: target, attempts, elapsedMs: Date.now() - started, error: "aborted" };
		const discovered = opts.discover && opts.log ? discoverUrlFromLog(opts.log()) : undefined;
		if (discovered) target = discovered;
		attempts += 1;
		const controller = new AbortController();
		const timer = setTimeout(() => controller.abort(), Math.min(5_000, Math.max(250, opts.timeoutMs)));
		try {
			const response = await fetchFn(target, { signal: controller.signal, redirect: "manual" });
			clearTimeout(timer);
			if (response.status >= 200 && response.status < 400) return { ok: true, url: target, status: response.status, attempts, elapsedMs: Date.now() - started };
			lastError = `HTTP ${response.status}`;
		} catch (error) {
			clearTimeout(timer);
			lastError = error instanceof Error ? error.message : String(error);
		}
		if (opts.appExited?.()) return { ok: false, url: target, attempts, elapsedMs: Date.now() - started, error: `the app exited before answering (${lastError ?? "no response"})` };
		const remaining = opts.timeoutMs - (Date.now() - started);
		if (remaining <= 0) break;
		await new Promise((resolve) => setTimeout(resolve, Math.min(interval, remaining)));
	}
	return { ok: false, url: target, attempts, elapsedMs: Date.now() - started, error: `no 2xx/3xx answer within ${Math.round(opts.timeoutMs / 1000)} s (${lastError ?? "no response"})` };
}

// ═══ Driver choice ══════════════════════════════════════════════════════════

export type Driver = "kane" | "cdp-browser";

export function chooseDriver(deps: { which(binary: string): string | undefined; chromium?: string }): { driver: Driver; detail: string } | { driver: "none"; detail: string } {
	const kane = deps.which("kane-cli");
	if (kane) return { driver: "kane", detail: `kane-cli at ${kane}` };
	if (deps.chromium) return { driver: "cdp-browser", detail: `headless Chromium at ${deps.chromium}` };
	return { driver: "none", detail: "no Kane (kane-cli not on PATH), no Chromium (Playwright cache, brave-browser or chrome; TITAN_CHROMIUM unset)" };
}

// ═══ The workflow document ══════════════════════════════════════════════════

const STEP_SCHEMA: JsonSchema = {
	type: "object",
	properties: {
		goto: { type: "string" },
		click: { type: "string" },
		fill: { type: "object", properties: { selector: { type: "string" }, value: { type: "string" } }, required: ["selector", "value"] },
		press: { type: "string" },
		wait: { type: ["string", "number"] },
		expect: { type: "string" },
		snapshot: { type: "boolean" },
		screenshot: { type: ["string", "boolean"] },
		eval: { type: "string" },
	},
};

/** What every sim-user worker must answer with. */
export const FLOWS_SCHEMA: JsonSchema = {
	type: "object",
	required: ["flows"],
	properties: {
		flows: {
			type: "array",
			items: {
				type: "object",
				required: ["name", "steps"],
				properties: {
					name: { type: "string", minLength: 1 },
					description: { type: "string" },
					url: { type: "string" },
					steps: { type: "array", items: STEP_SCHEMA },
				},
			},
		},
	},
};

const ANGLES = ["the happy path a first-time visitor takes", "careless input: empty fields, wrong values, double submits", "navigation: every link, back and forth, deep pages", "an impatient user who skips instructions and clicks around", "accessibility and text: reading everything, keyboard-only where possible"];

const q = (value: string): string => `'${value.replace(/'/g, `'\\''`)}'`;

/** The Node one-liner the `collect` node runs: merge worker outputs (JSON argv) into $ARTIFACTS_DIR/flows.json. */
export const COLLECT_SCRIPT = String.raw`const fs=require("node:fs");const out=process.env.ARTIFACTS_DIR+"/flows.json";const seen=new Set();const flows=[];for(const arg of process.argv.slice(1)){let v;try{v=JSON.parse(arg)}catch{continue}const list=Array.isArray(v)?v:Array.isArray(v&&v.flows)?v.flows:[];for(const f of list){if(!f||typeof f!=="object"||typeof f.name!=="string"||!Array.isArray(f.steps)||!f.steps.length)continue;const key=f.name.trim().toLowerCase();if(seen.has(key))continue;seen.add(key);flows.push({name:f.name.trim(),description:typeof f.description==="string"?f.description:"",url:typeof f.url==="string"?f.url:process.env.APP_URL,steps:f.steps});if(flows.length>=${MAX_FLOWS})break}}fs.writeFileSync(out,JSON.stringify({flows},null,2)+"\n");const objectiveText=flows.map((f,i)=>(i+1)+". "+f.name+(f.description?" — "+f.description:"")+": "+f.steps.map(s=>Object.entries(s).map(([k,v])=>k+" "+(typeof v==="string"?v:JSON.stringify(v))).join(" ")).join("; ")).join("\n");console.log(JSON.stringify({flows:flows.length,names:flows.map(f=>f.name),objectiveText,file:out}))`;

export interface BuildInput {
	url: string;
	workers: number;
	driver: Driver;
	video: boolean;
	/** A pre-authored flows file: the sim-user nodes are skipped and this file is copied in. */
	flowsFile?: string;
	/** Where scripts/cdp-browser.mjs lives (default: the package). */
	cli?: string;
	/** Per-node timeout for the verify node, ms. */
	verifyTimeoutMs?: number;
}

/** The in-memory workflow /local-dev-verify runs; validate it with `loadedFor`. */
export function buildLocalDevWorkflow(input: BuildInput): WorkflowDoc {
	const cli = input.cli ?? scriptPath("cdp-browser.mjs");
	const workers = Math.max(1, Math.min(MAX_WORKERS, Math.round(input.workers)));
	const nodes: NodeDoc[] = [];
	nodes.push({
		id: "probe",
		phase: "probe",
		bash: `node -e 'fetch(process.argv[1],{redirect:"manual"}).then(r=>{console.log(JSON.stringify({status:r.status,url:process.argv[1]}));process.exit(r.status>=200&&r.status<400?0:1)}).catch(e=>{console.log(JSON.stringify({status:0,error:String(e)}));process.exit(1)})' ${q(input.url)}`,
		timeout: 30_000,
	} as NodeDoc);
	nodes.push({
		id: "snapshot",
		phase: "probe",
		depends_on: ["probe"],
		bash: `node ${q(cli)} snapshot --url ${q(input.url)} --out $ARTIFACTS_DIR/snapshot`,
		timeout: 60_000,
	} as NodeDoc);
	const simIds: string[] = [];
	if (!input.flowsFile) {
		for (let i = 1; i <= workers; i++) {
			const id = `sim-user-${i}`;
			simIds.push(id);
			const prompt = fill("USER_PROMPT_SIM_USER.md", {
				URL: input.url,
				WORKER: String(i),
				WORKERS: String(workers),
				SNAPSHOT: "$snapshot.output",
				MIN_FLOWS: "2",
				MAX_FLOWS: "4",
				ANGLE: ANGLES[(i - 1) % ANGLES.length],
			});
			nodes.push({
				id,
				phase: "sim-users",
				role: "worker",
				callsign: `sim-${i}`,
				depends_on: ["snapshot"],
				context: "fresh",
				allowed_tools: [],
				output_format: FLOWS_SCHEMA,
				retry: { max_attempts: 1 },
				prompt,
			} as NodeDoc);
		}
		nodes.push({
			id: "collect",
			phase: "sim-users",
			depends_on: simIds,
			trigger_rule: "one_success",
			bash: `APP_URL=${q(input.url)} node -e ${q(COLLECT_SCRIPT)} ${simIds.map((id) => `$${id}.output`).join(" ")}`,
			timeout: 30_000,
		} as NodeDoc);
	} else {
		nodes.push({
			id: "collect",
			phase: "sim-users",
			depends_on: ["snapshot"],
			bash: `cp ${q(input.flowsFile)} $ARTIFACTS_DIR/flows.json && APP_URL=${q(input.url)} node -e ${q(COLLECT_SCRIPT)} "$(cat $ARTIFACTS_DIR/flows.json)"`,
			timeout: 30_000,
		} as NodeDoc);
	}
	const verify: NodeDoc =
		input.driver === "kane"
			? ({ id: "verify", phase: "verify", depends_on: ["collect"], role: "verifier", verify: { runner: "kane", objective: "Exercise these flows as a real user would and report pass or fail per flow:\n$collect.output.objectiveText", headless: true, url: input.url }, evidence: { require: ["screenshot"] }, timeout: input.verifyTimeoutMs ?? 900_000, retry: { max_attempts: 1 } } as NodeDoc)
			: ({ id: "verify", phase: "verify", depends_on: ["collect"], role: "verifier", verify: { runner: "cdp-browser", flows_file: "flows.json", video: input.video, url: input.url }, evidence: { require: [...REQUIRED_KINDS] }, timeout: input.verifyTimeoutMs ?? 900_000, retry: { max_attempts: 1 } } as NodeDoc);
	nodes.push(verify);
	nodes.push({ id: "report", phase: "report", depends_on: ["verify"], trigger_rule: "all_done", bash: `printf '%s\\n' $verify.output`, timeout: 10_000 } as NodeDoc);
	return {
		apiVersion: "titan.harness/v1",
		name: WORKFLOW_NAME,
		description: `Simulated users against ${input.url} (${input.driver})`,
		provider: "pi",
		phases: [{ title: "probe" }, { title: "sim-users" }, { title: "verify" }, { title: "report" }],
		returns: "report",
		nodes,
	};
}

/** Validate the document and wrap it the way the loader would (dir "" skips the directory-name rule). */
export function loadedFor(doc: WorkflowDoc, dir: string): LoadedWorkflow {
	const validation = validateWorkflow(doc, { dir: "", commandDirs: [], scriptDirs: [], workflowNames: [] });
	if (!validation.ok) throw new Error(`local-dev-verify: the generated workflow is invalid:\n${formatIssues(validation)}`);
	const text = JSON.stringify(doc);
	return {
		doc,
		normalized: validation.normalized ?? doc,
		name: WORKFLOW_NAME,
		dir,
		path: path.join(dir, `${WORKFLOW_NAME}.json`),
		sha256: sha256Hex(text),
		source: "project",
		commands: {},
		scripts: {},
		validation,
	};
}

const sha256Hex = (text: string): string => createHash("sha256").update(text).digest("hex");

// ═══ Running ════════════════════════════════════════════════════════════════

export interface LocalDevVerifyDeps {
	cwd(ctx: any): string;
	store(): RunStore;
	notify(ctx: any, text: string, level?: "info" | "warning" | "error"): void;
	panel(ctx: any, title: string, markdown: string): void;
	/** The host's workflow runtime factory (the same one /workflow run uses). */
	runtime(ctx: any, loaded: LoadedWorkflow, runId: string, runDir: string): WorkflowRuntimeDeps;
	settings(): StackSettings;
	which(binary: string): string | undefined;
	/** Test seams. */
	chromium?(): string | undefined;
	fetch?: ProbeFetch;
	spawnApp?(command: string, cwd: string, logFile: string): AppHandle;
	setStatus?(ctx: any, text: string | undefined): void;
}

export interface FlowRow {
	name: string;
	status: "pass" | "fail" | "unavailable";
}

export interface LocalDevOutcome {
	status: "completed" | "failed" | "unavailable";
	reason?: string;
	url?: string;
	driver?: Driver;
	recipe?: Recipe;
	started?: string;
	appLog?: string;
	runId?: string;
	runDir?: string;
	workers: number;
	flows: FlowRow[];
	stepsOk?: number;
	stepsTotal?: number;
	screenshots?: number;
	video?: "yes" | "unavailable" | "off";
	evidence?: EvidencePackage["status"];
	evidencePath?: string;
	missing?: string[];
	result?: RunResult;
	elapsedMs: number;
}

/** One row per flow, the evidence verdict, and where the files are. */
export function formatLocalDevPanel(outcome: LocalDevOutcome): string {
	const lines: string[] = [];
	const head = outcome.status === "completed" ? "✓ completed" : outcome.status === "failed" ? "✗ failed" : "○ unavailable";
	lines.push(`**/local-dev-verify** · ${head} · ${fmtSecs(outcome.elapsedMs)}${outcome.url ? ` · ${outcome.url}` : ""}${outcome.driver ? ` · driver ${outcome.driver}` : ""}`);
	if (outcome.reason) lines.push(`\n**reason:** ${outcome.reason}`);
	if (outcome.recipe) lines.push(`\napp: \`${outcome.recipe.command}\` (${outcome.recipe.note})${outcome.appLog ? ` · log \`${outcome.appLog}\`` : ""}`);
	else if (outcome.started) lines.push(`\napp: \`${outcome.started}\`${outcome.appLog ? ` · log \`${outcome.appLog}\`` : ""}`);
	if (outcome.flows.length) {
		lines.push("", "| flow | status |", "|---|---|");
		for (const flow of outcome.flows) lines.push(`| ${flow.name} | ${flow.status === "pass" ? "✓ pass" : flow.status === "fail" ? "✗ fail" : "○ unavailable"} |`);
	}
	const facts: string[] = [];
	if (outcome.stepsTotal !== undefined) facts.push(`steps ${outcome.stepsOk ?? 0}/${outcome.stepsTotal}`);
	if (outcome.screenshots !== undefined) facts.push(`${outcome.screenshots} screenshot(s)`);
	if (outcome.video) facts.push(`video ${outcome.video}`);
	if (outcome.evidence) facts.push(`evidence ${outcome.evidence}`);
	if (facts.length) lines.push("", facts.join(" · "));
	if (outcome.missing?.length) lines.push("", `missing: ${outcome.missing.join("; ")}`);
	if (outcome.evidencePath) lines.push("", `evidence: \`${outcome.evidencePath}\``);
	if (outcome.runDir) lines.push(`run: \`${outcome.runDir}\``);
	return lines.join("\n");
}

/** The whole command, testable without pi: returns the outcome it also rendered. */
export async function runLocalDevVerify(ctx: any, args: LocalDevArgs, deps: LocalDevVerifyDeps): Promise<LocalDevOutcome> {
	const startedAt = Date.now();
	const cwd = deps.cwd(ctx);
	const settings = deps.settings();
	const workers = args.workers ?? Math.max(1, Math.min(MAX_WORKERS, settings.workerFanOut || 1));
	const store = deps.store();
	const { runId, dir: runDir } = store.open({ projectSlug: RunStore.projectSlug(cwd), cwd, command: "local-dev-verify", status: "running", phases: ["probe", "sim-users", "verify", "report"] });
	const setStatus = (text: string | undefined) => {
		try {
			(deps.setStatus ?? ((c: any, t: string | undefined) => c?.ui?.setStatus?.(STATUS_KEY, t)))(ctx, text);
		} catch {}
	};
	// The run settles on every path (completed | failed | aborted for "unavailable": nothing ran),
	// with run.start/run.end events like /workflow run, so the monitor and /workflow status see it end.
	try {
		store.appendEvent(runDir, "run.start", { command: "local-dev-verify", url: args.url ?? null, start: args.start ?? null, flows: args.flows ?? null, workers });
	} catch {}
	const finish = (outcome: LocalDevOutcome): LocalDevOutcome => {
		outcome.elapsedMs = Date.now() - startedAt;
		outcome.runId = runId;
		outcome.runDir = runDir;
		const runStatus = outcome.status === "completed" ? "completed" : outcome.status === "failed" ? "failed" : "aborted";
		try {
			store.updateRun(runDir, { status: runStatus, endedAt: new Date().toISOString() });
			store.appendEvent(runDir, "local-dev-verify.end", { status: outcome.status, reason: outcome.reason ?? null, url: outcome.url ?? null, driver: outcome.driver ?? null, flows: outcome.flows });
			store.appendEvent(runDir, "run.end", { status: runStatus, error: outcome.reason ?? null, elapsedMs: outcome.elapsedMs });
		} catch (error) {
			deps.notify(ctx, `local-dev-verify: could not settle the run record: ${error instanceof Error ? error.message : String(error)}`, "warning");
		}
		setStatus(undefined);
		deps.panel(ctx, `◆ LOCAL-DEV-VERIFY — ${outcome.status.toUpperCase()}`, formatLocalDevPanel(outcome));
		// One line the host also uses to repaint its bar rows.
		const passed = outcome.flows.filter((flow) => flow.status === "pass").length;
		deps.notify(ctx, outcome.status === "completed" ? `local-dev-verify: ${passed}/${outcome.flows.length} flows passed · evidence ${outcome.evidence ?? "none"} · run ${runId}` : `local-dev-verify: ${outcome.status}${outcome.reason ? ` — ${outcome.reason}` : ""} · run ${runId}`, outcome.status === "completed" ? "info" : "warning");
		return outcome;
	};
	const base: LocalDevOutcome = { status: "unavailable", workers, flows: [], elapsedMs: 0 };
	// 1. The app.
	let app: AppHandle | undefined;
	const recipe = args.start ? undefined : args.url ? undefined : detectRecipe(cwd, args.port);
	const startCommand = args.start ?? recipe?.command;
	let url = args.url ?? recipe?.url ?? (args.port ? `http://localhost:${args.port}` : DEFAULT_URL);
	if (startCommand) {
		const logFile = path.join(runDir, "app.log");
		app = (deps.spawnApp ?? spawnApp)(startCommand, cwd, logFile);
		base.appLog = logFile;
		base.started = startCommand;
		base.recipe = recipe;
		store.appendEvent(runDir, "local-dev-verify.app", { command: startCommand, pid: app.pid ?? null, log: logFile });
		setStatus(`local-dev-verify: starting \`${startCommand}\` …`);
	} else if (!args.url) {
		return finish({ ...base, reason: `no --url, no --start and no recipe recognised in ${cwd} (package.json scripts dev|start, Procfile web:, pyproject [project.scripts], index.html)` });
	}
	const stopApp = () => {
		try {
			app?.kill();
		} catch {}
	};
	try {
		// 2. The probe.
		setStatus(`local-dev-verify: probing ${url} …`);
		const probe = await probeUrl(url, { timeoutMs: args.timeoutMs, fetch: deps.fetch, log: app ? () => app!.readLog() : undefined, discover: !args.url && !recipe?.url, appExited: app ? () => app!.exited() : undefined });
		store.appendEvent(runDir, "local-dev-verify.probe", { url: probe.url, ok: probe.ok, status: probe.status ?? null, attempts: probe.attempts, elapsedMs: probe.elapsedMs, error: probe.error ?? null });
		url = probe.url;
		if (!probe.ok) {
			stopApp();
			return finish({ ...base, url, reason: `the app did not answer at ${url}: ${probe.error}${app ? ` — see ${app.logFile}` : ""}` });
		}
		// 3. The driver.
		const chromium = deps.chromium ? deps.chromium() : findChromium()?.path;
		const choice = chooseDriver({ which: deps.which, chromium });
		store.appendEvent(runDir, "local-dev-verify.driver", { driver: choice.driver, detail: choice.detail });
		if (choice.driver === "none") {
			stopApp();
			return finish({ ...base, url, reason: `unavailable: ${choice.detail}` });
		}
		// 4–5. The workflow.
		const flowsFile = args.flows ? path.resolve(cwd, args.flows) : undefined;
		if (flowsFile && !fs.existsSync(flowsFile)) {
			stopApp();
			return finish({ ...base, url, driver: choice.driver, reason: `--flows ${flowsFile} does not exist` });
		}
		const doc = buildLocalDevWorkflow({ url, workers, driver: choice.driver, video: args.video, flowsFile });
		const loaded = loadedFor(doc, runDir);
		store.updateRun(runDir, { workflow: { name: WORKFLOW_NAME, sha256: loaded.sha256 } });
		const runtime = deps.runtime(ctx, loaded, runId, runDir);
		const total = doc.nodes.length;
		let done = 0;
		setStatus(`local-dev-verify: ${choice.driver} · 0/${total} nodes`);
		const result = await executeWorkflow(loaded, runtime, {
			onNode: (node) => {
				done += 1;
				setStatus(`local-dev-verify: ${choice.driver} · ${done}/${total} nodes · ${node.nodeId} ${node.status} · ${fmtSecs(Date.now() - startedAt)}`);
			},
		});
		stopApp();
		// 6. Evidence + report.
		const verifyNode = result.nodes.verify;
		const output = (verifyNode?.output ?? {}) as { devices?: Record<string, "pass" | "fail" | "unavailable">; artifacts?: number; missing?: string[]; checks?: Record<string, unknown> };
		const pkg = readEvidencePackage(runDir, "verify");
		const flows: FlowRow[] = Object.entries(output.devices ?? {}).map(([name, status]) => ({ name, status }));
		const screenshots = pkg?.artifacts.filter((artifact) => artifact.kind === "screenshot" && artifact.sha256).length;
		const hasVideo = pkg?.artifacts.some((artifact) => artifact.kind === "video" && artifact.sha256);
		const missing = pkg?.missingInformation ?? output.missing ?? [];
		const evidencePath = pkg ? path.join(runDir, "evidence", "verify", "evidence.json") : undefined;
		const stepsFromReport = (() => {
			let ok = 0;
			let all = 0;
			const evidenceDir = path.join(runDir, "artifacts", "evidence", "verify");
			try {
				for (const entry of fs.readdirSync(evidenceDir)) {
					const file = path.join(evidenceDir, entry, "flow-result.json");
					if (!fs.existsSync(file)) continue;
					const report = JSON.parse(fs.readFileSync(file, "utf8")) as { steps?: Array<{ ok: boolean }> };
					all += report.steps?.length ?? 0;
					ok += report.steps?.filter((step) => step.ok).length ?? 0;
				}
			} catch {}
			return all ? { ok, all } : undefined;
		})();
		const summary = `${flows.filter((f) => f.status === "pass").length}/${flows.length} flows passed at ${url} via ${choice.driver}; evidence ${pkg?.status ?? "none"}${missing.length ? `; missing: ${missing.join("; ")}` : ""}`;
		store.appendEvent(runDir, "inbox.architect", { from: "local-dev-verify", summary, evidencePaths: [evidencePath, ...(pkg?.artifacts.map((artifact) => artifact.path) ?? [])].filter(Boolean), flows, status: result.status });
		const status: LocalDevOutcome["status"] = result.status === "completed" && verifyNode?.status === "success" ? "completed" : "failed";
		return finish({
			...base,
			status,
			url,
			driver: choice.driver,
			reason: status === "completed" ? undefined : (result.error ?? verifyNode?.error ?? `workflow ${result.status}`),
			flows,
			stepsOk: stepsFromReport?.ok,
			stepsTotal: stepsFromReport?.all,
			screenshots,
			video: !args.video ? "off" : hasVideo ? "yes" : "unavailable",
			evidence: pkg?.status,
			evidencePath,
			missing: missing.length ? missing : undefined,
			result,
		});
	} catch (error) {
		stopApp();
		return finish({ ...base, url, reason: error instanceof Error ? error.message : String(error) });
	}
}

export const HELP = `/local-dev-verify [--url <u>] [--start "<cmd>"] [--flows <file.json>] [--workers <n>] [--no-video] [--port <n>] [--timeout <s>]
  starts the app (or uses --url), probes it, lets sim-user workers write flows, replays them in a headless
  Chromium (or Kane) and hands the architect hashed screenshots, snapshots, console/network logs and a video.`;

export function registerLocalDevVerifyCommand(pi: ExtensionAPI, deps: LocalDevVerifyDeps): void {
	let inFlight = false;
	pi.registerCommand("local-dev-verify", {
		description: "Simulated users against a locally running app: start/probe, sim-user flows, headless-browser replay, hashed evidence for the architect. /local-dev-verify [--url <u>] [--start \"<cmd>\"] [--flows <file>] [--workers <n>] [--no-video]",
		handler: async (args: string, ctx: any) => {
			const parsed = parseLocalDevArgs(args ?? "");
			if (parsed.errors.length) return deps.notify(ctx, `Not run: ${parsed.errors.join("; ")}\n${HELP}`, "warning");
			if (inFlight) return deps.notify(ctx, "A /local-dev-verify run is already in flight.", "warning");
			inFlight = true;
			try {
				await runLocalDevVerify(ctx, parsed, deps);
			} finally {
				inFlight = false;
			}
		},
	} as any);
}
