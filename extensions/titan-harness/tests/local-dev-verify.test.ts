import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import * as http from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { findChromium } from "../modules/cdp-browser.ts";
import {
	buildLocalDevWorkflow,
	chooseDriver,
	COLLECT_SCRIPT,
	detectRecipe,
	discoverUrlFromLog,
	FLOWS_SCHEMA,
	formatLocalDevPanel,
	type LocalDevVerifyDeps,
	loadedFor,
	parseLocalDevArgs,
	probeUrl,
	runLocalDevVerify,
	spawnApp,
	WORKFLOW_NAME,
} from "../modules/cmd-local-dev-verify.ts";
import { readChain } from "../modules/hash-chain.ts";
import { RunStore } from "../modules/run-store.ts";
import { FULL_TOOLS, READONLY_TOOLS } from "../modules/runtime.ts";
import { DEFAULT_STACK_SETTINGS } from "../modules/stack-config.ts";
import { runProcess } from "../modules/workflow-runtime.ts";
import type { AgentRequest, WorkflowRuntimeDeps } from "../modules/workflow/executor.ts";
import { validateJson } from "../modules/workflow/json-schema.ts";
import { validateWorkflow } from "../modules/workflow/validator.ts";

// ═══ Scaffolding ═════════════════════════════════════════════════════════════

const dirs: string[] = [];
afterEach(() => {
	while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});
const scratch = (): string => {
	const dir = mkdtempSync(join(tmpdir(), "titan-ldv-"));
	dirs.push(dir);
	return dir;
};

