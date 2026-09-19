import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readChain, sha256 } from "../modules/hash-chain.ts";
import { RunStore } from "../modules/run-store.ts";
import { FULL_TOOLS, READONLY_TOOLS } from "../modules/runtime.ts";
import { DEFAULT_STACK_SETTINGS } from "../modules/stack-config.ts";
import { runProcess } from "../modules/workflow-runtime.ts";
import { hashArtifact } from "../modules/workflow/evidence.ts";
import { type AgentRequest, type AgentResult, executeWorkflow, type ProcessResult, type WorkflowRuntimeDeps } from "../modules/workflow/executor.ts";
import type { LoadedWorkflow } from "../modules/workflow/loader.ts";
import { evidenceDirFor, groundingDocs, shellQuote, whichBinary } from "../modules/workflow/nodes/verify.ts";
import { bashRunner } from "../modules/workflow/runners/bash.ts";
import { CURSOR_KEY_ENV, cursorArtifactList, cursorCloudRunner, cursorResultText } from "../modules/workflow/runners/cursor-cloud.ts";
import { changedFiles, coverageOf, httpStatusesOf, isRunnerName, kindForFile, rowCountsOf, type RunnerContext, RUNNERS, setRunnerFetch, snapshotFiles } from "../modules/workflow/runners/index.ts";
import { kaneArgs, kaneRunner, parseKaneStream } from "../modules/workflow/runners/kane.ts";
import { momenticEnabled, momenticRunner } from "../modules/workflow/runners/momentic.ts";
import { orcaArgs, orcaBrowserRunner, orcaTabVerbs } from "../modules/workflow/runners/orca-browser.ts";
import { testmuRunner } from "../modules/workflow/runners/testmu.ts";
import { VERIFIER_SCHEMA, verifierRunner } from "../modules/workflow/runners/verifier.ts";
import type { NodeDoc, VerifySpec, WorkflowDoc } from "../modules/workflow/schema.ts";

// ═══ Scaffolding ═════════════════════════════════════════════════════════════

const dirs: string[] = [];
afterEach(() => {
	while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
	setRunnerFetch(undefined);
});
const scratch = (): string => {
	const dir = mkdtempSync(join(tmpdir(), "titan-runners-"));
	dirs.push(dir);
	return dir;
};
const FIXTURES = join(import.meta.dir, "fixtures");
const fixture = (name: string): string => readFileSync(join(FIXTURES, name), "utf8");
const ok = (stdout = "", code = 0, stderr = ""): ProcessResult => ({ code, stdout, stderr });

type ExecOpts = { timeoutMs?: number; env?: Record<string, string>; cwd?: string };
type ExecFake = (command: string, args: string[], opts?: ExecOpts) => ProcessResult | Promise<ProcessResult>;
interface CtxOptions {
	exec?: ExecFake;
	bins?: string[];
	env?: Record<string, string>;
	fetch?: RunnerContext["fetch"];
	mcpTool?: RunnerContext["mcpTool"];
	agent?: RunnerContext["agent"];
	docs?: RunnerContext["docs"];
	cwd?: string;
}
function runnerCtx(options: CtxOptions = {}): RunnerContext & { execCalls: Array<[string, string[]]>; notices: string[] } {
	const cwd = options.cwd ?? scratch();
	const artifactsDir = join(cwd, "artifacts");
	const evidenceDir = join(artifactsDir, "evidence", "verify");
	mkdirSync(evidenceDir, { recursive: true });
	const execCalls: Array<[string, string[]]> = [];
	const notices: string[] = [];
	const bins = new Set(options.bins ?? []);
	return {
		runId: "run-test",
		nodeId: "verify",
		cwd,
		env: options.env ?? {},
		artifactsDir,
		evidenceDir,
		exec: async (command, args, opts) => {
			execCalls.push([command, args]);
			return options.exec ? options.exec(command, args, opts) : ok("", 127, `${command}: not found`);
		},
		fetch: options.fetch,
		mcpTool: options.mcpTool,
		agent: options.agent,
		notify: (text) => notices.push(text),
		signal: new AbortController().signal,
		timeoutMs: 5000,
		hash: hashArtifact,
		which: (binary) => (bins.has(binary) ? `/fake/bin/${binary}` : undefined),
		docs: options.docs,
		execCalls,
		notices,
	};
}
/** A real bash exec for the bash runner. */
const realExec: ExecFake = (command, args, opts) => runProcess(command, args, { cwd: opts?.cwd ?? process.cwd(), timeoutMs: opts?.timeoutMs ?? 10_000, env: opts?.env });

// ═══ Shared helpers ═════════════════════════════════════════════════════════

