import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, readFileSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readChain, sha256, verifyChain } from "../modules/hash-chain.ts";
import { APPROVALS_FILE, DEFAULT_RUN_ROOT, MAX_APPROVAL_REFUSALS, RUNNER_LOCK_FILE, RUNNER_LOCK_UNPARSABLE_GRACE_MS, RunStore, type RunnerStore, assertRunnerRootOutside, listPendingApprovals, openRunnerStore, recoverInterruptedRuns } from "../modules/run-store.ts";
import { DEFAULT_STACK_SETTINGS } from "../modules/stack-config.ts";
import { createWorkflowRuntime, type WorkflowRuntimeHost } from "../modules/workflow-runtime.ts";
import { type ActorPolicy, DEFAULT_APPROVAL_TTL_MS, QueueApprover, type ApprovalDecision, type ApprovalRequest, type Approver } from "../modules/workflow/approver.ts";
import { executeWorkflow } from "../modules/workflow/executor.ts";
import type { LoadedWorkflow } from "../modules/workflow/loader.ts";
import type { ApprovalSpec, WorkflowDoc } from "../modules/workflow/schema.ts";
import { readWorkflowProjection } from "../modules/monitor/workflow-projection.ts";
import { buildSidebarView, sidebarHeaderText } from "../modules/monitor/sidebar.ts";
import { renderWorkflowTui } from "../modules/monitor/workflow-tui.ts";

const dirs: string[] = [];
const active: Array<() => Promise<void>> = [];
afterEach(async () => {
	while (active.length) await active.pop()!();
	while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});
const allowAll: ActorPolicy = { policyId: "test-allow-all", authorize: () => true };
const stores: RunnerStore[] = [];
afterEach(() => { while (stores.length) stores.pop()!.release(); });
function runnerStore(root: string): RunnerStore {
	const store = openRunnerStore(root);
	stores.push(store);
	return store;
}
const PRESET = readFileSync(join(import.meta.dir, "../../../.pi/titan-harness/presets/content/example-saas-blog-post-founder.yaml"), "utf8");
function harness(spec: ApprovalSpec = { message: "Ship?", content: "draft", capture_response: true }, overrides: Partial<WorkflowRuntimeHost> = {}, inputs: Record<string, unknown> = {}, nodes?: WorkflowDoc["nodes"]) {
	const root = mkdtempSync(join(tmpdir(), "titan-web-approval-"));
	dirs.push(root);
	mkdirSync(join(root, ".titan/presets/content"), { recursive: true });
	writeFileSync(join(root, ".titan/presets/content/p.yaml"), PRESET.replace("key: example-saas-blog-post-founder", "key: p"));
	const storeRoot = mkdtempSync(join(tmpdir(), "titan-web-approval-runner-")); // outside the workflow cwd
	dirs.push(storeRoot);
	const store = runnerStore(storeRoot);
	const { runId, dir } = store.open({ projectSlug: "p", cwd: root, workflow: { name: "web" } });
	const doc: WorkflowDoc = { name: "web", nodes: nodes ?? [{ id: "gate", approval: spec }] };
	const loaded = { name: "web", doc, normalized: doc, dir: root, path: join(root, "web.yaml"), sha256: sha256("web"), source: "project", commands: {}, scripts: {}, validation: { ok: true, errors: [], warnings: [] } } as LoadedWorkflow;
	const queue = new QueueApprover();
	const controller = new AbortController();
	const deps = createWorkflowRuntime({ cwd: root, runId, runDir: dir, loaded, store, settings: DEFAULT_STACK_SETTINGS,
		runChild: async () => { throw new Error("unexpected child"); },
		resolveRole: () => ({ model: "fake/model", thinking: "low", callsign: "worker", appendSystemPrompts: [], tools: "read" }),
		approver: queue, actorPolicy: allowAll, signal: controller.signal, ...overrides });
	let finished = false;
	const result = executeWorkflow(loaded, deps, { inputs }).finally(() => { finished = true; });
	active.push(async () => { controller.abort(); await result; });
	return { root, storeRoot, store, runId, dir, queue, result, spec, doc, finished: () => finished };
}
async function requested(queue: QueueApprover, n = 1): Promise<ApprovalRequest> {
	for (let i = 0; i < 200 && queue.requests.length < n; i++) await Bun.sleep(1);
	expect(queue.requests.length).toBeGreaterThanOrEqual(n);
	return queue.requests[n - 1];
}
function decision(req: ApprovalRequest, patch: Partial<ApprovalDecision> = {}): ApprovalDecision {
	return { requestId: req.requestId, runId: req.runId, nodeId: req.nodeId, artifactSha256: req.artifactSha256,
		actor: "reviewer@example.test", decision: "approve", response: "ship it", decidedAt: new Date().toISOString(), nonce: "nonce-1", ...patch };
}
const rows = (dir: string) => readChain(join(dir, APPROVALS_FILE));
const binding = (req: ApprovalRequest) => ({ requestId: req.requestId, artifactSha256: req.artifactSha256, actorAuthorized: true });
/** Lifecycle checks sit behind the ownership fence: put a finished run back to `running` (plain store write). */
const markRunning = (h: { storeRoot: string; dir: string }) => new RunStore(h.storeRoot).updateRun(h.dir, { status: "running" });