const SITE = join(import.meta.dir, "fixtures", "site");
let server: http.Server;
let base = "";
beforeAll(async () => {
	server = http.createServer((req, res) => {
		if (req.url === "/api/ping") {
			res.setHeader("content-type", "application/json");
			res.end(JSON.stringify({ pong: true }));
			return;
		}
		const file = join(SITE, req.url === "/" ? "index.html" : (req.url ?? "").replace(/^\//, "").split("?")[0]);
		if (!existsSync(file)) {
			res.statusCode = 404;
			res.end("not found");
			return;
		}
		res.setHeader("content-type", "text/html; charset=utf-8");
		res.end(readFileSync(file));
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
	base = `http://127.0.0.1:${(server.address() as { port: number }).port}/`;
});
afterAll(() => server?.close());

/** A port nothing listens on. */
async function closedPort(): Promise<number> {
	const probe = http.createServer();
	await new Promise<void>((resolve) => probe.listen(0, "127.0.0.1", () => resolve()));
	const port = (probe.address() as { port: number }).port;
	await new Promise<void>((resolve) => probe.close(() => resolve()));
	return port;
}

const chromium = findChromium();
const withChromium = chromium ? test : test.skip;

// ═══ Pure parts ═════════════════════════════════════════════════════════════

describe("parseLocalDevArgs", () => {
	test("flags, quoted commands, defaults and errors", () => {
		expect(parseLocalDevArgs("")).toMatchObject({ video: true, timeoutMs: 60_000, errors: [] });
		const parsed = parseLocalDevArgs(`--url http://localhost:5173 --start "npm run dev -- --port 5173" --flows flows.json --workers 9 --no-video --port 5173 --timeout 15`);
		expect(parsed).toMatchObject({ url: "http://localhost:5173", start: "npm run dev -- --port 5173", flows: "flows.json", workers: 5, video: false, port: 5173, timeoutMs: 15_000, errors: [] });
		expect(parseLocalDevArgs("--url ftp://x").errors[0]).toContain("http(s)");
		expect(parseLocalDevArgs("--workers zero").errors[0]).toContain("positive integer");
		expect(parseLocalDevArgs("--bogus").errors[0]).toContain("unknown argument");
		expect(parseLocalDevArgs("--start").errors[0]).toContain("needs a command");
	});
});

describe("detectRecipe", () => {
	const project = (files: Record<string, string>): string => {
		const dir = scratch();
		for (const [name, text] of Object.entries(files)) writeFileSync(join(dir, name), text);
		return dir;
	};
	test("package.json dev by lockfile, then start; Procfile; pyproject scripts; static index; nothing", () => {
		expect(detectRecipe(project({ "package.json": JSON.stringify({ scripts: { dev: "vite" } }) }))).toMatchObject({ kind: "npm-dev", command: "npm run dev" });
		expect(detectRecipe(project({ "package.json": JSON.stringify({ scripts: { dev: "vite" } }), "bun.lockb": "" }))).toMatchObject({ kind: "bun-dev", command: "bun run dev" });
		expect(detectRecipe(project({ "package.json": JSON.stringify({ scripts: { dev: "vite" } }), "pnpm-lock.yaml": "" }))).toMatchObject({ kind: "pnpm-dev", command: "pnpm dev" });
		expect(detectRecipe(project({ "package.json": JSON.stringify({ scripts: { dev: "vite" } }), "yarn.lock": "" }))).toMatchObject({ kind: "yarn-dev", command: "yarn dev" });
		expect(detectRecipe(project({ "package.json": JSON.stringify({ scripts: { start: "node server.js" } }) }))).toMatchObject({ kind: "npm-start", command: "npm start" });
		expect(detectRecipe(project({ Procfile: "worker: node worker.js\nweb: gunicorn app:app --bind 127.0.0.1:8000\n" }))).toMatchObject({ kind: "procfile", command: "gunicorn app:app --bind 127.0.0.1:8000" });
		expect(detectRecipe(project({ "pyproject.toml": "[project]\nname = 'x'\n\n[project.scripts]\nserve = 'x.main:run'\n\n[tool.uv]\n" }))).toMatchObject({ kind: "uv", command: "uv run serve" });
		expect(detectRecipe(project({ "pyproject.toml": "[project]\nname = 'x'\ndependencies = ['fastapi']\n" }))).toMatchObject({ kind: "uv", command: "uv run python -m app" });
		expect(detectRecipe(project({ "index.html": "<html></html>" }), 8123)).toMatchObject({ kind: "static", command: "python3 -m http.server 8123 --bind 127.0.0.1", url: "http://127.0.0.1:8123/" });
		expect(detectRecipe(project({}))).toBeUndefined();
	});
});

describe("probe + discovery + driver", () => {
	test("discoverUrlFromLog finds the announced URL", () => {
		expect(discoverUrlFromLog("VITE v5 ready\n  ➜  Local:   http://localhost:5173/\n")).toBe("http://localhost:5173/");
		expect(discoverUrlFromLog("Listening on http://0.0.0.0:8000")).toBe("http://127.0.0.1:8000");
		expect(discoverUrlFromLog("nothing here")).toBeUndefined();
	});

	test("probeUrl answers ok against the fixture server and times out against a closed port", async () => {
		const ok = await probeUrl(base, { timeoutMs: 5_000, intervalMs: 100 });
		expect(ok).toMatchObject({ ok: true, status: 200, url: base });
		const port = await closedPort();
		const dead = await probeUrl(`http://127.0.0.1:${port}/`, { timeoutMs: 600, intervalMs: 100 });
		expect(dead.ok).toBe(false);
		expect(dead.attempts).toBeGreaterThanOrEqual(2);
		expect(dead.error).toContain("no 2xx/3xx answer");
		// The log announces a better URL when the user gave none.
		const discovered = await probeUrl(`http://127.0.0.1:${port}/`, { timeoutMs: 5_000, intervalMs: 50, discover: true, log: () => `server ready at ${base}` });
		expect(discovered).toMatchObject({ ok: true, url: base });
		// An app that exits ends the probe early.
		const exited = await probeUrl(`http://127.0.0.1:${port}/`, { timeoutMs: 5_000, intervalMs: 50, appExited: () => true });
		expect(exited.ok).toBe(false);
		expect(exited.error).toContain("exited");
	});

	test("chooseDriver prefers Kane, then Chromium, else none", () => {
		expect(chooseDriver({ which: (b) => (b === "kane-cli" ? "/usr/bin/kane-cli" : undefined), chromium: "/x/chrome" })).toMatchObject({ driver: "kane" });
		expect(chooseDriver({ which: () => undefined, chromium: "/x/chrome" })).toMatchObject({ driver: "cdp-browser" });
		expect(chooseDriver({ which: () => undefined })).toMatchObject({ driver: "none" });
	});

	test("spawnApp runs the command in its own group, logs to the file and can be killed", async () => {
		const dir = scratch();
		const app = spawnApp("echo hello-from-app; sleep 30", dir, join(dir, "app.log"));
		await new Promise((resolve) => setTimeout(resolve, 300));
		expect(app.readLog()).toContain("hello-from-app");
		expect(app.exited()).toBe(false);
		app.kill();
		await new Promise((resolve) => setTimeout(resolve, 300));
		expect(app.exited()).toBe(true);
	});
});

describe("the generated workflow", () => {
	test("validates for both drivers, with workers and with a flows file; the sim-user nodes carry the schema and the snapshot", () => {
		for (const driver of ["cdp-browser", "kane"] as const) {
			const doc = buildLocalDevWorkflow({ url: "http://localhost:3000", workers: 3, driver, video: true, cli: "/pkg/scripts/cdp-browser.mjs" });
			expect(doc.name).toBe(WORKFLOW_NAME);
			const result = validateWorkflow(doc, { dir: "", commandDirs: [], scriptDirs: [], workflowNames: [] });
			expect(result.errors).toEqual([]);
			expect(result.ok).toBe(true);
			expect(doc.nodes.map((node) => node.id)).toEqual(["probe", "snapshot", "sim-user-1", "sim-user-2", "sim-user-3", "collect", "verify", "report"]);
			const sim = doc.nodes.find((node) => node.id === "sim-user-2") as { prompt: string; output_format: unknown; allowed_tools: string[]; role: string; context: string };
			expect(sim.role).toBe("worker");
			expect(sim.allowed_tools).toEqual([]);
			expect(sim.context).toBe("fresh");
			expect(sim.output_format).toBe(FLOWS_SCHEMA);
			expect(sim.prompt).toContain("worker 2 of 3");
			expect(sim.prompt).toContain("$snapshot.output");
			expect(sim.prompt).toContain("http://localhost:3000");
			const verify = doc.nodes.find((node) => node.id === "verify") as { verify: Record<string, unknown>; evidence: { require: string[] } };
			expect(verify.verify.runner).toBe(driver);
			if (driver === "cdp-browser") expect(verify.evidence.require).toEqual(["screenshot", "snapshot", "console-log", "network-log"]);
			const loaded = loadedFor(doc, scratch());
			expect(loaded.validation.ok).toBe(true);
			expect(loaded.sha256).toHaveLength(64);
		}
		const withFile = buildLocalDevWorkflow({ url: "http://localhost:3000", workers: 2, driver: "cdp-browser", video: false, flowsFile: "/tmp/flows.json", cli: "/pkg/cli.mjs" });
		expect(withFile.nodes.map((node) => node.id)).toEqual(["probe", "snapshot", "collect", "verify", "report"]);
		expect((withFile.nodes.find((node) => node.id === "collect") as { bash: string }).bash).toContain("cp '/tmp/flows.json' $ARTIFACTS_DIR/flows.json");
		expect(validateWorkflow(withFile, { dir: "", commandDirs: [], scriptDirs: [], workflowNames: [] }).ok).toBe(true);
	});

	test("the flows schema accepts a worker answer and rejects a flow without steps; the collect script merges and dedupes", async () => {
		const good = { flows: [{ name: "hello", description: "say hi", steps: [{ fill: { selector: "#name", value: "A" } }, { click: "Say hello" }, { expect: "Hello, A" }] }] };
		expect(validateJson(good, FLOWS_SCHEMA)).toEqual([]);
		expect(validateJson({ flows: [{ name: "x" }] }, FLOWS_SCHEMA).length).toBeGreaterThan(0);
		expect(validateJson({ flows: "no" }, FLOWS_SCHEMA).length).toBeGreaterThan(0);
		const dir = scratch();
		const args = [JSON.stringify(good), JSON.stringify({ flows: [{ name: "HELLO", steps: [{ snapshot: true }] }, { name: "second", steps: [{ click: "x" }] }] }), "$sim-user-3.output", "not json"];
		const result = await runProcess("node", ["-e", COLLECT_SCRIPT, ...args], { cwd: dir, timeoutMs: 10_000, env: { ARTIFACTS_DIR: dir, APP_URL: "http://app/" } });
		expect(result.code).toBe(0);
		const summary = JSON.parse(result.stdout);
		expect(summary).toMatchObject({ flows: 2, names: ["hello", "second"] });
		expect(summary.objectiveText).toContain("1. hello — say hi: fill");
		const written = JSON.parse(readFileSync(join(dir, "flows.json"), "utf8"));
		expect(written.flows.map((flow: { name: string; url: string }) => [flow.name, flow.url])).toEqual([
			["hello", "http://app/"],
			["second", "http://app/"],
		]);
	});

	test("formatLocalDevPanel renders the rows and the verdict", () => {
		const text = formatLocalDevPanel({ status: "completed", url: "http://x/", driver: "cdp-browser", workers: 2, flows: [{ name: "a", status: "pass" }, { name: "b", status: "fail" }], stepsOk: 5, stepsTotal: 6, screenshots: 6, video: "unavailable", evidence: "matched", evidencePath: "/r/evidence/verify/evidence.json", missing: ["video: unavailable (ffmpeg not found)"], elapsedMs: 4200 });
		expect(text).toContain("✓ completed");
		expect(text).toContain("| a | ✓ pass |");
		expect(text).toContain("| b | ✗ fail |");
		expect(text).toContain("steps 5/6 · 6 screenshot(s) · video unavailable · evidence matched");
		expect(text).toContain("missing: video: unavailable");
		expect(formatLocalDevPanel({ status: "unavailable", reason: "no Kane, no Chromium", workers: 1, flows: [], elapsedMs: 10 })).toContain("○ unavailable");
	});
});

// ═══ The command end to end ═════════════════════════════════════════════════

interface Harness {
	deps: LocalDevVerifyDeps;
	store: RunStore;
	panels: Array<{ title: string; markdown: string }>;
	notices: string[];
	agentCalls: AgentRequest[];
	runtimeCalls: number;
}

function harness(options: { answer?: (req: AgentRequest) => string; which?: (binary: string) => string | undefined; chromium?: () => string | undefined } = {}): Harness {
	const store = new RunStore(join(scratch(), "runs"));
	const panels: Array<{ title: string; markdown: string }> = [];
	const notices: string[] = [];
	const agentCalls: AgentRequest[] = [];
	const h: Harness = { store, panels, notices, agentCalls, runtimeCalls: 0, deps: undefined as unknown as LocalDevVerifyDeps };
	h.deps = {
		cwd: () => scratch(),
		store: () => store,
		notify: (_ctx, text) => notices.push(text),
		panel: (_ctx, title, markdown) => panels.push({ title, markdown }),
		settings: () => ({ ...DEFAULT_STACK_SETTINGS, workerFanOut: 2 }),
		which: options.which ?? (() => undefined),
		chromium: options.chromium ?? (() => chromium?.path),
		runtime: (_ctx, loaded, runId, runDir): WorkflowRuntimeDeps => {
			h.runtimeCalls += 1;
			return {
				cwd: loaded.dir,
				runId,
				runDir,
				artifactsDir: join(runDir, "artifacts"),
				workflowId: loaded.name,
				store,
				settings: { ...DEFAULT_STACK_SETTINGS, workerFanOut: 2 },
				async agent(req) {
					agentCalls.push(req);
					const text = options.answer ? options.answer(req) : JSON.stringify({ flows: [{ name: "say hello", description: "greet", steps: [{ fill: { selector: "#name", value: "Zed" } }, { click: "Say hello" }, { expect: "Hello, Zed!" }] }] });
					return { ok: true, text, sessionRef: `sess-${req.nodeId}`, usage: { tokensIn: 50, tokensOut: 20, costUsd: 0.0005, tpsSeconds: 1 }, toolCalls: 0, model: req.model };
				},
				bash: (command, opts) => runProcess("bash", ["-c", command], { cwd: opts.cwd, timeoutMs: opts.timeoutMs, env: opts.env, signal: opts.signal }),
				script: async () => ({ code: 0, stdout: "", stderr: "" }),
				approval: async () => ({ approved: false }),
				notify: (text) => notices.push(text),
				resolveRole: (role) => ({ model: `stub/${role}`, thinking: "medium", callsign: `${role}-1`, appendSystemPrompts: [], tools: role === "architect" ? READONLY_TOOLS : FULL_TOOLS }),
			};
		},
	};
	return h;
}

describe("runLocalDevVerify", () => {
	test("probe timeout → unavailable, no workflow run, the app is stopped", async () => {
		const h = harness();
		const port = await closedPort();
		const outcome = await runLocalDevVerify({}, { url: `http://127.0.0.1:${port}/`, video: false, timeoutMs: 700, errors: [] }, h.deps);
		expect(outcome.status).toBe("unavailable");
		expect(outcome.reason).toContain("did not answer");
		expect(h.runtimeCalls).toBe(0);
		expect(h.panels.at(-1)?.title).toContain("UNAVAILABLE");
		const run = JSON.parse(readFileSync(join(outcome.runDir!, "run.json"), "utf8"));
		expect(run.status).toBe("aborted"); // nothing ran: the run is settled as aborted, never left running
		expect(typeof run.endedAt).toBe("string");
		const events = readChain(join(outcome.runDir!, "events.jsonl"));
		expect(events.map((row) => row.type)).toEqual(["run.start", "local-dev-verify.probe", "local-dev-verify.end", "run.end"]);
		expect((events.at(-1)!.data as { status: string; error: string }).status).toBe("aborted");
		expect((events.at(-1)!.data as { error: string }).error).toContain("did not answer");
		expect(h.notices.at(-1)).toContain("local-dev-verify: unavailable");
	});

	test("no Kane and no Chromium → unavailable, never a silent pass", async () => {
		const h = harness({ chromium: () => undefined });
		const outcome = await runLocalDevVerify({}, { url: base, video: false, timeoutMs: 5_000, errors: [] }, h.deps);
		expect(outcome.status).toBe("unavailable");
		expect(outcome.reason).toContain("no Kane");
		expect(outcome.reason).toContain("no Chromium");
		expect(h.runtimeCalls).toBe(0);
	});

	test("no url, no start and no recipe → unavailable with the reason", async () => {
		const h = harness();
		const outcome = await runLocalDevVerify({}, { video: false, timeoutMs: 1_000, errors: [] }, h.deps);
		expect(outcome.status).toBe("unavailable");
		expect(outcome.reason).toContain("no recipe recognised");
	});

	withChromium(
		"end to end against the fixture site: workers write flows, the driver replays them, the evidence package is matched and the architect inbox row lands",
		async () => {
			const h = harness();
			const outcome = await runLocalDevVerify({}, { url: base, workers: 2, video: false, timeoutMs: 10_000, errors: [] }, h.deps);
			expect(outcome.reason).toBeUndefined();
			expect(outcome.status).toBe("completed");
			expect(outcome.driver).toBe("cdp-browser");
			expect(h.runtimeCalls).toBe(1);
			expect(h.agentCalls.map((req) => req.nodeId).sort()).toEqual(["sim-user-1", "sim-user-2"]);
			expect(h.agentCalls[0].tools).toBe("none");
			expect(h.agentCalls[0].prompt).toContain("[button] Say hello"); // the snapshot reached the worker
			expect(h.agentCalls[0].prompt).not.toContain("$snapshot.output");
			expect(outcome.flows).toEqual([{ name: "say hello", status: "pass" }]);
			expect(outcome.evidence).toBe("matched");
			expect(outcome.screenshots).toBeGreaterThanOrEqual(3);
			expect(outcome.video).toBe("off");
			expect(existsSync(outcome.evidencePath!)).toBe(true);
			const events = readChain(join(outcome.runDir!, "events.jsonl"));
			const inbox = events.find((row) => row.type === "inbox.architect");
			expect(inbox).toBeDefined();
			expect((inbox!.data as { summary: string }).summary).toContain("1/1 flows passed");
			expect((inbox!.data as { evidencePaths: string[] }).evidencePaths.length).toBeGreaterThan(3);
			expect(events.map((row) => row.type)).toContain("node.end");
			const panel = h.panels.at(-1)!;
			expect(panel.title).toContain("COMPLETED");
			expect(panel.markdown).toContain("| say hello | ✓ pass |");
			expect(panel.markdown).toContain("evidence matched");
			const run = JSON.parse(readFileSync(join(outcome.runDir!, "run.json"), "utf8"));
			expect(run.status).toBe("completed");
			expect(run.workflow.name).toBe(WORKFLOW_NAME);
			expect(events.at(-1)?.type).toBe("run.end");
			expect(h.notices.at(-1)).toContain("1/1 flows passed");
		},
		120_000,
	);

	withChromium(
		"a flows file replays without workers; a failing flow ends the command failed with the evidence kept",
		async () => {
			const h = harness();
			const dir = scratch();
			writeFileSync(join(dir, "flows.json"), JSON.stringify({ flows: [{ name: "broken", steps: [{ click: "There is no such button" }] }] }));
			const outcome = await runLocalDevVerify({}, { url: base, flows: join(dir, "flows.json"), video: false, timeoutMs: 10_000, errors: [] }, h.deps);
			expect(outcome.status).toBe("failed");
			expect(h.agentCalls).toHaveLength(0);
			expect(outcome.flows).toEqual([{ name: "broken", status: "fail" }]);
			expect(outcome.reason).toContain("verify");
			expect(outcome.evidence).toBeDefined();
			expect(h.panels.at(-1)!.markdown).toContain("| broken | ✗ fail |");
			const run = JSON.parse(readFileSync(join(outcome.runDir!, "run.json"), "utf8"));
			expect(run.status).toBe("failed");
			expect(readChain(join(outcome.runDir!, "events.jsonl")).at(-1)?.type).toBe("run.end");
		},
		120_000,
	);
});
