import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readChain, sha256, verifyChain } from "../modules/hash-chain.ts";
import { readLedger } from "../modules/ledger.ts";
import { RunStore } from "../modules/run-store.ts";
import { FULL_TOOLS } from "../modules/runtime.ts";
import { DEFAULT_STACK_SETTINGS } from "../modules/stack-config.ts";
import {
  BudgetScope,
  DEFAULT_PER_CALL_TOKENS,
  DEFAULT_PER_CALL_USD,
  formatUsdMicros,
  limitFrom,
  chargeUnreserved,
  perCallFrom,
  reservationFor,
  reserve,
  spendCapOf,
  settle,
  usdToMicrosCeil,
  usdToMicrosFloor,
} from "../modules/workflow/budget.ts";
import { type AgentRequest, type AgentResult, type ExecuteOptions, type RunResult, type RunWorkflowOptions, type WorkflowRuntimeDeps, executeWorkflow } from "../modules/workflow/executor.ts";
import type { LoadedWorkflow } from "../modules/workflow/loader.ts";
import type { NodeDoc, WorkflowDoc } from "../modules/workflow/schema.ts";
import { validateWorkflow } from "../modules/workflow/validator.ts";

// ═══ Harness (same shape as workflow-executor.test.ts: temp run store, scripted agent stub, no pi) ═══

const dirs: string[] = [];
afterEach(() => { while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true }); });
function scratch(): string { const dir = mkdtempSync(join(tmpdir(), "titan-budget-")); dirs.push(dir); return dir; }

type Answer = (req: AgentRequest, call: number) => Partial<AgentResult> | Promise<Partial<AgentResult>>;
const usage = (costUsd: number, tokensIn = 100, tokensOut = 50) => ({ tokensIn, tokensOut, costUsd, tpsSeconds: 1 });

interface Harness {
  deps: WorkflowRuntimeDeps;
  store: RunStore;
  runDir: string;
  agentCalls: AgentRequest[];
  notices: Array<{ text: string; level?: string }>;
}

function harness(options: { answers?: Record<string, Answer[]>; signal?: AbortSignal; runWorkflow?: WorkflowRuntimeDeps["runWorkflow"]; store?: RunStore } = {}): Harness {
  const store = options.store ?? new RunStore(scratch());
  const cwd = scratch();
  const { runId, dir: runDir } = store.open({ projectSlug: RunStore.projectSlug(cwd), cwd, workflow: { name: "t", sha256: sha256("t") }, command: "workflow" });
  const agentCalls: AgentRequest[] = [];
  const notices: Array<{ text: string; level?: string }> = [];
  const counts = new Map<string, number>();
  const deps: WorkflowRuntimeDeps = {
    cwd, runId, runDir, artifactsDir: join(runDir, "artifacts"), workflowId: "t", store,
    settings: { ...DEFAULT_STACK_SETTINGS },
    signal: options.signal,
    async agent(req) {
      agentCalls.push(req);
      const n = (counts.get(req.nodeId) ?? 0) + 1;
      counts.set(req.nodeId, n);
      const base: AgentResult = { ok: true, text: `${req.nodeId} done`, sessionRef: `sess-${req.nodeId}-${n}`, usage: usage(0.001), toolCalls: 0, model: req.model };
      const scripted = options.answers?.[req.nodeId]?.shift();
      return scripted ? { ...base, ...(await scripted(req, n)) } : base;
    },
    async bash() { return { code: 0, stdout: "ok\n", stderr: "" }; },
    async script() { return { code: 0, stdout: "{}\n", stderr: "" }; },
    async approval() { return { approved: false, response: "no" }; },
    notify(text, level) { notices.push({ text, level }); },
    resolveRole(role) { return { model: `stub/${role}`, thinking: "medium", callsign: `${role}-1`, appendSystemPrompts: [], tools: FULL_TOOLS }; },
    runWorkflow: options.runWorkflow,
  };
  return { deps, store, runDir, agentCalls, notices };
}

function loaded(nodes: NodeDoc[], extra: Partial<WorkflowDoc> = {}): LoadedWorkflow {
  const doc: WorkflowDoc = { apiVersion: "titan.harness/v1", name: extra.name ?? "t", version: 1, nodes, ...extra };
  const dir = scratch();
  return { doc, normalized: doc, name: doc.name, dir, path: join(dir, "t.yaml"), sha256: sha256(JSON.stringify(doc)), source: "project", commands: {}, scripts: {}, validation: { ok: true, errors: [], warnings: [] } } as LoadedWorkflow;
}

const run = (h: Harness, nodes: NodeDoc[], extra: Partial<WorkflowDoc> = {}, opts: ExecuteOptions = {}): Promise<RunResult> => executeWorkflow(loaded(nodes, extra), h.deps, opts);
const events = (h: Harness, type?: string) => readChain(join(h.runDir, "events.jsonl")).filter((r) => !type || r.type === type);
const data = (h: Harness, type: string) => events(h, type).map((r) => r.data as Record<string, any>);
/** Spent-so-far recomputed from the run dir alone (what a restarted runner would do). */
const spentFromEvents = (h: Harness) => data(h, "budget.settle").reduce((acc, d) => ({ usdMicros: acc.usdMicros + d.chargedUsdMicros, tokens: acc.tokens + d.chargedTokens }), { usdMicros: 0, tokens: 0 });

// ═══ The budget module ═══════════════════════════════════════════════════════