describe("runner web approvals", () => {
	test("approve through executeWorkflow; durable requested → decided → consumed with actor; approver wins over UI", async () => {
		let tuiCalls = 0;
		const h = harness(undefined, { ui: { confirm: async () => { tuiCalls++; return false; }, notify() {} } });
		const req = await requested(h.queue);
		expect(listPendingApprovals(h.dir)).toEqual([req]);
		expect(req.artifactSha256).toBe(sha256("draft"));
		expect(Date.parse(req.expiresAt) - Date.parse(req.createdAt)).toBe(DEFAULT_APPROVAL_TTL_MS);
		h.queue.deliver(decision(req));
		expect((await h.result).status).toBe("completed");
		expect(rows(h.dir).map(r => r.type)).toEqual(["approval.requested", "approval.decided", "approval.consumed"]);
		expect(rows(h.dir)[1].data).toMatchObject({ decision: { actor: "reviewer@example.test" } });
		expect(readChain(join(h.dir, "events.jsonl")).filter(r => String(r.type).startsWith("approval.")).map(r => r.type)).toEqual(rows(h.dir).map(r => r.type));
		expect(verifyChain(join(h.dir, APPROVALS_FILE)).ok).toBe(true);
		expect(listPendingApprovals(h.dir)).toEqual([]);
		expect(tuiCalls).toBe(0);
	});

	test("second consume fails for the same object AND a replay with a fresh nonce (owning store; a plain RunStore is refused as runner_not_owner)", async () => {
		const h = harness(); const req = await requested(h.queue); const d = decision(req);
		h.queue.deliver(d); await h.result;
		const fresh = new RunStore(h.storeRoot);
		expect(fresh.consumeDecision(h.dir, d, binding(req))).toEqual({ ok: false, reason: "runner_not_owner" });
		markRunning(h);
		expect(h.store.consumeDecision(h.dir, d, binding(req))).toEqual({ ok: false, reason: "request already consumed" });
		expect(h.store.consumeDecision(h.dir, { ...d, nonce: "forged-fresh-nonce" }, binding(req))).toEqual({ ok: false, reason: "request already consumed" });
		expect(rows(h.dir).filter(r => r.type === "approval.consumed")).toHaveLength(1);
		expect(rows(h.dir).filter(r => r.type === "approval.refused")).toHaveLength(2);
	});

	test("concurrent consumers on the owning store have exactly one winner", async () => {
		const h = harness(); const req = await requested(h.queue);
		const results = await Promise.all([h.store, h.store].map(store => Promise.resolve().then(() => store.consumeDecision(h.dir, decision(req), binding(req)))));
		expect(results.filter(r => r.ok)).toHaveLength(1);
		expect(results.filter(r => !r.ok)).toHaveLength(1);
		h.queue.deliver(decision(req));
		expect((await h.result).status).toBe("cancelled");
	});

	for (const [name, patch, reason] of [
		["wrong run", { runId: "other-run" }, "runId mismatch"],
		["wrong node", { nodeId: "other-node" }, "nodeId mismatch"],
		["wrong request", { requestId: "other-request" }, "requestId mismatch"],
		["wrong sha", { artifactSha256: sha256("other") }, "artifactSha256 mismatch"],
		["empty actor", { actor: " \t" }, "empty actor"],
		["empty nonce", { nonce: "" }, "empty nonce"],
		["invalid time", { decidedAt: "never" }, "invalid timestamp"],
		["invalid decision", { decision: "maybe" }, "invalid decision"],
	] as const) {
		test(`${name} is refused and recorded; node waits for a valid decision`, async () => {
			const h = harness(); const req = await requested(h.queue);
			h.queue.deliver(decision(req, patch as Partial<ApprovalDecision>));
			const retried = await requested(h.queue, 2);
			expect(retried.requestId).toBe(req.requestId);
			expect(h.finished()).toBe(false);
			expect(rows(h.dir).at(-1)?.data).toMatchObject({ reason });
			expect(listPendingApprovals(h.dir)).toEqual([req]);
			h.queue.deliver(decision(req));
			expect((await h.result).status).toBe("completed");
		});
	}

	test("decidedAt after expiry is refused without letting a forged future timestamp expire the pending request", async () => {
		const h = harness(); const req = await requested(h.queue);
		h.queue.deliver(decision(req, { decidedAt: new Date(Date.parse(req.expiresAt) + 1).toISOString() }));
		await requested(h.queue, 2);
		expect(rows(h.dir).at(-1)?.data).toMatchObject({ reason: "approval expired" });
		expect(h.finished()).toBe(false);
		expect(listPendingApprovals(h.dir)).toEqual([req]);
		h.queue.deliver(decision(req)); await h.result;
	});

	test("runner clock rejects a late delivery even if decidedAt was before expiry", async () => {
		const h = harness(); const base = await requested(h.queue);
		const req = { ...base, requestId: "expired-request", createdAt: new Date(Date.now() - 2000).toISOString(), expiresAt: new Date(Date.now() - 1000).toISOString() };
		h.store.requestApproval(h.dir, req);
		const result = h.store.consumeDecision(h.dir, decision(req, { decidedAt: req.createdAt }), binding(req));
		expect(result).toEqual({ ok: false, reason: "approval expired" });
		expect(rows(h.dir).slice(-2).map(r => r.type)).toEqual(["approval.refused", "approval.expired"]);
		expect(listPendingApprovals(h.dir).map(r => r.requestId)).not.toContain(req.requestId);
		expect(h.finished()).toBe(false);
		h.queue.deliver({ unavailable: true }); expect((await h.result).status).toBe("cancelled");
	});

	test("a host that never replies cannot bypass TTL", async () => {
		const h = harness(undefined, { approvalTtlMs: 15 });
		expect((await h.result).status).toBe("cancelled");
		expect(rows(h.dir).map(r => r.type)).toEqual(["approval.requested", "approval.expired"]);
		expect(listPendingApprovals(h.dir)).toEqual([]);
	});

	test("content changed while waiting refuses the old decision as stale and never approves the node", async () => {
		const h = harness(); const req = await requested(h.queue);
		h.spec.content = "edited while waiting";
		h.queue.deliver(decision(req)); await requested(h.queue, 2);
		expect(h.finished()).toBe(false);
		expect(rows(h.dir).at(-1)?.data).toMatchObject({ reason: "stale artifact" });
		expect(listPendingApprovals(h.dir)).toEqual([req]);
		h.queue.deliver({ unavailable: true });
		expect((await h.result).nodes.gate.status).toBe("cancelled");
		expect(rows(h.dir).some(r => r.type === "approval.consumed")).toBe(false);
	});

	test("unknown requests cannot be consumed", async () => {
		const h = harness(); const req = await requested(h.queue);
		expect(h.store.consumeDecision(h.dir, decision(req), { ...binding(req), requestId: "missing" })).toEqual({ ok: false, reason: "request not pending" });
		expect(listPendingApprovals(h.dir)).toEqual([req]);
	});

	test("restart marks running as interrupted and preserves pending sha/expiry without replay; monitors render it", async () => {
		const h = harness(); const req = await requested(h.queue);
		expect(h.store.readRun(h.dir).status).toBe("running");
		const before = readFileSync(join(h.dir, APPROVALS_FILE), "utf8");
		const fresh = new RunStore(h.storeRoot);
		expect(recoverInterruptedRuns(fresh).map(r => r.runId)).toEqual([h.runId]);
		expect(fresh.readRun(h.dir).status).toBe("interrupted");
		expect(fresh.listPendingApprovals(h.dir)).toEqual([req]);
		expect(readFileSync(join(h.dir, APPROVALS_FILE), "utf8")).toBe(before);
		expect(recoverInterruptedRuns(fresh)).toEqual([]);
		expect(h.queue.requests).toHaveLength(1);
		expect(readChain(join(h.dir, "events.jsonl")).at(-1)?.type).toBe("run.interrupted");
		const projection = readWorkflowProjection(h.dir);
		expect(projection.status).toBe("interrupted");
		const sidebar = buildSidebarView(fresh, h.dir, h.doc);
		expect(sidebarHeaderText(sidebar)).toContain("interrupted");
		expect(renderWorkflowTui(projection, { expanded: new Set(), selected: 0, offset: 0, help: false, group: "all" }, 120, 30).lines.join("\n")).toContain("interrupted");
	});

	test("headless with approver undefined and ui undefined cancels with unchanged reason", async () => {
		const h = harness(undefined, { approver: undefined, ui: undefined });
		const result = await h.result;
		expect(result.status).toBe("cancelled");
		expect(result.nodes.gate.status).toBe("cancelled");
		expect(result.nodes.gate.error).toBe("approval rejected: headless session: no approver available");
		expect(rows(h.dir)).toEqual([]);
	});

	test("rejection reworks through the agent and requests a fresh id and hash for the new artifact", async () => {
		const spec = { message: "Ship?", content: "draft", on_reject: { prompt: "Fix: $REJECTION_REASON", max_attempts: 1 } };
		const h = harness(spec, {
			runChild: async (opts) => { spec.content = "revised draft"; Object.assign(opts.run, { text: "revised draft", status: "done", exitCode: 0, stopReason: "stop" }); return opts.run; },
		});
		const first = await requested(h.queue);
		h.queue.deliver(decision(first, { decision: "reject", response: "needs revision" }));
		const second = await requested(h.queue, 2);
		expect(second.requestId).not.toBe(first.requestId);
		expect(second.attempt).toBe(2);
		expect(second.artifactSha256).toBe(sha256("revised draft"));
		h.queue.deliver(decision(second));
		expect((await h.result).status).toBe("completed");
		expect(rows(h.dir).filter(r => r.type === "approval.consumed")).toHaveLength(2);
	});

	test("empty content is bound; missing content hashes the substituted message", async () => {
		for (const content of ["", undefined]) {
			const h = harness({ message: "Ship $RUN_ID?", content }); const req = await requested(h.queue);
			expect(req.artifactSha256).toBe(sha256(content ?? `Ship ${h.runId}?`));
			h.queue.deliver(decision(req)); await h.result;
		}
	});

	test("declared content hashes raw substituted values and preset receipts keep the same binding", async () => {
		const h = harness({ message: "Review $RUN_ID", content: "$inputs.artifact", preset_key: "example-saas-blog-post-founder" }, {}, { artifact: { body: "draft" } });
		const req = await requested(h.queue);
		expect(req.message).toBe(`Review ${h.runId}`);
		expect(req.artifactSha256).toBe(sha256('{"body":"draft"}'));
		h.queue.deliver(decision(req, { response: "reviewer: Dana; accuracy=5" }));
		const result = await h.result;
		expect(result.status).toBe("completed");
		expect(result.nodes.gate.output).toMatchObject({ approved: true, receipts: 1, contentSha256: req.artifactSha256 });
	});

	test("a persistence failure prevents approval even after a valid decision", async () => {
		const h = harness(); const req = await requested(h.queue);
		const append = h.store.appendEvent.bind(h.store);
		h.store.appendEvent = (dir, type, data, agentId) => {
			if (type === "approval.consumed") throw new Error("simulated mirror write failure");
			return append(dir, type, data, agentId);
		};
		h.queue.deliver(decision(req));
		expect((await h.result).nodes.gate.status).toBe("failed");
		// The authoritative consumption survived even though the observer mirror failed.
		markRunning(h);
		expect(h.store.consumeDecision(h.dir, decision(req), binding(req))).toEqual({ ok: false, reason: "request already consumed" });
	});

	test("recovery leaves other run statuses and overdue pending requests untouched", async () => {
		const h = harness(); const base = await requested(h.queue);
		const req = { ...base, requestId: "overdue", expiresAt: new Date(Date.now() - 1000).toISOString() };
		h.store.requestApproval(h.dir, req);
		const other = h.store.open({ projectSlug: "p", cwd: h.root, status: "completed" });
		expect(recoverInterruptedRuns(new RunStore(h.storeRoot))).toHaveLength(1);
		expect(h.store.readRun(other.dir).status).toBe("completed");
		expect(listPendingApprovals(h.dir)).toEqual([base, req]);
	});

	test("tampering with the durable approval log fails closed", async () => {
		const h = harness(); const req = await requested(h.queue);
		const file = join(h.dir, APPROVALS_FILE);
		writeFileSync(file, readFileSync(file, "utf8").replace(req.artifactSha256, sha256("tampered")));
		expect(() => h.store.consumeDecision(h.dir, decision(req), binding(req))).toThrow("approval chain invalid");
	});
});

