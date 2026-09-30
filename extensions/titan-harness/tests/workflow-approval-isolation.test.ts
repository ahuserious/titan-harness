/**
 * Approval-store isolation (P3 prerequisite, ruling 2026-09-29 22:50 on N3-03): a child
 * process of a hosted run cannot create, edit or replay an approval, cannot touch run.json,
 * runner.lock or sibling runs, and cannot redirect the runner's own writes through a
 * symlink planted in its scratch dir. The attacks are given the store's absolute paths
 * (as if leaked) so the tests check the sandbox, not secrecy.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readChain, sha256 } from "../modules/hash-chain.ts";
import { APPROVALS_FILE, RUNNER_LOCK_FILE, RUN_FILE, type RunnerStore, listPendingApprovals, openRunnerStore } from "../modules/run-store.ts";
import { DEFAULT_STACK_SETTINGS } from "../modules/stack-config.ts";
import { createWorkflowRuntime, type WorkflowRuntimeHost } from "../modules/workflow-runtime.ts";
import { type ActorPolicy, QueueApprover, type ApprovalDecision, type ApprovalRequest } from "../modules/workflow/approver.ts";
import { createChildSandbox, guardedReadFileSync, guardedWriteFileSync, registerScratchRoot } from "../modules/workflow/child-sandbox.ts";
import { executeWorkflow } from "../modules/workflow/executor.ts";
import type { LoadedWorkflow } from "../modules/workflow/loader.ts";
import type { WorkflowDoc } from "../modules/workflow/schema.ts";

const dirs: string[] = [];
const stores: RunnerStore[] = [];
const active: Array<() => Promise<void>> = [];
afterEach(async () => {
	while (active.length) await active.pop()!();
	while (stores.length) stores.pop()!.release();
	while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});
const scratch = (prefix: string) => { const d = mkdtempSync(join(tmpdir(), prefix)); dirs.push(d); return d; };
const allowAll: ActorPolicy = { policyId: "test-allow-all", authorize: () => true };
const q = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;

function loadedOf(doc: WorkflowDoc, dir: string): LoadedWorkflow {
	return { name: doc.name, doc, normalized: doc, dir, path: join(dir, `${doc.name}.yaml`), sha256: sha256(doc.name), source: "project", commands: {}, scripts: {}, validation: { ok: true, errors: [], warnings: [] } } as LoadedWorkflow;
}

/** A hosted run parked on a web approval, plus a sibling run in the same runner root. */
function hosted(nodes: WorkflowDoc["nodes"] = [{ id: "gate", approval: { message: "Ship?", content: "draft" } }], overrides: Partial<WorkflowRuntimeHost> = {}) {
	const cwd = scratch("titan-iso-cwd-");
	const storeRoot = scratch("titan-iso-runner-");
	const store = openRunnerStore(storeRoot);
	stores.push(store);
	const sibling = store.open({ projectSlug: "p", cwd, workflow: { name: "other" }, status: "running" });
	const { runId, dir } = store.open({ projectSlug: "p", cwd, workflow: { name: "web" } });
	const doc: WorkflowDoc = { name: "web", nodes };
	const loaded = loadedOf(doc, cwd);
	const queue = new QueueApprover();
	const controller = new AbortController();
	const agentCalls: any[] = [];
	const deps = createWorkflowRuntime({ cwd, runId, runDir: dir, loaded, store, settings: DEFAULT_STACK_SETTINGS,
		runChild: async (opts: any) => { agentCalls.push(opts); throw new Error("no agents here"); },
		resolveRole: () => ({ model: "fake/model", thinking: "low", callsign: "worker", appendSystemPrompts: [], tools: "read" }),
		approver: queue, actorPolicy: allowAll, signal: controller.signal, ...overrides });
	dirs.push(join(deps.artifactsDir, ".."));
	const result = executeWorkflow(loaded, deps, { inputs: {} });
	active.push(async () => { controller.abort(); await result; });
	return { cwd, storeRoot, store, runId, dir, sibling, queue, deps, result, agentCalls };
}
async function requested(queue: QueueApprover, n = 1): Promise<ApprovalRequest> {
	for (let i = 0; i < 400 && queue.requests.length < n; i++) await Bun.sleep(2);
	expect(queue.requests.length).toBeGreaterThanOrEqual(n);
	return queue.requests[n - 1];
}
function decision(req: ApprovalRequest, patch: Partial<ApprovalDecision> = {}): ApprovalDecision {
	return { requestId: req.requestId, runId: req.runId, nodeId: req.nodeId, artifactSha256: req.artifactSha256,
		actor: "reviewer@example.test", decision: "approve", response: "ok", decidedAt: new Date().toISOString(), nonce: "nonce-1", ...patch };
}
/** Every file under a directory with its bytes (the store snapshot an attack must leave unchanged). */
function snapshot(root: string): Record<string, string> {
	const out: Record<string, string> = {};
	const walk = (d: string) => {
		for (const entry of readdirSync(d, { withFileTypes: true })) {
			const p = join(d, entry.name);
			if (entry.isDirectory()) walk(p);
			else out[p.slice(root.length)] = readFileSync(p, "utf8");
		}
	};
	walk(root);
	return out;
}
/** A shell attack that reports each attempt as `name=ok` (it worked) or `name=blocked`. */
function attack(steps: Record<string, string>): string {
	return Object.entries(steps).map(([name, cmd]) => `if ( ${cmd} ) 2>/dev/null; then echo ${name}=ok; else echo ${name}=blocked; fi`).join("\n");
}
const outcomes = (stdout: string) => Object.fromEntries(stdout.trim().split("\n").filter(Boolean).map(line => line.split("=")));