describe("budget.ts: integer reservations across a scope chain", () => {
  test("micro-USD conversion rounds charges up and limits down; formatting is exact", () => {
    expect(usdToMicrosCeil(0.1 + 0.2)).toBe(300_000);
    expect(usdToMicrosCeil(0.0000011)).toBe(2);
    expect(usdToMicrosFloor(0.0000019)).toBe(1);
    expect(formatUsdMicros(1_250_000)).toBe("$1.25");
    expect(formatUsdMicros(3)).toBe("$0.000003");
    expect(limitFrom({ usd: 2.5, tokens: 1000 })).toEqual({ usdMicros: 2_500_000, tokens: 1000 });
    expect(limitFrom(undefined)).toEqual({});
  });

  test("reservation: the largest per_call along the chain (else the default), clamped to what the chain has unspent, floored at 1", () => {
    const wf = (budget?: Parameters<typeof perCallFrom>[0]) => new BudgetScope("wf", limitFrom(budget), undefined, { kind: "workflow", perCall: perCallFrom(budget) });
    const node = (parent: BudgetScope, budget?: Parameters<typeof perCallFrom>[0]) => parent.child("node", limitFrom(budget), { perCall: perCallFrom(budget) });
    expect(reservationFor(node(wf()))).toEqual({ usdMicros: DEFAULT_PER_CALL_USD * 1e6, tokens: DEFAULT_PER_CALL_TOKENS });
    // a node can raise the per-call worst case but never lower what an ancestor declared
    expect(reservationFor(node(wf({ per_call_usd: 1, per_call_tokens: 900 }), { per_call_usd: 0.5 }))).toEqual({ usdMicros: 1_000_000, tokens: 900 });
    expect(reservationFor(node(wf({ per_call_usd: 0.2 }), { per_call_usd: 0.5 }))).toEqual({ usdMicros: 500_000, tokens: DEFAULT_PER_CALL_TOKENS });
    expect(reservationFor(node(wf({ per_call_usd: 1 }), { usd: 0.2, tokens: 10 }))).toEqual({ usdMicros: 200_000, tokens: 10 });
    // spent budget shrinks the reservation; an exhausted one still reserves 1 (so it refuses)
    const n = node(wf({ usd: 1 }));
    n.parent!.spent.usdMicros = 999_999;
    expect(reservationFor(n).usdMicros).toBe(1);
    n.parent!.spent.usdMicros = 1_000_000;
    expect(reservationFor(n).usdMicros).toBe(1);
    expect(reserve(n, reservationFor(n)).ok).toBe(false);
    // per_call 0 is not a declaration (the validator rejects it): the default applies, never a free call
    expect(perCallFrom({ per_call_usd: 0, per_call_tokens: 0 })).toEqual({});
  });

  test("reserve checks every scope in the chain; settle releases, charges, and wakes; in-flight refusals are transient", () => {
    const root = new BudgetScope("wf", { usdMicros: 1_000_000 });
    const node = root.child("node", { tokens: 500 });
    const a = reserve(node, { usdMicros: 600_000, tokens: 100 });
    expect(a.ok).toBe(true);
    const b = reserve(node, { usdMicros: 600_000, tokens: 100 });
    expect(b).toEqual({ ok: false, refusal: { scope: "wf", dimension: "usd", limit: 1_000_000, remaining: 400_000, needed: 600_000, transient: true } });
    const c = reserve(node, { usdMicros: 1, tokens: 501 });
    expect(c.ok).toBe(false);
    if (!c.ok) expect(c.refusal).toMatchObject({ scope: "node", dimension: "tokens", transient: false });
    if (!a.ok) throw new Error("unreachable");
    const s = settle(a.reservation, { usd: 0.25, tokens: 80 });
    expect(s).toMatchObject({ charged: { usdMicros: 250_000, tokens: 80 }, basis: { usd: "reported", tokens: "reported" } });
    expect(settle(a.reservation, { usd: 9 })).toBe(s); // idempotent
    expect(root.spent).toEqual({ usdMicros: 250_000, tokens: 80 });
    expect(root.reserved).toEqual({ usdMicros: 0, tokens: 0 });
    expect(node.remaining("tokens")).toBe(420);
  });
});

// ═══ Executor enforcement ════════════════════════════════════════════════════