describe("runners: helpers", () => {
	test("kindForFile classifies by prefix and extension", () => {
		expect(kindForFile("db-op-log-signups.json")).toBe("db-op-log");
		expect(kindForFile("http-status.json")).toBe("http-status");
		expect(kindForFile("payload.sha256")).toBe("payload-hash");
		expect(kindForFile("screenshot-home.png")).toBe("screenshot");
		expect(kindForFile("coverage-final.json")).toBe("coverage-report");
		expect(kindForFile("probe-after-deploy.txt")).toBe("probe");
		expect(kindForFile("rollback.md")).toBe("rollback-note");
		expect(kindForFile("changes.diff")).toBe("diff");
		expect(kindForFile("migration-0042.log")).toBe("migration-log");
		expect(kindForFile("junit.xml")).toBe("test-result");
		expect(kindForFile("console.log")).toBe("console-log");
		expect(kindForFile("network.har")).toBe("network-log");
		expect(kindForFile("clip.mp4")).toBe("video");
		expect(kindForFile("whatever.txt")).toBe("log");
		expect(kindForFile("whatever.txt", "report")).toBe("report");
	});

	test("coverage, row counts and http statuses are read from the common shapes", () => {
		expect(coverageOf(JSON.parse(fixture("coverage-90.json")))).toBe(90);
		expect(coverageOf({ coverage: "97.5" })).toBe(97.5);
		expect(coverageOf({})).toBeUndefined();
		expect(rowCountsOf(JSON.parse(fixture("db-op-log.json")))).toEqual({ writes: 3, reads: 3, "write:signups": 3, "read:signups": 3 });
		expect(rowCountsOf({ rowCounts: { users: 2 } })).toEqual({ users: 2 });
		expect(httpStatusesOf({ "https://a.test/": 200, "https://a.test/x": 404 })).toEqual({ "https://a.test/": 200, "https://a.test/x": 404 });
		expect(httpStatusesOf([{ url: "https://b.test", status: 201 }])).toEqual({ "https://b.test": 201 });
	});

	test("snapshotFiles/changedFiles see new and modified files only", () => {
		const dir = scratch();
		writeFileSync(join(dir, "old.txt"), "old");
		const before = snapshotFiles(dir);
		writeFileSync(join(dir, "new.txt"), "new");
		writeFileSync(join(dir, "old.txt"), "old-but-longer");
		mkdirSync(join(dir, "nested"));
		writeFileSync(join(dir, "nested", "deep.log"), "x");
		expect(changedFiles(dir, before).map((file) => file.slice(dir.length + 1)).sort()).toEqual(["nested/deep.log", "new.txt", "old.txt"]);
	});

	test("the registry names every runner; shellQuote and whichBinary behave", () => {
		expect(Object.keys(RUNNERS).sort()).toEqual(["bash", "cdp-browser", "cursor-cloud", "kane", "momentic", "orca-browser", "testmu", "verifier"]);
		expect(isRunnerName("kane")).toBe(true);
		expect(isRunnerName("selenium")).toBe(false);
		expect(shellQuote("it's $HOME")).toBe(`'it'\\''s $HOME'`);
		expect(whichBinary("bash", { PATH: process.env.PATH ?? "" })).toMatch(/bash$/);
		expect(whichBinary("definitely-not-a-binary-xyz", { PATH: "/nonexistent" })).toBeUndefined();
	});
});

// ═══ bash (H3a, H3e) ════════════════════════════════════════════════════════

describe("runners: bash", () => {
	test("H3a: a write → read round trip that writes db-op-log under EVIDENCE_DIR is observed and passes", async () => {
		const ctx = runnerCtx({ exec: realExec });
		const result = await bashRunner({ runner: "bash", command: `cp ${shellQuote(join(FIXTURES, "db-op-log.json"))} "$EVIDENCE_DIR/db-op-log.json" && cp ${shellQuote(join(FIXTURES, "coverage-90.json"))} "$EVIDENCE_DIR/coverage.json" && echo done` }, ctx);
		expect(result.status).toBe("pass");
		expect(result.artifacts.map((artifact) => artifact.kind).sort()).toEqual(["coverage-report", "db-op-log"]);
		expect(result.artifacts.every((artifact) => artifact.sha256 && artifact.capturedBy === "observed" && artifact.source === "bash")).toBe(true);
		expect(result.checks).toMatchObject({ exitCode: 0, testsPass: true, coverage: 90, rowCounts: { writes: 3, reads: 3 } });
	});

	test("H3a: exit 0 with nothing written is unavailable, a non-zero exit is fail", async () => {
		const nothing = await bashRunner({ runner: "bash", command: "echo 'tests passed, trust me'" }, runnerCtx({ exec: realExec }));
		expect(nothing.status).toBe("unavailable");
		expect(nothing.reason).toContain("wrote no evidence");
		const red = await bashRunner({ runner: "bash", command: "echo boom >&2; exit 3" }, runnerCtx({ exec: realExec }));
		expect(red.status).toBe("fail");
		expect(red.reason).toContain("exited 3");
		expect(red.checks).toMatchObject({ exitCode: 3, testsPass: false });
		const none = await bashRunner({ runner: "bash" } as VerifySpec, runnerCtx());
		expect(none.status).toBe("fail");
	});
});

// ═══ kane ═══════════════════════════════════════════════════════════════════

