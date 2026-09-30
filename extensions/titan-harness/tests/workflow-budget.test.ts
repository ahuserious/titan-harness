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

  test("reservation = the worst case: the largest per_call along the chain (else the default), never shrunk to the remainder or a node total, floored at 1", () => {
    const wf = (budget?: Parameters<typeof perCallFrom>[0]) => new BudgetScope("wf", limitFrom(budget), undefined, { kind: "workflow", perCall: perCallFrom(budget) });
    const node = (parent: BudgetScope, budget?: Parameters<typeof perCallFrom>[0]) => parent.child("node", limitFrom(budget), { perCall: perCallFrom(budget) });
    expect(reservationFor(node(wf()))).toEqual({ usdMicros: DEFAULT_PER_CALL_USD * 1e6, tokens: DEFAULT_PER_CALL_TOKENS });
    // a node can raise the per-call worst case but never lower what an ancestor declared
    expect(reservationFor(node(wf({ per_call_usd: 1, per_call_tokens: 900 }), { per_call_usd: 0.5 }))).toEqual({ usdMicros: 1_000_000, tokens: 900 });
    expect(reservationFor(node(wf({ per_call_usd: 0.2 }), { per_call_usd: 0.5 }))).toEqual({ usdMicros: 500_000, tokens: DEFAULT_PER_CALL_TOKENS });
    // a tiny node TOTAL does not lower the ancestor's per_call: the node reserves $1 and is refused against its own $0.20
    const tiny = node(wf({ usd: 5, per_call_usd: 1 }), { usd: 0.2, tokens: 10 });
    expect(reservationFor(tiny)).toEqual({ usdMicros: 1_000_000, tokens: DEFAULT_PER_CALL_TOKENS });
    expect(reserve(tiny, reservationFor(tiny))).toMatchObject({ ok: false, refusal: { scope: "node", transient: false } });
    // spent budget never shrinks the reservation: $0.40 needed against $0.30 left is refused, not admitted at $0.30
    const n = node(wf({ usd: 1, per_call_usd: 0.4 }));
    n.parent!.spent.usdMicros = 700_000;
    expect(reservationFor(n).usdMicros).toBe(400_000);
    expect(reserve(n, reservationFor(n))).toEqual({ ok: false, refusal: { scope: "wf", dimension: "usd", limit: 1_000_000, remaining: 300_000, needed: 400_000, transient: false } });
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
  test("a node whose reservation exceeds the remaining budget is refused before dispatch: the agent is never called", async () => {
    const h = harness();
    const result = await run(h, [{ id: "big", prompt: "go", budget: { per_call_usd: 2 } } as NodeDoc], { titan: { budget: { usd: 1 } } });
    expect(h.agentCalls).toHaveLength(0);
    expect(result.status).toBe("failed");
    expect(result.nodes.big).toMatchObject({ status: "failed", attempts: 1, error: "budget exceeded: workflow:t remaining $1, needed $2" });
    expect(data(h, "budget.refused")).toEqual([expect.objectContaining({ nodeId: "big", scope: "workflow:t", dimension: "usd", remaining: 1_000_000, needed: 2_000_000, transient: false })]);
    expect(data(h, "budget.reserve")).toHaveLength(0);
    expect(events(h, "agent.start")).toHaveLength(0);
    expect(readLedger(h.runDir)).toHaveLength(0);
    expect(h.notices.some((n) => n.level === "error" && n.text.includes("budget exceeded"))).toBe(true);
    expect(verifyChain(join(h.runDir, "events.jsonl")).ok).toBe(true);
  });

  test("three retries near the cap never overshoot: each attempt reserves, the one that would overshoot is refused", async () => {
    // budget $1.00, per call $0.40; attempts 1 and 2 fail after spending $0.35 each → $0.30 left < $0.40 → attempt 3 refused.
    const fail: Answer = () => ({ ok: false, text: "", error: "flaky", usage: usage(0.35) });
    const h = harness({ answers: { n: [fail, fail, fail] } });
    const result = await run(h, [{ id: "n", prompt: "go", retry: { max_attempts: 3, delay_ms: 0 } } as NodeDoc], { titan: { budget: { usd: 1, per_call_usd: 0.4 } } });
    expect(h.agentCalls).toHaveLength(2);
    expect(result.nodes.n).toMatchObject({ status: "failed", attempts: 3, error: "budget exceeded: workflow:t remaining $0.3, needed $0.4" });
    expect(data(h, "budget.reserve").map((d) => d.usdMicros)).toEqual([400_000, 400_000]);
    expect(data(h, "budget.settle").map((d) => d.chargedUsdMicros)).toEqual([350_000, 350_000]);
    expect(result.budget).toMatchObject({ spentUsdMicros: 700_000, reservedUsdMicros: 0 });
    expect(spentFromEvents(h).usdMicros).toBeLessThanOrEqual(1_000_000);
    expect(data(h, "budget.summary")[0].workflow).toMatchObject({ spentUsdMicros: 700_000 });
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
    const h = harness({ answers: { a: [() => ({ usage: usage(0, 600, 300) })] } });
    const result = await run(h, [
      { id: "a", prompt: "a" } as NodeDoc,
      { id: "b", prompt: "b", depends_on: ["a"] } as NodeDoc,
    ], { titan: { budget: { tokens: 1500, per_call_tokens: 1000 } } });
    expect(h.agentCalls.map((c) => c.nodeId)).toEqual(["a"]);
    expect(result.nodes.b).toMatchObject({ status: "failed", error: "budget exceeded: workflow:t remaining 600 tokens, needed 1000 tokens" });
  });

  test("a node-level budget is enforced on its own scope, beside the workflow budget", async () => {
    // node loop: budget $0.5, per call $0.25; iteration 1 spends $0.3 → $0.2 left < $0.25 → iteration 2 refused.
    const h = harness({ answers: { l: [() => ({ text: "not yet", usage: usage(0.3) }), () => ({ text: "DONE" })] } });
    const result = await run(h, [
      { id: "l", loop: { prompt: "work", until: "DONE", max_iterations: 3 }, budget: { usd: 0.5, per_call_usd: 0.25 } } as NodeDoc,
      { id: "other", prompt: "unaffected", depends_on: ["l"], trigger_rule: "all_done" } as NodeDoc,
    ]);
    expect(h.agentCalls.map((c) => c.nodeId)).toEqual(["l", "other"]);
    expect(result.nodes.l).toMatchObject({ status: "failed", error: "budget exceeded: workflow:t/node:l remaining $0.2, needed $0.25" });
    expect(result.nodes.other.status).toBe("success");
    // only a node budget applied: the workflow scope has no limit, yet it still records the spend
    expect(data(h, "budget.settle").map((d) => d.nodeId)).toEqual(["l"]);
    expect(result.budget).toMatchObject({ spentUsdMicros: 300_000 });
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

    // a fan-out whose calls cannot fit even once everything settles is refused, not dispatched (and not retried)
    const tight = harness();
    const refused = await run(tight, [{ id: "pick", best_of: { n: 3, prompt: "solve" } } as NodeDoc], { titan: { budget: { usd: 0.3, per_call_usd: 0.4 } } });
    expect(tight.agentCalls).toHaveLength(0);
    expect(refused.nodes.pick).toMatchObject({ attempts: 1, error: "budget exceeded: workflow:t remaining $0.3, needed $0.4" });
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
      const ch = harness({ store, answers: { c1: [() => ({ usage: usage(0.4) })] } });
      childRuns.push(ch);
      return executeWorkflow(child, ch.deps, { parentBudget: opts?.parentBudget, signal: opts?.signal });
    };
    const h = harness({ store, runWorkflow, answers: { first: [() => ({ usage: usage(0.3) })] } });
    const result = await run(h, [
      { id: "first", prompt: "spend some" } as NodeDoc,
      { id: "sub", workflow: { name: "sub" }, depends_on: ["first"] } as NodeDoc,
    ], { titan: { budget: { usd: 1, per_call_usd: 0.5 } } });
    // parent $1: first spends $0.30; child c1 reserves $0.50 (fits $0.70), spends $0.40; c2 needs $0.50 > $0.30 left in the PARENT.
    const ch = childRuns[0];
    expect(ch.agentCalls.map((c) => c.nodeId)).toEqual(["c1"]);
    expect(data(ch, "budget.refused")).toEqual([expect.objectContaining({ nodeId: "c2", scope: "workflow:t", remaining: 300_000, needed: 500_000 })]);
    expect(result.nodes.sub).toMatchObject({ status: "failed", attempts: 1, error: expect.stringContaining("budget exceeded: workflow:t remaining $0.3, needed $0.5") });
    // item 9: a child that failed on a budget refusal is not re-run by the parent
    expect(childRuns).toHaveLength(1);
    expect(result.budget).toMatchObject({ spentUsdMicros: 700_000, reservedUsdMicros: 0 });
    expect(result.budget!.spentUsdMicros as number).toBeLessThanOrEqual(1_000_000);
  });

  test("a node budget on the workflow: node caps its children too (the child's default worst case is refused, never shrunk to fit)", async () => {
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
    expect(calls).toEqual([]);
    expect(result.nodes.sub.error).toContain("budget exceeded: workflow:t/node:sub remaining $0.01, needed $5"); // the child declares no per_call: the default applies
    expect(result.budget).toMatchObject({ spentUsdMicros: 0, reservedUsdMicros: 0 });
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

import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { overSpendCap, runChild, watchdogPreemptionAllowed } from "../modules/child-runner.ts";
import { newRun } from "../modules/runtime.ts";
import { createAgentRunner, usageProvenanceOf } from "../modules/workflow-runtime.ts";
import { RUNNERS } from "../modules/workflow/runners/index.ts";

const settleOf = (h: Harness, nodeId?: string) => data(h, "budget.settle").filter((d) => !nodeId || d.nodeId === nodeId);
/** A stand-in `pi --mode json` child: one assistant message_end costing `usd` every 30 ms, 50 times. */
function fakePi(dir: string, usd: number): string {
  const script = join(dir, "fake-pi.ts");
  writeFileSync(script, `
    const out = (o) => process.stdout.write(JSON.stringify(o) + "\\n");
    // stands in for the per-turn guard's load-time "armed" record, so this child exercises the parent-side BACKSTOP only
    if (process.env.TITAN_BUDGET_STATE_PATH) require("node:fs").writeFileSync(process.env.TITAN_BUDGET_STATE_PATH, JSON.stringify({ state: "armed" }));
    out({ type: "session", id: "s1" });
    let i = 0;
    const tick = () => { i++; out({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "m" + i }], usage: { input: 10, output: 10, cost: { total: ${usd} } } } }); if (i < 50) setTimeout(tick, 30); };
    tick();
  `);
  return script;
}

describe("repair: zero budgets and zero reservations are fail-closed (item 3, P1, P2)", () => {
  test("P1: a node with budget usd 0 is never dispatched (validator rejects it; the executor refuses it anyway)", async () => {
    const h = harness({ answers: { a: [() => ({ usage: usage(0.5) })] } });
    const r = await run(h, [{ id: "a", prompt: "x", budget: { usd: 0 } } as NodeDoc]);
    expect(h.agentCalls).toHaveLength(0);
    expect(r.nodes.a).toMatchObject({ status: "failed", attempts: 1, error: "budget exceeded: workflow:t/node:a remaining $0, needed $5" });
    expect(r.budgetRefused).toMatchObject({ scope: "workflow:t/node:a", dimension: "usd", remaining: 0, needed: 5_000_000 });
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
    const tr = await run(t, [{ id: "a", prompt: "x" } as NodeDoc], { titan: { budget: { tokens: 1000, per_call_tokens: 500 } } });
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
    // at the cap there is no room for another message (>=); one more message of the largest size seen must also fit
    expect(overSpendCap({ costUsd: 0.1, tokensIn: 0, tokensOut: 0 }, { usdMicros: 100_000 })).toBe(true);
    expect(overSpendCap({ costUsd: 0.099999, tokensIn: 0, tokensOut: 0 }, { usdMicros: 100_000 })).toBe(false);
    expect(overSpendCap({ costUsd: 0.06, tokensIn: 0, tokensOut: 0 }, { usdMicros: 100_000 }, { usdMicros: 40_000 })).toBe(true);
    expect(overSpendCap({ costUsd: 0.05, tokensIn: 0, tokensOut: 0 }, { usdMicros: 100_000 }, { usdMicros: 40_000 })).toBe(false);
    expect(overSpendCap({ costUsd: 0, tokensIn: 60, tokensOut: 30 }, { tokens: 100 }, { tokens: 10 })).toBe(true);
  });

  test("P6: a real runChild (real guard) never exceeds the $1 cap: $0.40 turns, the third is clamped to what is left, the fourth is refused", async () => {
    const dir = scratch();
    const { script, ledger } = guardedPi(dir, PRICED, Array.from({ length: 50 }, () => 4000));
    const r = newRun("BUILDER", "stub/model");
    await withFakePi(script, () => runChild({ run: r, prompt: "x", tools: "none", thinking: "off", sessionDir: dir, cwd: dir, timeoutMs: 20_000, spendCap: () => ({ usdMicros: 1_000_000 }) }));
    const sent = sentOf(ledger);
    expect(sent).toHaveLength(3);
    expect(sent[2].maxTokens).toBeLessThan(4000);
    expect(sum(sent)).toBeLessThanOrEqual(1);
    expect(r.costUsd).toBeLessThanOrEqual(1);
    expect(r.budgetRefusal).toMatchObject({ dimension: "usd" });
    expect(usageProvenanceOf(r)).toBe("partial");
  });

  test("P6 backstop: a child whose guard is armed but whose spend still passes the cap is killed by the parent at the first message over it", async () => {
    const dir = scratch();
    const script = fakePi(dir, 0.4); // writes the armed record but bypasses the per-turn bound
    const r = newRun("BUILDER", "stub/model");
    await withFakePi(script, () => runChild({ run: r, prompt: "x", tools: "none", thinking: "off", sessionDir: dir, cwd: dir, timeoutMs: 20_000, spendCap: () => ({ usdMicros: 1_000_000 }) }));
    expect(r.budgetHalted).toBe(true);
    expect(r.stopReason).toBe("budget");
    expect(Math.round(r.costUsd * 100)).toBe(120); // killed at once, not after 50 messages; the overshoot is charged in full at settle
  });

  test("P6: through the executor, the REAL agent runner + runChild + guard under usd 1 / per_call 1 never spends past $1", async () => {
    const dir = scratch();
    const { script, ledger } = guardedPi(dir, PRICED, Array.from({ length: 50 }, () => 4000));
    await withFakePi(script, async () => {
      const h = harness();
      h.deps.agent = createAgentRunner({ sessionsDir: join(h.runDir, "sessions"), cwd: h.deps.cwd, runChild }) as any;
      const r = await run(h, [{ id: "a", prompt: "x", retry: { max_attempts: 3, delay_ms: 0 } } as NodeDoc, { id: "b", prompt: "y", depends_on: ["a"], trigger_rule: "all_done" } as NodeDoc], { titan: { budget: { usd: 1, per_call_usd: 1 } } });
      expect(sum(sentOf(ledger))).toBeLessThanOrEqual(1);
      // a: reserves $1; its guard refuses the turn that no longer fits → settles max(observed, $1) = $1 (partial); no retries; b is refused
      expect(settleOf(h)).toHaveLength(1);
      expect(settleOf(h)[0]).toMatchObject({ reservedUsdMicros: 1_000_000, chargedUsdMicros: 1_000_000, provenance: "partial" });
      expect(r.nodes.a).toMatchObject({ status: "failed", attempts: 1 });
      expect(r.budget).toMatchObject({ spentUsdMicros: 1_000_000, reservedUsdMicros: 0, overrunUsdMicros: 0 });
      expect(r.nodes.b.error).toBe("budget exceeded: workflow:t remaining $0, needed $1");
    });
  });

  test("an overrun is still charged in full and flagged", async () => {
    const h = harness({ answers: { a: [() => ({ usage: usage(4) })] } });
    const r = await run(h, [{ id: "a", prompt: "x" } as NodeDoc], { titan: { budget: { usd: 1, per_call_usd: 0.01 } } });
    expect(r.budget).toMatchObject({ spentUsdMicros: 4_000_000, overrunUsdMicros: 3_990_000 });
    expect(data(h, "budget.overrun")).toHaveLength(1);
  });
});

describe("repair: reservations follow the remaining budget and the scope chain (items 5, 6, 10, P5, P7)", () => {
  test("P7 / item 5: a node usd budget with a per_call allows retries while the worst case still fits", async () => {
    const h = harness({ answers: { a: [() => ({ ok: false, text: "", error: "flaky", usage: usage(0.05) }), () => ({ usage: usage(0.05) })] } });
    const r = await run(h, [{ id: "a", prompt: "x", budget: { usd: 1, per_call_usd: 0.4 }, retry: { max_attempts: 2, delay_ms: 0 } } as NodeDoc]);
    expect(h.agentCalls).toHaveLength(2);
    expect(r.nodes.a.status).toBe("success");
    expect(data(h, "budget.reserve").map((d) => d.usdMicros)).toEqual([400_000, 400_000]);
    // without a per_call the $5 default worst case never fits a $1 node: refused before dispatch (the validator warns)
    const d = harness();
    const dr = await run(d, [{ id: "a", prompt: "x", budget: { usd: 1 } } as NodeDoc]);
    expect(d.agentCalls).toHaveLength(0);
    expect(dr.nodes.a.error).toBe("budget exceeded: workflow:t/node:a remaining $1, needed $5");
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

  test("item 10: a $25 budget with no per_call (the shipped workflows) refuses the call whose $5 worst case no longer fits", async () => {
    const answers = Array.from({ length: 6 }, () => () => ({ usage: usage(4.5) }));
    const h = harness({ answers: { l: answers as Answer[] } });
    const r = await run(h, [{ id: "l", loop: { prompt: "work", until: "NEVER", max_iterations: 6 } } as NodeDoc], { titan: { budget: { usd: 25 } } });
    // 5 × $4.50 = $22.50; the 6th iteration needs its full $5 worst case against $2.50 left → refused, never admitted at $2.50
    expect(h.agentCalls).toHaveLength(5);
    expect(data(h, "budget.reserve").map((d) => d.usdMicros)).toEqual(Array(5).fill(5_000_000));
    expect(r.nodes.l.error).toBe("budget exceeded: workflow:t remaining $2.5, needed $5");
    expect(r.budget).toMatchObject({ spentUsdMicros: 22_500_000, reservedUsdMicros: 0 });
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
    expect(r.nodes.p).toMatchObject({ status: "failed", attempts: 1, error: "budget exceeded: workflow:t remaining $0, needed $0.4" });
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

// ═══ Repair round 2 (gate N3-09-wf-r1-astra): blockers 1–4 ═══════════════════════════════════

describe("repair 2: a thrown child keeps its reported usage (blocker 2)", () => {
  test("the REAL createAgentRunner: runChild records $0.40 then rejects → settled at max($0.40, reservation) as partial, not the reservation alone", async () => {
    const h = harness();
    h.deps.agent = createAgentRunner({
      sessionsDir: join(h.runDir, "sessions"), cwd: h.deps.cwd,
      runChild: (async (o: any) => { o.run.usageSeen = true; o.run.costUsd = 0.4; o.run.tokensIn = 300; o.run.tokensOut = 100; throw new Error("stream broke after a turn"); }) as any,
    }) as any;
    const r = await run(h, [{ id: "a", prompt: "x", retry: { max_attempts: 1 } } as NodeDoc], { titan: { budget: { usd: 5, per_call_usd: 0.01 } } });
    expect(settleOf(h)[0]).toMatchObject({ reservedUsdMicros: 10_000, chargedUsdMicros: 400_000, chargedTokens: 400, provenance: "partial", basis: { usd: "partial", tokens: "reported" } });
    expect(r.budget).toMatchObject({ spentUsdMicros: 400_000, reservedUsdMicros: 0 });
    const run0 = newRun("BUILDER", "m");
    expect(usageProvenanceOf({ ...run0, usageSeen: true, status: "failed", exitCode: 0 }, true)).toBe("partial");
    expect(usageProvenanceOf({ ...run0, status: "failed" }, true)).toBe("none");
  });
});

describe("repair 2: settlement is exception-safe and complete (blocker 3)", () => {
  const within = <T>(p: Promise<T>, ms = 4000): Promise<T> => Promise.race([p, new Promise<T>((_, reject) => setTimeout(() => reject(new Error(`hung for ${ms} ms`)), ms))]);

  test("a store failure before dispatch releases the reservation at $0 and never hangs the final drain", async () => {
    const h = harness();
    const upsert = h.store.upsertAgent.bind(h.store);
    h.store.upsertAgent = ((dir: string, patch: any) => { if (patch.state === "dispatched-working") throw new Error("disk full"); return upsert(dir, patch); }) as any;
    const r = await within(run(h, [{ id: "a", prompt: "x", retry: { max_attempts: 1 } } as NodeDoc], { titan: { budget: { usd: 5, per_call_usd: 1 } } }));
    expect(h.agentCalls).toHaveLength(0);
    expect(r.nodes.a).toMatchObject({ status: "failed", error: "disk full" });
    expect(r.budget).toMatchObject({ spentUsdMicros: 0, reservedUsdMicros: 0 });
    expect(settleOf(h)[0]).toMatchObject({ chargedUsdMicros: 0, provenance: "not-dispatched" });
  });

  test("agent.start / budget.reserve record failures after the reservation still settle it", async () => {
    const h = harness();
    const append = h.store.appendEvent.bind(h.store);
    h.store.appendEvent = ((dir: string, type: string, d: Record<string, unknown>, agentId?: string) => { if (type === "budget.reserve") throw new Error("disk full"); return append(dir, type, d, agentId); }) as any;
    const r = await within(run(h, [{ id: "a", prompt: "x", retry: { max_attempts: 1 } } as NodeDoc], { titan: { budget: { usd: 5, per_call_usd: 1 } } }));
    expect(h.agentCalls).toHaveLength(0);
    expect(r.budget).toMatchObject({ spentUsdMicros: 0, reservedUsdMicros: 0 });
  });

  test("error-path bookkeeping failures (agent record + agent.end) never skip the settlement", async () => {
    const h = harness();
    h.deps.agent = async () => { throw new Error("agent boom"); };
    const upsert = h.store.upsertAgent.bind(h.store);
    h.store.upsertAgent = ((dir: string, patch: any) => { if (patch.state === "failed") throw new Error("disk full"); return upsert(dir, patch); }) as any;
    const append = h.store.appendEvent.bind(h.store);
    h.store.appendEvent = ((dir: string, type: string, d: Record<string, unknown>, agentId?: string) => { if (type === "agent.end") throw new Error("disk full"); return append(dir, type, d, agentId); }) as any;
    const r = await within(run(h, [{ id: "a", prompt: "x", retry: { max_attempts: 1 } } as NodeDoc], { titan: { budget: { usd: 5, per_call_usd: 1 } } }));
    expect(r.nodes.a.error).toBe("agent boom");
    expect(r.budget).toMatchObject({ spentUsdMicros: 1_000_000, reservedUsdMicros: 0 });
    expect(h.notices.some((n) => n.text.includes("agent.end record failed: disk full"))).toBe(true);
  });

  test("success-path bookkeeping failures after the call keep the settlement at the reported usage", async () => {
    const h = harness({ answers: { a: [() => ({ usage: usage(0.2) })] } });
    const upsert = h.store.upsertAgent.bind(h.store);
    h.store.upsertAgent = ((dir: string, patch: any) => { if (patch.state === "done-unverified") throw new Error("disk full"); return upsert(dir, patch); }) as any;
    const r = await within(run(h, [{ id: "a", prompt: "x", retry: { max_attempts: 1 } } as NodeDoc], { titan: { budget: { usd: 5, per_call_usd: 1 } } }));
    expect(r.budget).toMatchObject({ spentUsdMicros: 200_000, reservedUsdMicros: 0 });
    expect(settleOf(h)).toHaveLength(1);
  });

  test("nested cancellation: the child run gets the attempt's signal, stops, and settles BEFORE the parent's budget.summary", async () => {
    const store = new RunStore(scratch());
    const controller = new AbortController();
    let childAgentAborted = false;
    let childFinished = false;
    const child = loaded([{ id: "c1", prompt: "long" } as NodeDoc], { name: "sub" });
    const runWorkflow = async (_n: string, _i: Record<string, unknown>, opts?: RunWorkflowOptions) => {
      const ch = harness({ store }); // no deps.signal: only the propagated attempt signal can stop it
      ch.deps.agent = (req) => new Promise((resolve) => req.signal!.addEventListener("abort", () => { childAgentAborted = true; setTimeout(() => resolve({ ok: false, text: "", error: "killed", usage: usage(0.3), toolCalls: 0 }), 30); }));
      const result = await executeWorkflow(child, ch.deps, { parentBudget: opts?.parentBudget, signal: opts?.signal, budgetAbortGraceMs: 500 });
      childFinished = true;
      return result;
    };
    const h = harness({ store, runWorkflow, signal: controller.signal });
    setTimeout(() => controller.abort(), 20);
    const r = await within(run(h, [{ id: "sub", workflow: { name: "sub" } } as NodeDoc], { titan: { budget: { usd: 5, per_call_usd: 1 } } }));
    expect(r.status).toBe("cancelled");
    expect(childAgentAborted).toBe(true);
    expect(childFinished).toBe(true);
    // the child's interrupted call settled max($0.30, $1) = $1 into the PARENT scope before the parent summarised
    expect(r.budget).toMatchObject({ spentUsdMicros: 1_000_000, reservedUsdMicros: 0 });
    expect(data(h, "budget.summary")[0].workflow).toMatchObject({ spentUsdMicros: 1_000_000, reservedUsdMicros: 0 });
  });

  test("a handler that swallows a hard refusal and returns success still fails the node, non-retryable", async () => {
    const saved = RUNNERS.verifier;
    let swallowed = 0;
    (RUNNERS as any).verifier = async (_spec: unknown, ctx: any) => {
      try {
        await ctx.agent("check", { role: "verifier" });
      } catch {
        swallowed++;
      }
      return { status: "pass", artifacts: [], checks: {}, summary: "swallowed the refusal" };
    };
    try {
      const h = harness({ answers: { first: [() => ({ usage: usage(0.8) })] } });
      const r = await run(h, [
        { id: "first", prompt: "spend" } as NodeDoc,
        { id: "v", verify: { runner: "verifier", input: "x" }, depends_on: ["first"], retry: { max_attempts: 3, delay_ms: 0 } } as unknown as NodeDoc,
      ], { titan: { budget: { usd: 1, per_call_usd: 0.5 } } });
      expect(swallowed).toBe(1);
      expect(r.nodes.v).toMatchObject({ status: "failed", attempts: 1, error: "budget exceeded: workflow:t remaining $0.2, needed $0.5" });
      expect(r.budgetRefused).toMatchObject({ scope: "workflow:t", needed: 500_000 });
    } finally {
      (RUNNERS as any).verifier = saved;
    }
  });

  test("a mimeograph whose judge no longer fits after its cells spent the budget fails once, non-retryable", async () => {
    const h = harness();
    let n = 0;
    h.deps.agent = async (req) => { h.agentCalls.push(req); n++; return { ok: true, text: `cell ${n}`, usage: usage(n === 1 ? 0.9 : 0.1), toolCalls: 0 }; };
    const r = await run(h, [{ id: "m", prompt: "x", mimeograph: "implementer,contrarian", retry: { max_attempts: 3, delay_ms: 0 } } as NodeDoc], { titan: { budget: { usd: 1, per_call_usd: 0.5 } } });
    expect(h.agentCalls).toHaveLength(2);
    expect(r.nodes.m).toMatchObject({ status: "failed", attempts: 1, error: "budget exceeded: workflow:t remaining $0, needed $0.5" });
    expect(r.budget).toMatchObject({ spentUsdMicros: 1_000_000, reservedUsdMicros: 0 });
  });
});

describe("repair 2: every agent dispatch path reserves and settles (blocker 4)", () => {
  test("every AI node path under a budget: one budget.reserve and one budget.settle per deps.agent call, nothing left reserved", async () => {
    const h = harness();
    writeFileSync(join(h.deps.cwd, "vision.md"), "# Vision\n\n## Goals\nShip the dashboard.\n");
    const commandsDir = scratch();
    writeFileSync(join(commandsDir, "do-it.md"), "Do the command thing.");
    const reasks = new Map<string, number>();
    h.deps.agent = async (req) => {
      h.agentCalls.push(req);
      const base = { ok: true, sessionRef: `s-${h.agentCalls.length}`, usage: usage(0.01), toolCalls: 0, model: req.model };
      const props = (req.outputSchema as any)?.properties ?? {};
      if (props.winner) return { ...base, text: "```json\n" + JSON.stringify({ winner: 1, summary: "one" }) + "\n```" };
      if (props.alignment) return { ...base, text: "```json\n" + JSON.stringify({ ok: true, alignment: [{ claim: "dashboard", source: "vision.md", section: "goals", status: "aligned" }], executionClaims: [], summary: "aligned" }) + "\n```" };
      if (props.verdict || req.nodeId === "audit") return { ...base, text: "```json\n" + JSON.stringify({ verdict: "PASS", summary: "ok" }) + "\n```" };
      if (props.answer) {
        const n = (reasks.get(req.nodeId) ?? 0) + 1;
        reasks.set(req.nodeId, n);
        return { ...base, text: n === 1 ? "not json" : "```json\n{\"answer\": 42}\n```" };
      }
      return { ...base, text: `${req.nodeId} DONE` };
    };
    let asked = 0;
    h.deps.approval = async () => (++asked === 1 ? { approved: false, response: "redo" } : { approved: true });
    h.deps.bash = async () => ({ code: 1, stdout: "still red\n", stderr: "" });
    h.deps.familyMax = () => "stub/max";
    const nodes = [
      { id: "prompt", prompt: "p" },
      { id: "structured", prompt: "s", output_format: { type: "object", properties: { answer: { type: "number" } }, required: ["answer"] } },
      { id: "cmd", command: "do-it" },
      { id: "loop", loop: { prompt: "l", until: "NEVER", until_bash: "false", max_iterations: 3 } },
      { id: "gate", approval: { message: "ok?", on_reject: { prompt: "rework $REJECTION_REASON", max_attempts: 1 } } },
      { id: "bo", best_of: { n: 2, prompt: "b" } },
      { id: "mimeo", prompt: "m", mimeograph: "implementer,contrarian" },
      { id: "il", interleave: { segments: 2, prompt: "seg $SEGMENT" } },
      { id: "ver", verify: { runner: "verifier", input: "Build the dashboard per vision.md#goals." } },
      { id: "audit", prompt: "audit", role: "auditor", depends_on: ["prompt"], output_format: { $ref: "titan://schemas/audit-verdict" } },
    ].map((n) => ({ retry: { max_attempts: 1 }, ...n })) as unknown as NodeDoc[];
    const wf = loaded(nodes, { titan: { budget: { usd: 1000, per_call_usd: 1 } } });
    (wf as any).commands = { "do-it": join(commandsDir, "do-it.md") };
    const r = await executeWorkflow(wf, h.deps, {});
    const calls = h.agentCalls.length;
    const byNode = (list: Array<{ nodeId: string }>) => list.reduce((acc, c) => ({ ...acc, [c.nodeId]: (acc[c.nodeId] ?? 0) + 1 }), {} as Record<string, number>);
    // every path dispatched at least once, and the multi-call paths dispatched all their calls
    expect(byNode(h.agentCalls)).toEqual({ prompt: 1, structured: 2, cmd: 1, loop: 3, gate: 1, bo: 3, mimeo: 3, il: 3, ver: 1, audit: 1 });
    expect(h.agentCalls.filter((c) => c.nodeId === "loop").map((c) => c.model)).toContain("stub/max"); // the familyMax ladder step
    expect(data(h, "budget.reserve")).toHaveLength(calls);
    expect(settleOf(h)).toHaveLength(calls);
    expect(byNode(data(h, "budget.reserve") as any)).toEqual(byNode(h.agentCalls));
    expect(h.agentCalls.every((c) => typeof c.spendCap === "function")).toBe(true);
    expect(r.budget).toMatchObject({ spentUsdMicros: calls * 10_000, reservedUsdMicros: 0 });
  });

  test("source audit: deps.agent has exactly one call site (executor runAgent); no workflow module spawns runChild or fetches a model directly", () => {
    const root = join(import.meta.dir, "..", "modules");
    const files: string[] = [];
    const walk = (dir: string) => { for (const e of readdirSync(dir, { withFileTypes: true })) { const p = join(dir, e.name); if (e.isDirectory()) walk(p); else if (p.endsWith(".ts")) files.push(p); } };
    walk(root);
    const hits = (re: RegExp) => files.flatMap((f) => readFileSync(f, "utf8").split("\n").map((line, i) => [f.slice(root.length + 1), i + 1, line] as const).filter(([, , line]) => re.test(line) && !/^\s*(\*|\/\/)/.test(line)));
    const agentCalls = hits(/deps\.agent\(/);
    expect(agentCalls.map(([f]) => f)).toEqual(["workflow/executor.ts"]);
    expect(hits(/\.runAgent\(/).every(([f]) => f.startsWith("workflow/"))).toBe(true);
    // workflow modules reach models only through ctx.runAgent / callAgent: no runChild, no createAgentRunner
    expect(hits(/\brunChild\(|createAgentRunner\(/).filter(([f]) => f.startsWith("workflow/"))).toEqual([]);
    // the runner-side agent seam of verify runners is callAgent (→ ctx.runAgent)
    expect(readFileSync(join(root, "workflow", "nodes", "verify.ts"), "utf8")).toMatch(/agent: async \(prompt[^)]*\) => \{\s*const call = await callAgent\(ctx,/);
    // the one runtime deps.agent is createAgentRunner, which forwards spendCap to runChild
    expect(readFileSync(join(root, "workflow-runtime.ts"), "utf8")).toContain("...(req.spendCap ? { spendCap: req.spendCap } : {})");
  });
});

describe("repair 2: worst-case admission across the chain (blocker 1)", () => {
  test("a child node with a tiny TOTAL cannot undercut the parent's per_call: it reserves $0.50 and is refused, never a micro-dollar", async () => {
    const store = new RunStore(scratch());
    const child = loaded([{ id: "c1", prompt: "one", budget: { usd: 0.000001 } } as NodeDoc], { name: "sub" });
    const childRuns: Harness[] = [];
    const runWorkflow = async (_n: string, _i: Record<string, unknown>, opts?: RunWorkflowOptions) => {
      const ch = harness({ store });
      childRuns.push(ch);
      return executeWorkflow(child, ch.deps, { parentBudget: opts?.parentBudget });
    };
    const h = harness({ store, runWorkflow });
    const r = await run(h, [{ id: "sub", workflow: { name: "sub" }, retry: { max_attempts: 1 } } as NodeDoc], { titan: { budget: { usd: 3, per_call_usd: 0.5 } } });
    expect(childRuns[0].agentCalls).toHaveLength(0);
    expect(data(childRuns[0], "budget.refused")[0]).toMatchObject({ nodeId: "c1", scope: "workflow:t/node:sub/workflow:sub/node:c1", remaining: 1, needed: 500_000, transient: false });
    expect(r.nodes.sub.error).toContain("needed $0.5");
    expect(r.budget).toMatchObject({ spentUsdMicros: 0, reservedUsdMicros: 0 });
  });

  test("a fan-out of children shares the parent's remainder: concurrent worst cases never exceed it", async () => {
    const store = new RunStore(scratch());
    const child = loaded([{ id: "c1", prompt: "one" } as NodeDoc], { name: "sub" });
    let inFlight = 0;
    let peak = 0;
    const runWorkflow = async (_n: string, _i: Record<string, unknown>, opts?: RunWorkflowOptions) => {
      const ch = harness({ store });
      ch.deps.agent = async (req) => { inFlight++; peak = Math.max(peak, inFlight); await new Promise((res) => setTimeout(res, 10)); inFlight--; return { ok: true, text: "c", usage: usage(0.1), toolCalls: 0, model: req.model }; };
      return executeWorkflow(child, ch.deps, { parentBudget: opts?.parentBudget, signal: opts?.signal });
    };
    const h = harness({ store, runWorkflow });
    const r = await run(h, [
      { id: "list", bash: "echo" } as NodeDoc,
      { id: "fan", workflow: { name: "sub", fan_out: { source: "$inputs.items", as: "item", join: "all_done" } }, retry: { max_attempts: 1 } } as unknown as NodeDoc,
    ], { titan: { budget: { usd: 1, per_call_usd: 0.4 } } }, { inputs: { items: [1, 2, 3, 4, 5] } });
    // $1 / $0.40 worst case → at most 2 children in flight at once; the rest wait for settlements, all five eventually run
    expect(peak).toBeLessThanOrEqual(2);
    expect(r.budget).toMatchObject({ spentUsdMicros: 500_000, reservedUsdMicros: 0 });
  });

  test("validator: a per_call above the total it sits beside (or a node total below the chain's per_call) is an error", () => {
    const doc = (titan: Record<string, unknown>, node: Record<string, unknown> = {}) => validateWorkflow({ apiVersion: "titan.harness/v1", name: "t", nodes: [{ id: "a", prompt: "x", ...node }], titan: { budget: titan } }, {});
    expect(doc({ usd: 1, per_call_usd: 2 }).errors.some((e) => e.message.includes("exceeds titan.budget.usd"))).toBe(true);
    expect(doc({ tokens: 100, per_call_tokens: 200 }).errors.some((e) => e.message.includes("exceeds titan.budget.tokens"))).toBe(true);
    expect(doc({ usd: 5, per_call_usd: 1 }, { budget: { usd: 0.5 } }).errors.some((e) => e.message.includes("could never dispatch"))).toBe(true);
    expect(doc({ usd: 5, per_call_usd: 1 }, { budget: { usd: 2, per_call_usd: 0.5 } }).ok).toBe(true);
    const warned = doc({ usd: 50 }, { budget: { usd: 1 } });
    expect(warned.ok).toBe(true);
    expect(warned.warnings.some((w) => w.rule === "budget" && w.message.includes("budget.per_call_usd"))).toBe(true);
    expect(doc({ tokens: 1000 }).warnings.some((w) => w.message.includes("per_call_tokens"))).toBe(true);
  });
});

// ═══ Repair round 3 (gate N3-09 r2 Astra 1, Fable N2/N3): a numeric bound before every paid model turn ═══

import { existsSync } from "node:fs";
import { BUDGET_GUARD_EXTENSION } from "../modules/child-runner.ts";
import { BUDGET_REFUSED_EXIT, MIN_OUTPUT_TOKENS, PROVIDER_OVERHEAD_TOKENS, TurnBudgetGuard, planTurn, turnBudgetEnv, turnBudgetFromEnv, worstRates } from "../modules/turn-budget.ts";
import { registerBudgetGuard } from "../../titan-budget-guard.ts";
import { effectivePerCall } from "../modules/workflow/budget.ts";

/** $100/M output (100 µ$/token), $1/M input: a 12,000-token answer costs $1.20. */
const PRICED = { api: "anthropic-messages", provider: "stub", id: "priced", maxTokens: 32_000, cost: { input: 1, output: 100, cacheRead: 0.1, cacheWrite: 1.25 } };

/**
 * A stand-in `pi --mode json -p` child that loads the REAL guard from `--extension` (what runChild passes to a
 * budgeted child) and drives an ADVERSARIAL provider: every turn it bills the full serialised payload as input
 * and min(wanted, the payload's max_tokens) as output. Each request actually "sent" is appended to `ledger`.
 */
function guardedPi(dir: string, model: Record<string, unknown>, wants: number[], promptChars = 200): { script: string; ledger: string } {
  const script = join(dir, "guarded-pi.ts");
  const ledger = join(dir, "sent.jsonl");
  writeFileSync(script, `
    import { appendFileSync } from "node:fs";
    const args = process.argv.slice(2);
    const handlers: Record<string, Function[]> = {};
    const pi = { on: (e: string, h: Function) => (handlers[e] ??= []).push(h) };
    const at = args.indexOf("--extension");
    if (at >= 0) (await import(args[at + 1])).default(pi);
    const model = ${JSON.stringify(model)};
    const wants = ${JSON.stringify(wants)};
    const out = (o: unknown) => process.stdout.write(JSON.stringify(o) + "\\n");
    out({ type: "session", id: "s1" });
    let history = "x".repeat(${promptChars});
    for (const want of wants) {
      let payload: any = { model: model.id, max_tokens: model.maxTokens, stream: true, messages: [{ role: "user", content: history }] };
      for (const h of handlers.before_provider_request ?? []) { const r = await h({ type: "before_provider_request", payload }, { model }); if (r !== undefined) payload = r; }
      const input = Buffer.byteLength(JSON.stringify(payload));
      const output = Math.min(want, payload.max_tokens ?? Infinity);
      const cost = (input * model.cost.input + output * model.cost.output) / 1e6;
      appendFileSync(${JSON.stringify(ledger)}, JSON.stringify({ maxTokens: payload.max_tokens, input, output, cost }) + "\\n");
      const message = { role: "assistant", content: [{ type: "text", text: "m" }], usage: { input, output, cacheRead: 0, cacheWrite: 0, cost: { total: cost } }, stopReason: "stop" };
      for (const h of handlers.message_end ?? []) await h({ type: "message_end", message });
      out({ type: "message_end", message });
      history += "y".repeat(Math.min(output, 2000));
    }
  `);
  return { script, ledger };
}
const sentOf = (ledger: string): Array<{ maxTokens: number; input: number; output: number; cost: number }> => (existsSync(ledger) ? readFileSync(ledger, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)) : []);
const sum = (rows: Array<{ cost: number }>) => rows.reduce((a, r) => a + r.cost, 0);

async function withFakePi<T>(script: string, fn: () => Promise<T>): Promise<T> {
  const saved = process.argv[1];
  process.argv[1] = script;
  try {
    return await fn();
  } finally {
    process.argv[1] = saved;
  }
}

describe("repair 3: planTurn bounds each turn before it is sent", () => {
  test("a first turn whose max output would cost $1.20 under a $1 cap is CLAMPED so input bound × input rate + cap × output rate ≤ $1", () => {
    const payload = { model: "priced", max_tokens: 12_000, messages: [{ role: "user", content: "hello" }] };
    const plan = planTurn(PRICED, payload, { usdMicros: 1_000_000 });
    if (!plan.ok) throw new Error(plan.reason);
    const inputBound = Buffer.byteLength(JSON.stringify(payload)) + PROVIDER_OVERHEAD_TOKENS;
    expect(plan.inputBound).toBe(inputBound);
    // highest input rate = max(input, cacheRead, cacheWrite) = 1.25 µ$/token (no 1h TTL requested)
    expect(plan.maxOutputTokens).toBe(Math.floor((1_000_000 - Math.ceil(inputBound * 1.25)) / 100));
    expect((plan.payload as any).max_tokens).toBe(plan.maxOutputTokens);
    expect(plan.worst.usdMicros).toBeLessThanOrEqual(1_000_000);
    expect(payload.max_tokens).toBe(12_000); // the caller's payload is not mutated
    // a cap that already fits is never raised
    const small = planTurn(PRICED, { ...payload, max_tokens: 100 }, { usdMicros: 1_000_000 });
    expect(small.ok && (small.payload as any).max_tokens).toBe(100);
  });

  test("refusals: remainder below input + minimum output; unknown pricing under USD; unknown API; no model; tokens", () => {
    const payload = { max_tokens: 1000, messages: [{ role: "user", content: "x".repeat(5000) }] };
    const low = planTurn(PRICED, payload, { usdMicros: 7000 });
    expect(low).toMatchObject({ ok: false, dimension: "usd", remaining: 7000 });
    expect(planTurn({ ...PRICED, cost: { input: 0, output: 0 } }, payload, { usdMicros: 1_000_000 })).toMatchObject({ ok: false, dimension: "usd" });
    expect(planTurn({ ...PRICED, cost: undefined }, payload, { usdMicros: 1_000_000 })).toMatchObject({ ok: false });
    expect(planTurn({ ...PRICED, api: "some-new-api" }, payload, { usdMicros: 1_000_000 })).toMatchObject({ ok: false });
    expect(planTurn(undefined, payload, { usdMicros: 1_000_000 })).toMatchObject({ ok: false });
    // token caps: input bound alone over the remainder → refused; otherwise output clamped to remainder − input bound
    const bound = Buffer.byteLength(JSON.stringify(payload)) + PROVIDER_OVERHEAD_TOKENS;
    expect(planTurn(PRICED, payload, { tokens: bound + MIN_OUTPUT_TOKENS - 1 })).toMatchObject({ ok: false, dimension: "tokens" });
    const fits = planTurn(PRICED, payload, { tokens: bound + 300 });
    expect(fits.ok && [fits.maxOutputTokens, fits.worst.tokens]).toEqual([300, bound + 300]);
    // an unpriced model under a TOKEN-only cap is still bounded (tokens need no price)
    expect(planTurn({ ...PRICED, cost: { input: 0, output: 0 } }, payload, { tokens: 100_000 }).ok).toBe(true);
  });

  test("thinking and per-API output fields: Anthropic budget_tokens kept below max_tokens; Gemini thinking bounded outside the cap; OpenAI Responses", () => {
    const anth = planTurn(PRICED, { max_tokens: 32_000, thinking: { type: "enabled", budget_tokens: 20_000 }, messages: [] }, { usdMicros: 500_000 });
    if (!anth.ok) throw new Error(anth.reason);
    expect((anth.payload as any).thinking.budget_tokens).toBe(anth.maxOutputTokens - 1);
    const tiny = planTurn(PRICED, { max_tokens: 32_000, thinking: { type: "enabled", budget_tokens: 20_000 }, messages: [] }, { usdMicros: 60_000 });
    expect(tiny.ok && (tiny.payload as any).thinking).toBeUndefined(); // below Anthropic's 1024 minimum → thinking off for the turn
    const gem = planTurn({ ...PRICED, api: "google-generative-ai" }, { model: "g", contents: [], config: { maxOutputTokens: 60_000, thinkingConfig: { includeThoughts: true, thinkingLevel: "HIGH" } } }, { usdMicros: 1_000_000 });
    if (!gem.ok) throw new Error(gem.reason);
    const cfg = (gem.payload as any).config;
    expect(cfg.thinkingConfig.thinkingLevel).toBeUndefined();
    expect(cfg.maxOutputTokens + cfg.thinkingConfig.thinkingBudget).toBeLessThanOrEqual(Math.floor((1_000_000 - Math.ceil(gem.inputBound * 1.25)) / 100));
    expect(gem.worst.usdMicros).toBeLessThanOrEqual(1_000_000);
    const resp = planTurn({ ...PRICED, api: "openai-codex-responses" }, { model: "o", input: [], max_output_tokens: undefined }, { usdMicros: 100_000 });
    expect(resp.ok && (resp.payload as any).max_output_tokens).toBe((resp as any).maxOutputTokens); // the model's maxTokens is the ceiling when the payload names none
    // a 1h cache TTL in the payload doubles the worst input rate (pi-ai bills 1h writes at 2× input)
    expect(worstRates(PRICED, true)!.input).toBe(2);
    expect(worstRates(PRICED, false)!.input).toBe(1.25);
  });
});

describe("repair 3: the child-side guard", () => {
  const fakeExt = () => {
    const handlers = new Map<string, Function>();
    return { pi: { on: (e: string, h: Function) => handlers.set(e, h) } as any, handlers };
  };

  test("inactive outside a budgeted child; env parsing is strict; malformed values refuse every turn", () => {
    expect(registerBudgetGuard(fakeExt().pi, { env: { [BUDGET_STATE_ENV_KEY]: "/tmp/x" }, allowReload: true })).toBeUndefined();
    expect(registerBudgetGuard(fakeExt().pi, { env: { TITAN_HARNESS_CHILD: "1" }, allowReload: true })).toBeUndefined();
    expect(turnBudgetFromEnv(turnBudgetEnv({ usdMicros: 1_000_000.9, tokens: 5 }, "/s"))).toEqual({ active: true, usdMicros: 1_000_000, tokens: 5, statePath: "/s", problems: [] });
    expect(turnBudgetFromEnv({ TITAN_BUDGET_USD_MICROS: "1e6" }).problems).toHaveLength(1);
    const dir = scratch();
    const codes: number[] = [];
    const ext = fakeExt();
    registerBudgetGuard(ext.pi, { env: { TITAN_HARNESS_CHILD: "1", TITAN_BUDGET_USD_MICROS: "-5", TITAN_BUDGET_STATE_PATH: join(dir, "s.json") }, exit: (c) => codes.push(c), allowReload: true });
    ext.handlers.get("before_provider_request")!({ payload: { max_tokens: 10 } }, { model: PRICED });
    expect(codes).toEqual([BUDGET_REFUSED_EXIT]);
    expect(JSON.parse(readFileSync(join(dir, "s.json"), "utf8"))).toMatchObject({ state: "refused" });
  });

  test("a growing message never pushes spend over the cap: $0.10 then a $1.10 attempt under $1 — the second turn is clamped to what is left", () => {
    const guard = new TurnBudgetGuard({ usdMicros: 1_000_000 });
    let spentMicros = 0;
    for (const want of [1000, 11_000, 11_000, 11_000]) {
      const payload = { max_tokens: 32_000, messages: [{ role: "user", content: "q".repeat(300) }] };
      const plan = guard.beforeRequest(PRICED, payload);
      if (!plan.ok) break;
      const input = Buffer.byteLength(JSON.stringify(plan.payload));
      const output = Math.min(want, (plan.payload as any).max_tokens);
      const cost = input * 1 + output * 100;
      spentMicros += cost;
      guard.afterTurn({ input, output, cacheRead: 0, cacheWrite: 0, cost: { total: cost / 1e6 } }, "stop");
    }
    expect(spentMicros).toBeLessThanOrEqual(1_000_000);
    expect(guard.turns).toBeGreaterThanOrEqual(2);
    expect(guard.refusal).toMatchObject({ ok: false, dimension: "usd" }); // the remainder ran out: the next turn is refused, never sent
  });

  test("tokens: a growing conversation never passes a 5,000-token cap", () => {
    const guard = new TurnBudgetGuard({ tokens: 5000 });
    let used = 0;
    for (const want of [500, 20_000, 20_000]) {
      const plan = guard.beforeRequest(PRICED, { max_tokens: 32_000, messages: [{ role: "user", content: "q".repeat(200) }] });
      if (!plan.ok) break;
      const input = Buffer.byteLength(JSON.stringify(plan.payload));
      const output = Math.min(want, (plan.payload as any).max_tokens);
      used += input + output;
      guard.afterTurn({ input, output, cost: { total: 0 } }, "stop");
    }
    expect(used).toBeLessThanOrEqual(5000);
    expect(guard.refusal).toMatchObject({ dimension: "tokens" });
  });

  test("a turn with no reported usage, an errored turn, or tokens at $0 under a USD cap is charged its worst case", () => {
    const g = new TurnBudgetGuard({ usdMicros: 1_000_000 });
    const p = g.beforeRequest(PRICED, { max_tokens: 100, messages: [] });
    if (!p.ok) throw new Error(p.reason);
    g.afterTurn(undefined);
    expect(g.spent.usdMicros).toBe(p.worst.usdMicros);
    const e = g.beforeRequest(PRICED, { max_tokens: 100, messages: [] });
    g.afterTurn({ input: 1, output: 1, cost: { total: 0.000001 } }, "error");
    expect(g.spent.usdMicros).toBe(2 * (e as any).worst.usdMicros);
    const z = g.beforeRequest(PRICED, { max_tokens: 100, messages: [] });
    g.afterTurn({ input: 50, output: 50, cost: { total: 0 } }, "stop");
    expect(g.spent.usdMicros).toBe(3 * (z as any).worst.usdMicros);
    // a turn whose end never arrived is charged its worst case before the next is planned
    const before = g.spent.usdMicros;
    const w = g.beforeRequest(PRICED, { max_tokens: 100, messages: [] });
    g.beforeRequest(PRICED, { max_tokens: 100, messages: [] });
    expect(g.spent.usdMicros).toBe(before + (w as any).worst.usdMicros);
  });

  test("compaction is cancelled in a budgeted child (summaries do not pass through before_provider_request)", () => {
    const ext = fakeExt();
    registerBudgetGuard(ext.pi, { env: { TITAN_HARNESS_CHILD: "1", TITAN_BUDGET_USD_MICROS: "5" }, exit: () => {}, allowReload: true });
    expect(ext.handlers.get("session_before_compact")!({})).toEqual({ cancel: true });
  });
});
const BUDGET_STATE_ENV_KEY = "TITAN_BUDGET_STATE_PATH";

describe("repair 3: real runChild + the real guard, adversarial provider", () => {
  test("the guard ships next to the harness and runChild passes it to a budgeted child only", () => {
    expect(existsSync(BUDGET_GUARD_EXTENSION)).toBe(true);
  });

  test("first message over the cap ($1.20 wanted, $1 cap): clamped BEFORE the request is sent; spend ≤ $1; the next turn is refused (exit 86, hard refusal)", async () => {
    const dir = scratch();
    const { script, ledger } = guardedPi(dir, PRICED, [12_000, 12_000]);
    const r = newRun("BUILDER", "stub/priced");
    await withFakePi(script, () => runChild({ run: r, prompt: "x", tools: "none", thinking: "off", sessionDir: dir, cwd: dir, timeoutMs: 20_000, spendCap: () => ({ usdMicros: 1_000_000 }) }));
    const sent = sentOf(ledger);
    expect(sent).toHaveLength(1);
    expect(sent[0].maxTokens).toBeLessThan(12_000);
    expect(sum(sent)).toBeLessThanOrEqual(1);
    expect(r.costUsd).toBeLessThanOrEqual(1);
    expect([r.exitCode, r.stderr]).toEqual([BUDGET_REFUSED_EXIT, expect.anything()]);
    expect(r.budgetRefusal).toMatchObject({ dimension: "usd" });
    expect(r.stopReason).toBe("budget_refused");
  });

  test("a growing message ($0.10 then a $1.10 attempt) never pushes a real child over $1", async () => {
    const dir = scratch();
    const { script, ledger } = guardedPi(dir, PRICED, [1000, 11_000, 11_000]);
    const r = newRun("BUILDER", "stub/priced");
    await withFakePi(script, () => runChild({ run: r, prompt: "x", tools: "none", thinking: "off", sessionDir: dir, cwd: dir, timeoutMs: 20_000, spendCap: () => ({ usdMicros: 1_000_000 }) }));
    const sent = sentOf(ledger);
    expect(sent.length).toBeGreaterThanOrEqual(2);
    expect(sent[0].cost).toBeLessThan(0.11);
    expect(sent[1].maxTokens).toBeLessThan(11_000);
    expect(sum(sent)).toBeLessThanOrEqual(1);
  });

  test("tokens: a real child under a 20,000-token cap never uses more than 20,000 tokens", async () => {
    const dir = scratch();
    const { script, ledger } = guardedPi(dir, PRICED, [2000, 50_000, 50_000]);
    const r = newRun("BUILDER", "stub/priced");
    await withFakePi(script, () => runChild({ run: r, prompt: "x", tools: "none", thinking: "off", sessionDir: dir, cwd: dir, timeoutMs: 20_000, spendCap: () => ({ tokens: 20_000 }) }));
    const sent = sentOf(ledger);
    expect(sent.reduce((a, s) => a + s.input + s.output, 0)).toBeLessThanOrEqual(20_000);
    expect(r.tokensIn + r.tokensOut).toBeLessThanOrEqual(20_000);
    expect(r.budgetRefusal).toMatchObject({ dimension: "tokens" });
  });

  test("an unbudgeted child gets no guard (no --extension, no budget env): the provider's own cap applies", async () => {
    const dir = scratch();
    const { script, ledger } = guardedPi(dir, PRICED, [12_000]);
    const r = newRun("BUILDER", "stub/priced");
    await withFakePi(script, () => runChild({ run: r, prompt: "x", tools: "none", thinking: "off", sessionDir: dir, cwd: dir, timeoutMs: 20_000 }));
    expect(sentOf(ledger)[0]).toMatchObject({ maxTokens: 32_000, output: 12_000 });
    expect(r.budgetStatePath).toBeUndefined();
  });

  test("a budgeted child that reports usage without its guard armed is killed at its first message (unguarded backstop)", async () => {
    const dir = scratch();
    const script = join(dir, "unguarded.ts");
    writeFileSync(script, `
      const out = (o) => process.stdout.write(JSON.stringify(o) + "\\n");
      let i = 0;
      const tick = () => { i++; out({ type: "message_end", message: { role: "assistant", content: [], usage: { input: 1, output: 1, cost: { total: 0.01 } } } }); if (i < 50) setTimeout(tick, 30); };
      tick();
    `);
    const r = newRun("BUILDER", "stub/priced");
    await withFakePi(script, () => runChild({ run: r, prompt: "x", tools: "none", thinking: "off", sessionDir: dir, cwd: dir, timeoutMs: 20_000, spendCap: () => ({ usdMicros: 1_000_000 }) }));
    expect(r.budgetHalted).toBe(true);
    expect(r.budgetUnguarded).toBe(true);
    expect(r.costUsd).toBeLessThan(0.05);
  });
});

describe("repair 3: through the executor (real createAgentRunner + runChild + guard)", () => {
  test("usd 1 / per_call 1, a $1.20 first message: clamped, spend ≤ $1, the node fails with a hard non-retryable budget refusal", async () => {
    const dir = scratch();
    const { script, ledger } = guardedPi(dir, PRICED, [12_000, 12_000]);
    await withFakePi(script, async () => {
      const h = harness();
      h.deps.agent = createAgentRunner({ sessionsDir: join(h.runDir, "sessions"), cwd: h.deps.cwd, runChild }) as any;
      const r = await run(h, [{ id: "a", prompt: "x", retry: { max_attempts: 3, delay_ms: 0 } } as NodeDoc], { titan: { budget: { usd: 1, per_call_usd: 1 } } });
      expect(sum(sentOf(ledger))).toBeLessThanOrEqual(1);
      expect(r.nodes.a).toMatchObject({ status: "failed", attempts: 1 });
      expect(r.nodes.a.error).toContain("(model turn)");
      expect(r.budgetRefused).toMatchObject({ transient: false, dimension: "usd" });
      expect(r.budget).toMatchObject({ spentUsdMicros: 1_000_000, reservedUsdMicros: 0, overrunUsdMicros: 0 });
      expect(data(h, "budget.refused")[0]).toMatchObject({ turn: true });
    });
  });

  test("two concurrent children near a shared $1 cap (per_call $0.50 each) never overshoot combined", async () => {
    const dir = scratch();
    const { script, ledger } = guardedPi(dir, PRICED, [12_000, 12_000, 12_000]);
    await withFakePi(script, async () => {
      const h = harness();
      h.deps.agent = createAgentRunner({ sessionsDir: join(h.runDir, "sessions"), cwd: h.deps.cwd, runChild }) as any;
      const r = await run(h, [{ id: "a", prompt: "x", retry: { max_attempts: 1 } } as NodeDoc, { id: "b", prompt: "y", retry: { max_attempts: 1 } } as NodeDoc], { titan: { budget: { usd: 1, per_call_usd: 0.5 } } });
      const sent = sentOf(ledger);
      expect(sent.length).toBeGreaterThanOrEqual(2); // both children really ran
      expect(sum(sent)).toBeLessThanOrEqual(1);
      expect(data(h, "budget.reserve")).toHaveLength(2);
      expect(r.budget!.spentUsdMicros as number).toBeLessThanOrEqual(1_000_000);
      expect(r.budget).toMatchObject({ reservedUsdMicros: 0, overrunUsdMicros: 0 });
    });
  });

  test("unknown pricing: the first turn is refused before any request is sent; settled at $0 (not-dispatched); hard refusal", async () => {
    const dir = scratch();
    const { script, ledger } = guardedPi(dir, { ...PRICED, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }, [100]);
    await withFakePi(script, async () => {
      const h = harness();
      h.deps.agent = createAgentRunner({ sessionsDir: join(h.runDir, "sessions"), cwd: h.deps.cwd, runChild }) as any;
      const r = await run(h, [{ id: "a", prompt: "x", retry: { max_attempts: 3, delay_ms: 0 } } as NodeDoc], { titan: { budget: { usd: 1, per_call_usd: 1 } } });
      expect(sentOf(ledger)).toEqual([]);
      expect(r.nodes.a).toMatchObject({ status: "failed", attempts: 1 });
      expect(r.nodes.a.error).toContain("no input/output pricing");
      expect(settleOf(h)[0]).toMatchObject({ chargedUsdMicros: 0, provenance: "not-dispatched" });
    });
  });
});

describe("repair 3 (Fable r2 N3): across a workflow boundary a child's per_call is floored at the parent's effective per_call", () => {
  test("parent usd 25 with no per_call (default $5), child per_call $0.001 → the child reserves $5", async () => {
    const store = new RunStore(scratch());
    const child = loaded([{ id: "c1", prompt: "one" } as NodeDoc], { name: "sub", titan: { budget: { per_call_usd: 0.001 } } });
    const childRuns: Harness[] = [];
    const runWorkflow = async (_n: string, _i: Record<string, unknown>, opts?: RunWorkflowOptions) => {
      const ch = harness({ store });
      childRuns.push(ch);
      return executeWorkflow(child, ch.deps, { parentBudget: opts?.parentBudget });
    };
    const h = harness({ store, runWorkflow });
    await run(h, [{ id: "sub", workflow: { name: "sub" } } as NodeDoc], { titan: { budget: { usd: 25 } } });
    expect(data(childRuns[0], "budget.reserve")[0]).toMatchObject({ usdMicros: 5_000_000 });
  });

  test("the floor applies only when the parent chain limits the dimension; a root workflow keeps its own per_call", () => {
    const root = new BudgetScope("wf", { usdMicros: 25_000_000 }, undefined, { kind: "workflow" });
    const sub = root.child("wf/node:sub").child("wf/node:sub/sub", {}, { kind: "workflow", perCall: { usdMicros: 1000 } });
    expect(effectivePerCall(sub.child("n"), "usd")).toBe(5_000_000);
    expect(effectivePerCall(sub.child("n"), "tokens")).toBe(DEFAULT_PER_CALL_TOKENS); // tokens: parent limits none, child declares none → default
    const free = new BudgetScope("wf", {}, undefined, { kind: "workflow" });
    const sub2 = free.child("n").child("sub", { usdMicros: 1_000_000 }, { kind: "workflow", perCall: { usdMicros: 1000 } });
    expect(effectivePerCall(sub2.child("n"), "usd")).toBe(1000); // the parent limits nothing: no floor
    const own = new BudgetScope("wf", { usdMicros: 1_000_000 }, undefined, { kind: "workflow", perCall: { usdMicros: 1000 } });
    expect(effectivePerCall(own.child("n"), "usd")).toBe(1000);
  });
});