describe("executor: budgets are enforced before dispatch", () => {
  test("a node whose budget is spent is refused before dispatch: the agent is never called (a per_call above the remainder reserves the remainder)", async () => {
    const h = harness({ answers: { first: [(req) => { expect(req.spendCap!()).toEqual({ usdMicros: 1_000_000 }); return { usage: usage(1) }; }] } });
    const result = await run(h, [{ id: "first", prompt: "go", budget: { per_call_usd: 2 } } as NodeDoc, { id: "big", prompt: "go", depends_on: ["first"], budget: { per_call_usd: 2 } } as NodeDoc], { titan: { budget: { usd: 1 } } });
    expect(data(h, "budget.reserve").map((d) => d.usdMicros)).toEqual([1_000_000]);
    expect(h.agentCalls.map((c) => c.nodeId)).toEqual(["first"]);
    expect(result.status).toBe("failed");
    expect(result.nodes.big).toMatchObject({ status: "failed", attempts: 1, error: "budget exceeded: workflow:t remaining $0, needed $0.000001" });
    expect(data(h, "budget.refused")).toEqual([expect.objectContaining({ nodeId: "big", scope: "workflow:t", dimension: "usd", remaining: 0, needed: 1, transient: false })]);
    expect(data(h, "agent.start").map((d) => d.nodeId)).toEqual(["first"]);
    expect(readLedger(h.runDir).map((r) => r.agentId)).toEqual(["first"]);
    expect(h.notices.some((n) => n.level === "error" && n.text.includes("budget exceeded"))).toBe(true);
    expect(verifyChain(join(h.runDir, "events.jsonl")).ok).toBe(true);
  });

  test("retries near the cap never overshoot: each attempt reserves what is left (the tail is spendable), then the spent budget refuses", async () => {
    // budget $1.00, per call $0.40; attempts 1 and 2 spend $0.35 → attempt 3 reserves the $0.30 left and spends it → attempt 4 refused.
    const fail = (usd: number): Answer => () => ({ ok: false, text: "", error: "flaky", usage: usage(usd) });
    const h = harness({ answers: { n: [fail(0.35), fail(0.35), fail(0.3), fail(0.3)] } });
    const result = await run(h, [{ id: "n", prompt: "go", retry: { max_attempts: 4, delay_ms: 0 } } as NodeDoc], { titan: { budget: { usd: 1, per_call_usd: 0.4 } } });
    expect(h.agentCalls).toHaveLength(3);
    expect(result.nodes.n).toMatchObject({ status: "failed", attempts: 4, error: "budget exceeded: workflow:t remaining $0, needed $0.000001" });
    expect(data(h, "budget.reserve").map((d) => d.usdMicros)).toEqual([400_000, 400_000, 300_000]);
    expect(data(h, "budget.settle").map((d) => d.chargedUsdMicros)).toEqual([350_000, 350_000, 300_000]);
    expect(result.budget).toMatchObject({ spentUsdMicros: 1_000_000, reservedUsdMicros: 0 });
    expect(spentFromEvents(h).usdMicros).toBeLessThanOrEqual(1_000_000);
    expect(data(h, "budget.summary")[0].workflow).toMatchObject({ spentUsdMicros: 1_000_000 });
  });

  test("retry settles failed attempts at the full reservation when usage is unknown", async () => {
    const h = harness({ answers: { n: [() => ({ ok: false, text: "", error: "x", usage: undefined as any }), () => ({ ok: true, text: "fine", usage: usage(0.1) })] } });
    const result = await run(h, [{ id: "n", prompt: "go", retry: { max_attempts: 3, delay_ms: 0 } } as NodeDoc], { titan: { budget: { usd: 1, per_call_usd: 0.4 } } });
    expect(result.status).toBe("completed");
    expect(data(h, "budget.settle").map((d) => [d.chargedUsdMicros, d.basis.usd])).toEqual([[400_000, "reservation"], [100_000, "reported"]]);
  });

  test("missing usage settles at the reservation; an overrun is recorded, flagged and charged in full", async () => {
    const h = harness({
      answers: {
        a: [() => ({ usage: undefined as any })],
        b: [() => ({ usage: { tokensIn: 100, tokensOut: 50, costUsd: Number.NaN, tpsSeconds: 1 } })],
        c: [() => ({ usage: usage(0.9, 4000, 2000) })],
      },
    });
    const result = await run(h, [
      { id: "a", prompt: "a" } as NodeDoc,
      { id: "b", prompt: "b", depends_on: ["a"] } as NodeDoc,
      { id: "c", prompt: "c", depends_on: ["b"] } as NodeDoc,
    ], { titan: { budget: { usd: 10, tokens: 100_000, per_call_usd: 0.5, per_call_tokens: 5000 } } });
    expect(result.status).toBe("completed");
    const settles = Object.fromEntries(data(h, "budget.settle").map((d) => [d.nodeId, d]));
    expect(settles.a).toMatchObject({ chargedUsdMicros: 500_000, chargedTokens: 5000, basis: { usd: "reservation", tokens: "reservation" } });
    expect(settles.b).toMatchObject({ chargedUsdMicros: 500_000, chargedTokens: 150, basis: { usd: "reservation", tokens: "reported" } });
    expect(settles.c).toMatchObject({ chargedUsdMicros: 900_000, chargedTokens: 6000 });
    expect(data(h, "budget.overrun")).toEqual([expect.objectContaining({ nodeId: "c", overrunUsdMicros: 400_000, overrunTokens: 1000 })]);
    expect(result.budget).toMatchObject({ spentUsdMicros: 1_900_000, spentTokens: 11_150, overrunUsdMicros: 400_000, overrunTokens: 1000 });
    expect(h.notices.some((n) => n.text.includes("budget overrun"))).toBe(true);
    // the ledger still records what the child reported, as before
    expect(readLedger(h.runDir).map((r) => r.agentId)).toEqual(["a", "b", "c"]);
  });

  test("the token budget is enforced like the USD budget", async () => {
    const h = harness({ answers: { a: [() => ({ usage: usage(0, 600, 300) })], b: [() => ({ usage: usage(0, 400, 200) })] } });
    const result = await run(h, [
      { id: "a", prompt: "a" } as NodeDoc,
      { id: "b", prompt: "b", depends_on: ["a"] } as NodeDoc,
      { id: "c", prompt: "c", depends_on: ["b"] } as NodeDoc,
    ], { titan: { budget: { tokens: 1500, per_call_tokens: 1000 } } });
    // b reserves the 600 tokens left (not 1000) and spends them; c is refused on the spent budget
    expect(h.agentCalls.map((c) => c.nodeId)).toEqual(["a", "b"]);
    expect(data(h, "budget.reserve").map((d) => d.tokens)).toEqual([1000, 600]);
    expect(result.nodes.c).toMatchObject({ status: "failed", error: "budget exceeded: workflow:t remaining 0 tokens, needed 1 tokens" });
  });

  test("a node-level budget is enforced on its own scope, beside the workflow budget", async () => {
    // node loop: budget $0.5, per call $0.25; iteration 1 spends $0.3, iteration 2 reserves the $0.2 left and spends it → iteration 3 refused.
    const h = harness({ answers: { l: [() => ({ text: "not yet", usage: usage(0.3) }), () => ({ text: "not yet", usage: usage(0.2) }), () => ({ text: "DONE" })] } });
    const result = await run(h, [
      { id: "l", loop: { prompt: "work", until: "DONE", max_iterations: 3 }, budget: { usd: 0.5, per_call_usd: 0.25 } } as NodeDoc,
      { id: "other", prompt: "unaffected", depends_on: ["l"], trigger_rule: "all_done" } as NodeDoc,
    ]);
    expect(h.agentCalls.map((c) => c.nodeId)).toEqual(["l", "l", "other"]);
    expect(result.nodes.l).toMatchObject({ status: "failed", error: "budget exceeded: workflow:t/node:l remaining $0, needed $0.000001" });
    expect(result.nodes.other.status).toBe("success");
    // only a node budget applied: the workflow scope has no limit, yet it still records the spend
    expect(data(h, "budget.settle").map((d) => d.nodeId)).toEqual(["l", "l"]);
    expect(result.budget).toMatchObject({ spentUsdMicros: 500_000 });
  });

  test("fan-outs reserve per call: a best_of candidate that does not fit yet waits for a settlement; one that never fits is refused", async () => {
    const verdict = JSON.stringify({ winner: 2, scores: [{ candidate: 2, score: 9, reason: "best" }], summary: "picked" });
    const answer: Answer = (req) => (req.role === "judge" ? { text: `\`\`\`json\n${verdict}\n\`\`\``, usage: usage(0.05) } : { text: `answer from ${req.callsign}`, usage: usage(0.1) });
    const h = harness({ answers: { pick: [answer, answer, answer, answer] } });
    const result = await run(h, [{ id: "pick", best_of: { n: 3, prompt: "solve" } } as NodeDoc], { titan: { budget: { usd: 1, per_call_usd: 0.4 } } });
    // two candidates fit ($0.80 reserved), the third waits for a settlement and then fits, the judge fits too — nothing overshoots
    expect(spentFromEvents(h).usdMicros).toBeLessThanOrEqual(1_000_000);
    expect(data(h, "budget.reserve").length).toBe(h.agentCalls.length);
    expect(result.nodes.pick.status).toBe("success");
    expect(h.agentCalls).toHaveLength(4);
    expect(data(h, "budget.wait").length).toBeGreaterThan(0);
    expect(spentFromEvents(h).usdMicros).toBe(350_000);

    // a fan-out under a spent budget is refused, not dispatched (and not retried)
    const tight = harness({ answers: { first: [() => ({ usage: usage(0.3) })] } });
    const refused = await run(tight, [{ id: "first", prompt: "spend it all" } as NodeDoc, { id: "pick", best_of: { n: 3, prompt: "solve" }, depends_on: ["first"] } as NodeDoc], { titan: { budget: { usd: 0.3, per_call_usd: 0.4 } } });
    expect(tight.agentCalls.map((c) => c.nodeId)).toEqual(["first"]);
    expect(refused.nodes.pick).toMatchObject({ attempts: 1, error: "budget exceeded: workflow:t remaining $0, needed $0.000001" });
  });

  test("an interrupted call settles max(late usage, reservation) as partial; one that never reports settles at the reservation", async () => {
    const controller = new AbortController();
    const h = harness({
      signal: controller.signal,
      answers: {
        a: [() => new Promise((resolve) => controller.signal.addEventListener("abort", () => setTimeout(() => resolve({ ok: false, text: "", error: "killed", usage: usage(0.12, 300, 20) }), 5)))],
        b: [() => new Promise(() => {})],
      },
    });
    setTimeout(() => controller.abort(), 20);
    const result = await run(h, [
      { id: "a", prompt: "reports late usage" } as NodeDoc,
      { id: "b", prompt: "never reports" } as NodeDoc,
    ], { titan: { budget: { usd: 5, per_call_usd: 1 } } }, { budgetAbortGraceMs: 50 });
    expect(result.status).toBe("cancelled");
    const settles = Object.fromEntries(data(h, "budget.settle").map((d) => [d.nodeId, d]));
    // a's turn in progress was never billed: its $0.12 is a lower bound, so the $1 reservation is charged (tokens are unlimited → as reported)
    expect(settles.a).toMatchObject({ interrupted: true, chargedUsdMicros: 1_000_000, chargedTokens: 320, basis: { usd: "partial", tokens: "reported" }, provenance: "partial" });
    expect(settles.b).toMatchObject({ interrupted: true, chargedUsdMicros: 1_000_000, basis: { usd: "reservation" }, provenance: "none" });
    expect(result.budget).toMatchObject({ spentUsdMicros: 2_000_000, reservedUsdMicros: 0 });
    const types = events(h).map((r) => r.type);
    expect(types.indexOf("budget.summary")).toBeLessThan(types.indexOf("workflow.end"));
    expect(spentFromEvents(h)).toEqual({ usdMicros: 2_000_000, tokens: 320 + DEFAULT_PER_CALL_TOKENS });
  });
});

