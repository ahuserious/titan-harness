import { afterEach, describe, expect, test } from "bun:test";
import * as http from "node:http";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readChain, sha256 } from "../modules/hash-chain.ts";
import { APPROVALS_FILE, RunStore, type RunnerStore, openRunnerStore } from "../modules/run-store.ts";
import { FULL_TOOLS } from "../modules/runtime.ts";
import { DEFAULT_STACK_SETTINGS } from "../modules/stack-config.ts";
import { createWorkflowRuntime } from "../modules/workflow-runtime.ts";
import { type ActorPolicy, type ApprovalRequest, QueueApprover } from "../modules/workflow/approver.ts";
import { type AgentResult, type RunResult, type WorkflowRuntimeDeps, executeWorkflow } from "../modules/workflow/executor.ts";
import type { LoadedWorkflow } from "../modules/workflow/loader.ts";
import {
	MAX_WORKFLOW_DEPTH,
	PROD_V1_MAX_PARALLEL,
	ProfileError,
	SidecarMcpError,
	createRunnerRunWorkflow,
	createSidecarMcpTool,
	executeProdV1,
	isWriteNamedTool,
	validateProdV1,
} from "../modules/workflow/runner-seams.ts";
import type { NodeDoc, WorkflowDoc } from "../modules/workflow/schema.ts";

// ═══ Harness ═══════════════════════════════════════════════════════════════════

const dirs: string[] = [];
const servers: http.Server[] = [];
const stores: RunnerStore[] = [];
afterEach(async () => {
	while (stores.length) stores.pop()!.release();
	while (servers.length) await new Promise((r) => servers.pop()!.close(r));
	while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});
function scratch(prefix = "titan-seams-"): string {
	const dir = mkdtempSync(join(tmpdir(), prefix));
	dirs.push(dir);
	return dir;
}
const allowAll: ActorPolicy = { policyId: "test-allow-all", authorize: () => true };

interface SidecarCall { url: string; method: string; host?: string; body: any }
type Reply = (call: SidecarCall) => { status?: number; body?: unknown; raw?: string; headers?: Record<string, string>; hang?: boolean; trickleMs?: number };

/** A fake unit sidecar on a unix socket: records every request, answers by `reply`. */
async function fakeSidecar(reply: Reply = (c) => ({ body: { jsonrpc: "2.0", id: c.body.id, result: { content: [{ type: "text", text: JSON.stringify({ records: [{ id: "r1" }] }) }] } } })) {
	const socketPath = join(scratch("titan-sock-"), "unit-a.sock");
	const calls: SidecarCall[] = [];
	const trickleClosed: number[] = [];
	const server = http.createServer((req, res) => {
		let text = "";
		req.on("data", (c) => (text += c));
		req.on("end", () => {
			let body: any;
			try { body = JSON.parse(text); } catch { body = text; }
			const call = { url: req.url ?? "", method: req.method ?? "", host: req.headers.host, body };
			calls.push(call);
			const r = reply(call);
			if (r.hang) return;
			if (r.trickleMs) {
				// Stays under the response cap and keeps the socket busy: one space every trickleMs, never ends.
				res.writeHead(r.status ?? 200, { "content-type": "application/json" });
				const tick = setInterval(() => res.write(" "), r.trickleMs);
				res.on("close", () => { clearInterval(tick); trickleClosed.push(Date.now()); });
				return;
			}
			res.writeHead(r.status ?? 200, { "content-type": "application/json", ...(r.headers ?? {}) });
			res.end(r.raw ?? JSON.stringify(r.body));
		});
	});
	await new Promise<void>((resolve) => server.listen(socketPath, resolve));
	servers.push(server);
	return { socketPath, calls, trickleClosed };
}

function loadedOf(doc: WorkflowDoc, dir = scratch()): LoadedWorkflow {
	return { doc, normalized: doc, name: doc.name, dir, path: join(dir, `${doc.name}.yaml`), sha256: sha256(JSON.stringify(doc)), source: "project", commands: {}, scripts: {}, validation: { ok: true, errors: [], warnings: [] } } as LoadedWorkflow;
}
const wf = (name: string, nodes: NodeDoc[], extra: Partial<WorkflowDoc> = {}): WorkflowDoc => ({ apiVersion: "titan.harness/v1", name, version: 1, nodes, ...extra });
const events = (dir: string, type?: string) => readChain(join(dir, "events.jsonl")).filter((r) => !type || r.type === type);

// ═══ Seam 3: mcpTool through the unit's sidecar socket ═════════════════════════