describe("runners: kane", () => {
	test("parses the recorded stream and builds argv per device", () => {
		const parsed = parseKaneStream(fixture("kane-run.ndjson"));
		expect(parsed.runEnd).toMatchObject({ status: "passed", final_state: "Dashboard visible for user qa@example.test", test_url: "https://kaneai.testmu.ai/runs/kr-7f3a" });
		expect(parsed.events).toBe(6);
		expect(parseKaneStream("garbage\n{not json").runEnd).toBeUndefined();
		expect(kaneArgs("Log in", { max_steps: 20 }, "default")).toEqual(["run", "Log in", "--agent", "--headless", "--max-steps", "20"]);
		expect(kaneArgs("Log in", { headless: false }, "iphone-15")).toEqual(["run", "Log in", "--agent", "--remote", "--device-name", "iphone-15"]);
	});

	test("kane-cli absent → unavailable and nothing is executed", async () => {
		const ctx = runnerCtx();
		const result = await kaneRunner({ runner: "kane", objective: "Log in" }, ctx);
		expect(result.status).toBe("unavailable");
		expect(result.reason).toContain("kane-cli not on PATH");
		expect(ctx.execCalls).toEqual([]);
	});

	test("device matrix: one passing and one failing device → fail with per-device status; a lone passing device → pass with hashed screenshots", async () => {
		const cwd = scratch();
		const exec: ExecFake = (_command, args, opts) => {
			const device = args.includes("--device-name") ? args[args.indexOf("--device-name") + 1] : "default";
			const evidence = join(opts?.cwd ?? cwd, ".testmuai", "evidence", device);
			mkdirSync(evidence, { recursive: true });
			writeFileSync(join(evidence, "step-1.png"), `png-${device}`);
			writeFileSync(join(evidence, "run.log"), `log-${device}`);
			return ok(fixture(device === "default" ? "kane-run.ndjson" : "kane-run-fail.ndjson"));
		};
		const both = runnerCtx({ cwd, bins: ["kane-cli"], exec });
		const mixed = await kaneRunner({ runner: "kane", objective: "Log in and reach the dashboard", devices: ["default", "iphone-15"] }, both);
		expect(mixed.status).toBe("fail");
		expect(mixed.devices).toEqual({ default: "pass", "iphone-15": "fail" });
		expect(mixed.reason).toContain("iphone-15: run_end status failed");
		expect(both.execCalls.map(([command]) => command)).toEqual(["kane-cli", "kane-cli"]);

		const single = runnerCtx({ cwd: scratch(), bins: ["kane-cli"], exec });
		const passed = await kaneRunner({ runner: "kane", objective: "Log in and reach the dashboard" }, single);
		expect(passed.status).toBe("pass");
		expect(passed.devices).toEqual({ default: "pass" });
		const kinds = passed.artifacts.filter((artifact) => artifact.sha256).map((artifact) => artifact.kind).sort();
		expect(kinds).toEqual(["log", "log", "screenshot"]); // the stream copy, run.log and step-1.png
		expect(passed.artifacts.find((artifact) => artifact.kind === "evidence-pack")?.capturedBy).toBe("inferred");
		expect(passed.checks).toMatchObject({ userFlowsPassed: true, screenshotPresent: true, testsPass: true });
		expect(existsSync(join(single.evidenceDir, "kane-default.ndjson"))).toBe(true);
	});

	test("a stream without run_end fails closed", async () => {
		const ctx = runnerCtx({ bins: ["kane-cli"], exec: () => ok('{"type":"run_start"}\n') });
		const result = await kaneRunner({ runner: "kane", objective: "x" }, ctx);
		expect(result.status).toBe("fail");
		expect(result.reason).toContain("no run_end");
	});
});

// ═══ cursor-cloud ═══════════════════════════════════════════════════════════

const KEY = "cur_test_key_do_not_leak_9f8e7d";

function cursorFetch(options: { me?: number; final?: string; artifacts?: unknown } = {}) {
	const calls: Array<{ method: string; url: string; auth?: string }> = [];
	let polls = 0;
	const json = (status: number, body: unknown) => ({ status, ok: status < 300, json: async () => body, text: async () => JSON.stringify(body) });
	const text = (status: number, body: string) => ({ status, ok: status < 300, json: async () => JSON.parse(body), text: async () => body });
	const fetch: RunnerContext["fetch"] = async (url, init) => {
		calls.push({ method: init?.method ?? "GET", url, auth: init?.headers?.Authorization });
		if (url.endsWith("/v1/me")) return json(options.me ?? 200, JSON.parse(fixture("cursor-me.json")));
		if (url.endsWith("/v1/agents") && init?.method === "POST") return json(200, JSON.parse(fixture("cursor-agent-created.json")));
		if (/\/v1\/agents\/[^/]+$/.test(url)) {
			polls += 1;
			if (polls === 1) return json(200, JSON.parse(fixture("cursor-agent-running.json")));
			const finished = JSON.parse(fixture("cursor-agent-finished.json"));
			if (options.final) finished.status = options.final;
			return json(200, finished);
		}
		if (url.endsWith("/artifacts")) return json(200, options.artifacts ?? JSON.parse(fixture("cursor-artifacts.json")));
		if (url.includes("/download")) {
			const name = url.split("/artifacts/")[1].split("/download")[0];
			return text(200, name.endsWith(".xml") ? '<testsuite tests="42" failures="0"/>' : name.endsWith(".png") ? "png-bytes" : "run log line\n");
		}
		return json(404, {});
	};
	return { fetch, calls };
}
const gitExec: ExecFake = (command, args) => {
	if (command !== "git") return ok("", 127);
	if (args[0] === "remote") return ok("https://github.com/example/proto-analytics\n");
	if (args[0] === "ls-remote") return ok(args[3] === "titan/run-test" ? "abc123\trefs/heads/titan/run-test\n" : "");
	return ok("", 1);
};