describe("executor: nested workflows draw from the parent's remainder", () => {
  test("a child that declares a larger budget is still refused at the parent's remainder", async () => {
    const store = new RunStore(scratch());
    const childRuns: Harness[] = [];
    const child = loaded([
      { id: "c1", prompt: "one" } as NodeDoc,
      { id: "c2", prompt: "two", depends_on: ["c1"] } as NodeDoc,
    ], { name: "sub", titan: { budget: { usd: 100, per_call_usd: 0.5 } } });
    const runWorkflow = async (_name: string, _inputs: Record<string, unknown>, opts?: RunWorkflowOptions): Promise<RunResult> => {
      const ch = harness({ store, answers: { c1: [() => ({ usage: usage(0.7) })] } });
      childRuns.push(ch);
      return executeWorkflow(child, ch.deps, { parentBudget: opts?.parentBudget });
    };
    const h = harness({ store, runWorkflow, answers: { first: [() => ({ usage: usage(0.3) })] } });
    const result = await run(h, [
      { id: "first", prompt: "spend some" } as NodeDoc,
      { id: "sub", workflow: { name: "sub" }, depends_on: ["first"] } as NodeDoc,
    ], { titan: { budget: { usd: 1, per_call_usd: 0.5 } } });
    // parent $1: first spends $0.30; child c1 reserves $0.50 (fits $0.70), spends $0.70 → the PARENT is spent, c2 is refused there.
    const ch = childRuns[0];
    expect(ch.agentCalls.map((c) => c.nodeId)).toEqual(["c1"]);
    expect(data(ch, "budget.refused")).toEqual([expect.objectContaining({ nodeId: "c2", scope: "workflow:t", remaining: 0, needed: 1 })]);
    expect(result.nodes.sub).toMatchObject({ status: "failed", attempts: 1, error: expect.stringContaining("budget exceeded: workflow:t remaining $0, needed $0.000001") });
    // item 9: a child that failed on a budget refusal is not re-run by the parent
    expect(childRuns).toHaveLength(1);
    expect(result.budget).toMatchObject({ spentUsdMicros: 1_000_000, reservedUsdMicros: 0 });
    expect(result.budget!.spentUsdMicros as number).toBeLessThanOrEqual(1_000_000);
  });

  test("a node budget on the workflow: node caps its children too (a child with no per_call reserves what the node has left)", async () => {
    const store = new RunStore(scratch());
    const child = loaded([{ id: "c1", prompt: "one" } as NodeDoc], { name: "sub" });
    const calls: string[] = [];
    const runWorkflow = async (_n: string, _i: Record<string, unknown>, opts?: RunWorkflowOptions) => {
      const ch = harness({ store });
      const r = await executeWorkflow(child, ch.deps, { parentBudget: opts?.parentBudget });
      calls.push(...ch.agentCalls.map((c) => c.nodeId));
      return r;
    };
    const h = harness({ store, runWorkflow });
    const result = await run(h, [{ id: "sub", workflow: { name: "sub" }, budget: { usd: 0.01 }, retry: { max_attempts: 1 } } as NodeDoc]);
    expect(calls).toEqual(["c1"]);
    expect(result.nodes.sub.status).toBe("success");
    expect(result.budget).toMatchObject({ spentUsdMicros: 1000 });
  });
});

describe("executor: no budget declared → behaviour unchanged", () => {
  test("no reservations, no refusals, no budget events; usage still lands in the ledger and agent.end", async () => {
    const h = harness({ answers: { a: [() => ({ usage: usage(999, 9_000_000, 9_000_000) })] } });
    const result = await run(h, [{ id: "a", prompt: "a" } as NodeDoc, { id: "b", prompt: "b", depends_on: ["a"] } as NodeDoc]);
    expect(result.status).toBe("completed");
    expect(result.budget).toBeUndefined();
    expect(events(h).some((r) => r.type.startsWith("budget."))).toBe(false);
    expect(readLedger(h.runDir)[0]).toMatchObject({ agentId: "a", costUsd: 999 });
    expect(data(h, "agent.end")[0]).toMatchObject({ costUsd: 999, tokensIn: 9_000_000 });
  });

  test("the validator accepts per_call_* keys and rejects bad values", () => {
    const base = { apiVersion: "titan.harness/v1", name: "t", nodes: [{ id: "a", prompt: "x", budget: { usd: 1, per_call_usd: 0.1, per_call_tokens: 100 } }] };
    expect(validateWorkflow({ ...base, titan: { budget: { usd: 2, per_call_usd: 0.5, per_call_tokens: 1000 } } }, {}).ok).toBe(true);
    const bad = validateWorkflow({ ...base, titan: { budget: { per_call_usd: -1 } } }, {});
    expect(bad.ok).toBe(false);
    expect(bad.errors.some((e) => e.message.includes("per_call_usd"))).toBe(true);
  });
});

// ═══ Repair round 1 (gate N3-09): regressions for the gate probes P1–P7 and items 1–11 ═══