describe("sidecar mcpTool", () => {
	test("one JSON-RPC tools/call POSTed to /mcp/<server> on the unit socket; the text result is parsed", async () => {
		const sc = await fakeSidecar();
		const mcp = createSidecarMcpTool({ socketPath: sc.socketPath, routes: ["zoho", "exa"] });
		expect(await mcp("zoho", "search_records", { module: "Leads", word: "acme" })).toEqual({ records: [{ id: "r1" }] });
		expect(sc.calls).toEqual([{ url: "/mcp/zoho", method: "POST", host: "sidecar", body: { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "search_records", arguments: { module: "Leads", word: "acme" } } } }]);
	});

	test("construction refuses a relative socket, no routes, or a route that is not a plain slug", () => {
		expect(() => createSidecarMcpTool({ socketPath: "unit.sock", routes: ["zoho"] })).toThrow("absolute");
		expect(() => createSidecarMcpTool({ socketPath: "/tmp/x.sock", routes: [] })).toThrow("at least one");
		for (const bad of ["../zoho", "zoho/x", "http://evil", "Zoho", "", "a".repeat(64), "zoho?x=1"]) {
			expect(() => createSidecarMcpTool({ socketPath: "/tmp/x.sock", routes: [bad] })).toThrow("plain slug");
		}
	});

	test("a server outside the unit's routes (a direct upstream, a path, a URL) is refused before any request", async () => {
		const sc = await fakeSidecar();
		const mcp = createSidecarMcpTool({ socketPath: sc.socketPath, routes: ["zoho"] });
		for (const server of ["exa", "https://mcp.zoho.com/mcp", "zoho/../exa", "../../meter", "localhost:9000", "zoho "]) {
			const err = await mcp(server, "search_records", {}).catch((e) => e);
			expect(err).toBeInstanceOf(SidecarMcpError);
			expect(err.retryable).toBe(false);
		}
		expect(await mcp("zoho", " ", {}).catch((e) => e.message)).toContain("tool must be");
		expect(await mcp("zoho", "t", [] as any).catch((e) => e.message)).toContain("args must be an object");
		expect(sc.calls).toEqual([]);
	});

	test("a sidecar refusal is deterministic (retryable:false) and carries the symbolic code; 5xx and a missing socket are retryable", async () => {
		const sc = await fakeSidecar((c) => c.body.params.name === "update_record"
			? { status: 403, body: { jsonrpc: "2.0", id: c.body.id, error: { code: -32602, message: "tool not allowed", data: { code: "MCP_TOOL_DENIED" } } } }
			: { status: 503, body: { jsonrpc: "2.0", id: c.body.id, error: { code: -32003, message: "meter", data: { code: "METER_UNAVAILABLE" } } } });
		const mcp = createSidecarMcpTool({ socketPath: sc.socketPath, routes: ["zoho"] });
		const denied = await mcp("zoho", "update_record", {}).catch((e) => e);
		expect(denied).toMatchObject({ retryable: false, status: 403, code: "MCP_TOOL_DENIED" });
		const busy = await mcp("zoho", "search_records", {}).catch((e) => e);
		expect(busy).toMatchObject({ retryable: true, status: 503, code: "METER_UNAVAILABLE" });
		const gone = createSidecarMcpTool({ socketPath: join(scratch(), "missing.sock"), routes: ["zoho"] });
		expect(await gone("zoho", "search_records", {}).catch((e) => e)).toMatchObject({ retryable: true });
		const notSocket = join(scratch(), "file.sock");
		writeFileSync(notSocket, "");
		expect(await createSidecarMcpTool({ socketPath: notSocket, routes: ["zoho"] })("zoho", "t", {}).catch((e) => e.message)).toContain("not a unix socket");
	});

	test("redirects, an isError result, a wrong id, an oversized body and a hung sidecar all fail", async () => {
		let mode = "redirect";
		const sc = await fakeSidecar((c) => {
			if (mode === "redirect") return { status: 307, headers: { location: "http://evil.example/mcp" }, body: {} };
			if (mode === "isError") return { body: { jsonrpc: "2.0", id: c.body.id, result: { isError: true, content: [{ type: "text", text: "no such module" }] } } };
			if (mode === "wrong-id") return { body: { jsonrpc: "2.0", id: 999, result: { content: [] } } };
			if (mode === "large") return { raw: JSON.stringify({ jsonrpc: "2.0", id: c.body.id, result: { content: [{ type: "text", text: "x".repeat(4096) }] } }) };
			return { hang: true };
		});
		const mcp = createSidecarMcpTool({ socketPath: sc.socketPath, routes: ["zoho"], responseCap: 1024, timeoutMs: 200 });
		expect(await mcp("zoho", "t", {}).catch((e) => e)).toMatchObject({ retryable: false, message: expect.stringContaining("redirect") });
		mode = "isError";
		expect(await mcp("zoho", "t", {}).catch((e) => e)).toMatchObject({ retryable: false, message: expect.stringContaining("no such module") });
		mode = "wrong-id";
		expect(await mcp("zoho", "t", {}).catch((e) => e.message)).toContain("no JSON-RPC result");
		mode = "large";
		expect(await mcp("zoho", "t", {}).catch((e) => e.message)).toContain("exceeds 1024 bytes");
		mode = "hang";
		expect(await mcp("zoho", "t", {}).catch((e) => e)).toMatchObject({ retryable: true, message: expect.stringContaining("timed out") });
		expect(sc.calls.map((c) => c.url)).toEqual(Array(5).fill("/mcp/zoho"));
	});

	test("the timeout bounds elapsed call time: a sidecar trickling bytes below the cap is cut at the deadline (g1 finding 2)", async () => {
		const sc = await fakeSidecar(() => ({ trickleMs: 40 }));
		const mcp = createSidecarMcpTool({ socketPath: sc.socketPath, routes: ["zoho"], timeoutMs: 250, responseCap: 1_048_576 });
		const started = Date.now();
		const err = await mcp("zoho", "search_records", {}).catch((e) => e);
		const elapsed = Date.now() - started;
		expect(err).toBeInstanceOf(SidecarMcpError);
		expect(err).toMatchObject({ retryable: true, message: expect.stringContaining("timed out after 250 ms") });
		// each 40 ms byte resets a socket inactivity timer; only a wall-clock deadline ends the call
		expect(elapsed).toBeGreaterThanOrEqual(240);
		expect(elapsed).toBeLessThan(1500);
		// the request was destroyed: the sidecar sees its connection close
		for (let i = 0; i < 50 && !sc.trickleClosed.length; i++) await Bun.sleep(10);
		expect(sc.trickleClosed.length).toBe(1);
	});

	test("the call deadline is cleared on settlement (success, sidecar error, oversized body)", async () => {
		const DEADLINE = 12_345; // distinctive, so only this module's deadline timer is tracked
		let mode = "ok";
		const sc = await fakeSidecar((c) => mode === "ok"
			? { body: { jsonrpc: "2.0", id: c.body.id, result: { structuredContent: { ok: true } } } }
			: mode === "error" ? { status: 403, body: { jsonrpc: "2.0", id: c.body.id, error: { code: -32602, message: "denied" } } }
			: { raw: "x".repeat(4096) });
		const realSet = globalThis.setTimeout;
		const realClear = globalThis.clearTimeout;
		const armed = new Set<unknown>();
		let cleared = 0;
		globalThis.setTimeout = ((fn: (...a: any[]) => void, ms?: number, ...rest: any[]) => {
			const handle = realSet(fn, ms, ...rest);
			if (ms === DEADLINE) armed.add(handle);
			return handle;
		}) as typeof setTimeout;
		globalThis.clearTimeout = ((handle: any) => {
			if (armed.delete(handle)) cleared++;
			return realClear(handle);
		}) as typeof clearTimeout;
		try {
			const mcp = createSidecarMcpTool({ socketPath: sc.socketPath, routes: ["zoho"], timeoutMs: DEADLINE, responseCap: 1024 });
			expect(await mcp("zoho", "search_records", {})).toEqual({ ok: true });
			mode = "error";
			expect(await mcp("zoho", "update_record", {}).catch((e) => e)).toMatchObject({ retryable: false, status: 403 });
			mode = "large";
			expect(await mcp("zoho", "search_records", {}).catch((e) => e.message)).toContain("exceeds 1024 bytes");
		} finally {
			globalThis.setTimeout = realSet;
			globalThis.clearTimeout = realClear;
		}
		// at least one deadline per call (the http client may arm its own timers with the same ms), and none left pending
		expect(cleared).toBeGreaterThanOrEqual(3);
		expect(armed.size).toBe(0);
	});

	test("an mcp_tool node reaches only the sidecar route; a refusal fails the node once, without retries", async () => {
		const sc = await fakeSidecar((c) => c.body.params.name === "search_records"
			? { body: { jsonrpc: "2.0", id: c.body.id, result: { structuredContent: { count: 2, echo: c.body.params.arguments } } } }
			: { status: 403, body: { jsonrpc: "2.0", id: c.body.id, error: { code: -32602, message: "denied", data: { code: "MCP_TOOL_DENIED" } } } });
		const root = scratch();
		const store = new RunStore(join(root, "runs"));
		const cwd = join(root, "cwd");
		mkdirSync(cwd);
		const doc = wf("crm", [
			{ id: "find", mcp_tool: { server: "zoho", tool: "search_records", args: { word: "$inputs.word" } } } as unknown as NodeDoc,
			{ id: "write", mcp_tool: { server: "zoho", tool: "update_record", args: {} }, depends_on: ["find"] } as unknown as NodeDoc,
		], { inputs: { word: { default: "acme" } } });
		const { runId, dir } = store.open({ projectSlug: "p", cwd, workflow: { name: "crm" } });
		const deps = createWorkflowRuntime({ cwd, runId, runDir: dir, loaded: loadedOf(doc), store, settings: DEFAULT_STACK_SETTINGS,
			runChild: async () => { throw new Error("no agents here"); }, resolveRole: () => ({ model: "fake/m", thinking: "low", callsign: "w", appendSystemPrompts: [], tools: "read" }),
			sidecarMcp: { socketPath: sc.socketPath, routes: ["zoho"] } });
		const result = await executeWorkflow(loadedOf(doc), deps, { inputs: { word: "acme" } });
		expect(result.nodes.find).toMatchObject({ status: "success", output: { count: 2, echo: { word: "acme" } } });
		expect(result.nodes.write).toMatchObject({ status: "failed", attempts: 1, error: expect.stringContaining("MCP_TOOL_DENIED") });
		expect(sc.calls.map((c) => [c.url, c.body.params.name])).toEqual([["/mcp/zoho", "search_records"], ["/mcp/zoho", "update_record"]]);
	});

	test("a hosted runtime refuses a direct mcpTool bridge; mcpTool and sidecarMcp together are refused", () => {
		const root = scratch();
		const store = openRunnerStore(join(root, "runs"));
		stores.push(store);
		const cwd = join(root, "cwd");
		mkdirSync(cwd);
		const { runId, dir } = store.open({ projectSlug: "p", cwd, workflow: { name: "x" } });
		const base = { cwd, runId, runDir: dir, loaded: loadedOf(wf("x", [])), store, settings: DEFAULT_STACK_SETTINGS, runChild: async () => { throw new Error("x"); }, resolveRole: () => ({ model: "m", thinking: "low", callsign: "w", appendSystemPrompts: [], tools: "read" }) } as any;
		const direct = async () => "upstream";
		expect(() => createWorkflowRuntime({ ...base, approver: new QueueApprover(), actorPolicy: allowAll, mcpTool: direct })).toThrow("only through the unit's sidecar socket");
		expect(() => createWorkflowRuntime({ ...base, mcpTool: direct, sidecarMcp: { socketPath: "/tmp/s.sock", routes: ["zoho"] } })).toThrow("not both");
		expect(createWorkflowRuntime({ ...base, approver: new QueueApprover(), actorPolicy: allowAll, sidecarMcp: { socketPath: "/tmp/s.sock", routes: ["zoho"] } }).mcpTool).toBeFunction();
	});
});