describe("hosted children never learn or reach the runner store", () => {
	test("node env: no TITAN_RUN_DIR, ARTIFACTS_DIR outside the runner root, no env value names the root", async () => {
		const h = hosted([{ id: "env", bash: "env" }, { id: "gate", depends_on: ["env"], approval: { message: "Ship?", content: "draft" } }]);
		await requested(h.queue);
		const env = String(readFileSync(join(h.dir, "artifacts", "nodes", "env.md"), "utf8"));
		expect(env).not.toContain("TITAN_RUN_DIR=");
		expect(env).not.toContain(h.storeRoot);
		expect(env).toContain(`ARTIFACTS_DIR=${h.deps.artifactsDir}`);
		expect(h.deps.artifactsDir.startsWith(h.storeRoot)).toBe(false);
		// the node output is mirrored into the child-visible artifacts dir for downstream nodes
		expect(readFileSync(join(h.deps.artifactsDir, "nodes", "env.md"), "utf8")).toBe(env);
	});

	test("a child cannot create, edit, truncate or delete approvals.jsonl, run.json, runner.lock or a sibling run while a request is pending", async () => {
		const h = hosted();
		const req = await requested(h.queue);
		const before = snapshot(h.storeRoot);
		const approvals = join(h.dir, APPROVALS_FILE);
		const res = await h.deps.bash(attack({
			list: `ls -A ${q(h.dir)} | grep -q .`,
			read: `cat ${q(approvals)} | grep -q requested`,
			append: `printf '%s\\n' '{"type":"approval.decided"}' >> ${q(approvals)}`,
			truncate: `: > ${q(approvals)}`,
			replace: `mv ${q(approvals)} ${q(approvals)}.old`,
			create: `printf x > ${q(join(h.dir, "approvals-forged.jsonl"))}`,
			runjson: `printf '{"status":"interrupted"}' > ${q(join(h.dir, RUN_FILE))}`,
			lock: `rm ${q(join(h.storeRoot, RUNNER_LOCK_FILE))}`,
			locktmp: `printf x > ${q(join(h.storeRoot, `${RUNNER_LOCK_FILE}.stale.1`))}`,
			sibling: `printf x >> ${q(join(h.sibling.dir, APPROVALS_FILE))}`,
			symlink: `ln -sf /dev/null ${q(join(h.dir, "events.jsonl"))}`,
			rmroot: `rm -rf ${q(h.storeRoot)}`,
			parent: `mv ${q(h.storeRoot)} ${q(`${h.storeRoot}-moved`)}`,
			proc: `cat /proc/[0-9]*/root${approvals} 2>/dev/null | grep -q requested`,
			umount: `umount ${q(h.storeRoot)}`,
		}), { cwd: h.cwd, timeoutMs: 10_000, env: { ARTIFACTS_DIR: h.deps.artifactsDir } });
		const got = outcomes(res.stdout);
		expect(Object.keys(got).length).toBe(15);
		expect(Object.entries(got).filter(([, v]) => v !== "blocked")).toEqual([]);
		expect(snapshot(h.storeRoot)).toEqual(before);
		expect(listPendingApprovals(h.dir)).toEqual([req]);
		// the runner still owns the store and consumes the real decision
		h.queue.deliver(decision(req));
		expect((await h.result).nodes.gate.status).toBe("success");
		expect(readChain(join(h.dir, APPROVALS_FILE)).map(r => r.type)).toEqual(["approval.requested", "approval.decided", "approval.consumed"]);
	});

	test("a child cannot replay a consumed approval: truncating the consumed row or re-adding a request is blocked, and the log is unchanged", async () => {
		const h = hosted([
			{ id: "gate", approval: { message: "Ship?", content: "draft" } },
			{ id: "after", depends_on: ["gate"], approval: { message: "Again?", content: "draft" } },
		]);
		const first = await requested(h.queue);
		h.queue.deliver(decision(first));
		await requested(h.queue, 2);
		const approvals = join(h.dir, APPROVALS_FILE);
		const before = readFileSync(approvals, "utf8");
		const lines = before.trimEnd().split("\n");
		const withoutConsumed = lines.filter(l => !l.includes('"approval.consumed"')).join("\n");
		const res = await h.deps.bash(attack({
			untruncate: `printf '%s\\n' ${q(withoutConsumed)} > ${q(approvals)}`,
			dup: `printf '%s\\n' ${q(lines[0])} >> ${q(approvals)}`,
			swap: `cp /dev/null ${q(approvals)}`,
		}), { cwd: h.cwd, timeoutMs: 10_000 });
		expect(outcomes(res.stdout)).toEqual({ untruncate: "blocked", dup: "blocked", swap: "blocked" });
		expect(readFileSync(approvals, "utf8")).toBe(before);
		// the old decision cannot be delivered again to the second request, and the first stays consumed
		const second = h.queue.requests[1];
		expect(h.store.consumeDecision(h.dir, decision(first, { nonce: "replay" }), { requestId: first.requestId, artifactSha256: first.artifactSha256, actorAuthorized: true })).toEqual({ ok: false, reason: "request already consumed" });
		h.queue.deliver(decision(second, { nonce: "n2" }));
		expect((await h.result).status).toBe("completed");
	});

	test("a planted symlink in the child's scratch cannot redirect the runner's writes into the store (artifact mirror, receipts)", async () => {
		const h = hosted();
		// A bash node ran with the scratch dir writable; emulate what a hostile node could plant there.
		const approvals = join(h.dir, APPROVALS_FILE);
		await requested(h.queue);
		const before = readFileSync(approvals, "utf8");
		const plant = await h.deps.bash([
			`mkdir -p "$ARTIFACTS_DIR/nodes" "$ARTIFACTS_DIR/receipts"`,
			`ln -s ${q(approvals)} "$ARTIFACTS_DIR/nodes/next.md"`,
			`ln -s ${q(h.dir)} "$ARTIFACTS_DIR/receipts/p"`,
			`echo planted`,
		].join(" && "), { cwd: h.cwd, timeoutMs: 10_000, env: { ARTIFACTS_DIR: h.deps.artifactsDir } });
		expect(plant.stdout.trim()).toBe("planted");
		expect(() => guardedWriteFileSync(join(h.deps.artifactsDir, "nodes", "next.md"), "forged")).toThrow("symlink");
		expect(() => guardedWriteFileSync(join(h.deps.artifactsDir, "receipts", "p", "x.json"), "forged")).toThrow("symlink");
		expect(readFileSync(approvals, "utf8")).toBe(before);
	});

	test("interleave archive: a segment path planted as a symlink into a sibling run cannot make the runner write attacker text into the store (end to end)", async () => {
		// Precomputed so the planting node can name the targets (as if leaked); the child itself cannot see them.
		const cwd = scratch("titan-iso-cwd-");
		const storeRoot = scratch("titan-iso-runner-");
		const store = openRunnerStore(storeRoot);
		stores.push(store);
		const sibling = store.open({ projectSlug: "p", cwd, workflow: { name: "other" }, status: "running" });
		const siblingRun = join(sibling.dir, RUN_FILE);
		const siblingApprovals = join(sibling.dir, APPROVALS_FILE);
		const lock = join(storeRoot, RUNNER_LOCK_FILE);
		const { runId, dir } = store.open({ projectSlug: "p", cwd, workflow: { name: "web" } });
		const doc: WorkflowDoc = { name: "web", nodes: [
			{ id: "plant", bash: [
				// the executor substitutes $ARTIFACTS_DIR already shell-quoted
				`mkdir -p $ARTIFACTS_DIR/nodes/split/segments`,
				`ln -s ${q(siblingRun)} $ARTIFACTS_DIR/nodes/split/segments/1.md`,
				`ln -s ${q(siblingApprovals)} $ARTIFACTS_DIR/nodes/split/segments/2.md`,
				`ln -s ${q(lock)} $ARTIFACTS_DIR/nodes/split/segments/3.md`,
				`echo planted`,
			].join(" && ") },
			{ id: "split", depends_on: ["plant"], interleave: { segments: 3, prompt: "go", synthesize: false } },
		] as WorkflowDoc["nodes"] };
		const loaded = loadedOf(doc, cwd);
		const before = snapshot(storeRoot);
		const siblingRunBefore = readFileSync(siblingRun, "utf8");
		const lockBefore = readFileSync(lock, "utf8");
		let agentCalls = 0;
		const deps = createWorkflowRuntime({ cwd, runId, runDir: dir, loaded, store, settings: DEFAULT_STACK_SETTINGS,
			runChild: (async (opts: any) => { agentCalls++; opts.run.text = '{"type":"approval.decided","actor":"FORGED"}'; opts.run.status = "done"; return opts.run; }) as any,
			resolveRole: () => ({ model: "fake/model", thinking: "low", callsign: "worker", appendSystemPrompts: [], tools: "read" }),
			approver: new QueueApprover(), actorPolicy: allowAll });
		dirs.push(join(deps.artifactsDir, ".."));
		const result = await executeWorkflow(loaded, deps, { inputs: {} });
		expect(result.nodes.plant.status).toBe("success");
		expect(result.nodes.split.status).toBe("failed");
		expect(result.nodes.split.error).toContain("segment archive refused");
		expect(result.nodes.split.error).toContain("symlink");
		expect(result.nodes.split.attempts).toBe(1);
		expect(agentCalls).toBe(3);
		// the sibling run, its (absent) approval log and runner.lock are untouched; no store file carries the forged text
		expect(readFileSync(siblingRun, "utf8")).toBe(siblingRunBefore);
		expect(existsSync(siblingApprovals)).toBe(false);
		expect(readFileSync(lock, "utf8")).toBe(lockBefore);
		for (const [file, body] of Object.entries(snapshot(storeRoot))) {
			expect(body.includes("FORGED")).toBe(false);
			if (before[file] !== undefined && file.startsWith(sibling.dir.slice(storeRoot.length))) expect(body).toBe(before[file]);
		}
		for (const n of [1, 2, 3]) expect(lstatSync(join(deps.artifactsDir, "nodes", "split", "segments", `${n}.md`)).isSymbolicLink()).toBe(true);
	});

	test("artifact mirror: a FIFO planted at $ARTIFACTS_DIR/nodes/<id>.md cannot hang the runner; the run completes and the store copy is written", async () => {
		const notes: string[] = [];
		const h = hosted([
			{ id: "attack", bash: `mkdir -p $ARTIFACTS_DIR/nodes && mkfifo $ARTIFACTS_DIR/nodes/attack.md && echo ok` },
			{ id: "after", depends_on: ["attack"], bash: "echo done" },
		], { ui: { confirm: async () => false, notify: (text: string) => notes.push(text) } });
		const result = await Promise.race([h.result, Bun.sleep(8_000).then(() => "hung" as const)]);
		expect(result).not.toBe("hung");
		if (result === "hung") return;
		expect(result.status).toBe("completed");
		expect(result.nodes.attack.status).toBe("success");
		expect(result.nodes.after.status).toBe("success");
		expect(readFileSync(join(h.dir, "artifacts", "nodes", "attack.md"), "utf8")).toContain("ok");
		expect(lstatSync(join(h.deps.artifactsDir, "nodes", "attack.md")).isFIFO()).toBe(true);
		expect(notes.some(n => n.includes("attack: artifact write failed") && n.includes("FIFO"))).toBe(true);
	}, 15_000);

	test("agent children are spawned through the sandbox: the wrap is bwrap, drops TITAN_RUN_DIR and masks the root", async () => {
		const h = hosted([{ id: "ask", prompt: "hi" }, { id: "gate", depends_on: ["ask"], approval: { message: "Ship?", content: "draft" } }] as WorkflowDoc["nodes"]);
		for (let i = 0; i < 400 && !h.agentCalls.length; i++) await Bun.sleep(2);
		const call = h.agentCalls[0];
		expect(call).toBeDefined();
		expect(call.sessionDir.startsWith(h.storeRoot)).toBe(false);
		expect(call.env.TITAN_RUN_DIR).toBeUndefined();
		const wrapped = call.wrapSpawn("/bin/sh", ["-c", `ls -A ${q(h.storeRoot)} | wc -l; if (: > ${q(join(h.storeRoot, "x"))}) 2>/dev/null; then echo wrote; else echo blocked; fi`], { TITAN_RUN_DIR: h.dir, LEAK: `${h.dir}/approvals.jsonl`, KEEP: "1" });
		expect(wrapped.command).toMatch(/bwrap$/);
		expect(wrapped.env.TITAN_RUN_DIR).toBeUndefined();
		expect(wrapped.env.LEAK).toBeUndefined();
		expect(wrapped.env.KEEP).toBe("1");
		const proc = Bun.spawnSync([wrapped.command, ...wrapped.args], { env: wrapped.env });
		expect(proc.stdout.toString().trim().split("\n")).toEqual(["0", "blocked"]);
		expect(existsSync(join(h.storeRoot, "x"))).toBe(false);
	});
});

