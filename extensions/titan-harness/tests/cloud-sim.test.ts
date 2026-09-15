import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CLOUD_PROVIDERS, envProbe, formatProbeMatrix, probeAll, probeProvider, providerByName } from "../modules/cloud-providers.ts";
import { ADVICE_FILE, advicePath, cloudSimWorkflow, type CloudSimDeps, formatRunOutcome, helpText, parseCloudSimArgs, parseSetupResult, persistAdvice, readCursorConfig, registerCloudSimCommand, SETUP_SCHEMA } from "../modules/cmd-cloud-sim.ts";
import { readChain, sha256 } from "../modules/hash-chain.ts";
import { RunStore } from "../modules/run-store.ts";
import type { AgentRun } from "../modules/runtime.ts";
import { FULL_TOOLS, READONLY_TOOLS } from "../modules/runtime.ts";
import { DEFAULT_STACK_SETTINGS } from "../modules/stack-config.ts";
import type { ProcessResult, WorkflowRuntimeDeps } from "../modules/workflow/executor.ts";
import type { LoadedWorkflow } from "../modules/workflow/loader.ts";
import { CURSOR_KEY_ENV } from "../modules/workflow/runners/cursor-cloud.ts";
import { type RunnerContext, setRunnerFetch } from "../modules/workflow/runners/index.ts";

// ═══ Scaffolding ═════════════════════════════════════════════════════════════

const dirs: string[] = [];
const savedKey = process.env[CURSOR_KEY_ENV];
afterEach(() => {
	while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
	setRunnerFetch(undefined);
	if (savedKey === undefined) delete process.env[CURSOR_KEY_ENV];
	else process.env[CURSOR_KEY_ENV] = savedKey;
});
const scratch = (): string => {
	const dir = mkdtempSync(join(tmpdir(), "titan-cloud-sim-"));
	dirs.push(dir);
	return dir;
};
const FIXTURES = join(import.meta.dir, "fixtures");
const fixture = (name: string): string => readFileSync(join(FIXTURES, name), "utf8");
const KEY = "cur_test_key_do_not_leak_9f8e7d";

const vacant = { env: () => false, which: () => undefined, mcpEnabled: () => false };

/** The recorded Cursor API flow from the P4 runner tests. */
function cursorFetch() {
	const calls: Array<{ method: string; url: string; auth?: string }> = [];
	let polls = 0;
	const json = (status: number, body: unknown) => ({ status, ok: status < 300, json: async () => body, text: async () => JSON.stringify(body) });
	const text = (status: number, body: string) => ({ status, ok: status < 300, json: async () => JSON.parse(body), text: async () => body });
	const fetch: RunnerContext["fetch"] = async (url, init) => {
		calls.push({ method: init?.method ?? "GET", url, auth: init?.headers?.Authorization });
		if (url.endsWith("/v1/me")) return json(200, JSON.parse(fixture("cursor-me.json")));
		if (url.endsWith("/v1/agents") && init?.method === "POST") return json(200, JSON.parse(fixture("cursor-agent-created.json")));
		if (/\/v1\/agents\/[^/]+$/.test(url)) {
			polls += 1;
			return json(200, JSON.parse(fixture(polls === 1 ? "cursor-agent-running.json" : "cursor-agent-finished.json")));
		}
		if (url.endsWith("/artifacts")) return json(200, JSON.parse(fixture("cursor-artifacts.json")));
		if (url.includes("/download")) {
			const name = url.split("/artifacts/")[1].split("/download")[0];
			return text(200, name.endsWith(".xml") ? '<testsuite tests="42" failures="0"/>' : name.endsWith(".png") ? "png-bytes" : "run log line\n");
		}
		return json(404, {});
	};
	return { fetch, calls };
}