// ═══ prod-v1 profile ═══════════════════════════════════════════════════════════

describe("prod-v1 validator profile", () => {
	test("allows exactly the profile's node types; verify only with bash or verifier", () => {
		const ok = wf("ok", [
			{ id: "p", prompt: "x" }, { id: "c", command: "c" }, { id: "b", bash: "true" }, { id: "s", script: "s.ts", runtime: "bun" },
			{ id: "v", verify: { runner: "bash", command: "true" } }, { id: "v2", verify: { runner: "verifier" } }, { id: "a", approval: { message: "ok?" } },
			{ id: "m", mcp_tool: { server: "zoho", tool: "search_records" } }, { id: "x", cancel: "stop" }, { id: "w", workflow: { name: "child" } },
		] as unknown as NodeDoc[]);
		expect(validateProdV1(ok)).toEqual([]);
		const bad = wf("bad", [
			{ id: "l", loop: { prompt: "x", until: "done" } }, { id: "bo", best_of: { n: 2 }, prompt: "x" }, { id: "i", interleave: { segments: [] } }, { id: "h", hypothesis: { hypotheses: [] } },
			{ id: "k", verify: { runner: "kane" } }, { id: "cc", verify: { runner: "cursor-cloud" } },
		] as unknown as NodeDoc[]);
		const issues = validateProdV1(bad);
		expect(issues.map((i) => i.nodeId)).toEqual(["l", "bo", "i", "h", "k", "cc"]);
	});

	test("no dynamic fan-out, no worktree isolation, concurrency ≤ 2", () => {
		const doc = wf("d", [
			{ id: "f", workflow: { name: "c", fan_out: { source: "$in.items", as: "item" } } },
			{ id: "wt", workflow: { name: "c", isolation: "worktree" } },
			{ id: "iso", bash: "true", isolation: "worktree" },
		] as unknown as NodeDoc[], { titan: { budget: { max_concurrent_children: 3 } } });
		const messages = validateProdV1(doc).map((i) => `${i.nodeId ?? "-"}: ${i.message}`);
		expect(messages).toEqual([expect.stringContaining("max_concurrent_children must be 1..2"), expect.stringContaining("f: workflow.fan_out"), expect.stringContaining("wt: workflow.isolation"), expect.stringContaining("iso: isolation must be none")]);
		expect(validateProdV1(wf("d2", [], { titan: { budget: { max_concurrent_children: 2 } } }))).toEqual([]);
	});

	test("a write-named mcp_tool must depend (transitively) on an approval", () => {
		expect(["update_record", "createRecords", "upsert", "send_email", "delete-thing", "zoho_add_tags"].every(isWriteNamedTool)).toBe(true);
		expect(["search_records", "get_record", "executeCOQLQuery", "list_lists", "web_search_exa"].some(isWriteNamedTool)).toBe(false);
		const unguarded = wf("u", [{ id: "w", mcp_tool: { server: "zoho", tool: "update_record" } }] as unknown as NodeDoc[]);
		expect(validateProdV1(unguarded)).toEqual([{ nodeId: "w", message: expect.stringContaining("must depend on an approval") }]);
		const guarded = wf("g", [
			{ id: "gate", approval: { message: "write?" } }, { id: "prep", bash: "true", depends_on: ["gate"] },
			{ id: "w", mcp_tool: { server: "zoho", tool: "update_record" }, depends_on: ["prep"] },
		] as unknown as NodeDoc[]);
		expect(validateProdV1(guarded)).toEqual([]);
	});

	test("a skipped approval does not guard a write: the approval must SUCCEED on every path the trigger rules allow (g1 finding 1)", () => {
		const W = { server: "zoho", tool: "update_record" };
		const refused = (nodes: unknown[]) => validateProdV1(wf("r", nodes as NodeDoc[]));
		const denial = [{ nodeId: "w", message: expect.stringContaining("must succeed before it runs") }];
		// the gate reproduction: approval skipped by when:, write runs under all_done
		expect(refused([{ id: "gate", approval: { message: "write?" }, when: "1 == 2" }, { id: "w", mcp_tool: W, depends_on: ["gate"], trigger_rule: "all_done" }])).toEqual(denial);
		// through an intermediate dependency: prep runs under all_done whatever the gate did
		expect(refused([{ id: "gate", approval: { message: "write?" } }, { id: "prep", bash: "true", depends_on: ["gate"], trigger_rule: "all_done" }, { id: "w", mcp_tool: W, depends_on: ["prep"] }])).toEqual(denial);
		// one_success / none_failed_min_one_success: an ungated sibling can satisfy the rule alone
		for (const rule of ["one_success", "none_failed_min_one_success"]) {
			expect(refused([{ id: "gate", approval: { message: "write?" } }, { id: "other", bash: "true" }, { id: "w", mcp_tool: W, depends_on: ["gate", "other"], trigger_rule: rule }])).toEqual(denial);
			expect(refused([{ id: "g1", approval: { message: "a?" } }, { id: "g2", approval: { message: "b?" } }, { id: "w", mcp_tool: W, depends_on: ["g1", "g2"], trigger_rule: rule }])).toEqual([]);
		}
		// all_success: one gated dep is enough (every dep must succeed), including through intermediates
		expect(refused([{ id: "gate", approval: { message: "write?" } }, { id: "other", bash: "true" }, { id: "w", mcp_tool: W, depends_on: ["gate", "other"] }])).toEqual([]);
		expect(refused([{ id: "gate", approval: { message: "write?" } }, { id: "p1", bash: "true", depends_on: ["gate"], trigger_rule: "one_success" }, { id: "p2", bash: "true", depends_on: ["p1"] }, { id: "w", mcp_tool: W, depends_on: ["p2"] }])).toEqual([]);
		// a when: on a gated path only ever skips, so it never weakens the guard
		expect(refused([{ id: "gate", approval: { message: "write?" }, when: "1 == 2" }, { id: "w", mcp_tool: W, depends_on: ["gate"] }])).toEqual([]);
		// the write itself under all_done is never gated, whatever its deps
		expect(refused([{ id: "gate", approval: { message: "write?" } }, { id: "w", mcp_tool: W, depends_on: ["gate"], trigger_rule: "all_done" }])).toEqual(denial);
		// a dependency that does not exist, or a cycle, is not an approval
		expect(refused([{ id: "w", mcp_tool: W, depends_on: ["ghost"] }])).toEqual(denial);
		expect(refused([{ id: "a", bash: "true", depends_on: ["b"] }, { id: "b", bash: "true", depends_on: ["a"] }, { id: "w", mcp_tool: W, depends_on: ["a"] }])).toEqual(denial);
	});

	test("the reproduction executes nothing under executeProdV1: zero approval requests, zero write calls", async () => {
		const root = scratch();
		const store = new RunStore(join(root, "runs"));
		const { runId, dir } = store.open({ projectSlug: "p", cwd: root, workflow: { name: "skip-gate" } });
		const approvals: string[] = [];
		const writes: string[] = [];
		const deps = stubDeps(store, runId, dir, root, {
			async approval(message) { approvals.push(message); return { approved: true, response: "yes" }; },
			async mcpTool(server, tool) { writes.push(`${server}/${tool}`); return { ok: true }; },
		});
		const repro = wf("skip-gate", [
			{ id: "gate", approval: { message: "write?" }, when: "1 == 2" },
			{ id: "w", mcp_tool: { server: "zoho", tool: "update_record" }, depends_on: ["gate"], trigger_rule: "all_done" },
		] as unknown as NodeDoc[]);
		expect(() => executeProdV1(loadedOf(repro), deps)).toThrow(ProfileError);
		expect(events(dir)).toEqual([]);
		// the allowed shape (default all_success): the skipped approval skips the write too
		const guarded = wf("skip-gate-ok", [
			{ id: "gate", approval: { message: "write?" }, when: "1 == 2" },
			{ id: "w", mcp_tool: { server: "zoho", tool: "update_record" }, depends_on: ["gate"] },
		] as unknown as NodeDoc[]);
		const r = await executeProdV1(loadedOf(guarded), deps);
		expect(r.nodes.gate?.status).toBe("skipped");
		expect(r.nodes.w?.status).toBe("skipped");
		expect(approvals).toEqual([]);
		expect(writes).toEqual([]);
	});

	test("executeProdV1 refuses a non-prod-v1 workflow before any run work, and caps parallelism at 2", async () => {
		const root = scratch();
		const store = new RunStore(join(root, "runs"));
		const { runId, dir } = store.open({ projectSlug: "p", cwd: root, workflow: { name: "t" } });
		let live = 0, peak = 0;
		const deps = stubDeps(store, runId, dir, root, { bash: async () => { live++; peak = Math.max(peak, live); await Bun.sleep(20); live--; return { code: 0, stdout: "ok\n", stderr: "" }; } });
		expect(() => executeProdV1(loadedOf(wf("bad", [{ id: "l", loop: { prompt: "x", until: "d" } }] as unknown as NodeDoc[])), deps)).toThrow(ProfileError);
		expect(events(dir)).toEqual([]);
		const wide = wf("wide", Array.from({ length: 5 }, (_, i) => ({ id: `b${i}`, bash: "true" })) as unknown as NodeDoc[]);
		const r = await executeProdV1(loadedOf(wide), deps, { maxParallel: 8 });
		expect(r.status).toBe("completed");
		expect(peak).toBe(PROD_V1_MAX_PARALLEL);
	});
});

