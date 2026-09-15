import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { verifyChain } from "../modules/hash-chain.ts";
import { type LedgerRow, type Totals, appendLedger, fmtTokens, formatTotals, readLedger, rowFromAgentRun, totalsFor } from "../modules/ledger.ts";

const dirs: string[] = [];
afterEach(() => { while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true }); });
function scratch(): string { const dir = mkdtempSync(join(tmpdir(), "titan-ledger-")); dirs.push(dir); return dir; }

const base = { ts: "2026-09-15T00:00:00.000Z", runId: "run-x", role: "BUILDER", provider: "xai", model: "xai/grok-4.6", source: "observed" as const, origin: "run" as const };
const row = (agentId: string, input: number, output: number, costUsd: number, extra: Partial<LedgerRow> = {}): LedgerRow =>
  ({ ...base, agentId, tokens: { input, output, cacheRead: 0, cacheWrite: 0 }, costUsd, ...extra });

// Worked example: three agents plus the host turn.
//   ember  (done-verified)   1000 in /  500 out  $0.50   tps 500/10 s = 50
//   slate  (done-unverified) 2000 in / 1000 out  $1.00   tps 1000/25 s = 40
//   flint  (failed)             0 in /    0 out  $0      unmetered watchdog inside the child
//   host                      400 in /  100 out  $0.05
const rows: LedgerRow[] = [
  row("ember", 1000, 500, 0.5, { callsign: "ember", thinking: { requested: "xhigh", effective: "xhigh" }, tpsSeconds: 10 }),
  row("slate", 2000, 1000, 1.0, { callsign: "slate", model: "antigravity/gemini-3.8-flash", provider: "antigravity", thinking: { requested: "xhigh", effective: "high" }, tpsSeconds: 25 }),
  row("flint", 0, 0, 0, { source: "unmetered", origin: "watchdog", note: "pi-subagents watchdog, count 1" }),
  row("host", 400, 100, 0.05, { role: "HOST", origin: "host", model: "anthropic/claude-fable-5-1", provider: "anthropic" }),
];
const agents = [
  { state: "done-verified", tps: { outputTokens: 500, seconds: 10 } },
  { state: "done-unverified", tps: { outputTokens: 1000, seconds: 25 } },
  { state: "failed", tps: { outputTokens: 0, seconds: 0 } },
];

describe("ledger totals", () => {
  test("sums tokens and cost, counts unmetered rows and agents, averages tps and the completion rate", () => {
    const t = totalsFor(rows, agents);
    expect(t).toEqual({ tokens: 5000, input: 3400, output: 1600, costUsd: 1.55, unmetered: 1, agents: 3, avgTpsPerAgent: 45, completionRate: 1 / 3, verified: 1, unverified: 1, failed: 1 });
    expect(formatTotals(t)).toBe("Σ 5k tok · $1.55 · 45 tps/agent · verified 33 % (1/3) · unmetered ×1");
  });

  test("without agent records the rate and tps are absent and agents are the distinct ids", () => {
    const t = totalsFor(rows);
    expect(t).toEqual({ tokens: 5000, input: 3400, output: 1600, costUsd: 1.55, unmetered: 1, agents: 4, verified: 0, unverified: 0, failed: 0 });
    expect(t.avgTpsPerAgent).toBeUndefined();
    expect(t.completionRate).toBeUndefined();
    expect(formatTotals(t)).toBe("Σ 5k tok · $1.55 · unmetered ×1");
    expect(formatTotals(totalsFor([]))).toBe("Σ 0 tok · $0.00");
  });

  test("cancelled and stalemate count against completion; queued agents do not", () => {
    const t = totalsFor([], [{ state: "done-verified" }, { state: "done-verified" }, { state: "cancelled" }, { state: "stalemate" }, { state: "dispatched-working" }, { state: "queued" }]);
    expect(t).toMatchObject({ agents: 6, verified: 2, unverified: 0, failed: 2, completionRate: 0.5 });
    expect(t.avgTpsPerAgent).toBeUndefined();
  });

  test("renders the plan's example row", () => {
    const t: Totals = { tokens: 1_240_000, input: 1_000_000, output: 240_000, costUsd: 3.87, unmetered: 0, agents: 14, avgTpsPerAgent: 41.4, completionRate: 12 / 14, verified: 12, unverified: 1, failed: 1 };
    expect(formatTotals(t)).toBe("Σ 1.24M tok · $3.87 · 41 tps/agent · verified 86 % (12/14)");
    expect(fmtTokens(950)).toBe("950");
    expect(fmtTokens(12_300)).toBe("12.3k");
    expect(fmtTokens(1_000_000)).toBe("1M");
    expect(formatTotals({ ...t, costUsd: 0.0042 })).toContain("$0.0042");
  });
});

describe("ledger file", () => {
  test("appends chained rows and reads them back", () => {
    const dir = scratch();
    expect(readLedger(dir)).toEqual([]);
    const { ts: _ts, ...noTs } = rows[0];
    const first = appendLedger(dir, noTs);
    const second = appendLedger(dir, rows[1]);
    expect(first.seq).toBe(1);
    expect(first.ts).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(second.ts).toBe(rows[1].ts);
    expect(second.prev).toBe(first.hash);
    const back = readLedger(dir);
    expect(back).toHaveLength(2);
    expect(back[1]).toMatchObject({ agentId: "slate", tokens: { input: 2000, output: 1000 }, thinking: { requested: "xhigh", effective: "high" } });
    expect(verifyChain(join(dir, "ledger.jsonl"))).toEqual({ ok: true, rows: 2 });
    expect(totalsFor(back).tokens).toBe(4500);
  });

  test("rowFromAgentRun folds an AgentRun into an observed row", () => {
    const run = { role: "BUILDER", model: "xai/grok-4.6", slot: { id: "ember", name: "ember", thinking: "xhigh" }, tokensIn: 1234, tokensOut: 321, costUsd: 0.42, tpsSeconds: 6.5 };
    expect(rowFromAgentRun(run, "run-1", "run")).toEqual({
      runId: "run-1", agentId: "ember", callsign: "ember", role: "BUILDER", model: "xai/grok-4.6", provider: "xai",
      thinking: { requested: "xhigh", effective: "xhigh" }, tokens: { input: 1234, output: 321, cacheRead: 0, cacheWrite: 0 },
      costUsd: 0.42, source: "observed", origin: "run", tpsSeconds: 6.5,
    });
    const degraded = rowFromAgentRun({ ...run, model: "cerebras/qwen-3.8-27b", tpsSeconds: 0 }, "run-1", "auditor", "high", "aud-1");
    expect(degraded).toMatchObject({ agentId: "aud-1", provider: "cerebras", origin: "auditor", thinking: { requested: "xhigh", effective: "high" } });
    expect(degraded.tpsSeconds).toBeUndefined();
    const bare = rowFromAgentRun({ role: "FUSION", model: "local-model", tokensIn: 1, tokensOut: 1, costUsd: 0, tpsSeconds: 0 }, "run-1", "fuser");
    expect(bare).toMatchObject({ agentId: "fusion", provider: "unknown" });
    expect(bare.thinking).toBeUndefined();
  });
});