/** `'git' 'remote' 'get-url' 'origin'` → ["git", "remote", "get-url", "origin"] (the verify node's shell quoting). */
function argvOf(command: string): string[] {
	const out: string[] = [];
	for (const match of command.matchAll(/'((?:[^']|'\\'')*)'/g)) out.push(match[1].replace(/'\\''/g, "'"));
	return out;
}

const gitAnswer = (argv: string[]): ProcessResult => {
	if (argv[0] !== "git") return { code: 127, stdout: "", stderr: `${argv[0]}: not found` };
	if (argv[1] === "remote") return { code: 0, stdout: "https://github.com/example/proto-analytics\n", stderr: "" };
	if (argv[1] === "ls-remote") return { code: 0, stdout: argv[4] === "titan/run-test" ? "abc123\trefs/heads/titan/run-test\n" : "", stderr: "" };
	return { code: 1, stdout: "", stderr: "" };
};

function stubRuntime(cwd: string, loaded: LoadedWorkflow, runId: string, runDir: string, store: RunStore, notices: string[]): WorkflowRuntimeDeps {
	return {
		cwd,
		runId,
		runDir,
		artifactsDir: join(runDir, "artifacts"),
		workflowId: loaded.name,
		store,
		settings: DEFAULT_STACK_SETTINGS,
		async agent(req) {
			return { ok: true, text: `${req.nodeId} done`, usage: { tokensIn: 1, tokensOut: 1, costUsd: 0, tpsSeconds: 0 }, toolCalls: 0, model: req.model };
		},
		async bash(command) {
			return gitAnswer(argvOf(command));
		},
		async script() {
			return { code: 0, stdout: "", stderr: "" };
		},
		async approval() {
			return { approved: false };
		},
		notify(text) {
			notices.push(text);
		},
		resolveRole(role) {
			return { model: `stub/${role}`, thinking: "medium", callsign: `${role}-1`, appendSystemPrompts: [], tools: role === "architect" ? READONLY_TOOLS : FULL_TOOLS };
		},
	};
}

interface FakePi {
	handlers: Record<string, (args: string, ctx: any) => Promise<void>>;
}
function fakePi(): FakePi & { pi: any } {
	const handlers: FakePi["handlers"] = {};
	const pi = { registerCommand: (name: string, cfg: any) => void (handlers[name] = cfg.handler) };
	return { handlers, pi };
}

interface Captured {
	panels: Array<{ title: string; markdown: string }>;
	notices: Array<{ text: string; level?: string }>;
	confirms: string[];
	runtimeNotices: string[];
}

function command(options: { cwd: string; store: RunStore; env?: (name: string) => boolean; which?: (b: string) => string | undefined; mcpEnabled?: (s: string) => boolean; runChild?: CloudSimDeps["runChild"]; confirm?: boolean; skillText?: (skill: string) => string | undefined }) {
	const captured: Captured = { panels: [], notices: [], confirms: [], runtimeNotices: [] };
	const { pi, handlers } = fakePi();
	const deps: CloudSimDeps = {
		cwd: () => options.cwd,
		store: () => options.store,
		notify: (_ctx, text, level) => captured.notices.push({ text, level }),
		panel: (_ctx, title, markdown) => captured.panels.push({ title, markdown }),
		runtime: (_ctx, loaded, runId, runDir) => stubRuntime(options.cwd, loaded, runId, runDir, options.store, captured.runtimeNotices),
		confirm: async (_ctx, title) => {
			captured.confirms.push(title);
			return options.confirm ?? false;
		},
		which: options.which ?? (() => undefined),
		env: options.env ?? (() => false),
		mcpEnabled: options.mcpEnabled ?? (() => false),
		runChild: options.runChild ?? (async (opts) => opts.run),
		workerSeat: () => ({ model: "stub/worker", thinking: "medium", callsign: "scout", appendSystemPrompts: [], tools: FULL_TOOLS }),
		childTimeoutMs: () => 1000,
		pollMs: () => 1,
		skillText: options.skillText ?? (() => "# fake skill\nSetup: login first."),
	};
	registerCloudSimCommand(pi, deps);
	const run = (args: string) => handlers["cloud-simulated-users"](args, { cwd: options.cwd, hasUI: true });
	return { run, captured };
}

const allFiles = (root: string): string[] => {
	const out: string[] = [];
	const walk = (dir: string) => {
		for (const entry of readdirSync(dir)) {
			const full = join(dir, entry);
			if (statSync(full).isDirectory()) walk(full);
			else out.push(full);
		}
	};
	if (existsSync(root)) walk(root);
	return out.sort();
};

// ═══ Registry + probes ══════════════════════════════════════════════════════

describe("cloud-providers", () => {
	test("today's machine: every lane vacant, needs named, never a value", () => {
		const results = probeAll(vacant);
		expect(results.map((r) => r.provider)).toEqual(["cursor-cloud", "testmu-hyperexecute", "kane-remote", "momentic"]);
		expect(results.every((r) => !r.ready)).toBe(true);
		expect(results.find((r) => r.provider === "cursor-cloud")!.needs).toEqual(["env CURSOR_API_KEY", "binary git"]);
		expect(results.find((r) => r.provider === "testmu-hyperexecute")!.needs).toEqual(["mcp server testmu (enabled)"]);
		expect(results.find((r) => r.provider === "kane-remote")!.needs).toEqual(["binary kane-cli"]);
		expect(results.find((r) => r.provider === "momentic")!.needs).toEqual(["env MOMENTIC_API_KEY or MOMENTIC_CONFIG", "mcp server momentic (enabled)"]);
		const matrix = formatProbeMatrix(results);
		expect(matrix).toContain("○ vacant");
		expect(matrix).not.toContain("✓ ready");
		expect(matrix).toContain("| cursor-cloud |");
	});

	test("one ready lane with a fake env; the value never appears; aliases resolve", () => {
		const env = envProbe({ CURSOR_API_KEY: KEY, MOMENTIC_CONFIG: "" });
		expect(env("CURSOR_API_KEY")).toBe(true);
		expect(env("MOMENTIC_CONFIG")).toBe(false);
		const cursor = probeProvider(providerByName("cursor")!, { env, which: (b) => (b === "git" ? "/usr/bin/git" : undefined), mcpEnabled: () => false });
		expect(cursor.ready).toBe(true);
		expect(cursor.reason).toBe("ready");
		const matrix = formatProbeMatrix([cursor]);
		expect(matrix).toContain("✓ ready");
		expect(matrix).not.toContain(KEY);
		const kane = probeProvider(providerByName("kaneai")!, { env, which: (b) => (b === "kane-cli" ? "/usr/local/bin/kane-cli" : undefined), mcpEnabled: () => false });
		expect(kane.ready).toBe(true);
		const momentic = probeProvider(providerByName("momentic")!, { env: envProbe({ MOMENTIC_API_KEY: "x" }), which: () => undefined, mcpEnabled: (s) => s === "momentic" });
		expect(momentic.ready).toBe(true);
		expect(providerByName("nope")).toBeUndefined();
		expect(CLOUD_PROVIDERS.map((p) => p.runner)).toEqual(["cursor-cloud", "testmu", "kane", "momentic"]);
	});
});

// ═══ Arguments, workflow doc, cursor config ════════════════════════════════

describe("cmd-cloud-sim: pure parts", () => {
	test("parseCloudSimArgs", () => {
		expect(parseCloudSimArgs("")).toMatchObject({ verb: "probe", errors: [] });
		expect(parseCloudSimArgs('run cursor --objective "Run the suite" --devices "iPhone 15, Pixel 8" --ref titan/x')).toMatchObject({ verb: "run", provider: "cursor", objective: "Run the suite", devices: ["iPhone 15", "Pixel 8"], ref: "titan/x", errors: [] });
		expect(parseCloudSimArgs("run kane Smoke the checkout flow")).toMatchObject({ verb: "run", provider: "kane", objective: "Smoke the checkout flow" });
		expect(parseCloudSimArgs("run cursor").errors[0]).toContain("--objective");
		expect(parseCloudSimArgs("setup").errors[0]).toContain("needs a provider");
		expect(parseCloudSimArgs("run cursor --objective x --bogus").errors[0]).toContain("--bogus");
		expect(parseCloudSimArgs("frobnicate")).toMatchObject({ verb: "help" });
		expect(helpText()).toContain("/cloud-simulated-users run <provider>");
	});

	test("cloudSimWorkflow: one valid verify node per lane; cursor reads .titan/cursor.yaml", () => {
		const cwd = scratch();
		mkdirSync(join(cwd, ".titan"), { recursive: true });
		writeFileSync(join(cwd, ".titan", "cursor.yaml"), "env:\n  type: ubuntu-22.04\n  name: default\nrepo: https://github.com/example/proto-analytics\nstartingRef: titan/<runId>   # per run\napi_base: https://api.cursor.com\ncredentials:\n  api_key_env: CURSOR_API_KEY\n");
		expect(readCursorConfig(cwd)).toEqual({ repo: "https://github.com/example/proto-analytics", ref: "titan/<runId>", api_base: "https://api.cursor.com", env: { type: "ubuntu-22.04", name: "default" } });
		const cursor = cloudSimWorkflow({ provider: providerByName("cursor-cloud")!, objective: "Run the analytics suite", runId: "run-x", cwd });
		expect(cursor.loaded.validation.ok).toBe(true);
		expect(cursor.doc.nodes[0]).toMatchObject({ id: "verify", verify: { runner: "cursor-cloud", objective: "Run the analytics suite", ref: "titan/run-x", repo: "https://github.com/example/proto-analytics" }, evidence: { require: ["report"] } });
		const kane = cloudSimWorkflow({ provider: providerByName("kane-remote")!, objective: "Checkout", devices: ["iPhone 15"], runId: "r", cwd });
		expect(kane.loaded.validation.ok).toBe(true);
		expect(kane.doc.nodes[0]).toMatchObject({ verify: { runner: "kane", devices: ["iPhone 15"], remote: true }, evidence: { require: ["log"] } });
		const momentic = cloudSimWorkflow({ provider: providerByName("momentic")!, objective: "x", runId: "r", cwd });
		expect((momentic.doc.nodes[0] as any).verify.enabled).toBe(true);
		expect(readCursorConfig(scratch())).toEqual({});
	});

	test("parseSetupResult finds the JSON in prose; persistAdvice writes only the advice file and drops credential values", () => {
		const cwd = scratch();
		const parsed = parseSetupResult('Here you go:\n{"provider":"kane-remote","advice_markdown":"# Kane\\nlogin first","steps":["npm i -g @testmuai/kane-cli"],"installs":["npm i -g @testmuai/kane-cli"],"credentials_needed":["TESTMU_API_KEY=abcd1234efgh5678"]}\nthanks');
		expect(parsed).toMatchObject({ provider: "kane-remote", steps: ["npm i -g @testmuai/kane-cli"] });
		expect(parseSetupResult("no json here")).toBeUndefined();
		expect(SETUP_SCHEMA.required).toEqual(["provider", "advice_markdown"]);
		const provider = providerByName("kane-remote")!;
		const probe = probeProvider(provider, vacant);
		const before = allFiles(cwd);
		const written = persistAdvice(cwd, provider, { ...parsed!, advice_markdown: "# Kane\nlogin first\napi_key: sk-live-0123456789abcdef\nthen run" }, probe);
		expect(written.path).toBe(advicePath(cwd));
		expect(written.path.endsWith(ADVICE_FILE)).toBe(true);
		const text = readFileSync(written.path, "utf8");
		expect(text).toContain("## kane-remote — KaneAI on cloud devices");
		expect(text).toContain("login first");
		expect(text).not.toContain("sk-live-0123456789abcdef");
		expect(text).not.toContain("abcd1234efgh5678");
		expect(text).toContain("TESTMU_API_KEY (name only)");
		expect(written.dropped).toBe(1);
		expect(written.sha256).toBe(sha256(text));
		expect(allFiles(cwd)).toEqual([...before, written.path].sort());
		// Re-running replaces the section instead of appending a second one.
		persistAdvice(cwd, provider, { provider: "kane-remote", advice_markdown: "# Kane v2" }, probe);
		const again = readFileSync(written.path, "utf8");
		expect(again.split("## kane-remote").length).toBe(2);
		expect(again).toContain("# Kane v2");
		expect(again).not.toContain("login first");
	});
});

// ═══ The command ════════════════════════════════════════════════════════════

describe("cmd-cloud-sim: /cloud-simulated-users", () => {
	test("probe (default) prints the matrix panel", async () => {
		const cwd = scratch();
		const { run, captured } = command({ cwd, store: new RunStore(join(cwd, "runs")) });
		await run("");
		expect(captured.panels[0].title).toContain("PROBE");
		expect(captured.panels[0].markdown).toContain("0/4 lanes ready");
		expect(captured.panels[0].markdown).toContain("○ vacant");
	});

	test("setup: the read-only child answers, the host persists advice under .titan/terraform only, installs are printed not run", async () => {
		const cwd = scratch();
		const store = new RunStore(join(scratch(), "runs"));
		const childCalls: any[] = [];
		const runChild: CloudSimDeps["runChild"] = async (opts) => {
			childCalls.push(opts);
			const run = opts.run as AgentRun;
			run.status = "done";
			run.text = 'Advice:\n{"provider":"kane-remote","advice_markdown":"# Kane on this project\\nSimulate the checkout and the signup flows.","steps":["kane-cli login"],"installs":["npm i -g @testmuai/kane-cli"],"credentials_needed":["TESTMU_API_KEY"]}';
			run.exitCode = 0;
			return run;
		};
		const { run, captured } = command({ cwd, store, runChild });
		const before = allFiles(cwd);
		await run("setup kane");
		expect(childCalls).toHaveLength(1);
		expect(childCalls[0].tools).toBe(READONLY_TOOLS);
		expect(childCalls[0].prompt).toContain("kane-remote");
		expect(childCalls[0].prompt).toContain("fake skill");
		expect(childCalls[0].prompt).toContain("Never print, guess or request credential VALUES");
		const advice = readFileSync(advicePath(cwd), "utf8");
		expect(advice).toContain("Simulate the checkout and the signup flows.");
		expect(advice).toContain("npm i -g @testmuai/kane-cli");
		expect(allFiles(cwd)).toEqual([...before, advicePath(cwd)].sort());
		expect(captured.confirms).toHaveLength(1); // installs offered, declined → not run
		expect(captured.panels.at(-1)!.markdown).toContain("printed, not run");
		const runs = store.listRuns(RunStore.projectSlug(cwd));
		expect(runs).toHaveLength(1);
		const events = readChain(join(store.dir(runs[0].runId, runs[0].projectSlug), "events.jsonl")).map((row) => row.type);
		expect(events).toContain("cloud-sim.setup.start");
		expect(events).toContain("cloud-sim.setup.end");
		// A child without a JSON answer writes nothing.
		const cwd2 = scratch();
		const silent = command({ cwd: cwd2, store, runChild: async (opts) => Object.assign(opts.run, { status: "done", text: "I could not determine anything.", exitCode: 0 }) });
		await silent.run("setup cursor");
		expect(existsSync(advicePath(cwd2))).toBe(false);
		expect(silent.captured.notices.at(-1)!.text).toContain("Nothing was written");
	});

	test("run cursor-cloud through the recorded API: cloud-sim.* events, a hashed evidence package, and no key anywhere", async () => {
		const cwd = scratch();
		const storeRoot = scratch();
		const store = new RunStore(join(storeRoot, "runs"));
		process.env[CURSOR_KEY_ENV] = KEY;
		const api = cursorFetch();
		setRunnerFetch(api.fetch);
		const { run, captured } = command({ cwd, store, env: (name) => name === CURSOR_KEY_ENV, which: (b) => (b === "git" ? "/usr/bin/git" : undefined) });
		mkdirSync(join(cwd, ".titan"), { recursive: true });
		writeFileSync(join(cwd, ".titan", "cursor.yaml"), "startingRef: titan/run-test\n");
		await run('run cursor --objective "Run the analytics dashboard suite"');
		const runs = store.listRuns(RunStore.projectSlug(cwd));
		expect(runs).toHaveLength(1);
		const dir = store.dir(runs[0].runId, runs[0].projectSlug);
		const events = readChain(join(dir, "events.jsonl"));
		const types = events.map((row) => row.type);
		expect(types.filter((t) => t.startsWith("cloud-sim.")).length).toBeGreaterThanOrEqual(3);
		expect(types).toContain("cloud-sim.preflight");
		expect(types).toContain("cloud-sim.started");
		expect(types.filter((t) => t === "cloud-sim.exec").length).toBeGreaterThanOrEqual(2);
		expect(types).toContain("evidence.captured");
		expect(types).toContain("cloud-sim.finished");
		const finished = events.find((row) => row.type === "cloud-sim.finished")!.data as Record<string, unknown>;
		expect(finished.status).toBe("completed");
		expect(finished.evidence).toBe("matched");
		expect(typeof finished.sha256).toBe("string");
		const evidenceFile = join(dir, "evidence", "verify", "evidence.json");
		expect(existsSync(evidenceFile)).toBe(true);
		expect(sha256(readFileSync(evidenceFile))).toBe(finished.sha256);
		const pkg = JSON.parse(readFileSync(evidenceFile, "utf8"));
		expect(pkg.status).toBe("matched");
		expect(pkg.artifacts.map((a: any) => a.kind).sort()).toEqual(["log", "report", "screenshot", "test-result"]);
		expect(api.calls.map((c) => c.method)).toEqual(["GET", "POST", "GET", "GET", "GET", "GET", "GET", "GET"]);
		expect(api.calls.every((c) => c.auth === `Bearer ${KEY}`)).toBe(true);
		const panel = captured.panels.at(-1)!;
		expect(panel.title).toContain("COMPLETED");
		expect(panel.markdown).toContain((finished.sha256 as string).slice(0, 16));
		expect(panel.markdown).toContain("cursor-cloud");
		// The key never lands in the store, the panel or a notice.
		for (const file of allFiles(dir)) expect(readFileSync(file, "utf8")).not.toContain(KEY);
		expect(JSON.stringify(captured)).not.toContain(KEY);
		expect(store.readRun(dir)?.status).toBe("completed");
	});

	test("a vacant provider refuses to run and names what is missing; advice reports the missing file", async () => {
		const cwd = scratch();
		const store = new RunStore(join(scratch(), "runs"));
		const { run, captured } = command({ cwd, store });
		await run('run cursor --objective "x"');
		expect(captured.notices.at(-1)!.level).toBe("warning");
		expect(captured.notices.at(-1)!.text).toContain("vacant");
		expect(captured.notices.at(-1)!.text).toContain("CURSOR_API_KEY");
		expect(store.listRuns(RunStore.projectSlug(cwd))).toHaveLength(0);
		await run("run momentic --objective x");
		expect(captured.notices.at(-1)!.text).toContain("MOMENTIC_API_KEY or MOMENTIC_CONFIG");
		await run("advice");
		expect(captured.notices.at(-1)!.text).toContain("remote-testing.md");
	});

	test("formatRunOutcome renders the lane table with the evidence hash", () => {
		const provider = providerByName("cursor-cloud")!;
		const md = formatRunOutcome(provider, { runId: "r", status: "completed", nodes: { verify: { nodeId: "verify", type: "verify", status: "success", output: {}, startedAt: "", endedAt: "", attempts: 1 } } } as any, { runId: "r", runDir: "/tmp/r", elapsedMs: 1500, evidence: { sha256: "abcdef0123456789abcdef", status: "matched", kinds: ["report"], path: "/tmp/r/evidence/verify/evidence.json" } });
		expect(md).toContain("`abcdef0123456789…`");
		expect(md).toContain("matched");
		expect(md).toContain("kinds: report");
	});
});