// ═══ Repair round 1: runner store, rework binding, actor policy, store-derived preset tally ═══

const MODULES = join(import.meta.dir, "../modules");
/** A real child process that opens a runner store and parks a hosted approval; it prints the run dir. */
function childRunnerScript(root: string): string {
	return `
import { openRunnerStore } from ${JSON.stringify(join(MODULES, "run-store.ts"))};
import { DEFAULT_STACK_SETTINGS } from ${JSON.stringify(join(MODULES, "stack-config.ts"))};
import { createWorkflowRuntime } from ${JSON.stringify(join(MODULES, "workflow-runtime.ts"))};
import { QueueApprover } from ${JSON.stringify(join(MODULES, "workflow/approver.ts"))};
import { executeWorkflow } from ${JSON.stringify(join(MODULES, "workflow/executor.ts"))};
const root = ${JSON.stringify(root)};
const store = openRunnerStore(root);
const cwd = root + "-cwd"; // the workflow cwd must not overlap the runner root
(await import("node:fs")).mkdirSync(cwd, { recursive: true });
const { runId, dir } = store.open({ projectSlug: "p", cwd, workflow: { name: "web" } });
const doc = { name: "web", nodes: [{ id: "gate", approval: { message: "Ship?", content: "draft" } }] };
const loaded = { name: "web", doc, normalized: doc, dir: root, path: root + "/web.yaml", sha256: "x", source: "project", commands: {}, scripts: {}, validation: { ok: true, errors: [], warnings: [] } };
const queue = new QueueApprover();
const deps = createWorkflowRuntime({ cwd, runId, runDir: dir, loaded, store, settings: DEFAULT_STACK_SETTINGS,
	runChild: async () => { throw new Error("unexpected child"); },
	resolveRole: () => ({ model: "fake/model", thinking: "low", callsign: "worker", appendSystemPrompts: [], tools: "read" }),
	approver: queue, actorPolicy: { policyId: "p", authorize: () => true } });
executeWorkflow(loaded, deps, { inputs: {} });
const wait = setInterval(() => { if (queue.requests.length) { clearInterval(wait); console.log(JSON.stringify({ dir, req: queue.requests[0] })); } }, 5);
setInterval(() => {}, 1 << 30);
`;
}