// ═══ Seam 4: runWorkflow, recursive in the runner ═════════════════════════════

function stubDeps(store: RunStore, runId: string, runDir: string, cwd: string, extra: Partial<WorkflowRuntimeDeps> = {}): WorkflowRuntimeDeps {
	return {
		cwd, runId, runDir, artifactsDir: join(runDir, "artifacts"), workflowId: "t", store,
		settings: { ...DEFAULT_STACK_SETTINGS },
		async agent(req) { return { ok: true, text: `${req.nodeId} done`, sessionRef: `s-${req.nodeId}`, usage: { tokensIn: 100, tokensOut: 50, costUsd: 0.4, tpsSeconds: 1 }, toolCalls: 0, model: req.model } as AgentResult; },
		async bash() { return { code: 0, stdout: "ok\n", stderr: "" }; },
		async script() { return { code: 0, stdout: "{}\n", stderr: "" }; },
		async approval() { return { approved: false, response: "no" }; },
		notify() {},
		resolveRole(role) { return { model: `stub/${role}`, thinking: "medium", callsign: `${role}-1`, appendSystemPrompts: [], tools: FULL_TOOLS }; },
		...extra,
	};
}

function runnerHost(workflows: Record<string, WorkflowDoc>, agentCalls: string[] = []) {
	const root = scratch();
	const store = new RunStore(join(root, "runs"));
	const cwd = join(root, "cwd");
	mkdirSync(cwd);
	const loads: string[] = [];
	const host = {
		store, cwd, projectSlug: "p",
		load: (name: string) => {
			loads.push(name);
			const doc = workflows[name];
			if (!doc) throw new Error(`workflow ${JSON.stringify(name)} not found`);
			return loadedOf(doc);
		},
		makeDeps: ({ loaded, runId, runDir, runWorkflow }: any) => stubDeps(store, runId, runDir, cwd, {
			workflowId: loaded.name, runWorkflow,
			async agent(req) { agentCalls.push(`${loaded.name}:${req.nodeId}`); return { ok: true, text: "done", sessionRef: `s-${req.nodeId}`, usage: { tokensIn: 100, tokensOut: 50, costUsd: 0.4, tpsSeconds: 1 }, toolCalls: 0, model: req.model } as AgentResult; },
		}),
	};
	return { host, store, cwd, loads };
}