describe("runners: cursor-cloud", () => {
	test("preflight fails closed without CURSOR_API_KEY (the fetch is never called) and on a rejected key", async () => {
		const noKey = cursorFetch();
		const ctx = runnerCtx({ fetch: noKey.fetch, exec: gitExec });
		const result = await cursorCloudRunner({ runner: "cursor-cloud", objective: "Run the suite" }, ctx);
		expect(result.status).toBe("unavailable");
		expect(result.reason).toContain(`${CURSOR_KEY_ENV} not set`);
		expect(noKey.calls).toEqual([]);
		const rejected = cursorFetch({ me: 401 });
		const bad = await cursorCloudRunner({ runner: "cursor-cloud", objective: "Run the suite" }, runnerCtx({ fetch: rejected.fetch, exec: gitExec, env: { [CURSOR_KEY_ENV]: KEY } }));
		expect(bad.status).toBe("unavailable");
		expect(bad.reason).toContain("returned 401");
		expect(rejected.calls).toHaveLength(1);
		const noFetch = await cursorCloudRunner({ runner: "cursor-cloud", objective: "x" }, runnerCtx({ exec: gitExec, env: { [CURSOR_KEY_ENV]: KEY } }));
		expect(noFetch.status).toBe("unavailable");
	});

	test("recorded flow: preflight → branch check → launch → poll → artifacts; the key never lands in an artifact or the result", async () => {
		const api = cursorFetch();
		const ctx = runnerCtx({ fetch: api.fetch, exec: gitExec, env: { [CURSOR_KEY_ENV]: KEY } });
		const result = await cursorCloudRunner({ runner: "cursor-cloud", objective: "Run the analytics dashboard suite", ref: "titan/run-test", poll_ms: 1 }, ctx);
		expect(result.status).toBe("pass");
		expect(result.summary).toContain("bc_5e0b1e8c FINISHED");
		expect(result.raw).toMatchObject({ provider: "cursor", agentId: "bc_5e0b1e8c", externalCostUsd: 0.37 });
		const kinds = result.artifacts.filter((artifact) => artifact.sha256).map((artifact) => artifact.kind).sort();
		expect(kinds).toEqual(["log", "report", "screenshot", "test-result"]);
		expect(result.checks).toMatchObject({ testsPass: true, logsPresent: true });
		// the wire: me, POST agents (idempotent id), two polls, artifacts list, three downloads — all bearer-authed
		expect(api.calls.map((call) => `${call.method} ${call.url.replace("https://api.cursor.com", "")}`)).toEqual([
			"GET /v1/me",
			"POST /v1/agents",
			"GET /v1/agents/bc_5e0b1e8c",
			"GET /v1/agents/bc_5e0b1e8c",
			"GET /v1/agents/bc_5e0b1e8c/artifacts",
			"GET /v1/agents/bc_5e0b1e8c/artifacts/test-results.xml/download",
			"GET /v1/agents/bc_5e0b1e8c/artifacts/screenshot-dashboard.png/download",
			"GET /v1/agents/bc_5e0b1e8c/artifacts/run.log/download",
		]);
		expect(api.calls.every((call) => call.auth === `Bearer ${KEY}`)).toBe(true);
		expect(ctx.execCalls.map(([command, args]) => `${command} ${args.join(" ")}`)).toEqual(["git remote get-url origin", "git ls-remote --heads origin titan/run-test"]);
		// the credential is nowhere: not in the result, not in any file under the evidence dir
		expect(JSON.stringify(result)).not.toContain(KEY);
		for (const artifact of result.artifacts) expect(readFileSync(artifact.path, "utf8")).not.toContain(KEY);
		expect(readFileSync(join(ctx.evidenceDir, "cursor-result.md"), "utf8")).toContain("42 passed");
	});

	test("a branch that is not on the remote, a FAILED agent and a result without artifacts each fail", async () => {
		const missingBranch = await cursorCloudRunner({ runner: "cursor-cloud", objective: "x", ref: "titan/elsewhere", poll_ms: 1 }, runnerCtx({ fetch: cursorFetch().fetch, exec: gitExec, env: { [CURSOR_KEY_ENV]: KEY } }));
		expect(missingBranch.status).toBe("fail");
		expect(missingBranch.reason).toContain("not on the remote");
		const failedAgent = await cursorCloudRunner({ runner: "cursor-cloud", objective: "x", ref: "titan/run-test", poll_ms: 1 }, runnerCtx({ fetch: cursorFetch({ final: "FAILED" }).fetch, exec: gitExec, env: { [CURSOR_KEY_ENV]: KEY } }));
		expect(failedAgent.status).toBe("fail");
		expect(failedAgent.reason).toContain("ended FAILED");
		const noArtifacts = await cursorCloudRunner({ runner: "cursor-cloud", objective: "x", ref: "titan/run-test", poll_ms: 1 }, runnerCtx({ fetch: cursorFetch({ artifacts: { artifacts: [] } }).fetch, exec: gitExec, env: { [CURSOR_KEY_ENV]: KEY } }));
		expect(noArtifacts.status).toBe("fail");
		expect(noArtifacts.reason).toContain("no downloadable artifact");
	});

	test("result text and artifact list readers accept the API's shapes", () => {
		expect(cursorResultText({ result: "done" })).toBe("done");
		expect(cursorResultText({ result: { summary: "s" } })).toBe("s");
		expect(cursorResultText({ summary: "top" })).toBe("top");
		expect(cursorResultText({})).toBeUndefined();
		expect(cursorArtifactList([{ name: "a", url: "u" }, { path: "b", content: "c" }, { nothing: true }])).toEqual([{ name: "a", url: "u", content: undefined }, { name: "b", url: undefined, content: "c" }]);
	});
});

// ═══ momentic + testmu ══════════════════════════════════════════════════════