describe("A. runner store: exclusive root, startup recovery, hosted path refuses other stores", () => {
	test("A1 kill -9 mid-approval, reopen with openRunnerStore: stale lock taken over, run interrupted, pending approval intact", async () => {
		const root = mkdtempSync(join(tmpdir(), "titan-runner-kill-")); dirs.push(root);
		const script = join(root, "child.ts");
		writeFileSync(script, childRunnerScript(join(root, "runs")));
		const child = Bun.spawn([process.execPath, script], { stdout: "pipe", stderr: "pipe" });
		const reader = child.stdout.getReader();
		let out = "";
		while (!out.includes("\n")) {
			const chunk = await reader.read();
			if (chunk.done) break;
			out += new TextDecoder().decode(chunk.value);
		}
		const { dir, req } = JSON.parse(out) as { dir: string; req: ApprovalRequest };
		expect(existsSync(join(root, "runs", RUNNER_LOCK_FILE))).toBe(true);
		expect(() => openRunnerStore(join(root, "runs"))).toThrow("locked by live runner");
		child.kill("SIGKILL");
		await child.exited;
		const before = readFileSync(join(dir, APPROVALS_FILE), "utf8");
		const store = runnerStore(join(root, "runs"));
		expect(store.recovered.map(r => r.runId)).toEqual([req.runId]);
		expect(store.readRun(dir).status).toBe("interrupted");
		expect(store.listPendingApprovals(dir)).toEqual([req]);
		expect(readFileSync(join(dir, APPROVALS_FILE), "utf8")).toBe(before);
		expect(readChain(join(dir, "events.jsonl")).at(-1)?.type).toBe("run.interrupted");
		expect(JSON.parse(readFileSync(store.lockPath, "utf8")).pid).toBe(process.pid);
	}, 20_000);

	test("A2 opening DEFAULT_RUN_ROOT (the TUI's shared root) or a path inside it is refused", () => {
		expect(() => openRunnerStore(DEFAULT_RUN_ROOT)).toThrow("refusing the shared TUI run root");
		expect(() => openRunnerStore(join(DEFAULT_RUN_ROOT, "runner"))).toThrow("refusing the shared TUI run root");
		const fake = mkdtempSync(join(tmpdir(), "titan-fake-default-")); dirs.push(fake);
		expect(() => openRunnerStore(fake, { defaultRoot: fake })).toThrow("refusing the shared TUI run root");
		expect(existsSync(join(fake, RUNNER_LOCK_FILE))).toBe(false);
	});

	test("A3 a second concurrent opener is refused (same process too); release lets the next opener in", () => {
		const root = mkdtempSync(join(tmpdir(), "titan-runner-lock-")); dirs.push(root);
		const first = openRunnerStore(root);
		expect(() => openRunnerStore(root)).toThrow("locked by live runner");
		first.release();
		expect(existsSync(join(root, RUNNER_LOCK_FILE))).toBe(false);
		runnerStore(root);
	});

	test("A4 a dead holder's lock (and a reused pid with another start time) is taken over; recovery runs once per open", () => {
		const root = mkdtempSync(join(tmpdir(), "titan-runner-stale-")); dirs.push(root);
		const plain = new RunStore(root);
		const run = plain.open({ projectSlug: "p", cwd: root, status: "running" });
		writeFileSync(join(root, RUNNER_LOCK_FILE), JSON.stringify({ pid: 2 ** 22 + 12345, token: "dead", acquiredAt: "x" }));
		const store = openRunnerStore(root);
		expect(store.recovered.map(r => r.runId)).toEqual([run.runId]);
		store.release();
		writeFileSync(join(root, RUNNER_LOCK_FILE), JSON.stringify({ pid: process.pid, procStart: "not-my-start-time", token: "reused", acquiredAt: "x" }));
		expect(runnerStore(root).recovered).toEqual([]);
	});

	test("A5 hosted approvals refuse a store not opened with openRunnerStore, a released store, and a run dir outside its root", () => {
		const root = mkdtempSync(join(tmpdir(), "titan-runner-refuse-")); dirs.push(root);
		const doc: WorkflowDoc = { name: "web", nodes: [{ id: "gate", approval: { message: "Ship?" } }] };
		const loaded = { name: "web", doc, normalized: doc, dir: root, path: join(root, "web.yaml"), sha256: "x", source: "project", commands: {}, scripts: {}, validation: { ok: true, errors: [], warnings: [] } } as unknown as LoadedWorkflow;
		const host = (store: RunStore, runDir: string, runId: string): WorkflowRuntimeHost => ({ cwd: root, runId, runDir, loaded, store, settings: DEFAULT_STACK_SETTINGS,
			runChild: async () => { throw new Error("unexpected"); }, resolveRole: () => ({ model: "m", thinking: "low", callsign: "w", appendSystemPrompts: [], tools: "read" }),
			approver: new QueueApprover(), actorPolicy: allowAll });
		const plain = new RunStore(join(root, "plain"));
		const p = plain.open({ projectSlug: "p", cwd: root });
		expect(() => createWorkflowRuntime(host(plain, p.dir, p.runId))).toThrow("openRunnerStore");
		const released = openRunnerStore(join(root, "released"));
		const r = released.open({ projectSlug: "p", cwd: root });
		released.release();
		expect(() => createWorkflowRuntime(host(released, r.dir, r.runId))).toThrow("openRunnerStore");
		const owned = runnerStore(join(root, "owned"));
		expect(() => createWorkflowRuntime(host(owned, p.dir, p.runId))).toThrow("outside the runner store root");
		// The TUI/headless path (no approver) is unchanged and needs no runner store.
		expect(() => createWorkflowRuntime({ ...host(plain, p.dir, p.runId), approver: undefined })).not.toThrow();
	});
});