async function runTop(h: ReturnType<typeof runnerHost>, doc: WorkflowDoc): Promise<{ result: RunResult; runId: string; dir: string }> {
	const { runId, dir } = h.store.open({ projectSlug: "p", cwd: h.cwd, workflow: { name: doc.name }, status: "running" });
	const runWorkflow = createRunnerRunWorkflow(h.host, { runId, chain: [doc.name] });
	const result = await executeProdV1(loadedOf(doc), h.host.makeDeps({ loaded: loadedOf(doc), runId, runDir: dir, runWorkflow }));
	return { result, runId, dir };
}

describe("runner runWorkflow", () => {
	test("a nested workflow opens its run in the runner store with parentRunId, recursively, and returns its value", async () => {
		const h = runnerHost({
			mid: wf("mid", [{ id: "leaf", workflow: { name: "leaf" } }] as unknown as NodeDoc[], { returns: "leaf" }),
			leaf: wf("leaf", [{ id: "b", bash: "echo leaf" }] as unknown as NodeDoc[], { returns: "b" }),
		});
		const { result, runId } = await runTop(h, wf("top", [{ id: "m", workflow: { name: "mid" } }] as unknown as NodeDoc[], { returns: "m" }));
		expect(result.status).toBe("completed");
		expect(result.returns).toBe("ok");
		const runs = h.store.listRuns(undefined, 50);
		const mid = runs.find((r) => r.workflow?.name === "mid")!;
		const leaf = runs.find((r) => r.workflow?.name === "leaf")!;
		expect(mid.parentRunId).toBe(runId);
		expect(leaf.parentRunId).toBe(mid.runId);
		expect(h.loads).toEqual(["mid", "leaf"]);
	});

	test("a nested workflow runs under the parent's budget: refused at the parent's remainder whatever it declares", async () => {
		const agentCalls: string[] = [];
		const h = runnerHost({
			sub: wf("sub", [{ id: "c1", prompt: "one" }, { id: "c2", prompt: "two", depends_on: ["c1"] }] as unknown as NodeDoc[], { titan: { budget: { usd: 100, per_call_usd: 0.5 } } }),
		}, agentCalls);
		const { result } = await runTop(h, wf("top", [
			{ id: "first", prompt: "spend" },
			{ id: "sub", workflow: { name: "sub" }, depends_on: ["first"] },
		] as unknown as NodeDoc[], { titan: { budget: { usd: 1, per_call_usd: 0.5 } } }));
		// parent $1: first spends $0.40; sub.c1 reserves $0.50 of the $0.60 left, spends $0.40; c2 needs $0.50 > $0.20.
		expect(agentCalls).toEqual(["top:first", "sub:c1"]);
		expect(result.nodes.sub).toMatchObject({ status: "failed", attempts: 1, error: expect.stringContaining("budget exceeded: workflow:top") });
		expect(result.budget).toMatchObject({ spentUsdMicros: 800_000, reservedUsdMicros: 0 });
	});

	test("prod-v1 calls only prod-v1: a child outside the profile, a missing child, recursion and excess depth fail the node before any child run opens", async () => {
		const deep: Record<string, WorkflowDoc> = {};
		for (let i = 1; i <= MAX_WORKFLOW_DEPTH + 1; i++) deep[`d${i}`] = wf(`d${i}`, [{ id: "n", workflow: { name: `d${i + 1}` }, retry: { max_attempts: 1 } }] as unknown as NodeDoc[]);
		const h = runnerHost({
			loopy: wf("loopy", [{ id: "l", loop: { prompt: "x", until: "d" } }] as unknown as NodeDoc[]),
			self: wf("self", [{ id: "again", workflow: { name: "self" }, retry: { max_attempts: 1 } }] as unknown as NodeDoc[]),
			...deep,
		});
		const before = () => h.store.listRuns(undefined, 100).length;
		const one = async (name: string, retry?: number) => (await runTop(h, wf("top", [{ id: "n", workflow: { name }, ...(retry ? { retry: { max_attempts: retry } } : {}) }] as unknown as NodeDoc[]))).result.nodes.n;
		// a seam refusal is final: attempts 1 even under the default retry policy (2)
		let n0 = before();
		expect(await one("loopy")).toMatchObject({ status: "failed", attempts: 1, error: expect.stringContaining("is not prod-v1") });
		expect(before()).toBe(n0 + 1); // only the top run
		expect((await one("ghost")).error).toContain("not found");
		n0 = before();
		const self = await one("self", 1);
		expect(self.error).toContain("would recurse (top → self → self)");
		expect(before()).toBe(n0 + 2); // top + the first self; the inner self never opened
		expect(h.store.listRuns(undefined, 100).filter((r) => r.workflow?.name === "self").every((r) => r.status === "failed")).toBe(true);
		const d = await one("d1", 1);
		expect(d.status).toBe("failed");
		const depthRefusal = h.store.listRuns(undefined, 100).find((r) => r.workflow?.name === `d${MAX_WORKFLOW_DEPTH - 1}`);
		expect(depthRefusal).toBeDefined();
		expect(h.store.listRuns(undefined, 100).some((r) => r.workflow?.name === `d${MAX_WORKFLOW_DEPTH}`)).toBe(false);
	});

	test("cancelling the parent cancels the running child through the caller's signal", async () => {
		const root = scratch();
		const store = new RunStore(join(root, "runs"));
		const controller = new AbortController();
		let childStatus: string | undefined;
		const host = {
			store, cwd: root, projectSlug: "p",
			load: (name: string) => loadedOf(wf(name, [{ id: "slow", bash: "sleep" }] as unknown as NodeDoc[])),
			makeDeps: ({ loaded, runId, runDir, runWorkflow }: any) => stubDeps(store, runId, runDir, root, { workflowId: loaded.name, runWorkflow, signal: loaded.name === "top" ? controller.signal : undefined,
				bash: (_c: string, opts: any) => new Promise((resolve, reject) => { opts.signal?.addEventListener("abort", () => reject(Object.assign(new Error("aborted"), { name: "AbortError" }))); }) }),
		};
		const { runId, dir } = store.open({ projectSlug: "p", cwd: root, workflow: { name: "top" }, status: "running" });
		const top = loadedOf(wf("top", [{ id: "c", workflow: { name: "child" }, retry: { max_attempts: 1 } }] as unknown as NodeDoc[]));
		const running = executeProdV1(top, host.makeDeps({ loaded: top, runId, runDir: dir, runWorkflow: async (...a: Parameters<NonNullable<WorkflowRuntimeDeps["runWorkflow"]>>) => { const r = await createRunnerRunWorkflow(host, { runId, chain: ["top"] })(...a); childStatus = r.status; return r; } }));
		for (let i = 0; i < 200 && !store.listRuns(undefined, 10).some((r) => r.workflow?.name === "child"); i++) await Bun.sleep(2);
		controller.abort();
		const result = await running;
		expect(result.status).toBe("cancelled");
		expect(childStatus).toBe("cancelled");
	});
});