import { readFileSync, writeFileSync } from "node:fs";
import { overSpendCap, runChild, watchdogPreemptionAllowed } from "../modules/child-runner.ts";
import { newRun } from "../modules/runtime.ts";
import { createAgentRunner, usageProvenanceOf } from "../modules/workflow-runtime.ts";
import { RUNNERS } from "../modules/workflow/runners/index.ts";

const settleOf = (h: Harness, nodeId?: string) => data(h, "budget.settle").filter((d) => !nodeId || d.nodeId === nodeId);

describe("repair: zero budgets and zero reservations are fail-closed (item 3, P1, P2)", () => {
  test("P1: a node with budget usd 0 is never dispatched (validator rejects it; the executor refuses it anyway)", async () => {
    const h = harness({ answers: { a: [() => ({ usage: usage(0.5) })] } });
    const r = await run(h, [{ id: "a", prompt: "x", budget: { usd: 0 } } as NodeDoc]);
    expect(h.agentCalls).toHaveLength(0);
    expect(r.nodes.a).toMatchObject({ status: "failed", attempts: 1, error: "budget exceeded: workflow:t/node:a remaining $0, needed $0.000001" });
    expect(r.budgetRefused).toMatchObject({ scope: "workflow:t/node:a", dimension: "usd", remaining: 0, needed: 1 });
  });

  test("P2: per_call_usd 0 never makes calls free — a best_of fan-out stays inside the workflow cap", async () => {
    const verdict = JSON.stringify({ winner: 1, scores: [{ candidate: 1, score: 9, reason: "b" }], summary: "s" });
    const ans: Answer = (req) => (req.role === "judge" ? { text: "```json\n" + verdict + "\n```", usage: usage(0.2) } : { text: "c", usage: usage(0.2) });
    const h = harness({ answers: { p: [ans, ans, ans, ans, ans, ans] } });
    const r = await run(h, [{ id: "p", best_of: { n: 5, prompt: "x" } } as NodeDoc], { titan: { budget: { usd: 1, per_call_usd: 0 } } });
    const reserves = data(h, "budget.reserve");
    expect(reserves.every((d) => d.usdMicros >= 1)).toBe(true);
    expect(reserves).toHaveLength(h.agentCalls.length);
    expect(r.budget!.spentUsdMicros as number).toBeLessThanOrEqual(1_000_000);
    expect(h.agentCalls.length).toBeLessThanOrEqual(5); // 4 candidates of $0.20 + nothing left for more; never 6 calls / $2
    expect(r.budget).toMatchObject({ reservedUsdMicros: 0, overrunUsdMicros: 0 });
  });

  test("reserve refuses a limited dimension with remaining ≤ 0 even when asked for 0", () => {
    const wf = new BudgetScope("wf", { usdMicros: 0, tokens: 10 });
    const refused = reserve(wf, { usdMicros: 0, tokens: 0 });
    expect(refused).toEqual({ ok: false, refusal: { scope: "wf", dimension: "usd", limit: 0, remaining: 0, needed: 1, transient: false } });
    const unlimited = new BudgetScope("free", { tokens: 10 });
    const ok = reserve(unlimited, { usdMicros: 0, tokens: 0 });
    expect(ok.ok && ok.reservation.amount).toEqual({ usdMicros: 0, tokens: 1 });
  });

  test("validator: usd/tokens/per_call_* must be > 0 at both levels; allow_unmetered_runners must be a boolean", () => {
    const wf = (budget: Record<string, unknown>) => validateWorkflow({ apiVersion: "titan.harness/v1", name: "t", nodes: [{ id: "a", prompt: "x" }], titan: { budget } }, {});
    const node = (budget: Record<string, unknown>) => validateWorkflow({ apiVersion: "titan.harness/v1", name: "t", nodes: [{ id: "a", prompt: "x", budget }] }, {});
    for (const [check, key] of [[wf({ usd: 0 }), "titan.budget.usd"], [wf({ tokens: 0 }), "titan.budget.tokens"], [wf({ usd: 9, per_call_usd: 0 }), "per_call_usd"], [wf({ per_call_tokens: 0 }), "per_call_tokens"], [wf({ allow_unmetered_runners: "yes" }), "allow_unmetered_runners"], [node({ usd: 0 }), "budget.usd"], [node({ tokens: 0 }), "budget.tokens"], [node({ per_call_usd: 0 }), "budget.per_call_usd"], [node({ per_call_tokens: 0 }), "budget.per_call_tokens"]] as const) {
      expect(check.ok).toBe(false);
      expect(check.errors.some((e) => e.message.includes(key))).toBe(true);
    }
    expect(wf({ usd: 9, per_call_usd: 0.5, per_call_tokens: 10, tokens: 100, allow_unmetered_runners: true }).ok).toBe(true);
  });
});