describe("B. rework binding: from attempt 2 the request binds the text the node releases", () => {
	const reworkNodes = (maxAttempts = 1): WorkflowDoc["nodes"] => [
		{ id: "draft", prompt: "write" },
		{ id: "review", depends_on: ["draft"], approval: { message: "Ship?", content: "$draft.output", on_reject: { prompt: "Fix: $REJECTION_REASON", max_attempts: maxAttempts } } },
	];
	const agent = (texts: string[]) => async (opts: { run: object }) => {
		Object.assign(opts.run, { text: texts.shift() ?? "exhausted", status: "done", exitCode: 0, stopReason: "stop" });
		return opts.run;
	};

	test("B1 real agent rework (runChild returns new text): attempt-2 sha = sha(rework text); attempt-1 sha refused; released $review.text = approved bytes", async () => {
		const h = harness(undefined, { runChild: agent(["original draft", "reworked draft v2"]) as WorkflowRuntimeHost["runChild"] }, {}, reworkNodes());
		const first = await requested(h.queue);
		expect(first.artifactSha256).toBe(sha256("original draft"));
		h.queue.deliver(decision(first, { decision: "reject", response: "tighten it" }));
		const second = await requested(h.queue, 2);
		expect(second.attempt).toBe(2);
		expect(second.artifactSha256).toBe(sha256("reworked draft v2"));
		// A decision bound to the attempt-1 content is refused, even re-addressed to the new request.
		h.queue.deliver(decision(second, { artifactSha256: first.artifactSha256, nonce: "stale" }));
		await requested(h.queue, 3);
		expect(rows(h.dir).at(-1)?.data).toMatchObject({ reason: "artifactSha256 mismatch" });
		h.queue.deliver(decision(second, { nonce: "fresh" }));
		const result = await h.result;
		expect(result.status).toBe("completed");
		expect(result.nodes.review.text).toBe("reworked draft v2");
		expect(sha256(result.nodes.review.text!)).toBe(second.artifactSha256);
		expect(readFileSync(result.nodes.review.artifactPath!, "utf8")).toBe("reworked draft v2");
	});

	test("B2 preset gate after rework hashes the rework text too (contentSha256 = the released bytes)", async () => {
		const nodes: WorkflowDoc["nodes"] = [
			{ id: "draft", prompt: "write" },
			{ id: "review", depends_on: ["draft"], approval: { message: "Ship?", content: "$draft.output", preset_key: "p", on_reject: { prompt: "Fix", max_attempts: 1 } } },
		];
		const h = harness(undefined, { runChild: agent(["v1", "v2"]) as WorkflowRuntimeHost["runChild"] }, {}, nodes);
		h.queue.deliver(decision(await requested(h.queue), { decision: "reject", response: "no" }));
		const second = await requested(h.queue, 2);
		h.queue.deliver(decision(second));
		const result = await h.result;
		expect(result.nodes.review.output).toMatchObject({ approved: true, contentSha256: sha256("v2"), receipts: 1, reviewers: ["reviewer@example.test"] });
		expect(sha256(result.nodes.review.text!)).toBe(sha256("v2"));
	});
});

describe("C. actor binding: a required host policy, recorded on the request", () => {
	test("C1 no actorPolicy configured: every hosted decision is refused actor_not_authorized (fail closed)", async () => {
		const h = harness(undefined, { actorPolicy: undefined });
		const req = await requested(h.queue);
		expect(req.actorPolicy).toEqual({ policyId: null });
		h.queue.deliver(decision(req));
		await requested(h.queue, 2);
		expect(rows(h.dir).at(-1)?.data).toMatchObject({ reason: "actor_not_authorized" });
		expect(rows(h.dir).some(r => r.type === "approval.consumed")).toBe(false);
		h.queue.deliver({ unavailable: true });
		expect((await h.result).status).toBe("cancelled");
	});

	test("C2 the host policy refuses an unauthorized actor with a recorded reason, then accepts an authorized one", async () => {
		const seen: Array<[string, string]> = [];
		const policy: ActorPolicy = { policyId: "prod-reviewer", authorize: (actor, req) => { seen.push([actor, req.requestId]); return actor === "dana@triarc.test"; } };
		const h = harness(undefined, { actorPolicy: policy });
		const req = await requested(h.queue);
		expect(req.actorPolicy).toEqual({ policyId: "prod-reviewer" });
		h.queue.deliver(decision(req, { actor: "mallory@x" }));
		await requested(h.queue, 2);
		expect(rows(h.dir).at(-1)).toMatchObject({ type: "approval.refused", data: { reason: "actor_not_authorized", decision: { actor: "mallory@x" } } });
		h.queue.deliver(decision(req, { actor: "dana@triarc.test", nonce: "n2" }));
		expect((await h.result).status).toBe("completed");
		expect(rows(h.dir).at(-1)?.data).toMatchObject({ actor: "dana@triarc.test" });
		expect(seen).toEqual([["mallory@x", req.requestId], ["dana@triarc.test", req.requestId]]);
	});

	test("C3 spec reviewers: list is recorded and intersected with the host policy; a throwing policy refuses", async () => {
		const h = harness({ message: "Ship?", content: "draft", reviewers: ["dana@triarc.test"] });
		const req = await requested(h.queue);
		expect(req.actorPolicy).toEqual({ policyId: "test-allow-all", allowedActors: ["dana@triarc.test"] });
		h.queue.deliver(decision(req, { actor: "eve@triarc.test" })); // policy allows all, list does not
		await requested(h.queue, 2);
		expect(rows(h.dir).at(-1)?.data).toMatchObject({ reason: "actor_not_authorized" });
		h.queue.deliver(decision(req, { actor: "dana@triarc.test", nonce: "n2" }));
		expect((await h.result).status).toBe("completed");

		const t = harness(undefined, { actorPolicy: { policyId: "boom", authorize: () => { throw new Error("grant lookup failed"); } } });
		const treq = await requested(t.queue);
		t.queue.deliver(decision(treq));
		await requested(t.queue, 2);
		expect(rows(t.dir).at(-1)?.data).toMatchObject({ reason: "actor_not_authorized" });
		t.queue.deliver({ unavailable: true }); await t.result;
	});

	test("C4 store level: consumeDecision without the runner's actorAuthorized verdict refuses", async () => {
		const h = harness(); const req = await requested(h.queue);
		expect(h.store.consumeDecision(h.dir, decision(req), { requestId: req.requestId, artifactSha256: req.artifactSha256 })).toEqual({ ok: false, reason: "actor_not_authorized" });
		expect(listPendingApprovals(h.dir)).toEqual([req]);
	});
});

