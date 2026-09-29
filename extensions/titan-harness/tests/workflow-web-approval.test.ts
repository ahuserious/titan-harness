import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readChain, sha256, verifyChain } from "../modules/hash-chain.ts";
import { APPROVALS_FILE, RunStore, listPendingApprovals, recoverInterruptedRuns } from "../modules/run-store.ts";
import { DEFAULT_STACK_SETTINGS } from "../modules/stack-config.ts";
import { createWorkflowRuntime, type WorkflowRuntimeHost } from "../modules/workflow-runtime.ts";
import { DEFAULT_APPROVAL_TTL_MS, QueueApprover, type ApprovalDecision, type ApprovalRequest } from "../modules/workflow/approver.ts";
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
function harness(spec: ApprovalSpec = { message: "Ship?", content: "draft", capture_response: true }, overrides: Partial<WorkflowRuntimeHost> = {}, inputs: Record<string, unknown> = {}) {
	const root = mkdtempSync(join(tmpdir(), "titan-web-approval-"));
	dirs.push(root);
	const store = new RunStore(root);
	const { runId, dir } = store.open({ projectSlug: "p", cwd: root, workflow: { name: "web" } });
	const doc: WorkflowDoc = { name: "web", nodes: [{ id: "gate", approval: spec }] };
	const loaded = { name: "web", doc, normalized: doc, dir: root, path: join(root, "web.yaml"), sha256: sha256("web"), source: "project", commands: {}, scripts: {}, validation: { ok: true, errors: [], warnings: [] } } as LoadedWorkflow;
	const queue = new QueueApprover();
	const controller = new AbortController();
	const deps = createWorkflowRuntime({ cwd: root, runId, runDir: dir, loaded, store, settings: DEFAULT_STACK_SETTINGS,
		runChild: async () => { throw new Error("unexpected child"); },
		resolveRole: () => ({ model: "fake/model", thinking: "low", callsign: "worker", appendSystemPrompts: [], tools: "read" }),
		approver: queue, signal: controller.signal, ...overrides });
	let finished = false;
	const result = executeWorkflow(loaded, deps, { inputs }).finally(() => { finished = true; });
	active.push(async () => { controller.abort(); await result; });
	return { root, store, runId, dir, queue, result, spec, doc, finished: () => finished };
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
const binding = (req: ApprovalRequest) => ({ requestId: req.requestId, artifactSha256: req.artifactSha256 });

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

	test("second consume fails for the same object AND a replay with a fresh nonce, across store instances", async () => {
		const h = harness(); const req = await requested(h.queue); const d = decision(req);
		h.queue.deliver(d); await h.result;
		const fresh = new RunStore(h.root);
		expect(fresh.consumeDecision(h.dir, d, binding(req))).toEqual({ ok: false, reason: "request already consumed" });
		expect(fresh.consumeDecision(h.dir, { ...d, nonce: "forged-fresh-nonce" }, binding(req))).toEqual({ ok: false, reason: "request already consumed" });
		expect(rows(h.dir).filter(r => r.type === "approval.consumed")).toHaveLength(1);
		expect(rows(h.dir).filter(r => r.type === "approval.refused")).toHaveLength(2);
	});

	test("concurrent consumers have exactly one winner", async () => {
		const h = harness(); const req = await requested(h.queue);
		const results = await Promise.all([h.store, new RunStore(h.root)].map(store => Promise.resolve().then(() => store.consumeDecision(h.dir, decision(req), binding(req)))));
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
		const fresh = new RunStore(h.root);
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
		expect(new RunStore(h.root).consumeDecision(h.dir, decision(req), binding(req))).toEqual({ ok: false, reason: "request already consumed" });
	});

	test("recovery leaves other run statuses and overdue pending requests untouched", async () => {
		const h = harness(); const base = await requested(h.queue);
		const req = { ...base, requestId: "overdue", expiresAt: new Date(Date.now() - 1000).toISOString() };
		h.store.requestApproval(h.dir, req);
		const other = h.store.open({ projectSlug: "p", cwd: h.root, status: "completed" });
		expect(recoverInterruptedRuns(new RunStore(h.root))).toHaveLength(1);
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