// ═══ The interrupted-run test: all three seams in one runner process, kill -9, restart ═══

const MODULES = join(import.meta.dir, "../modules");
function runnerProcessScript(root: string, socketPath: string): string {
	return `
import { mkdirSync } from "node:fs";
import { openRunnerStore } from ${JSON.stringify(join(MODULES, "run-store.ts"))};
import { DEFAULT_STACK_SETTINGS } from ${JSON.stringify(join(MODULES, "stack-config.ts"))};
import { createWorkflowRuntime } from ${JSON.stringify(join(MODULES, "workflow-runtime.ts"))};
import { QueueApprover } from ${JSON.stringify(join(MODULES, "workflow/approver.ts"))};
import { createRunnerRunWorkflow, executeProdV1 } from ${JSON.stringify(join(MODULES, "workflow/runner-seams.ts"))};
const root = ${JSON.stringify(root)};
const store = openRunnerStore(root + "/runs");
const cwd = root + "/cwd";
mkdirSync(cwd, { recursive: true });
const docs = {
	top: { apiVersion: "titan.harness/v1", name: "top", nodes: [
		{ id: "lookup", mcp_tool: { server: "zoho", tool: "search_records", args: { word: "$inputs.word" } } },
		{ id: "release", workflow: { name: "release" }, depends_on: ["lookup"] },
	] },
	release: { apiVersion: "titan.harness/v1", name: "release", nodes: [{ id: "gate", approval: { message: "Release?", content: "$inputs.word" } }] },
};
const loaded = (name) => { const doc = docs[name]; return { doc, normalized: doc, name, dir: root, path: root + "/" + name + ".yaml", sha256: name, source: "project", commands: {}, scripts: {}, validation: { ok: true, errors: [], warnings: [] } }; };
const queue = new QueueApprover();
const host = {
	store, cwd, projectSlug: "p", load: loaded,
	makeDeps: ({ loaded, runId, runDir, runWorkflow }) => createWorkflowRuntime({ cwd, runId, runDir, loaded, store, settings: DEFAULT_STACK_SETTINGS,
		runChild: async () => { throw new Error("no agents"); },
		resolveRole: () => ({ model: "fake/model", thinking: "low", callsign: "worker", appendSystemPrompts: [], tools: "read" }),
		approver: queue, actorPolicy: { policyId: "p", authorize: () => true },
		sidecarMcp: { socketPath: ${JSON.stringify(socketPath)}, routes: ["zoho"] }, runWorkflow }),
};
const { runId, dir } = store.open({ projectSlug: "p", cwd, workflow: { name: "top" }, status: "running" });
executeProdV1(loaded("top"), host.makeDeps({ loaded: loaded("top"), runId, runDir: dir, runWorkflow: createRunnerRunWorkflow(host, { runId, chain: ["top"] }) }), { inputs: { word: "acme" } });
const wait = setInterval(() => { if (queue.requests.length) { clearInterval(wait); console.log(JSON.stringify({ topDir: dir, topRunId: runId, req: queue.requests[0] })); } }, 5);
setInterval(() => {}, 1 << 30);
`;
}