describe("D. preset tally from the runner store, never from receipt files or typed names", () => {
	test("D1 (adv O) receipts planted by an upstream bash node do not raise the count; the ship gate stays closed", async () => {
		const sha = sha256("draft");
		// $ARTIFACTS_DIR is substituted shell-quoted by the runner, so it stays unquoted here.
		const plant = `mkdir -p $ARTIFACTS_DIR/receipts/p && for i in 1 2; do printf '{"decision":"approve","reviewer":"forged-%s","contentSha256":"${sha}"}' $i > $ARTIFACTS_DIR/receipts/p/${sha}-$i.json; done`;
		const h = harness(undefined, {}, {}, [
			{ id: "evil", bash: plant },
			{ id: "gate", depends_on: ["evil"], approval: { message: "Ship?", content: "draft", preset_key: "p" } },
			{ id: "ship", depends_on: ["gate"], when: "$gate.output.receipts >= 3", bash: "echo SHIPPED" },
		]);
		const req = await requested(h.queue);
		expect(req.presetKey).toBe("p");
		h.queue.deliver(decision(req, { actor: "only-one-human@x", response: "reviewer: editor" }));
		const result = await h.result;
		expect(readdirSync(join(h.dir, "artifacts/receipts/p")).length).toBe(3); // the planted files are there
		expect(result.nodes.gate.output).toMatchObject({ approved: true, receipts: 1, reviewers: ["only-one-human@x"], contentSha256: sha });
		expect(result.nodes.ship.status).not.toBe("success");
	});

	test("D2 (adv Q) one actor approving three gates with three typed reviewer names counts once", async () => {
		const g = (id: string, dep?: string) => ({ id, ...(dep ? { depends_on: [dep] } : {}), approval: { message: "Ship?", content: "draft", preset_key: "p" } });
		const h = harness(undefined, {}, {}, [g("g1"), g("g2", "g1"), g("g3", "g2")]);
		for (const [i, name] of ["legal", "founder", "editor"].entries()) {
			const req = await requested(h.queue, i + 1);
			h.queue.deliver(decision(req, { actor: "mallory@x", nonce: `n${i}`, response: `reviewer: ${name}` }));
		}
		const result = await h.result;
		expect(result.nodes.g3.output).toMatchObject({ receipts: 1, reviewers: ["mallory@x"] });
	});

	test("D3 distinct actors across gates on the same content count; a different content sha does not", async () => {
		const g = (id: string, content: string, dep?: string) => ({ id, ...(dep ? { depends_on: [dep] } : {}), approval: { message: "Ship?", content, preset_key: "p" } });
		const h = harness(undefined, {}, {}, [g("g1", "draft"), g("g2", "other", "g1"), g("g3", "draft", "g2")]);
		for (const [i, actor] of ["a@x", "b@x", "c@x"].entries()) h.queue.deliver(decision(await requested(h.queue, i + 1), { actor, nonce: `n${i}` }));
		const result = await h.result;
		expect(result.nodes.g3.output).toMatchObject({ receipts: 2, reviewers: ["a@x", "c@x"] });
	});

	test("D4 a hosted timeout is not a human rejection: no rework, no synthetic receipt", async () => {
		const h = harness({ message: "Ship?", content: "draft", preset_key: "p", on_reject: { prompt: "fix", max_attempts: 1 } }, { approvalTtlMs: 20 });
		const result = await h.result;
		expect(result.nodes.gate.status).toBe("cancelled");
		expect(result.nodes.gate.error).toContain("approval timed out");
		expect(h.queue.requests).toHaveLength(1);
		expect(existsSync(join(h.dir, "artifacts/receipts/p"))).toBe(false);
	});
});

describe("hardening: decision snapshot, refusal cap, lifecycle validity", () => {
	test("(adv K) a decision getter that flips after consumption cannot desync the log from the outcome", async () => {
		const h = harness(); const req = await requested(h.queue);
		let reads = 0;
		const d: Record<string, unknown> = { ...decision(req) };
		delete d.decision;
		Object.defineProperty(d, "decision", { enumerable: true, get: () => (++reads === 1 ? "reject" : "approve") });
		h.queue.deliver(d as unknown as ApprovalDecision);
		const result = await h.result;
		const decided = rows(h.dir).find(r => r.type === "approval.decided");
		expect(reads).toBe(1);
		expect((decided?.data as { decision: ApprovalDecision }).decision.decision).toBe("reject");
		expect(result.nodes.gate.status).toBe("cancelled");
	});

	test("non-object answers and non-string responses are refused as malformed, not thrown", async () => {
		const h = harness(); const req = await requested(h.queue);
		h.queue.deliver(null as unknown as ApprovalDecision);
		await requested(h.queue, 2);
		expect(rows(h.dir).at(-1)?.data).toMatchObject({ reason: "malformed decision" });
		h.queue.deliver(decision(req, { response: { toString: () => "x" } as unknown as string }));
		await requested(h.queue, 3);
		expect(rows(h.dir).at(-1)?.data).toMatchObject({ reason: "malformed decision" });
		h.queue.deliver(decision(req));
		expect((await h.result).status).toBe("completed");
	});

	test("(adv G/N) a transport replaying invalid decisions hits the refusal cap: request expired, node fails closed fast, bounded log, timers keep running", async () => {
		let calls = 0;
		const replay: Approver = { request: (req) => { calls++; return Promise.resolve(decision(req, { actor: "", response: "x".repeat(10_000) })); } };
		let ticks = 0;
		const iv = setInterval(() => ticks++, 1);
		const t0 = Date.now();
		const h = harness(undefined, { approver: replay }); // default 24 h TTL: must not hang
		const result = await h.result;
		clearInterval(iv);
		expect(Date.now() - t0).toBeLessThan(5_000);
		expect(ticks).toBeGreaterThan(0);
		expect(result.nodes.gate.status).toBe("cancelled");
		expect(calls).toBe(MAX_APPROVAL_REFUSALS);
		const types = rows(h.dir).map(r => r.type);
		expect(types.filter(t => t === "approval.refused")).toHaveLength(MAX_APPROVAL_REFUSALS);
		expect(types.at(-1)).toBe("approval.expired");
		expect(rows(h.dir).at(-1)?.data).toMatchObject({ reason: "refusal limit" });
		expect(listPendingApprovals(h.dir)).toEqual([]);
	});

	test("(adv F) truncating the consumed row cannot re-open the request: the decision row blocks a second decision", async () => {
		const h = harness(); const req = await requested(h.queue);
		h.queue.deliver(decision(req)); await h.result;
		const file = join(h.dir, APPROVALS_FILE);
		const lines = readFileSync(file, "utf8").trimEnd().split("\n");
		writeFileSync(file, `${lines.slice(0, -1).join("\n")}\n`);
		expect(verifyChain(file).ok).toBe(true);
		markRunning(h);
		expect(h.store.consumeDecision(h.dir, decision(req, { nonce: "n2" }), binding(req))).toEqual({ ok: false, reason: "request already decided" });
		expect(rows(h.dir).some(r => r.type === "approval.consumed")).toBe(false);
	});

	test("(adv F) a duplicate approval.requested row (even with a valid chain) makes the chain invalid, fail closed", async () => {
		const h = harness(); const req = await requested(h.queue);
		h.queue.deliver(decision(req)); await h.result;
		const file = join(h.dir, APPROVALS_FILE);
		const { appendChained } = await import("../modules/hash-chain.ts");
		appendChained(file, { runId: h.runId, type: "approval.requested", data: { request: { ...req, artifactSha256: sha256("swapped") } } });
		expect(verifyChain(file).ok).toBe(true);
		expect(() => listPendingApprovals(h.dir)).toThrow("duplicate request");
		markRunning(h);
		expect(() => h.store.consumeDecision(h.dir, decision(req, { nonce: "n2" }), binding(req))).toThrow("approval chain invalid");
	});

	test("rows for unknown or terminal requests make the chain invalid", async () => {
		const { appendChained } = await import("../modules/hash-chain.ts");
		const h = harness(); const req = await requested(h.queue);
		h.queue.deliver(decision(req)); await h.result;
		const file = join(h.dir, APPROVALS_FILE);
		const clean = readFileSync(file, "utf8");
		for (const [type, data, why] of [
			["approval.consumed", { requestId: "ghost" }, "for unknown request"],
			["approval.expired", { requestId: req.requestId }, "for consumed request"],
			["approval.decided", { requestId: req.requestId, decision: decision(req) }, "for consumed request"],
			["approval.bogus", { requestId: req.requestId }, "unknown row type"],
		] as const) {
			writeFileSync(file, clean);
			appendChained(file, { runId: h.runId, type, data });
			expect(() => listPendingApprovals(h.dir)).toThrow(why);
		}
	});
});

