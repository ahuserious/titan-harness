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
  perCallCap,
  reserve,
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

  test("per-call cap: node per_call wins, then titan per_call, then defaults; clamped to the node's total", () => {
    expect(perCallCap(undefined, undefined)).toEqual({ usdMicros: DEFAULT_PER_CALL_USD * 1e6, tokens: DEFAULT_PER_CALL_TOKENS });
    expect(perCallCap({ per_call_usd: 0.5 }, { per_call_usd: 1, per_call_tokens: 900 })).toEqual({ usdMicros: 500_000, tokens: 900 });
    expect(perCallCap({ usd: 0.2, tokens: 10 }, { per_call_usd: 1 })).toEqual({ usdMicros: 200_000, tokens: 10 });
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
    expect(data(h, "budget.reserve")).toHaveLength(2);
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
    // node loop: budget $0.5, per call defaults clamp to the node's $0.5; iteration 1 spends $0.3 → iteration 2 refused.
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

    // a fan-out whose calls cannot fit even once everything settles is refused, not dispatched
    const tight = harness();
    const refused = await run(tight, [{ id: "pick", best_of: { n: 3, prompt: "solve" }, retry: { max_attempts: 1 } } as NodeDoc], { titan: { budget: { usd: 0.3, per_call_usd: 0.4 } } });
    expect(tight.agentCalls).toHaveLength(0);
    expect(refused.nodes.pick.error).toBe("budget exceeded: workflow:t remaining $0.3, needed $0.4");
  });

  test("an interrupted run settles what it used (late usage within the grace period), else the full reservation", async () => {
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
    expect(settles.a).toMatchObject({ interrupted: true, chargedUsdMicros: 120_000, chargedTokens: 320, basis: { usd: "reported" } });
    expect(settles.b).toMatchObject({ interrupted: true, chargedUsdMicros: 1_000_000, basis: { usd: "reservation" } });
    expect(result.budget).toMatchObject({ spentUsdMicros: 1_120_000, reservedUsdMicros: 0 });
    const types = events(h).map((r) => r.type);
    expect(types.indexOf("budget.summary")).toBeLessThan(types.indexOf("workflow.end"));
    expect(spentFromEvents(h)).toEqual({ usdMicros: 1_120_000, tokens: 320 + DEFAULT_PER_CALL_TOKENS });
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
      return executeWorkflow(child, ch.deps, { parentBudget: opts?.parentBudget });
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
    expect(result.nodes.sub).toMatchObject({ status: "failed", error: expect.stringContaining("budget exceeded: workflow:t remaining $0.3, needed $0.5") });
    expect(result.budget).toMatchObject({ spentUsdMicros: 700_000, reservedUsdMicros: 0 });
    expect(result.budget!.spentUsdMicros as number).toBeLessThanOrEqual(1_000_000);
  });

  test("a node budget on the workflow: node caps its children too", async () => {
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
    expect(result.nodes.sub.error).toContain("budget exceeded: workflow:t/node:sub remaining $0.01, needed $5");  // the child declares no per_call cap: the default applies there
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