describe("repair: unknown usage is never settled at zero (item 1, P3, item 2, P4, item 8)", () => {
  test("P3: the REAL createAgentRunner, child aborted before any usage event → charged the full reservation (provenance none)", async () => {
    const controller = new AbortController();
    const h = harness({ signal: controller.signal });
    const agent = createAgentRunner({ sessionsDir: join(h.runDir, "sessions"), cwd: h.deps.cwd, runChild: (async (o: any) => { await new Promise((res) => o.signal.addEventListener("abort", res)); o.run.status = "aborted"; o.run.exitCode = 130; return o.run; }) as any });
    h.deps.agent = agent as any;
    setTimeout(() => controller.abort(), 20);
    await run(h, [{ id: "a", prompt: "x" } as NodeDoc], { titan: { budget: { usd: 5, per_call_usd: 1 } } }, { budgetAbortGraceMs: 200 });
    expect(settleOf(h)[0]).toMatchObject({ chargedUsdMicros: 1_000_000, basis: { usd: "reservation", tokens: "reservation" }, provenance: "none", interrupted: true });
  });

  test("the real runner: a thrown runChild → none (reservation); usage then abort → partial (max); queued abort → not-dispatched ($0); clean exit → complete", async () => {
    const cases: Array<[string, (o: any) => Promise<any>, Record<string, unknown>]> = [
      ["throws", async () => { throw new Error("spawn exploded"); }, { chargedUsdMicros: 1_000_000, provenance: "none", basis: { usd: "reservation" } }],
      ["partial", async (o) => { o.run.usageSeen = true; o.run.costUsd = 0.25; o.run.tokensIn = 10; o.run.tokensOut = 5; o.run.status = "timeout"; o.run.exitCode = 124; return o.run; }, { chargedUsdMicros: 1_000_000, provenance: "partial", basis: { usd: "partial" } }],
      ["partial overrun", async (o) => { o.run.usageSeen = true; o.run.costUsd = 1.5; o.run.tokensIn = 10; o.run.tokensOut = 5; o.run.status = "failed"; o.run.exitCode = 1; return o.run; }, { chargedUsdMicros: 1_500_000, provenance: "partial", basis: { usd: "partial" } }],
      ["queued abort", async (o) => { o.run.notDispatched = true; o.run.status = "aborted"; o.run.exitCode = 130; return o.run; }, { chargedUsdMicros: 0, chargedTokens: 0, provenance: "not-dispatched", basis: { usd: "not-dispatched", tokens: "not-dispatched" } }],
      ["exited without usage", async (o) => { o.run.status = "failed"; o.run.exitCode = 1; return o.run; }, { chargedUsdMicros: 1_000_000, provenance: "none" }],
      ["complete", async (o) => { o.run.usageSeen = true; o.run.costUsd = 0.1; o.run.tokensIn = 10; o.run.tokensOut = 5; o.run.text = "ok"; o.run.status = "done"; return o.run; }, { chargedUsdMicros: 100_000, chargedTokens: 15, provenance: "complete", basis: { usd: "reported", tokens: "reported" } }],
    ];
    for (const [label, fake, expected] of cases) {
      const h = harness();
      h.deps.agent = createAgentRunner({ sessionsDir: join(h.runDir, "sessions"), cwd: h.deps.cwd, runChild: fake as any }) as any;
      await run(h, [{ id: "a", prompt: "x", retry: { max_attempts: 1 } } as NodeDoc], { titan: { budget: { usd: 5, per_call_usd: 1 } } });
      expect([label, settleOf(h)[0]]).toMatchObject([label, expected]);
    }
    const run0 = newRun("BUILDER", "m");
    expect(usageProvenanceOf(run0)).toBe("none");
    expect(usageProvenanceOf({ ...run0, usageSeen: true, budgetHalted: true, status: "aborted" })).toBe("partial");
  });

  test("P4 / item 2: tokens with a $0 cost under a USD budget charge the USD reservation and flag budget.cost_unknown", async () => {
    const h = harness({ answers: { a: [() => ({ usage: usage(0, 500000, 20000) })], b: [() => ({ usage: usage(0, 500000, 20000) })] } });
    const r = await run(h, [{ id: "a", prompt: "x" } as NodeDoc, { id: "b", prompt: "x", depends_on: ["a"] } as NodeDoc], { titan: { budget: { usd: 1, per_call_usd: 0.5 } } });
    expect(r.budget).toMatchObject({ spentUsdMicros: 1_000_000 });
    expect(settleOf(h).map((d) => [d.chargedUsdMicros, d.cost_unknown])).toEqual([[500_000, true], [500_000, true]]);
    expect(data(h, "budget.cost_unknown")).toHaveLength(2);
    // a token-only budget does not invent a USD charge
    const t = harness({ answers: { a: [() => ({ usage: usage(0, 50, 50) })] } });
    const tr = await run(t, [{ id: "a", prompt: "x" } as NodeDoc], { titan: { budget: { tokens: 1000 } } });
    expect(tr.budget).toMatchObject({ spentUsdMicros: 0, spentTokens: 100 });
  });

  test("item 8: partially reported tokens (one side missing or NaN) charge the token reservation", async () => {
    const h = harness({ answers: { a: [() => ({ usage: { tokensIn: 100, tokensOut: Number.NaN, costUsd: 0.1, tpsSeconds: 1 } })], b: [() => ({ usage: { tokensIn: 100, costUsd: 0.1, tpsSeconds: 1 } as any })] } });
    await run(h, [{ id: "a", prompt: "x" } as NodeDoc, { id: "b", prompt: "x", depends_on: ["a"] } as NodeDoc], { titan: { budget: { usd: 5, tokens: 100_000, per_call_usd: 1, per_call_tokens: 5000 } } });
    expect(settleOf(h).map((d) => [d.chargedTokens, d.basis.tokens])).toEqual([[5000, "reservation"], [5000, "reservation"]]);
  });

  test("a synchronous deps.agent throw settles at $0 (not-dispatched); a settlement record failure never masks the agent's error", async () => {
    const h = harness();
    h.deps.agent = (() => { throw new Error("sync boom"); }) as any;
    const r = await run(h, [{ id: "a", prompt: "x", retry: { max_attempts: 1 } } as NodeDoc], { titan: { budget: { usd: 5, per_call_usd: 1 } } });
    expect(r.nodes.a.error).toBe("sync boom");
    expect(settleOf(h)[0]).toMatchObject({ chargedUsdMicros: 0, basis: { usd: "not-dispatched" }, provenance: "not-dispatched" });

    const m = harness();
    m.deps.agent = async () => { throw new Error("agent boom"); };
    const append = m.store.appendEvent.bind(m.store);
    m.store.appendEvent = ((dir: string, type: string, d: Record<string, unknown>, agentId?: string) => {
      if (type === "budget.settle") throw new Error("disk full");
      return append(dir, type, d, agentId);
    }) as any;
    const mr = await run(m, [{ id: "a", prompt: "x", retry: { max_attempts: 1 } } as NodeDoc], { titan: { budget: { usd: 5, per_call_usd: 1 } } });
    expect(mr.nodes.a.error).toBe("agent boom");
    expect(mr.budget).toMatchObject({ spentUsdMicros: 1_000_000, reservedUsdMicros: 0 }); // the settlement itself still happened
    expect(m.notices.some((n) => n.text.includes("budget settlement record failed: disk full"))).toBe(true);
  });
});