describe("runners: momentic and testmu", () => {
	test("momentic is skipped unless enabled on the node AND keyed; enabled without a bridge is unavailable", async () => {
		expect(momenticEnabled({}, { MOMENTIC_API_KEY: "k" })).toMatchObject({ enabled: false });
		expect(momenticEnabled({ enabled: true }, {})).toMatchObject({ enabled: false });
		expect(momenticEnabled({ enabled: true }, { MOMENTIC_CONFIG: "momentic.yaml" })).toEqual({ enabled: true });
		const off = await momenticRunner({ runner: "momentic", objective: "x" }, runnerCtx({ env: { MOMENTIC_API_KEY: "k" } }));
		expect(off.status).toBe("skipped");
		expect(off.reason).toContain("disabled on this node");
		const unkeyed = await momenticRunner({ runner: "momentic", objective: "x", enabled: true }, runnerCtx());
		expect(unkeyed.status).toBe("skipped");
		expect(unkeyed.reason).toContain("not keyed");
		const noBridge = await momenticRunner({ runner: "momentic", objective: "x", enabled: true }, runnerCtx({ env: { MOMENTIC_API_KEY: "k" } }));
		expect(noBridge.status).toBe("unavailable");
		const calls: Array<[string, string, Record<string, unknown>]> = [];
		const live = await momenticRunner({ runner: "momentic", objective: "Sign up", enabled: true }, runnerCtx({ env: { MOMENTIC_API_KEY: "k" }, mcpTool: async (server, tool, args) => (calls.push([server, tool, args]), { status: "passed", runId: "m1" }) }));
		expect(live.status).toBe("pass");
		expect(calls).toEqual([["momentic", "momentic_run_step", { objective: "Sign up" }]]);
		expect(live.artifacts[0]).toMatchObject({ kind: "report", source: "momentic", capturedBy: "observed" });
		expect(live.artifacts[0].sha256).toHaveLength(64);
	});

	test("testmu needs the MCP bridge; a reply with an error or failing status fails, otherwise it passes with the stored report", async () => {
		const none = await testmuRunner({ runner: "testmu" }, runnerCtx());
		expect(none.status).toBe("unavailable");
		expect(none.reason).toContain("no MCP bridge");
		const failing = await testmuRunner({ runner: "testmu", tool: "hyperexecute_job_status", args: { jobId: "j1" } }, runnerCtx({ mcpTool: async () => ({ status: "failed" }) }));
		expect(failing.status).toBe("fail");
		const errored = await testmuRunner({ runner: "testmu" }, runnerCtx({ mcpTool: async () => ({ error: "unauthorized" }) }));
		expect(errored.status).toBe("fail");
		expect(errored.reason).toBe("unauthorized");
		const passing = await testmuRunner({ runner: "testmu", args: { jobId: "j1" } }, runnerCtx({ mcpTool: async () => ({ status: "completed", passed: 12 }) }));
		expect(passing.status).toBe("pass");
		expect(passing.artifacts[0]).toMatchObject({ kind: "report", source: "testmu" });
		expect(readFileSync(passing.artifacts[0].path, "utf8")).toContain('"passed": 12');
	});
});

// ═══ orca-browser ═══════════════════════════════════════════════════════════

describe("runners: orca-browser", () => {
	const flows = [{ name: "login", url: "https://app.test/login", steps: [{ action: "fill", selector: "#email", text: "qa@example.test" }, { action: "click", selector: "button" }, { action: "screenshot", name: "after-login" }, { action: "snapshot" }, { action: "eval", code: "console.logs()", capture: "console" }] }];

	test("orca absent → unavailable without any exec; the real Orca build (no goto/screenshot) → unavailable after the single probe", async () => {
		const missing = runnerCtx();
		const none = await orcaBrowserRunner({ runner: "orca-browser", flows }, missing);
		expect(none.status).toBe("unavailable");
		expect(missing.execCalls).toEqual([]);
		const real = runnerCtx({ bins: ["orca"], exec: (_command, args) => (args[0] === "tab" && args[1] === "--help" ? ok(fixture("orca-tab-help-real.txt")) : ok("", 2, "unexpected")) });
		const probed = await orcaBrowserRunner({ runner: "orca-browser", flows }, real);
		expect(probed.status).toBe("unavailable");
		expect(probed.reason).toBe("orca tab has no goto/screenshot automation in this Orca build (found: list, show, current, switch, create, profile, close)");
		expect(real.execCalls).toEqual([["orca", ["tab", "--help"]]]);
		expect(orcaTabVerbs(fixture("orca-tab-help-automation.txt"))).toContain("goto");
		expect(orcaArgs("t1", { action: "fill", selector: "#a", text: "b" })).toEqual(["tab", "fill", "t1", "#a", "b"]);
	});

	test("an automation-capable build drives the flow and hashes screenshots, snapshots and console logs; a failing step fails the flow", async () => {
		const drive =
			(failClick: boolean): ExecFake =>
			(_command, args) => {
				if (args[1] === "--help") return ok(fixture("orca-tab-help-automation.txt"));
				if (args[1] === "create") return ok("tab-7\n");
				if (args[1] === "screenshot") {
					writeFileSync(args[args.indexOf("--path") + 1], "png-bytes");
					return ok("saved\n");
				}
				if (args[1] === "snapshot") return ok("- heading Dashboard\n- button Logout\n");
				if (args[1] === "eval") return ok("[log] ready\n");
				if (args[1] === "click" && failClick) return ok("", 1, "element not found: button");
				return ok("ok\n");
			};
		const good = runnerCtx({ bins: ["orca"], exec: drive(false) });
		const passed = await orcaBrowserRunner({ runner: "orca-browser", flows }, good);
		expect(passed.status).toBe("pass");
		expect(passed.devices).toEqual({ login: "pass" });
		expect(passed.artifacts.map((artifact) => artifact.kind).sort()).toEqual(["console-log", "screenshot", "snapshot"]);
		expect(passed.artifacts.every((artifact) => artifact.sha256 && artifact.source === "orca" && artifact.device === "login")).toBe(true);
		expect(good.execCalls.map(([, args]) => args.slice(0, 2).join(" "))).toEqual(["tab --help", "tab create", "tab goto", "tab fill", "tab click", "tab screenshot", "tab snapshot", "tab eval"]);
		const bad = runnerCtx({ bins: ["orca"], exec: drive(true) });
		const failed = await orcaBrowserRunner({ runner: "orca-browser", flows }, bad);
		expect(failed.status).toBe("fail");
		expect(failed.devices).toEqual({ login: "fail" });
		expect(failed.reason).toContain("0/1 flow(s) passed");
	});
});

