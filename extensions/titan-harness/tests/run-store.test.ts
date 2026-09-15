import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { canonicalJson, sha256, verifyChain } from "../modules/hash-chain.ts";
import { RunStore, newRunId } from "../modules/run-store.ts";

const dirs: string[] = [];
afterEach(() => { while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true }); });
function scratch(): string { const dir = mkdtempSync(join(tmpdir(), "titan-run-store-")); dirs.push(dir); return dir; }
function openRun(store: RunStore, cwd: string, extra: Record<string, unknown> = {}) {
  return store.open({ projectSlug: RunStore.projectSlug(cwd), cwd, workflow: { name: "smoke", sha256: sha256("smoke") }, command: "titan-only", level: 1, ...extra });
}

describe("run store", () => {
  test("projectSlug is deterministic: readable tail + 12 hex of the real path", () => {
    const cwd = scratch();
    const slug = RunStore.projectSlug(cwd);
    expect(slug).toBe(RunStore.projectSlug(cwd));
    expect(slug).toMatch(/^[A-Za-z0-9-]+-[0-9a-f]{12}$/);
    expect(slug.split("-").slice(0, -1).join("-").length).toBeLessThanOrEqual(40);
    expect(RunStore.projectSlug(cwd)).not.toBe(RunStore.projectSlug(scratch()));
  });

  test("run ids are compact-ISO stamped and unique", () => {
    expect(newRunId(new Date("2026-09-15T03:14:55.123Z"))).toMatch(/^run-20260915T031455Z-[0-9a-f]{6}$/);
    expect(newRunId()).not.toBe(newRunId());
  });

  test("open lays out the run directory, run.json and the index", () => {
    const root = scratch();
    const cwd = scratch();
    const store = new RunStore(root);
    const { runId, dir } = openRun(store, cwd);
    expect(dir).toBe(store.dir(runId, RunStore.projectSlug(cwd)));
    for (const sub of ["evidence", "artifacts/nodes", "blobs", "agents"]) expect(statSync(join(dir, sub)).isDirectory()).toBe(true);
    const run = store.readRun(dir);
    expect(run).toMatchObject({ runId, status: "pending", cwd, command: "titan-only", level: 1, workflow: { name: "smoke" } });
    expect(run.startedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(statSync(join(dir, "run.json")).mode & 0o777).toBe(0o600);
    const index = readFileSync(join(root, "index.jsonl"), "utf8").trimEnd().split("\n").map((l) => JSON.parse(l));
    expect(index).toHaveLength(1);
    expect(index[0]).toEqual({ runId, projectSlug: RunStore.projectSlug(cwd), workflow: { name: "smoke", sha256: sha256("smoke") }, startedAt: run.startedAt });
    expect(() => store.dir("../escape", "slug")).toThrow(/runId/);
  });

  test("updateRun rewrites run.json atomically", () => {
    const store = new RunStore(scratch());
    const { dir } = openRun(store, scratch());
    const updated = store.updateRun(dir, { status: "running", currentPhase: "build", phases: ["plan", "build"], totals: { tokens: 12, costUsd: 0.5, agents: 2 } });
    expect(updated.status).toBe("running");
    expect(store.readRun(dir)).toEqual(updated);
    expect(store.updateRun(dir, { status: "completed", endedAt: "2026-09-15T00:00:00.000Z" })).toMatchObject({ status: "completed", currentPhase: "build", totals: { tokens: 12 } });
    expect(readdirSync(dir).filter((n) => n.endsWith(".tmp"))).toEqual([]);
    // canonical, pretty JSON on disk
    expect(readFileSync(join(dir, "run.json"), "utf8")).toBe(`${JSON.stringify(JSON.parse(canonicalJson(store.readRun(dir))), null, 2)}\n`);
  });

  test("events chain, agents keep a state history stamped with the events count", () => {
    const store = new RunStore(scratch());
    const { runId, dir } = openRun(store, scratch());
    const e1 = store.appendEvent(dir, "run.start", { level: 1 });
    const e2 = store.appendEvent(dir, "agent.state", { state: "dispatched-working" }, "b1");
    expect(e1).toMatchObject({ seq: 1, runId, type: "run.start", data: { level: 1 } });
    expect(e1.agentId).toBeUndefined();
    expect(e2).toMatchObject({ seq: 2, runId, agentId: "b1" });
    const created = store.upsertAgent(dir, { agentId: "b1", callsign: "ember", role: "BUILDER", model: "xai/grok-4.6", thinking: { requested: "xhigh", effective: "xhigh" }, state: "dispatched-working" });
    expect(created.stateHistory).toEqual([{ state: "dispatched-working", ts: created.stateHistory[0].ts, seq: 2 }]);
    expect(created.usage).toEqual({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 });
    store.appendEvent(dir, "tool.end", { tool: "write" }, "b1");
    const same = store.upsertAgent(dir, { agentId: "b1", state: "dispatched-working", usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, cost: 0.01 } });
    expect(same.stateHistory).toHaveLength(1);
    expect(same.usage.input).toBe(10);
    const done = store.upsertAgent(dir, { agentId: "b1", state: "done-verified", tps: { outputTokens: 500, seconds: 10 } });
    expect(done.state).toBe("done-verified");
    expect(done.stateHistory.map((h) => [h.state, h.seq])).toEqual([["dispatched-working", 2], ["done-verified", 3]]);
    expect(done).toMatchObject({ callsign: "ember", role: "BUILDER", model: "xai/grok-4.6", usage: { input: 10 }, tps: { outputTokens: 500, seconds: 10 } });
    const fresh = store.upsertAgent(dir, { agentId: "aud/1", callsign: "slate", role: "AUDITOR", model: "google/gemini-3.8-flash" });
    expect(fresh.state).toBe("queued");
    expect(fresh.stateHistory).toEqual([{ state: "queued", ts: fresh.stateHistory[0].ts, seq: 3 }]);
    expect(existsSync(join(dir, "agents", "aud-1.json"))).toBe(true);
    expect(store.listAgents(dir).map((a) => a.agentId)).toEqual(["b1", "aud/1"]);
    expect(verifyChain(join(dir, "events.jsonl"))).toEqual({ ok: true, rows: 3 });
  });

  test("artifacts and evidence carry sha256 identities that match their bytes", () => {
    const store = new RunStore(scratch());
    const { dir } = openRun(store, scratch());
    const body = "# node output\n\nhello\n";
    const artifact = store.writeArtifact(dir, "plan/step-1", body, { kind: "report", agent: "ember" });
    expect(artifact.sha256).toBe(sha256(body));
    expect(readFileSync(artifact.path, "utf8")).toBe(body);
    const meta = JSON.parse(readFileSync(join(dir, "artifacts", "nodes", "plan-step-1.meta.json"), "utf8"));
    expect(meta).toMatchObject({ sha256: sha256(body), bytes: Buffer.byteLength(body), kind: "report", agent: "ember", nodeId: "plan/step-1" });
    expect(meta.ts).toMatch(/^\d{4}-/);

    const evidence = { schemaVersion: 1, nodeId: "step-1", status: "matched", artifacts: [{ path: artifact.path, sha256: artifact.sha256, kind: "report" }], checks: { testsPass: true } };
    const file = store.writeEvidence(dir, "step-1", evidence);
    expect(file).toBe(join(dir, "evidence", "step-1", "evidence.json"));
    const text = readFileSync(file, "utf8");
    expect(text).toBe(`${canonicalJson(evidence)}\n`);
    expect(readFileSync(`${file}.sha256`, "utf8")).toBe(`${sha256(text)}  evidence.json\n`);
    expect(statSync(file).mode & 0o777).toBe(0o600);
  });

  test("storeBlob is content addressed", async () => {
    const store = new RunStore(scratch());
    const { dir } = openRun(store, scratch());
    const source = join(scratch(), "screenshot.png");
    writeFileSync(source, Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]));
    const blob = await store.storeBlob(dir, source);
    expect(blob.sha256).toBe(sha256(readFileSync(source)));
    expect(blob.blobPath).toBe(join(dir, "blobs", blob.sha256));
    expect(blob.bytes).toBe(7);
    expect(readFileSync(blob.blobPath)).toEqual(readFileSync(source));
    expect(await store.storeBlob(dir, source)).toEqual(blob);
    expect(readdirSync(join(dir, "blobs"))).toEqual([blob.sha256]);
  });

  test("listRuns reads the index newest first and filters by project", () => {
    const store = new RunStore(scratch());
    const cwdA = scratch();
    const cwdB = scratch();
    const a1 = openRun(store, cwdA);
    const b1 = openRun(store, cwdB);
    const a2 = openRun(store, cwdA);
    expect(store.listRuns().map((r) => r.runId)).toEqual([a2.runId, b1.runId, a1.runId]);
    expect(store.listRuns(RunStore.projectSlug(cwdA)).map((r) => r.runId)).toEqual([a2.runId, a1.runId]);
    expect(store.listRuns(undefined, 1).map((r) => r.runId)).toEqual([a2.runId]);
    rmSync(b1.dir, { recursive: true, force: true });
    expect(store.listRuns().map((r) => r.runId)).toEqual([a2.runId, a1.runId]);
    expect(new RunStore(scratch()).listRuns()).toEqual([]);
  });
});