// ═══ Repair round 2: ownership fence on consumption, validated stale-lock takeover ═══

const lockToken = (root: string) => JSON.parse(readFileSync(join(root, RUNNER_LOCK_FILE), "utf8")).token as string;
const nodeEnd = (dir: string) => readChain(join(dir, "events.jsonl")).filter(r => r.type === "node.end").at(-1)?.data as { status?: string; error?: string } | undefined;

describe("E. ownership fence: no consumption after the runner lost its lock or the run stopped running", () => {
	test("E1 release + reopen (recovery → interrupted), then a valid decision to the OLD transport: runner_not_owner, node cancelled, run stays interrupted, request still pending for the new owner", async () => {
		const h = harness(); const req = await requested(h.queue);
		h.store.release();
		const owner = runnerStore(h.storeRoot);
		expect(owner.recovered.map(r => r.runId)).toEqual([h.runId]);
		const before = readFileSync(join(h.dir, APPROVALS_FILE), "utf8");
		h.queue.deliver(decision(req));
		const result = await h.result;
		expect(result.status).toBe("cancelled");
		expect(result.nodes.gate.status).toBe("cancelled");
		expect(nodeEnd(h.dir)).toMatchObject({ status: "cancelled", error: expect.stringContaining("runner_not_owner") });
		expect(owner.readRun(h.dir).status).toBe("interrupted"); // the old runner cannot rewrite run.json either
		expect(owner.listPendingApprovals(h.dir)).toEqual([req]);
		expect(readFileSync(join(h.dir, APPROVALS_FILE), "utf8")).toBe(before); // a non-owner writes nothing to the authoritative log
		expect(h.store.consumeDecision(h.dir, decision(req, { nonce: "n2" }), binding(req))).toEqual({ ok: false, reason: "runner_not_owner" });
		expect(h.store.expireApproval(h.dir, req.requestId)).toBe(false);
	});

	test("E2 lock file replaced by another owner's token while waiting: runner_not_owner, node cancelled, request pending", async () => {
		const h = harness(); const req = await requested(h.queue);
		writeFileSync(join(h.storeRoot, RUNNER_LOCK_FILE), JSON.stringify({ pid: process.pid, token: "someone-else", acquiredAt: "x" }));
		h.queue.deliver(decision(req));
		expect((await h.result).nodes.gate.status).toBe("cancelled");
		expect(nodeEnd(h.dir)?.error).toContain("runner_not_owner");
		expect(rows(h.dir).map(r => r.type)).toEqual(["approval.requested"]);
		expect(listPendingApprovals(h.dir)).toEqual([req]);
		expect(lockToken(h.storeRoot)).toBe("someone-else");
	});

	test("E3 lock still held but the run is no longer running: run_not_running is recorded, never counted, request stays pending", async () => {
		const h = harness(); const req = await requested(h.queue);
		new RunStore(h.storeRoot).updateRun(h.dir, { status: "interrupted" });
		h.queue.deliver(decision(req));
		expect((await h.result).nodes.gate.status).toBe("cancelled");
		expect(nodeEnd(h.dir)?.error).toContain("run_not_running");
		expect(rows(h.dir).map(r => r.type)).toEqual(["approval.requested", "approval.refused"]);
		expect(rows(h.dir).at(-1)?.data).toMatchObject({ requestId: req.requestId, reason: "run_not_running" });
		expect(listPendingApprovals(h.dir)).toEqual([req]);
	});

	test("E4 store level: a plain RunStore (never a runner store) cannot consume even with a valid binding", async () => {
		const h = harness(); const req = await requested(h.queue);
		expect(new RunStore(h.storeRoot).consumeDecision(h.dir, decision(req), binding(req))).toEqual({ ok: false, reason: "runner_not_owner" });
		expect(rows(h.dir).map(r => r.type)).toEqual(["approval.requested"]);
	});
});