// ═══ verifier (H3b) ═════════════════════════════════════════════════════════

describe("runners: verifier", () => {
	const docs = [
		{ name: "vision.md", text: fixture("vision.md") },
		{ name: "intent.md", text: fixture("intent.md") },
	];
	const agree: RunnerContext["agent"] = async (prompt, opts) => {
		expect(opts?.role).toBe("verifier");
		expect(opts?.outputSchema).toEqual(VERIFIER_SCHEMA);
		expect(prompt).toContain("## Grounding documents");
		expect(prompt).toContain("## Text under review");
		return { ok: true, text: "{}", value: { ok: true, alignment: [{ claim: "one page dashboard", source: "vision.md", section: "Goals", status: "aligned" }], executionClaims: [], summary: "aligned" } };
	};

	test("no docs or no agent seam → unavailable", async () => {
		expect((await verifierRunner({ runner: "verifier", input: "plan" }, runnerCtx({ agent: agree }))).status).toBe("unavailable");
		expect((await verifierRunner({ runner: "verifier", input: "plan" }, runnerCtx({ docs }))).status).toBe("unavailable");
		expect((await verifierRunner({ runner: "verifier" }, runnerCtx({ docs, agent: agree }))).status).toBe("fail");
	});

	test("an aligned plan with real citations passes and writes alignment-table, plan-digest and source-digests", async () => {
		const ctx = runnerCtx({ docs, agent: agree });
		const result = await verifierRunner({ runner: "verifier", input: "We build the one-page dashboard from vision.md#goals within [intent: Scope]." }, ctx);
		expect(result.status).toBe("pass");
		expect(result.artifacts.map((artifact) => artifact.kind).sort()).toEqual(["alignment-table", "plan-digest", "source-digests"]);
		expect(result.artifacts.every((artifact) => artifact.sha256 && artifact.capturedBy === "observed" && artifact.source === "verifier")).toBe(true);
		expect(readFileSync(join(ctx.evidenceDir, "plan-digest.txt"), "utf8")).toMatch(/^[0-9a-f]{64}  reviewed-text\n$/);
		expect(JSON.parse(readFileSync(join(ctx.evidenceDir, "source-digests.json"), "utf8"))).toEqual(docs.map((doc) => ({ name: doc.name, sha256: sha256(doc.text), bytes: Buffer.byteLength(doc.text) })));
	});

	test("H3b: a citation of a vision section that does not exist is flagged even when the model says ok; execution claims fail too", async () => {
		const fake = await verifierRunner({ runner: "verifier", input: "Pricing follows vision.md#pricing-tiers exactly." }, runnerCtx({ docs, agent: agree }));
		expect(fake.status).toBe("fail");
		expect(fake.reason).toContain("citation not found: vision.md#pricing-tiers");
		expect(fake.checks.orgRulesMet).toBe(false);
		const claims = await verifierRunner({ runner: "verifier", input: "Per vision.md#goals the dashboard is planned. Tests pass on the new branch." }, runnerCtx({ docs, agent: agree }));
		expect(claims.status).toBe("fail");
		expect(claims.reason).toContain("execution claim: Tests pass on the new branch.");
		const contradicted = await verifierRunner({ runner: "verifier", input: "We ship a mobile app first." }, runnerCtx({ docs, agent: async () => ({ ok: true, text: "", value: { ok: false, alignment: [{ claim: "mobile app first", source: "vision.md", section: "Non-goals", status: "contradicted" }], executionClaims: [], summary: "contradicts non-goals" } }) }));
		expect(contradicted.status).toBe("fail");
		expect(contradicted.reason).toContain("contradicted: mobile app first (vision.md › Non-goals)");
	});
});

// ═══ The verify node through the executor ═══════════════════════════════════