describe("repair: in-flight hard cap (item 4, P6)", () => {
  test("P6: every budgeted call carries a live spend cap = min(reservation, what the chain has left)", async () => {
    const caps: Array<ReturnType<NonNullable<AgentRequest["spendCap"]>>> = [];
    const h = harness({ answers: { a: [(req) => { caps.push(req.spendCap!()); return { usage: usage(0.01) }; }] } });
    await run(h, [{ id: "a", prompt: "x" } as NodeDoc], { titan: { budget: { usd: 1, tokens: 1000, per_call_usd: 0.01, per_call_tokens: 400 } } });
    expect(caps).toEqual([{ usdMicros: 10_000, tokens: 400 }]);
    // an unbudgeted run passes no cap
    const free = harness({ answers: { a: [(req) => { expect(req.spendCap).toBeUndefined(); return {}; }] } });
    await run(free, [{ id: "a", prompt: "x" } as NodeDoc]);
    // the cap shrinks when a sibling's overrun eats the remainder
    const wf = new BudgetScope("wf", { usdMicros: 1_000_000 });
    const one = reserve(wf, { usdMicros: 400_000, tokens: 0 });
    const two = reserve(wf, { usdMicros: 400_000, tokens: 0 });
    if (!one.ok || !two.ok) throw new Error("unreachable");
    settle(one.reservation, { usd: 0.9, tokens: 0 });
    expect(spendCapOf(two.reservation)).toEqual({ usdMicros: 100_000 });
    expect(overSpendCap({ costUsd: 0.1000011, tokensIn: 0, tokensOut: 0 }, { usdMicros: 100_000 })).toBe(true);
    expect(overSpendCap({ costUsd: 0.1, tokensIn: 0, tokensOut: 0 }, { usdMicros: 100_000 })).toBe(false);
  });

  test("P6: the REAL runChild kills a child as soon as its observed spend passes the cap (overrun bounded by one message)", async () => {
    const dir = scratch();
    const script = join(dir, "fake-pi.ts");
    writeFileSync(script, `
      const out = (o) => process.stdout.write(JSON.stringify(o) + "\\n");
      out({ type: "session", id: "s1" });
      let i = 0;
      const tick = () => { i++; out({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "m" + i }], usage: { input: 10, output: 10, cost: { total: 0.4 } } } }); if (i < 50) setTimeout(tick, 30); };
      tick();
    `);
    const saved = process.argv[1];
    process.argv[1] = script;
    try {
      const r = newRun("BUILDER", "stub/model");
      await runChild({ run: r, prompt: "x", tools: "none", thinking: "off", sessionDir: dir, cwd: dir, timeoutMs: 20_000, spendCap: () => ({ usdMicros: 1_000_000 }) });
      expect(r.budgetHalted).toBe(true);
      expect(r.status).toBe("aborted");
      expect(r.stopReason).toBe("budget");
      expect(Math.round(r.costUsd * 10)).toBe(12); // 3 messages × $0.40: stopped on the first message over $1, not after 50
      expect(usageProvenanceOf(r)).toBe("partial");
    } finally {
      process.argv[1] = saved;
    }
  });

  test("an overrun is still charged in full and flagged", async () => {
    const h = harness({ answers: { a: [() => ({ usage: usage(4) })] } });
    const r = await run(h, [{ id: "a", prompt: "x" } as NodeDoc], { titan: { budget: { usd: 1, per_call_usd: 0.01 } } });
    expect(r.budget).toMatchObject({ spentUsdMicros: 4_000_000, overrunUsdMicros: 3_990_000 });
    expect(data(h, "budget.overrun")).toHaveLength(1);
  });
});

describe("repair: reservations follow the remaining budget and the scope chain (items 5, 6, 10, P5, P7)", () => {
  test("P7 / item 5: a node usd budget without per_call allows retries until the node budget is actually spent", async () => {
    const h = harness({ answers: { a: [() => ({ ok: false, text: "", error: "flaky", usage: usage(0.05) }), () => ({ usage: usage(0.05) })] } });
    const r = await run(h, [{ id: "a", prompt: "x", budget: { usd: 1 }, retry: { max_attempts: 2, delay_ms: 0 } } as NodeDoc]);
    expect(h.agentCalls).toHaveLength(2);
    expect(r.nodes.a.status).toBe("success");
    expect(data(h, "budget.reserve").map((d) => d.usdMicros)).toEqual([1_000_000, 950_000]);
  });

  test("P5 / item 6: parent $3 with per_call $0.5 — a child declaring nothing inherits the parent's per_call and runs", async () => {
    const store = new RunStore(scratch());
    const child = loaded([{ id: "c1", prompt: "one" } as NodeDoc], { name: "sub" });
    const childRuns: Harness[] = [];
    const runWorkflow = async (_n: string, _i: Record<string, unknown>, opts?: RunWorkflowOptions) => {
      const ch = harness({ store });
      childRuns.push(ch);
      return executeWorkflow(child, ch.deps, { parentBudget: opts?.parentBudget });
    };
    const h = harness({ store, runWorkflow });
    const r = await run(h, [{ id: "sub", workflow: { name: "sub" }, retry: { max_attempts: 1 } } as NodeDoc], { titan: { budget: { usd: 3, per_call_usd: 0.5 } } });
    expect(r.nodes.sub.status).toBe("success");
    expect(data(childRuns[0], "budget.reserve")[0]).toMatchObject({ usdMicros: 500_000 });
  });

  test("item 6 (fable 2): a child cannot lower the per-call reservation its ancestors declared", async () => {
    const store = new RunStore(scratch());
    const child = loaded([{ id: "c1", prompt: "one", budget: { per_call_usd: 0.000001 } } as NodeDoc], { name: "sub", titan: { budget: { per_call_usd: 0.000001 } } });
    const childRuns: Harness[] = [];
    const runWorkflow = async (_n: string, _i: Record<string, unknown>, opts?: RunWorkflowOptions) => {
      const ch = harness({ store });
      childRuns.push(ch);
      return executeWorkflow(child, ch.deps, { parentBudget: opts?.parentBudget });
    };
    const h = harness({ store, runWorkflow });
    await run(h, [{ id: "sub", workflow: { name: "sub" } } as NodeDoc], { titan: { budget: { usd: 3, per_call_usd: 0.5 } } });
    expect(data(childRuns[0], "budget.reserve")[0]).toMatchObject({ usdMicros: 500_000 });
  });

  test("item 10: a workflow total below the default per-call with no per_call_usd warns; declaring per_call_usd silences it", () => {
    const doc = (budget: Record<string, unknown>) => ({ apiVersion: "titan.harness/v1", name: "t", nodes: [{ id: "a", prompt: "x" }], titan: { budget } });
    const low = validateWorkflow(doc({ usd: 2 }), {});
    expect(low.ok).toBe(true);
    expect(low.warnings.some((w) => w.rule === "budget" && w.message.includes("per_call_usd"))).toBe(true);
    expect(validateWorkflow(doc({ usd: 2, per_call_usd: 0.5 }), {}).warnings).toEqual([]);
    expect(validateWorkflow(doc({ usd: 25 }), {}).warnings).toEqual([]);
  });

  test("item 10: a $25 budget with no per_call (the shipped workflows) can spend its last $5", async () => {
    const answers = Array.from({ length: 6 }, () => () => ({ usage: usage(4.5) }));
    const h = harness({ answers: { l: answers as Answer[] } });
    const r = await run(h, [{ id: "l", loop: { prompt: "work", until: "NEVER", max_iterations: 6 } } as NodeDoc], { titan: { budget: { usd: 25 } } });
    // 5 × $4.50 = $22.50, then the 6th iteration reserves the $2.50 left (not refused at the $5 default) and overruns on the stub
    expect(h.agentCalls).toHaveLength(6);
    expect(data(h, "budget.reserve").map((d) => d.usdMicros).slice(-1)).toEqual([2_500_000]);
    expect(r.nodes.l.error).toContain("loop did not complete");
  });
});