describe("interrupted run across the three runner seams", () => {
	test("mcp_tool via the sidecar → nested runWorkflow → web approval parks; kill -9; restart marks parent and child interrupted, the pending approval intact, nothing replayed", async () => {
		const sc = await fakeSidecar();
		const root = scratch("titan-seams-kill-");
		const script = join(root, "runner.ts");
		writeFileSync(script, runnerProcessScript(root, sc.socketPath));
		const child = Bun.spawn([process.execPath, script], { stdout: "pipe", stderr: "pipe" });
		const reader = child.stdout.getReader();
		let out = "";
		const deadline = Date.now() + 15_000;
		while (!out.includes("\n") && Date.now() < deadline) {
			const chunk = await reader.read();
			if (chunk.done) break;
			out += new TextDecoder().decode(chunk.value);
		}
		if (!out.includes("\n")) throw new Error(`runner process produced no request: ${await new Response(child.stderr).text()}`);
		const { topDir, topRunId, req } = JSON.parse(out) as { topDir: string; topRunId: string; req: ApprovalRequest };
		child.kill("SIGKILL");
		await child.exited;

		// seam 3 ran exactly once, through the unit socket
		expect(sc.calls.map((c) => [c.url, c.body.method, c.body.params.name])).toEqual([["/mcp/zoho", "tools/call", "search_records"]]);
		// seam 4: the child run lives in the runner store under the parent
		const runsRoot = join(root, "runs");
		const plain = new RunStore(runsRoot);
		const childMeta = plain.listRuns(undefined, 10).find((r) => r.workflow?.name === "release")!;
		expect(childMeta.parentRunId).toBe(topRunId);
		expect(req.runId).toBe(childMeta.runId);
		const childDir = plain.dir(childMeta.runId, childMeta.projectSlug);
		// seam 2 bound the approval to the content the nested run received from the parent's inputs
		expect(req.artifactSha256).toBe(sha256("acme"));
		const approvalsBefore = readFileSync(join(childDir, APPROVALS_FILE), "utf8");

		const store = openRunnerStore(runsRoot);
		stores.push(store);
		expect(store.recovered.map((r) => r.runId).sort()).toEqual([topRunId, childMeta.runId].sort());
		expect(store.readRun(topDir).status).toBe("interrupted");
		expect(store.readRun(childDir).status).toBe("interrupted");
		expect(store.listPendingApprovals(childDir)).toEqual([req]);
		expect(readFileSync(join(childDir, APPROVALS_FILE), "utf8")).toBe(approvalsBefore);
		expect(events(topDir).at(-1)?.type).toBe("run.interrupted");
		expect(events(childDir).at(-1)?.type).toBe("run.interrupted");
		// the finished mcp_tool node kept its artifact; the restart replayed nothing
		expect(events(topDir, "node.end").map((e) => (e.data as any).nodeId)).toEqual(["lookup"]);
		expect(existsSync(join(topDir, "artifacts", "nodes", "lookup.md"))).toBe(true);
		expect(sc.calls).toHaveLength(1);
	}, 30_000);
});