interface Harness {
	deps: WorkflowRuntimeDeps;
	store: RunStore;
	runDir: string;
	runId: string;
	cwd: string;
	agentCalls: AgentRequest[];
	notices: string[];
}
function harness(options: { answers?: Record<string, Array<string | Partial<AgentResult>>>; mcpTool?: WorkflowRuntimeDeps["mcpTool"]; cwd?: string } = {}): Harness {
	const store = new RunStore(scratch());
	const cwd = options.cwd ?? scratch();
	const { runId, dir: runDir } = store.open({ projectSlug: RunStore.projectSlug(cwd), cwd, workflow: { name: "t", sha256: sha256("t") }, command: "workflow" });
	const agentCalls: AgentRequest[] = [];
	const notices: string[] = [];
	const deps: WorkflowRuntimeDeps = {
		cwd,
		runId,
		runDir,
		artifactsDir: join(runDir, "artifacts"),
		workflowId: "t",
		store,
		settings: DEFAULT_STACK_SETTINGS,
		async agent(req) {
			agentCalls.push(req);
			const scripted = options.answers?.[req.nodeId]?.shift();
			const base: AgentResult = { ok: true, text: `${req.nodeId} done`, sessionRef: `sess-${req.nodeId}`, usage: { tokensIn: 10, tokensOut: 5, costUsd: 0.001, tpsSeconds: 1 }, toolCalls: 0, model: req.model };
			if (scripted === undefined) return base;
			return typeof scripted === "string" ? { ...base, text: scripted } : { ...base, ...scripted };
		},
		bash: (command, opts) => runProcess("bash", ["-c", command], { cwd: opts.cwd, timeoutMs: opts.timeoutMs, env: opts.env, signal: opts.signal }),
		async script() {
			return { code: 0, stdout: "", stderr: "" };
		},
		async approval() {
			return { approved: false };
		},
		notify: (text) => notices.push(text),
		resolveRole: (role) => ({ model: `stub/${role}`, thinking: "medium", callsign: `${role}-1`, appendSystemPrompts: [], tools: role === "architect" || role === "verifier" ? READONLY_TOOLS : FULL_TOOLS }),
		mcpTool: options.mcpTool,
	};
	return { deps, store, runDir, runId, cwd, agentCalls, notices };
}
const loaded = (nodes: NodeDoc[], extra: Partial<WorkflowDoc> = {}): LoadedWorkflow => {
	const doc: WorkflowDoc = { apiVersion: "titan.harness/v1", name: "t", version: 1, nodes, ...extra };
	const dir = scratch();
	return { doc, normalized: doc, name: "t", dir, path: join(dir, "t.yaml"), sha256: sha256(JSON.stringify(doc)), source: "project", commands: {}, scripts: {}, validation: { ok: true, errors: [], warnings: [] } } as LoadedWorkflow;
};
const webGeneralCommand = (kinds: string[]) => kinds.map((kind) => (kind === "screenshot" ? `printf png > "$EVIDENCE_DIR/screenshot-home.png"` : kind === "db-op-log" ? `cp ${shellQuote(join(FIXTURES, "db-op-log.json"))} "$EVIDENCE_DIR/db-op-log.json"` : kind === "http-status" ? `printf '{"https://app.test/":200}' > "$EVIDENCE_DIR/http-status.json"` : `printf abc > "$EVIDENCE_DIR/payload-hash.sha256"`)).join(" && ");