describe("repair: settlements are drained and siblings stopped (item 7)", () => {
  test("a hard refusal in a fan-out aborts the in-flight sibling; its settlement lands before budget.summary; nothing stays reserved", async () => {
    let siblingAborted = false;
    const answers: Answer[] = [
      // candidate 1: overruns and spends the whole budget
      async () => { await new Promise((r) => setTimeout(r, 10)); return { text: "c1", usage: usage(1.2) }; },
      // candidate 2: never finishes on its own; reports late usage when stopped
      (req) => new Promise((resolve) => req.signal!.addEventListener("abort", () => { siblingAborted = true; setTimeout(() => resolve({ ok: false, text: "", error: "killed", usage: usage(0.05) }), 5); })),
    ];
    const h = harness({ answers: { p: answers } });
    const r = await run(h, [{ id: "p", best_of: { n: 3, prompt: "x" }, retry: { max_attempts: 3, delay_ms: 0 } } as NodeDoc], { titan: { budget: { usd: 1, per_call_usd: 0.4 } } }, { budgetAbortGraceMs: 500 });
    expect(siblingAborted).toBe(true);
    expect(h.agentCalls).toHaveLength(2);
    expect(r.nodes.p).toMatchObject({ status: "failed", attempts: 1, error: "budget exceeded: workflow:t remaining $0, needed $0.000001" });
    expect(data(h, "budget.refused")).toHaveLength(1);
    const types = events(h).map((e) => e.type);
    const settles = types.flatMap((t, i) => (t === "budget.settle" ? [i] : []));
    expect(settles).toHaveLength(2);
    expect(Math.max(...settles)).toBeLessThan(types.indexOf("budget.summary"));
    expect(data(h, "budget.summary")[0].workflow).toMatchObject({ reservedUsdMicros: 0 });
    expect(r.budget).toMatchObject({ reservedUsdMicros: 0, spentUsdMicros: 1_600_000 }); // $1.20 + the sibling's partial max($0.05, $0.40)
  });

  test("item 9: a handler that retries or swallows cannot make a budget refusal retryable (interleave with retries)", async () => {
    const h = harness({ answers: { first: [() => ({ usage: usage(1) })] } });
    const r = await run(h, [
      { id: "first", prompt: "spend it" } as NodeDoc,
      { id: "il", interleave: { prompt: "part $SEGMENT", segments: ["a", "b"] }, depends_on: ["first"], retry: { max_attempts: 3, delay_ms: 0 } } as unknown as NodeDoc,
    ], { titan: { budget: { usd: 1, per_call_usd: 0.4 } } });
    expect(r.nodes.il).toMatchObject({ status: "failed", attempts: 1 });
    expect(r.nodes.il.error).toContain("budget exceeded");
    expect(h.agentCalls.map((c) => c.nodeId)).toEqual(["first"]);
  });
});

describe("repair: paid paths outside runAgent (item 11)", () => {
  const verifyNode = (runner: string): NodeDoc => ({ id: "v", verify: { runner, objective: "check" }, retry: { max_attempts: 3, delay_ms: 0 } } as unknown as NodeDoc);

  test("unmetered paid verify runners are refused under a budget without calling the runner", async () => {
    for (const runner of ["cursor-cloud", "kane", "testmu", "momentic"]) {
      const saved = (RUNNERS as any)[runner];
      let called = false;
      (RUNNERS as any)[runner] = async () => { called = true; return { status: "pass", artifacts: [], checks: {}, summary: "ok" }; };
      try {
        const h = harness();
        const r = await run(h, [verifyNode(runner)], { titan: { budget: { usd: 5 } } });
        expect(called).toBe(false);
        expect(r.nodes.v).toMatchObject({ status: "failed", attempts: 1 });
        expect(r.nodes.v.error).toContain("allow_unmetered_runners");
        // no budget → runs as before
        const free = harness();
        await run(free, [verifyNode(runner)]);
        expect(called).toBe(true);
      } finally {
        (RUNNERS as any)[runner] = saved;
      }
    }
  });

  test("allow_unmetered_runners: true lets cursor-cloud run and charges its reported externalCostUsd; a child cannot opt its parent in", async () => {
    const saved = RUNNERS["cursor-cloud"];
    (RUNNERS as any)["cursor-cloud"] = async () => ({ status: "fail", artifacts: [], checks: {}, summary: "done", reason: "x", retryable: false, raw: { provider: "cursor", agentId: "bc-1", externalCostUsd: 0.75 } });
    try {
      const h = harness();
      const r = await run(h, [verifyNode("cursor-cloud")], { titan: { budget: { usd: 5, allow_unmetered_runners: true } as any } });
      expect(r.budget).toMatchObject({ spentUsdMicros: 750_000 });
      expect(data(h, "budget.unmetered")[0]).toMatchObject({ runner: "cursor-cloud", externalCostUsd: 0.75, charged: true });

      const store = new RunStore(scratch());
      const child = loaded([verifyNode("cursor-cloud")], { name: "sub", titan: { budget: { allow_unmetered_runners: true } as any } });
      const runWorkflow = async (_n: string, _i: Record<string, unknown>, opts?: RunWorkflowOptions) => executeWorkflow(child, harness({ store }).deps, { parentBudget: opts?.parentBudget });
      const parent = harness({ store, runWorkflow });
      const pr = await run(parent, [{ id: "sub", workflow: { name: "sub" }, retry: { max_attempts: 1 } } as NodeDoc], { titan: { budget: { usd: 5 } } });
      expect(pr.nodes.sub.error).toContain("allow_unmetered_runners");
      expect(pr.budget).toMatchObject({ spentUsdMicros: 0 });
    } finally {
      (RUNNERS as any)["cursor-cloud"] = saved;
    }
    // the scope rule itself
    const wf = new BudgetScope("wf", { usdMicros: 1 }, undefined, { kind: "workflow", allowUnmeteredRunners: true });
    expect(wf.child("node").unmeteredRunnersAllowed()).toBe(true);
    expect(new BudgetScope("wf", {}, undefined, { kind: "workflow" }).child("node", { usdMicros: 5 }).unmeteredRunnersAllowed()).toBe(false);
    chargeUnreserved(wf, { usdMicros: 7, tokens: 0 });
    expect(wf.spent.usdMicros).toBe(7);
  });

  test("the watchdog never pre-empts (inspector + re-dispatch) a budgeted call; the host wires that check into watchdogRunChild", () => {
    expect(watchdogPreemptionAllowed({ spendCap: () => ({ usdMicros: 1 }) })).toBe(false);
    expect(watchdogPreemptionAllowed({})).toBe(true);
    const source = readFileSync(join(import.meta.dir, "..", "titan-harness.ts"), "utf8");
    expect(source).toContain("s.watchdog.enabled && watchdogPreemptionAllowed(opts) ? getWatchdog() : undefined");
    expect(source).toMatch(/opts\.run\.notDispatched = true;/);
  });
});