describe("the sandbox fails closed", () => {
	test("no bwrap, a scratch dir inside the root, or a writable path around the root: construction throws (and so does the hosted runtime)", () => {
		const root = scratch("titan-iso-root-");
		const cwd = scratch("titan-iso-cwd-");
		expect(() => createChildSandbox({ runnerRoot: root, cwd, scratchDir: scratch("titan-iso-s-"), bwrap: "/nonexistent/bwrap" })).toThrow("bwrap not found");
		expect(() => createChildSandbox({ runnerRoot: root, cwd, scratchDir: join(root, "scratch") })).toThrow("overlaps the hidden runner path");
		expect(() => createChildSandbox({ runnerRoot: root, cwd, scratchDir: scratch("titan-iso-s-"), writable: [join(root, "..")] })).toThrow("overlaps the hidden runner path");
		const store = openRunnerStore(scratch("titan-iso-runner-"));
		stores.push(store);
		const { runId, dir } = store.open({ projectSlug: "p", cwd, workflow: { name: "x" } });
		const doc: WorkflowDoc = { name: "x", nodes: [] };
		const base = { cwd, runId, runDir: dir, loaded: loadedOf(doc, cwd), store, settings: DEFAULT_STACK_SETTINGS, runChild: async () => { throw new Error("x"); }, resolveRole: () => ({ model: "m", thinking: "low", callsign: "w", appendSystemPrompts: [], tools: "read" }), approver: new QueueApprover(), actorPolicy: allowAll } as any;
		expect(() => createWorkflowRuntime({ ...base, sandbox: { bwrap: "/nonexistent/bwrap" } })).toThrow("bwrap not found");
		expect(() => createWorkflowRuntime({ ...base, nodeScratchDir: join(store.root, "scratch") })).toThrow("overlaps the hidden runner path");
	});

	test("guarded writes outside a registered scratch root are plain writes; inside, a regular file is written in place", () => {
		const d = scratch("titan-iso-guard-");
		registerScratchRoot(join(d, "s"));
		guardedWriteFileSync(join(d, "s", "a", "b.txt"), "one");
		guardedWriteFileSync(join(d, "s", "a", "b.txt"), "two");
		expect(readFileSync(join(d, "s", "a", "b.txt"), "utf8")).toBe("two");
		writeFileSync(join(d, "target"), "keep");
		mkdirSync(join(d, "s", "h"));
		symlinkSync(join(d, "target"), join(d, "s", "h", "link"));
		expect(() => guardedWriteFileSync(join(d, "s", "h", "link"), "x")).toThrow("symlink");
		expect(readFileSync(join(d, "target"), "utf8")).toBe("keep");
		// a FIFO below a scratch root: write and read refuse at once instead of blocking in open()
		const fifo = join(d, "s", "h", "fifo");
		expect(Bun.spawnSync(["mkfifo", fifo]).exitCode).toBe(0);
		const t0 = Date.now();
		expect(() => guardedWriteFileSync(fifo, "x")).toThrow("FIFO");
		expect(() => guardedReadFileSync(fifo)).toThrow("not a regular");
		expect(Date.now() - t0).toBeLessThan(2_000);
		guardedWriteFileSync(join(d, "plain.txt"), "p");
		expect(readFileSync(join(d, "plain.txt"), "utf8")).toBe("p");
	});
});