describe("verify node: evidence packages through the executor", () => {
	test("web-general with every kind observed → success, evidence.json matched, evidence.captured event, meta.verification", async () => {
		const h = harness();
		const node = { id: "check", verify: { runner: "bash", command: webGeneralCommand(["http-status", "payload-hash", "screenshot", "db-op-log"]) }, evidence: { require: ["db-op-log"] } } as unknown as NodeDoc;
		const result = await executeWorkflow(loaded([node], { titan: { tier: "web-general" }, returns: "check" }), h.deps);
		expect(result.status).toBe("completed");
		expect(result.nodes.check.status).toBe("success");
		const output = result.returns as Record<string, unknown>;
		expect(output).toMatchObject({ status: "pass", evidence: "matched", artifacts: 4, missing: [], tier: "web-general" });
		expect((output.kinds as string[]).sort()).toEqual(["db-op-log", "http-status", "payload-hash", "screenshot"]);
		expect((output.checks as Record<string, unknown>).rowCounts).toMatchObject({ writes: 3, reads: 3 });
		const evidence = JSON.parse(readFileSync(join(h.runDir, "evidence", "check", "evidence.json"), "utf8"));
		expect(evidence).toMatchObject({ schemaVersion: 1, runId: h.runId, nodeId: "check", tier: "web-general", modes: ["bash"], status: "matched", missingInformation: [] });
		expect(evidence.artifacts).toHaveLength(4);
		expect(existsSync(join(h.deps.artifactsDir, "evidence", "check", "db-op-log.json"))).toBe(true);
		const captured = readChain(join(h.runDir, "events.jsonl")).find((row) => row.type === "evidence.captured");
		expect(captured?.data).toMatchObject({ nodeId: "check", runner: "bash", runnerStatus: "pass", status: "matched", artifacts: 4 });
		const meta = JSON.parse(readFileSync(join(h.runDir, "artifacts", "nodes", "check.meta.json"), "utf8"));
		expect(meta.verification).toMatchObject({ runner: "bash", runnerStatus: "pass", evidenceStatus: "matched" });
	});

	test("a passing runner with incomplete evidence fails the node and is never retried (H3a/H3d shape)", async () => {
		const h = harness();
		const node = { id: "check", verify: { runner: "bash", command: webGeneralCommand(["db-op-log"]) }, evidence: { require: ["db-op-log"] }, retry: { max_attempts: 3, delay_ms: 0 } } as unknown as NodeDoc;
		const result = await executeWorkflow(loaded([node], { titan: { tier: "web-general" } }), h.deps);
		expect(result.status).toBe("failed");
		expect(result.nodes.check.status).toBe("failed");
		expect(result.nodes.check.attempts).toBe(1);
		expect(result.nodes.check.error).toContain("evidence is current-unverified");
		expect(result.nodes.check.error).toContain("missing evidence: http-status");
		const evidence = JSON.parse(readFileSync(join(h.runDir, "evidence", "check", "evidence.json"), "utf8"));
		expect(evidence.status).toBe("current-unverified");
	});

	test("H3d: production-swe demands a sim-user capture — bash screenshots alone leave the package current-unverified", async () => {
		const h = harness();
		const everything = ["test-result", "log", "screenshot", "script", "result-card", "design-match", "console-log", "network-log", "schedule-id"].map((kind) => `printf x > "$EVIDENCE_DIR/${kind === "test-result" ? "junit.xml" : kind === "log" ? "run.log" : kind === "screenshot" ? "screenshot-1.png" : kind === "script" ? "flow.ts" : kind === "console-log" ? "console.log" : kind === "network-log" ? "network.har" : `${kind}.txt`}"`).join(" && ");
		const node = { id: "swe", verify: { runner: "bash", command: everything }, evidence: { require: ["log"] } } as unknown as NodeDoc;
		const result = await executeWorkflow(loaded([node], { titan: { tier: "production-swe" } }), h.deps);
		expect(result.nodes.swe.status).toBe("failed");
		expect(result.nodes.swe.error).toContain("video|screenshot (sim-user source)");
		const output = result.nodes.swe.output as Record<string, unknown>;
		expect(output.evidence).toBe("current-unverified");
	});

	test("an unavailable lane fails closed without retries; a skipped lane passes only when optional", async () => {
		const h = harness();
		let processCalls = 0;
		h.deps.bash = async () => {
			processCalls++;
			throw new Error("unavailable lanes must not execute external commands");
		};
		const nodes = [
			{ id: "kane", verify: { runner: "kane", objective: "Log in" }, evidence: { require: ["screenshot"] }, retry: { max_attempts: 3, delay_ms: 0 } },
			{ id: "momentic", verify: { runner: "momentic", objective: "Log in", optional: true }, evidence: { require: ["screenshot"] } },
			{ id: "momentic-required", verify: { runner: "momentic", objective: "Log in" }, evidence: { require: ["screenshot"] } },
		] as unknown as NodeDoc[];
		const savedPath = process.env.PATH;
		const savedHome = process.env.HOME;
		// Discovery also searches HOME user bins, so isolate both lookup roots.
		process.env.PATH = join(h.cwd, "empty-bin");
		process.env.HOME = h.cwd;
		try {
			const result = await executeWorkflow(loaded(nodes), h.deps, { maxParallel: 1 });
			expect(processCalls).toBe(0);
			expect(result.nodes.kane.status).toBe("failed");
			expect(result.nodes.kane.attempts).toBe(1);
			expect(result.nodes.kane.error).toContain("kane unavailable: kane-cli not on PATH");
			expect(result.nodes.momentic.status).toBe("success");
			expect((result.nodes.momentic.output as Record<string, unknown>).status).toBe("skipped");
			expect(result.nodes["momentic-required"].status).toBe("failed");
			expect(result.nodes["momentic-required"].error).toContain("momentic skipped");
			for (const id of ["kane", "momentic", "momentic-required"]) expect(existsSync(join(h.runDir, "evidence", id, "evidence.json"))).toBe(true);
		} finally {
			if (savedPath === undefined) delete process.env.PATH;
			else process.env.PATH = savedPath;
			if (savedHome === undefined) delete process.env.HOME;
			else process.env.HOME = savedHome;
		}
	});

	test("the verifier lane reaches the stub agent with role verifier and read-only tools, grounded by the project's vision.md (H3b through the node)", async () => {
		const cwd = scratch();
		writeFileSync(join(cwd, "vision.md"), fixture("vision.md"));
		mkdirSync(join(cwd, ".titan", "terraform"), { recursive: true });
		writeFileSync(join(cwd, ".titan", "terraform", "entity.md"), "# Entity\n\n## Team\nTwo founders.\n");
		expect(groundingDocs(cwd).map((doc) => doc.name)).toEqual(["vision.md", "terraform/entity.md"]);
		const verdict = JSON.stringify({ ok: true, alignment: [{ claim: "dashboard", source: "vision.md", section: "Goals", status: "aligned" }], executionClaims: [], summary: "fine" });
		const h = harness({ cwd, answers: { plan: ["We build the dashboard per vision.md#goals and terraform/entity.md#team."], review: [verdict], bad: [verdict] } });
		const nodes = [
			{ id: "plan", prompt: "Draft the plan", role: "architect" },
			{ id: "review", depends_on: ["plan"], verify: { runner: "verifier", input: "$plan.output" }, evidence: { require: ["alignment-table"] } },
			{ id: "bad", verify: { runner: "verifier", input: "Follow vision.md#pricing-tiers." }, evidence: { require: ["alignment-table"] } },
		] as unknown as NodeDoc[];
		const result = await executeWorkflow(loaded(nodes, { titan: { tier: "research-planning" } }), h.deps, { maxParallel: 1 });
		expect(result.nodes.review.status).toBe("success");
		expect((result.nodes.review.output as Record<string, unknown>).evidence).toBe("matched");
		const call = h.agentCalls.find((req) => req.nodeId === "review")!;
		expect(call.role).toBe("verifier");
		expect(call.tools).toBe(READONLY_TOOLS);
		expect(call.prompt).toContain("## Grounding documents");
		expect(call.prompt).toContain("### vision.md");
		expect(call.prompt).toContain("We build the dashboard per vision.md#goals");
		expect(result.nodes.bad.status).toBe("failed");
		expect(result.nodes.bad.attempts).toBe(1); // a missing citation is deterministic: never retried
		expect(result.nodes.bad.error).toContain("citation not found: vision.md#pricing-tiers");
		expect(evidenceDirFor(h.deps.artifactsDir, "review")).toBe(join(h.deps.artifactsDir, "evidence", "review"));
	});
});