describe("F. stale-lock takeover never removes a lock it did not validate", () => {
	const deadLock = (root: string) => writeFileSync(join(root, RUNNER_LOCK_FILE), JSON.stringify({ pid: 2 ** 22 + 12345, token: "dead", acquiredAt: "x" }));
	const strays = (root: string) => readdirSync(root).filter(f => f.startsWith(`${RUNNER_LOCK_FILE}.`));

	test("F1 race: B judges a dead lock stale, A takes over before B's rename; B moves A's live lock, sees different bytes, puts it back and refuses; A still owns and consumes", async () => {
		const root = mkdtempSync(join(tmpdir(), "titan-lock-race-")); dirs.push(root);
		deadLock(root);
		let a: RunnerStore | undefined;
		expect(() => openRunnerStore(root, { _testHooks: { beforeRename: () => { a = runnerStore(root); } } })).toThrow("taken by another runner during stale-lock takeover");
		expect(a).toBeDefined();
		expect(lockToken(root)).toBe(readLockToken(a!));
		expect(strays(root)).toEqual([]);
		const run = a!.open({ projectSlug: "p", cwd: root, status: "running" });
		const req: ApprovalRequest = { requestId: "r1", runId: run.runId, nodeId: "gate", attempt: 1, artifactSha256: sha256("x"), message: "m", createdAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 60_000).toISOString(), captureResponse: false, actorPolicy: { policyId: "p" } };
		a!.requestApproval(run.dir, req);
		expect(a!.consumeDecision(run.dir, decision(req), binding(req)).ok).toBe(true);
	});

	test("F2 race where the displaced live lock cannot be restored (a third lock appeared): B refuses, and A fails closed via its fence", async () => {
		const root = mkdtempSync(join(tmpdir(), "titan-lock-race3-")); dirs.push(root);
		deadLock(root);
		let a: RunnerStore | undefined;
		expect(() => openRunnerStore(root, { _testHooks: {
			beforeRename: () => { a = runnerStore(root); },
			afterRename: (lockPath) => writeFileSync(lockPath, JSON.stringify({ pid: process.pid, token: "third", acquiredAt: "x" })),
		} })).toThrow("displaced lock kept");
		expect(lockToken(root)).toBe("third");
		const run = new RunStore(root).open({ projectSlug: "p", cwd: root, status: "running" });
		expect(a!.consumeDecision(run.dir, {}, { requestId: "x", artifactSha256: "y", actorAuthorized: true })).toEqual({ ok: false, reason: "runner_not_owner" });
	});

	test("F3 the byte check passes when the renamed file IS the stale lock: takeover succeeds, no stray files", () => {
		const root = mkdtempSync(join(tmpdir(), "titan-lock-ok-")); dirs.push(root);
		deadLock(root);
		const seen: string[] = [];
		const store = openRunnerStore(root, { _testHooks: { afterRename: (_l, aside) => seen.push(JSON.parse(readFileSync(aside, "utf8")).token) } });
		stores.push(store);
		expect(seen).toEqual(["dead"]);
		expect(lockToken(root)).toBe(readLockToken(store));
		expect(strays(root)).toEqual([]);
	});

	test("F4 an empty/unparsable lock is live (refused, untouched) until older than the grace period, then taken over", () => {
		const root = mkdtempSync(join(tmpdir(), "titan-lock-empty-")); dirs.push(root);
		const lock = join(root, RUNNER_LOCK_FILE);
		for (const content of ["", "{\"pid\":", "{}"]) {
			writeFileSync(lock, content);
			expect(() => openRunnerStore(root, { _testHooks: { beforeRename: () => { throw new Error("must not reach rename"); } } })).toThrow("unreadable runner.lock");
			expect(readFileSync(lock, "utf8")).toBe(content);
		}
		const old = (Date.now() - RUNNER_LOCK_UNPARSABLE_GRACE_MS - 5_000) / 1000;
		utimesSync(lock, old, old);
		const store = runnerStore(root);
		expect(lockToken(root)).toBe(readLockToken(store));
	});

	test("F5 the lock file is created complete (never empty) and no temp files are left behind", () => {
		const root = mkdtempSync(join(tmpdir(), "titan-lock-atomic-")); dirs.push(root);
		const store = runnerStore(root);
		const body = JSON.parse(readFileSync(store.lockPath, "utf8"));
		expect(body).toMatchObject({ pid: process.pid, token: expect.any(String) });
		expect(strays(root)).toEqual([]);
	});
});

/** The token a runner store holds, via its own lock file right after open (tests only). */
function readLockToken(store: RunnerStore): string {
	return JSON.parse(readFileSync(store.lockPath, "utf8")).token;
}

describe("G. defence-in-depth (not run-dir isolation): the runner root must not overlap the workflow cwd", () => {
	test("G2 a runner root whose name starts with '..' inside the cwd is still inside (and <defaultRoot>/..x is still refused)", () => {
		const cwd = mkdtempSync(join(tmpdir(), "n303cwd-"));
		dirs.push(cwd);
		const store = openRunnerStore(join(cwd, "..runner"));
		try { expect(() => assertRunnerRootOutside(store, cwd)).toThrow(); } finally { store.release(); }
		const fakeDefault = mkdtempSync(join(tmpdir(), "n303default-"));
		dirs.push(fakeDefault);
		expect(() => openRunnerStore(join(fakeDefault, "..x"), { defaultRoot: fakeDefault })).toThrow();
	});

	test("G1 hosted approvals refuse a runner store root inside or containing the workflow cwd", () => {
		const root = mkdtempSync(join(tmpdir(), "titan-runner-cwd-")); dirs.push(root);
		const doc: WorkflowDoc = { name: "web", nodes: [{ id: "gate", approval: { message: "Ship?" } }] };
		const loaded = { name: "web", doc, normalized: doc, dir: root, path: join(root, "web.yaml"), sha256: "x", source: "project", commands: {}, scripts: {}, validation: { ok: true, errors: [], warnings: [] } } as unknown as LoadedWorkflow;
		const host = (store: RunStore, cwd: string): WorkflowRuntimeHost => {
			const r = store.open({ projectSlug: "p", cwd });
			return { cwd, runId: r.runId, runDir: r.dir, loaded, store, settings: DEFAULT_STACK_SETTINGS,
				runChild: async () => { throw new Error("unexpected"); }, resolveRole: () => ({ model: "m", thinking: "low", callsign: "w", appendSystemPrompts: [], tools: "read" }),
				approver: new QueueApprover(), actorPolicy: allowAll };
		};
		const inside = runnerStore(join(root, "work", ".runner"));
		expect(() => createWorkflowRuntime(host(inside, join(root, "work")))).toThrow("overlaps the workflow cwd");
		mkdirSync(join(root, "runner2", "work"), { recursive: true });
		const around = runnerStore(join(root, "runner2"));
		expect(() => createWorkflowRuntime(host(around, join(root, "runner2", "work")))).toThrow("overlaps the workflow cwd");
		mkdirSync(join(root, "elsewhere"), { recursive: true });
		expect(() => createWorkflowRuntime(host(runnerStore(join(root, "runner3")), join(root, "elsewhere")))).not.toThrow();
	});
});
