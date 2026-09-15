import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import { readChain, sha256, verifyChain } from "../modules/hash-chain.ts";
import { readLedger } from "../modules/ledger.ts";
import { RunStore } from "../modules/run-store.ts";
import { FULL_TOOLS, READONLY_TOOLS } from "../modules/runtime.ts";
import { DEFAULT_STACK_SETTINGS } from "../modules/stack-config.ts";
import {
  type AgentRequest,
  type AgentResult,
  type ExecuteOptions,
  type ProcessResult,
  type RunResult,
  type ScriptSpec,
  type WorkflowRuntimeDeps,
  attemptsBudget,
  executeWorkflow,
  formatPlan,
  resolveInputs,
} from "../modules/workflow/executor.ts";
import type { LoadedWorkflow } from "../modules/workflow/loader.ts";
import { resolveTools } from "../modules/workflow/nodes/ai.ts";
import { parseStdout } from "../modules/workflow/nodes/bash.ts";
import { hasCompletionToken } from "../modules/workflow/nodes/loop.ts";
import { isInlineScript } from "../modules/workflow/nodes/script.ts";
import { joinChildren } from "../modules/workflow/nodes/workflow.ts";
import type { NodeDoc, WorkflowDoc } from "../modules/workflow/schema.ts";
import { layers } from "../modules/workflow/scheduler.ts";
import { MAX_SCHEMA_RETRIES } from "../modules/workflow/structured-output.ts";

// ═══ Harness: a run store in a temp dir, scripted agent/bash/approval stubs — no pi, no network ═══

const dirs: string[] = [];
afterEach(() => { while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true }); });
function scratch(): string { const dir = mkdtempSync(join(tmpdir(), "titan-workflow-")); dirs.push(dir); return dir; }

type Answer = string | ((req: AgentRequest, call: number) => Partial<AgentResult> | Promise<Partial<AgentResult>>);
const FAIL = (error = "boom"): Answer => () => ({ ok: false, text: "", error });

interface HarnessOptions {
  answers?: Record<string, Answer[]>;
  bash?: (command: string) => ProcessResult | Promise<ProcessResult>;
  script?: (spec: ScriptSpec, argv: string[]) => ProcessResult;
  approvals?: Array<{ approved: boolean; response?: string }>;
  signal?: AbortSignal;
  mcpTool?: WorkflowRuntimeDeps["mcpTool"];
  runWorkflow?: WorkflowRuntimeDeps["runWorkflow"];
  maxConcurrentChildren?: number;
}

interface Harness {
  deps: WorkflowRuntimeDeps;
  store: RunStore;
  runDir: string;
  runId: string;
  agentCalls: AgentRequest[];
  bashCalls: string[];
  scriptCalls: Array<{ spec: ScriptSpec; argv: string[] }>;
  approvalsAsked: string[];
  notices: Array<{ text: string; level?: string }>;
  peakConcurrency: () => number;
}

function harness(options: HarnessOptions = {}): Harness {
  const store = new RunStore(scratch());
  const cwd = scratch();
  const { runId, dir: runDir } = store.open({ projectSlug: RunStore.projectSlug(cwd), cwd, workflow: { name: "t", sha256: sha256("t") }, command: "workflow" });
  const agentCalls: AgentRequest[] = [];
  const bashCalls: string[] = [];
  const scriptCalls: Array<{ spec: ScriptSpec; argv: string[] }> = [];
  const approvalsAsked: string[] = [];
  const notices: Array<{ text: string; level?: string }> = [];
  const counts = new Map<string, number>();
  const approvals = [...(options.approvals ?? [])];
  let inFlight = 0;
  let peak = 0;
  const deps: WorkflowRuntimeDeps = {
    cwd,
    runId,
    runDir,
    artifactsDir: join(runDir, "artifacts"),
    workflowId: "t",
    store,
    settings: { ...DEFAULT_STACK_SETTINGS, maxConcurrentChildren: options.maxConcurrentChildren ?? DEFAULT_STACK_SETTINGS.maxConcurrentChildren },
    signal: options.signal,
    async agent(req) {
      agentCalls.push(req);
      inFlight++;
      peak = Math.max(peak, inFlight);
      try {
        const n = (counts.get(req.nodeId) ?? 0) + 1;
        counts.set(req.nodeId, n);
        const scripted = options.answers?.[req.nodeId]?.shift();
        const base: AgentResult = { ok: true, text: `${req.nodeId} done`, sessionRef: `sess-${req.nodeId}-${n}`, usage: { tokensIn: 100, tokensOut: 50, costUsd: 0.001, tpsSeconds: 2 }, toolCalls: 0, model: req.model };
        if (scripted === undefined) return base;
        if (typeof scripted === "string") return { ...base, text: scripted };
        return { ...base, ...(await scripted(req, n)) };
      } finally {
        inFlight--;
      }
    },
    async bash(command) {
      bashCalls.push(command);
      if (options.bash) return options.bash(command);
      // default stub: `echo …` prints its (unquoted) arguments, anything else prints ok
      return { code: 0, stdout: `${command.startsWith("echo ") ? command.slice(5).replace(/'/g, "") : "ok"}\n`, stderr: "" };
    },
    async script(spec, opts) {
      scriptCalls.push({ spec, argv: opts.argv ?? [] });
      return options.script ? options.script(spec, opts.argv ?? []) : { code: 0, stdout: '{"ran":true}\n', stderr: "" };
    },
    async approval(message) {
      approvalsAsked.push(message);
      return approvals.shift() ?? { approved: false, response: "no more scripted approvals" };
    },
    notify(text, level) { notices.push({ text, level }); },
    resolveRole(role) {
      return { model: `stub/${role}`, thinking: "medium", callsign: `${role}-1`, appendSystemPrompts: [], tools: role === "architect" ? READONLY_TOOLS : FULL_TOOLS };
    },
    mcpTool: options.mcpTool,
    runWorkflow: options.runWorkflow,
  };
  return { deps, store, runDir, runId, agentCalls, bashCalls, scriptCalls, approvalsAsked, notices, peakConcurrency: () => peak };
}

function loaded(nodes: NodeDoc[], extra: Partial<WorkflowDoc> = {}, files: { commands?: Record<string, string>; scripts?: Record<string, string> } = {}): LoadedWorkflow {
  const doc: WorkflowDoc = { apiVersion: "titan.harness/v1", name: "t", version: 1, nodes, ...extra };
  const dir = scratch();
  return { doc, normalized: doc, name: "t", dir, path: join(dir, "t.yaml"), sha256: sha256(JSON.stringify(doc)), source: "project", commands: files.commands ?? {}, scripts: files.scripts ?? {}, validation: { ok: true, errors: [], warnings: [] } } as LoadedWorkflow;
}

const run = (h: Harness, nodes: NodeDoc[], opts: ExecuteOptions = {}, extra: Partial<WorkflowDoc> = {}, files?: { commands?: Record<string, string>; scripts?: Record<string, string> }): Promise<RunResult> =>
  executeWorkflow(loaded(nodes, extra, files), h.deps, opts);
const events = (h: Harness) => readChain(join(h.runDir, "events.jsonl"));
const meta = (h: Harness, id: string) => JSON.parse(readFileSync(join(h.runDir, "artifacts", "nodes", `${id}.meta.json`), "utf8"));
const statuses = (r: RunResult) => Object.fromEntries(Object.values(r.nodes).map((n) => [n.nodeId, n.status]));

const ISSUE_SCHEMA = { type: "object", properties: { issue_type: { type: "string", enum: ["bug", "feature"] } }, required: ["issue_type"] };

// ═══ Tests ═══════════════════════════════════════════════════════════════════

describe("executor: the Archon classify-and-fix DAG", () => {
  const nodes: NodeDoc[] = [
    { id: "fetch-issue", bash: "gh issue view $ARGUMENTS --json title", timeout: 15000 },
    { id: "classify", prompt: "Classify this issue: $fetch-issue.output.title", depends_on: ["fetch-issue"], allowed_tools: [], output_format: ISSUE_SCHEMA, phase: "triage" },
    { id: "investigate", command: "investigate-bug", depends_on: ["classify"], when: "$classify.output.issue_type == 'bug'", context: "fresh", phase: "work" },
    { id: "plan", command: "plan-feature", depends_on: ["classify"], when: "$classify.output.issue_type == 'feature'", context: "fresh", phase: "work" },
    { id: "implement", prompt: "Implement the fix for: $investigate.output\nRead $ARTIFACTS_DIR/investigation.md first.", depends_on: ["investigate", "plan"], trigger_rule: "one_success", role: "builder", phase: "work" },
  ] as NodeDoc[];
  const commands = { "investigate-bug": "Investigate issue $ARGUMENTS. Write $ARTIFACTS_DIR/investigation.md", "plan-feature": "Plan the feature" };
  const finding = "Root cause: missing null check in auth.ts (issue 12)";

  test("routes classify → bug → implement, hands artifacts over, records events, ledger rows, agents and artifacts", async () => {
    const h = harness({
      answers: { classify: ['Here you go:\n```json\n{"issue_type": "bug"}\n```'], investigate: [finding], implement: ["implemented"] },
      bash: (cmd) => ({ code: 0, stdout: cmd.includes("gh issue view '12'") ? '{"title":"Login fails"}\n' : "", stderr: "" }),
    });
    const seen: string[] = [];
    const result = await run(h, nodes, { arguments: "12", onNode: (n) => seen.push(`${n.nodeId}:${n.status}`) }, { returns: "implement", phases: [{ title: "triage" }, { title: "work" }] }, { commands });

    expect(result.status).toBe("completed");
    expect(result.error).toBeUndefined();
    expect(statuses(result)).toEqual({ "fetch-issue": "success", classify: "success", investigate: "success", plan: "skipped", implement: "success" });
    expect(result.returns).toBe("implemented");
    expect(result.nodes.plan.error).toMatch(/^when: \$classify\.output\.issue_type == 'feature' → false$/);
    expect(seen).toEqual(["fetch-issue:success", "classify:success", "plan:skipped", "investigate:success", "implement:success"]); // a skip settles before its sibling's agent call

    // bash mode substitution shell-quotes $ARGUMENTS; stdout JSON becomes the output object
    expect(h.bashCalls).toEqual(["gh issue view '12' --json title"]);
    expect(result.nodes["fetch-issue"].output).toEqual({ title: "Login fails" });

    // classify: no tools, the schema suffix, the parsed object as output
    const classify = h.agentCalls.find((c) => c.nodeId === "classify")!;
    expect(classify.tools).toBe("none");
    expect(classify.prompt).toContain("Classify this issue: Login fails");
    expect(classify.prompt).toContain("Respond with ONLY one JSON object matching this schema");
    expect(classify.outputSchema).toEqual(ISSUE_SCHEMA);
    expect(classify.role).toBe("worker");
    expect(classify.model).toBe("stub/worker");
    expect(classify.context).toBe("fresh");
    expect(classify.env?.ARTIFACTS_DIR).toBe(h.deps.artifactsDir);
    expect(classify.signal).toBeDefined();
    expect(result.nodes.classify.output).toEqual({ issue_type: "bug" });

    // command body → prompt, with $ARGUMENTS and $ARTIFACTS_DIR
    const investigate = h.agentCalls.find((c) => c.nodeId === "investigate")!;
    expect(investigate.prompt).toBe(`Investigate issue 12. Write ${h.deps.artifactsDir}/investigation.md`);

    // artifact hand-off: implement's prompt carries investigate's ARTIFACT text, and the file exists with its sha256
    const implement = h.agentCalls.find((c) => c.nodeId === "implement")!;
    expect(implement.prompt).toContain(`Implement the fix for: ${finding}`);
    expect(implement.prompt).toContain(`Read ${h.deps.artifactsDir}/investigation.md first.`);
    expect(implement.role).toBe("builder");
    expect(implement.tools).toBe(FULL_TOOLS);
    const artifact = join(h.runDir, "artifacts", "nodes", "investigate.md");
    expect(result.nodes.investigate.artifactPath).toBe(artifact);
    expect(readFileSync(artifact, "utf8")).toBe(finding);
    expect(meta(h, "investigate")).toMatchObject({ sha256: sha256(finding), bytes: Buffer.byteLength(finding), nodeId: "investigate", type: "command", status: "success", attempts: 1, sessionRef: "sess-investigate-1" });
    expect(readFileSync(join(h.runDir, "artifacts", "nodes", "classify.md"), "utf8")).toContain('"issue_type": "bug"');
    expect(existsSync(join(h.runDir, "artifacts", "nodes", "plan.md"))).toBe(false);

    // events: node.start/node.end per node, phases, workflow start/end, chain intact
    const rows = events(h);
    const types = rows.map((r) => r.type);
    expect(types[0]).toBe("workflow.start");
    expect(types[types.length - 1]).toBe("workflow.end");
    for (const id of ["fetch-issue", "classify", "investigate", "plan", "implement"]) {
      expect(rows.some((r) => r.type === "node.start" && (r.data as any).nodeId === id)).toBe(true);
      expect(rows.some((r) => r.type === "node.end" && (r.data as any).nodeId === id)).toBe(true);
    }
    expect(rows.find((r) => r.type === "node.end" && (r.data as any).nodeId === "plan")!.data).toMatchObject({ status: "skipped" });
    expect(rows.filter((r) => r.type === "phase.start").map((r) => (r.data as any).phase)).toEqual(["triage", "work"]);
    expect(rows.filter((r) => r.type === "agent.end")).toHaveLength(3);
    expect(verifyChain(join(h.runDir, "events.jsonl")).ok).toBe(true);

    // ledger: one row per agent call, origin run, observed usage, chain intact
    const ledger = readLedger(h.runDir);
    expect(ledger.map((r) => r.agentId)).toEqual(["classify", "investigate", "implement"]);
    expect(ledger[0]).toMatchObject({ runId: h.runId, role: "worker", model: "stub/worker", provider: "stub", origin: "run", source: "observed", tokens: { input: 100, output: 50 }, costUsd: 0.001, tpsSeconds: 2, callsign: "worker-1", thinking: { requested: "medium", effective: "medium" } });
    expect(ledger[2]).toMatchObject({ role: "builder", origin: "run" });
    expect(verifyChain(join(h.runDir, "ledger.jsonl")).ok).toBe(true);

    // agent records and run.json
    const agents = h.store.listAgents(h.runDir);
    expect(agents.map((a) => [a.agentId, a.state])).toEqual([["classify", "done-unverified"], ["investigate", "done-unverified"], ["implement", "done-unverified"]]);
    expect(agents[0].usage).toEqual({ input: 100, output: 50, cacheRead: 0, cacheWrite: 0, cost: 0.001 });
    const runMeta = h.store.readRun(h.runDir);
    expect(runMeta).toMatchObject({ status: "completed", currentPhase: "work", phases: ["triage", "work"] });
    expect(runMeta.endedAt).toMatch(/^\d{4}-/);
  });

  test("routes to the feature branch and skips the bug branch", async () => {
    const h = harness({ answers: { classify: ['{"issue_type":"feature"}'] }, bash: () => ({ code: 0, stdout: '{"title":"Add export"}', stderr: "" }) });
    const result = await run(h, nodes, {}, { returns: "implement" }, { commands });
    expect(statuses(result)).toEqual({ "fetch-issue": "success", classify: "success", investigate: "skipped", plan: "success", implement: "success" });
    expect(h.agentCalls.map((c) => c.nodeId)).toEqual(["classify", "plan", "implement"]);
    // $investigate.output never settled → left untouched and warned about
    expect(h.agentCalls[2].prompt).toContain("Implement the fix for: $investigate.output");
    expect(h.notices.some((n) => n.text.includes("unknown reference $investigate.output"))).toBe(true);
  });

  test("a when over a missing output fails closed and a failing bash fails the run", async () => {
    const h = harness({ bash: () => ({ code: 2, stdout: "", stderr: "gh: not logged in\n" }) });
    const result = await run(h, nodes, {}, {}, { commands });
    expect(result.status).toBe("failed");
    expect(result.error).toMatch(/^fetch-issue: exit code 2: gh: not logged in$/);
    expect(result.nodes["fetch-issue"]).toMatchObject({ status: "failed", attempts: 2 });
    expect(statuses(result)).toEqual({ "fetch-issue": "failed", classify: "skipped", investigate: "skipped", plan: "skipped", implement: "skipped" });
    expect(result.nodes.classify.error).toMatch(/trigger_rule all_success not met by fetch-issue=failed/);
    expect(h.notices.some((n) => n.level === "warning" && n.text.includes("stderr: gh: not logged in"))).toBe(true);
    expect(h.agentCalls).toHaveLength(0);
  });
});

describe("executor: loop nodes", () => {
  const loopNode = (extra: Record<string, unknown> = {}, prompt = "Round $LOOP_COUNT. Feedback: [$LOOP_USER_INPUT]. Say <promise>DONE</promise> when finished."): NodeDoc =>
    ({ id: "loop", loop: { prompt, until: "DONE", max_iterations: 3, ...extra } }) as NodeDoc;

  test("stops on <promise>DONE</promise>, resumes the previous iteration's session, substitutes $LOOP_COUNT", async () => {
    const h = harness({ answers: { loop: ["still working", "all green <promise>DONE</promise>"] } });
    const result = await run(h, [loopNode()], {}, { returns: "loop" });
    expect(result.status).toBe("completed");
    expect(result.nodes.loop).toMatchObject({ status: "success", attempts: 1, output: "all green <promise>DONE</promise>", sessionRef: "sess-loop-2" });
    expect(h.agentCalls).toHaveLength(2);
    expect(h.agentCalls[0].prompt).toContain("Round 1. Feedback: [].");
    expect(h.agentCalls[0].context).toBe("fresh");
    expect(h.agentCalls[1].prompt).toContain("Round 2.");
    expect(h.agentCalls[1].context).toEqual({ resume: "sess-loop-1" });
    expect(meta(h, "loop")).toMatchObject({ iterations: 2, completedBy: "until" });
    expect(result.nodes.loop.usage).toEqual({ tokensIn: 200, tokensOut: 100, costUsd: 0.002, tpsSeconds: 4 });
  });

  test("a bare token completes too, but not inside another word; fresh_context starts every iteration fresh", async () => {
    expect(hasCompletionToken("The work is INCOMPLETE", "COMPLETE")).toBe(false);
    expect(hasCompletionToken("Done: COMPLETE.", "COMPLETE")).toBe(true);
    expect(hasCompletionToken("<promise> COMPLETE </promise>", "COMPLETE")).toBe(true);
    expect(hasCompletionToken("nothing", "")).toBe(false);
    const h = harness({ answers: { loop: ["INCOMPLETE", "DONE."] } });
    const result = await run(h, [loopNode({ fresh_context: true })]);
    expect(result.nodes.loop.status).toBe("success");
    expect(h.agentCalls.map((c) => c.context)).toEqual(["fresh", "fresh"]);
  });

  test("until_bash exit 0 completes the loop; the check is shell-substituted", async () => {
    let checks = 0;
    const h = harness({ answers: { loop: ["try 1", "try 2", "try 3"] }, bash: () => ({ code: ++checks < 2 ? 1 : 0, stdout: "", stderr: "" }) });
    const result = await run(h, [loopNode({ until: undefined, until_bash: "bun test --iteration $LOOP_COUNT" })]);
    expect(result.nodes.loop.status).toBe("success");
    expect(h.bashCalls).toEqual(["bun test --iteration '1'", "bun test --iteration '2'"]);
    expect(h.agentCalls).toHaveLength(2);
    expect(meta(h, "loop")).toMatchObject({ iterations: 2, completedBy: "until_bash" });
  });

  test("exhausting max_iterations fails the node and is never retried", async () => {
    const h = harness({ answers: { loop: ["a", "b", "c", "d"] } });
    const result = await run(h, [loopNode({ max_iterations: 2 })]);
    expect(result.status).toBe("failed");
    expect(result.nodes.loop).toMatchObject({ status: "failed", attempts: 1, error: "loop did not complete within 2 iterations", output: "b" });
    expect(h.agentCalls).toHaveLength(2);
    expect(attemptsBudget(loopNode(), "loop")).toBe(1);
  });

  test("interactive loops feed the gate reply into $LOOP_USER_INPUT and a rejection cancels the run", async () => {
    const h = harness({ answers: { loop: ["draft 1", "draft 2 <promise>DONE</promise>"] }, approvals: [{ approved: true, response: "make it shorter" }] });
    const result = await run(h, [loopNode({ interactive: true, gate_message: "Review draft $LOOP_COUNT" })]);
    expect(result.status).toBe("completed");
    expect(h.approvalsAsked).toEqual(["Review draft 1"]);
    expect(h.agentCalls[1].prompt).toContain("Feedback: [make it shorter].");

    const stopped = harness({ answers: { loop: ["draft 1", "draft 2"] }, approvals: [{ approved: false, response: "stop" }] });
    const cancelled = await run(stopped, [loopNode({ interactive: true, gate_message: "Review" }), { id: "after", prompt: "x", depends_on: ["loop"] } as NodeDoc]);
    expect(cancelled.status).toBe("cancelled");
    expect(cancelled.error).toBe("loop: loop stopped by the user at iteration 1/3");
    expect(statuses(cancelled)).toEqual({ loop: "cancelled", after: "cancelled" });
    expect(stopped.agentCalls).toHaveLength(1);

    const declared = harness({ answers: { loop: ["draft 1"] }, approvals: [{ approved: true, response: "DONE" }] });
    const byUser = await run(declared, [loopNode({ interactive: true, gate_message: "Review" })]);
    expect(byUser.nodes.loop.status).toBe("success");
    expect(meta(declared, "loop")).toMatchObject({ iterations: 1, completedBy: "user" });
  });
});

describe("executor: approval and cancel nodes", () => {
  const gate = (extra: Record<string, unknown> = {}): NodeDoc => ({ id: "gate", approval: { message: "Ship $inputs.what?", ...extra }, depends_on: ["draft"] }) as NodeDoc;
  const draft: NodeDoc = { id: "draft", prompt: "Draft $inputs.what" } as NodeDoc;
  const ship: NodeDoc = { id: "ship", bash: "echo shipped $gate.output", depends_on: ["gate"] } as NodeDoc;
  const inputs = { inputs: { what: { default: "v2" } } } as Partial<WorkflowDoc>;

  test("approve: the captured reply becomes the output", async () => {
    const h = harness({ approvals: [{ approved: true, response: "yes, go" }] });
    const result = await run(h, [draft, gate({ capture_response: true }), ship], {}, { ...inputs, returns: "ship" });
    expect(result.status).toBe("completed");
    expect(h.approvalsAsked).toEqual(["Ship v2?"]);
    expect(result.nodes.gate.output).toBe("yes, go");
    expect(h.bashCalls).toEqual(["echo shipped 'yes, go'"]);
    expect(result.returns).toBe("shipped yes, go");
    expect(meta(h, "gate")).toMatchObject({ reworks: 0, response: "yes, go" });
  });

  test("approve without capture_response yields an empty output", async () => {
    const h = harness({ approvals: [{ approved: true, response: "ignored" }] });
    const result = await run(h, [draft, gate(), ship], {}, inputs);
    expect(result.nodes.gate.output).toBe("");
    expect(h.bashCalls).toEqual(["echo shipped ''"]);
  });

  test("reject without on_reject cancels the run", async () => {
    const h = harness({ approvals: [{ approved: false, response: "needs work" }] });
    const result = await run(h, [draft, gate(), ship], {}, inputs);
    expect(result.status).toBe("cancelled");
    expect(result.error).toBe("gate: approval rejected: needs work");
    expect(statuses(result)).toEqual({ draft: "success", gate: "cancelled", ship: "cancelled" });
    expect(result.nodes.ship.error).toMatch(/^not reached: gate: approval rejected/);
    expect(h.bashCalls).toHaveLength(0);
  });

  test("reject with on_reject reworks with $REJECTION_REASON, then re-asks; approved on the second ask", async () => {
    const h = harness({ approvals: [{ approved: false, response: "too long" }, { approved: true }], answers: { gate: ["shorter draft"] } });
    const result = await run(h, [draft, gate({ on_reject: { prompt: "Revise the draft: $REJECTION_REASON", max_attempts: 2 } }), ship], {}, inputs);
    expect(result.status).toBe("completed");
    expect(h.approvalsAsked).toEqual(["Ship v2?", "Ship v2?"]);
    const rework = h.agentCalls.filter((c) => c.nodeId === "gate");
    expect(rework).toHaveLength(1);
    expect(rework[0].prompt).toBe("Revise the draft: too long");
    expect(rework[0].label).toBe("t/gate rework 1/2");
    expect(result.nodes.gate).toMatchObject({ status: "success", text: "shorter draft", sessionRef: "sess-gate-1" });
    expect(meta(h, "gate")).toMatchObject({ reworks: 1 });
    expect(readLedger(h.runDir).map((r) => r.agentId)).toEqual(["draft", "gate"]);
  });

  test("reject beyond max_attempts cancels the run; reworks chain their sessions", async () => {
    const h = harness({ approvals: [{ approved: false, response: "no 1" }, { approved: false, response: "no 2" }, { approved: false, response: "no 3" }], answers: { gate: ["r1", "r2"] } });
    const result = await run(h, [draft, gate({ on_reject: { prompt: "Revise: $REJECTION_REASON", max_attempts: 2 } }), ship], {}, inputs);
    expect(result.status).toBe("cancelled");
    expect(result.error).toBe("gate: approval rejected after 2/2 rework attempts: no 3");
    expect(h.approvalsAsked).toHaveLength(3);
    const rework = h.agentCalls.filter((c) => c.nodeId === "gate");
    expect(rework.map((c) => c.prompt)).toEqual(["Revise: no 1", "Revise: no 2"]);
    expect(rework[1].context).toEqual({ resume: "sess-gate-1" });
    expect(result.nodes.gate).toMatchObject({ status: "cancelled", attempts: 1 });
  });

  test("a cancel node ends the run with its substituted reason", async () => {
    const h = harness();
    const result = await run(h, [
      { id: "check", bash: "echo skip" } as NodeDoc,
      { id: "bail", cancel: "Nothing to do for $ARGUMENTS ($check.output)", depends_on: ["check"] } as NodeDoc,
      { id: "never", prompt: "x", depends_on: ["bail"] } as NodeDoc,
    ], { arguments: "12" });
    expect(result.status).toBe("cancelled");
    expect(result.error).toBe("Nothing to do for 12 (skip)");
    expect(result.nodes.bail).toMatchObject({ status: "cancelled", output: "Nothing to do for 12 (skip)", error: "Nothing to do for 12 (skip)" });
    expect(result.nodes.never.status).toBe("cancelled");
    expect(h.agentCalls).toHaveLength(0);
    expect(h.store.readRun(h.runDir).status).toBe("aborted");
    expect(events(h).at(-1)!.data).toMatchObject({ status: "cancelled", nodes: { check: "success", bail: "cancelled", never: "cancelled" } });
  });
});

describe("executor: retry and on_fail", () => {
  test("retry.max_attempts re-runs a failing node with delay_ms 0", async () => {
    const h = harness({ answers: { flaky: [FAIL("timeout"), FAIL("timeout"), "third time lucky"] } });
    const result = await run(h, [{ id: "flaky", prompt: "go", retry: { max_attempts: 3, delay_ms: 0 } } as NodeDoc]);
    expect(result.status).toBe("completed");
    expect(result.nodes.flaky).toMatchObject({ status: "success", attempts: 3, output: "third time lucky" });
    expect(h.agentCalls).toHaveLength(3);
    expect(h.notices.filter((n) => n.text.includes("retrying"))).toHaveLength(2);
    expect(meta(h, "flaky")).toMatchObject({ attempts: 3 });
    expect(readLedger(h.runDir).map((r) => r.agentId)).toEqual(["flaky", "flaky#2", "flaky#3"]);
    expect(h.store.listAgents(h.runDir).map((a) => a.state)).toEqual(["failed", "failed", "done-unverified"]);
  });

  test("the default budget is 2 attempts; a bash node retries too; on_fail retry's max wins", async () => {
    const h = harness({ answers: { bad: [FAIL("e1"), FAIL("e2"), "never"] } });
    const result = await run(h, [{ id: "bad", prompt: "go", retry: { delay_ms: 0 } } as NodeDoc]);
    expect(result.status).toBe("failed");
    expect(result.error).toBe("bad: e2");
    expect(result.nodes.bad).toMatchObject({ status: "failed", attempts: 2, error: "e2" });
    expect(h.agentCalls).toHaveLength(2);

    let calls = 0;
    const b = harness({ bash: () => ({ code: ++calls === 1 ? 1 : 0, stdout: "fine\n", stderr: "" }) });
    const bashResult = await run(b, [{ id: "sh", bash: "flaky-cmd", retry: { delay_ms: 0 } } as NodeDoc]);
    expect(bashResult.nodes.sh).toMatchObject({ status: "success", attempts: 2, output: "fine" });

    expect(attemptsBudget({ id: "x", prompt: "p" } as NodeDoc, "prompt")).toBe(2);
    expect(attemptsBudget({ id: "x", prompt: "p", on_fail: { action: "retry", max: 4 } } as NodeDoc, "prompt")).toBe(4);
    expect(attemptsBudget({ id: "x", prompt: "p", retry: { max_attempts: 3 }, on_fail: { action: "retry", max: 4 } } as NodeDoc, "prompt")).toBe(3);
    expect(attemptsBudget({ id: "x", approval: { message: "m" } } as NodeDoc, "approval")).toBe(1);
  });

  test("on_fail elevate ends the run failed with the elevation error and writes the escalation report", async () => {
    const h = harness({ answers: { implement: [FAIL("tests red"), () => ({ ok: false, text: "partial diff", error: "tests still red" })] } });
    const result = await run(h, [
      { id: "implement", prompt: "build it", role: "builder", retry: { delay_ms: 0 }, on_fail: { action: "elevate", max: 3 } } as NodeDoc,
      { id: "report", prompt: "report", depends_on: ["implement"], trigger_rule: "all_done" } as NodeDoc,
    ]);
    expect(result.status).toBe("failed");
    expect(result.error).toBe("elevation: implement failed 2 times");
    expect(result.nodes.implement).toMatchObject({ status: "failed", attempts: 2, error: "tests still red" });
    expect(result.nodes.report.status).toBe("cancelled");
    expect(h.agentCalls.map((c) => c.nodeId)).toEqual(["implement", "implement"]);
    const report = join(h.deps.artifactsDir, "escalation-report.md");
    expect(result.escalationReport).toBe(report);
    const text = readFileSync(report, "utf8");
    expect(text).toContain("- node: implement (prompt)");
    expect(text).toContain("- verdict: elevate");
    expect(text).toContain("- attempts: 2");
    expect(text).toContain("- error: tests still red");
    expect(text).toContain(`- run: ${h.runId}`);
    expect(text).toContain("partial diff");
    expect(text).toContain(`- artifact: ${join(h.runDir, "artifacts", "nodes", "implement.md")}`);
    expect(events(h).find((r) => r.type === "elevation.report")!.data).toMatchObject({ nodeId: "implement", action: "elevate", attempts: 2, path: report, sha256: sha256(text) });
    expect(h.store.readRun(h.runDir).status).toBe("reauthored"); // P4: an elevation freezes the run for re-authoring (plan §5.3 c); RunResult.status stays "failed"
    expect(result.frozen).toMatchObject({ kind: "mechanical", nodeId: "implement", report });
    expect(h.notices.some((n) => n.level === "error" && n.text.includes("elevate →"))).toBe(true);
  });

  test("on_fail reauthor writes the same report with verdict reauthor; on_fail cancel cancels the run", async () => {
    const h = harness({ answers: { audit: [FAIL("FAIL verdict")] } });
    const result = await run(h, [{ id: "audit", prompt: "audit", role: "auditor", retry: { max_attempts: 1 }, on_fail: { action: "reauthor" } } as NodeDoc]);
    expect(result.error).toBe("elevation: audit failed 1 times");
    expect(readFileSync(join(h.deps.artifactsDir, "escalation-report.md"), "utf8")).toContain("- verdict: reauthor");
    expect(readLedger(h.runDir)[0]).toMatchObject({ agentId: "audit", role: "auditor", origin: "auditor" });

    const c = harness({ answers: { step: [FAIL("nope")] } });
    const cancelled = await run(c, [{ id: "step", prompt: "x", retry: { max_attempts: 1 }, on_fail: { action: "cancel" } } as NodeDoc, { id: "later", prompt: "y", depends_on: ["step"], trigger_rule: "all_done" } as NodeDoc]);
    expect(cancelled.status).toBe("cancelled");
    expect(cancelled.error).toBe("cancelled by on_fail of step: nope");
    expect(cancelled.nodes.later.status).toBe("cancelled");
  });
});

describe("executor: structured output", () => {
  const classify = (extra: Record<string, unknown> = {}): NodeDoc => ({ id: "classify", prompt: "Classify", output_format: ISSUE_SCHEMA, retry: { max_attempts: 1 }, ...extra }) as NodeDoc;

  test("invalid JSON is re-asked with the errors in the same session, valid on the second try", async () => {
    const h = harness({ answers: { classify: ["I think it is a bug", '{"issue_type": "bug"}'] } });
    const result = await run(h, [classify()], {}, { returns: "classify" });
    expect(result.status).toBe("completed");
    expect(result.returns).toEqual({ issue_type: "bug" });
    expect(h.agentCalls).toHaveLength(2);
    expect(h.agentCalls[1].context).toEqual({ resume: "sess-classify-1" });
    expect(h.agentCalls[1].prompt).toContain("Your previous answer was not valid for the required schema: (root): no JSON object found in the answer.");
    expect(h.agentCalls[1].prompt).toContain("Respond with ONLY one JSON object matching this schema");
    expect(h.notices.some((n) => n.text.includes("re-asking 1/3"))).toBe(true);
    expect(meta(h, "classify")).toMatchObject({ calls: 2 });
    expect(result.nodes.classify.usage).toEqual({ tokensIn: 200, tokensOut: 100, costUsd: 0.002, tpsSeconds: 4 });
  });

  test("a schema violation is re-asked with the validator's message; without a session the full prompt is re-sent", async () => {
    const h = harness({ answers: { classify: [(req) => ({ text: '{"issue_type": "other"}', sessionRef: undefined }), '{"issue_type": "feature"}'] } });
    const result = await run(h, [classify()]);
    expect(result.nodes.classify.output).toEqual({ issue_type: "feature" });
    expect(h.agentCalls[1].context).toBe("fresh");
    expect(h.agentCalls[1].prompt).toContain("Classify");
    expect(h.agentCalls[1].prompt).toMatch(/issue_type/);
    expect(h.agentCalls[1].prompt).toContain('Previous answer:\n{"issue_type": "other"}');
  });

  test("fails after MAX_SCHEMA_RETRIES re-asks", async () => {
    const h = harness({ answers: { classify: ["nope", "still nope", "no", "never"] } });
    const result = await run(h, [classify()]);
    expect(result.status).toBe("failed");
    expect(h.agentCalls).toHaveLength(1 + MAX_SCHEMA_RETRIES);
    expect(result.nodes.classify.error).toMatch(/^structured output invalid after 3 re-asks: \(root\): no JSON object found/);
    expect(result.nodes.classify.attempts).toBe(1);
  });
});

describe("executor: tools, roles and context", () => {
  test("role architect is read-only whatever allowed_tools asks for", async () => {
    const h = harness();
    await run(h, [
      { id: "a", prompt: "x", role: "architect", allowed_tools: ["read", "write", "edit", "bash", "grep"] } as NodeDoc,
      { id: "b", prompt: "x", role: "architect", allowed_tools: ["write"] } as NodeDoc,
      { id: "c", prompt: "x", role: "architect", allowed_tools: [] } as NodeDoc,
      { id: "d", prompt: "x", role: "architect" } as NodeDoc,
      { id: "e", prompt: "x", role: "builder", denied_tools: ["bash"] } as NodeDoc,
      { id: "f", prompt: "x", allowed_tools: ["read", "edit"], denied_tools: ["edit"] } as NodeDoc,
    ]);
    const tools = Object.fromEntries(h.agentCalls.map((c) => [c.nodeId, c.tools]));
    expect(tools).toEqual({ a: "read,grep", b: READONLY_TOOLS, c: "none", d: READONLY_TOOLS, e: "read,grep,find,ls,edit,write", f: "read" });
    for (const id of ["a", "b", "c", "d"]) for (const forbidden of ["write", "edit", "bash"]) expect(tools[id].split(",")).not.toContain(forbidden);
    expect(resolveTools({ id: "x", prompt: "p", role: "architect", allowed_tools: ["bash", "mcp_thing"] } as NodeDoc, "architect")).toBe(READONLY_TOOLS);
    expect(resolveTools({ id: "x", prompt: "p" } as NodeDoc, "worker", "read,bash")).toBe("read,bash");
    expect(resolveTools({ id: "x", prompt: "p" } as NodeDoc, "worker", "none")).toBe(FULL_TOOLS);
  });

  test("node model/thinking/callsign/system prompts override the shape's, and roles map to ledger origins", async () => {
    const h = harness();
    await run(h, [
      { id: "a", prompt: "x", role: "verifier", model: "xai/grok-4.6", thinking: "xhigh", callsign: "assay", system_prompt: "SYS", append_system_prompt: ["A1", "A2"], hooks: { PreToolUse: [{ matcher: "bash", response: { hookSpecificOutput: { permissionDecision: "deny" } } }] } } as NodeDoc,
      { id: "b", prompt: "x", role: "judge", callsign: "pool", idle_timeout: 42 } as NodeDoc,
    ]);
    const [a, b] = h.agentCalls;
    expect(a).toMatchObject({ role: "verifier", model: "xai/grok-4.6", thinking: "xhigh", callsign: "assay", systemPrompt: "SYS", appendSystemPrompts: ["A1", "A2"], timeoutMs: 300_000, label: "t/a" });
    expect(a.hooks?.PreToolUse?.[0].matcher).toBe("bash");
    expect(b).toMatchObject({ role: "judge", model: "stub/judge", thinking: "medium", callsign: "judge-1", timeoutMs: 42 });
    expect(readLedger(h.runDir).map((r) => [r.agentId, r.origin, r.callsign])).toEqual([["a", "verifier", "assay"], ["b", "judge", "judge-1"]]);
  });

  test("context shared resumes the previous node's session; {resume: id} that node's; fresh is the default", async () => {
    const h = harness();
    await run(h, [
      { id: "a", prompt: "x" } as NodeDoc,
      { id: "sh", bash: "echo hi", depends_on: ["a"] } as NodeDoc,
      { id: "b", prompt: "x", depends_on: ["sh"], context: "shared" } as NodeDoc,
      { id: "c", prompt: "x", depends_on: ["b"], context: { resume: "a" } } as NodeDoc,
      { id: "d", prompt: "x", depends_on: ["c"] } as NodeDoc,
      { id: "e", prompt: "x", depends_on: ["d"], context: "shared" } as NodeDoc,
      { id: "f", prompt: "x", depends_on: ["e"], context: { resume: "sh" } } as NodeDoc,
    ]);
    const ctx = Object.fromEntries(h.agentCalls.map((c) => [c.nodeId, c.context]));
    expect(ctx).toEqual({ a: "fresh", b: { resume: "sess-a-1" }, c: { resume: "sess-a-1" }, d: "fresh", e: { resume: "sess-d-1" }, f: "fresh" });
    expect(h.notices.some((n) => n.text.includes('context resume "sh" has no session'))).toBe(true);
    const first = harness();
    await run(first, [{ id: "only", prompt: "x", context: "shared" } as NodeDoc]);
    expect(first.agentCalls[0].context).toBe("fresh");
    expect(first.notices.some((n) => n.text.includes("no previous session"))).toBe(true);
  });
});

describe("executor: process nodes, mcp_tool, workflow and P4 stubs", () => {
  test("bash: stdout JSON becomes an object, plain text stays text, stderr warns", async () => {
    expect(parseStdout('{"a":1}\n')).toEqual({ text: '{"a":1}', output: { a: 1 } });
    expect(parseStdout("[1,2]\n")).toEqual({ text: "[1,2]", output: [1, 2] });
    expect(parseStdout("{not json\n")).toEqual({ text: "{not json", output: "{not json" });
    expect(parseStdout("hello\n\n")).toEqual({ text: "hello\n", output: "hello\n" });
    const h = harness({ bash: (cmd) => (cmd.startsWith("count") ? { code: 0, stdout: "7\n", stderr: "warn: slow\n" } : { code: 0, stdout: '{"n": 7}\n', stderr: "" }) });
    const result = await run(h, [{ id: "count", bash: "count things", timeout: 5 } as NodeDoc, { id: "json", bash: "emit $count.output", depends_on: ["count"] } as NodeDoc]);
    expect(result.nodes.count.output).toBe("7");
    expect(result.nodes.json.output).toEqual({ n: 7 });
    expect(h.bashCalls[1]).toBe("emit '7'");
    expect(h.notices.some((n) => n.level === "warning" && n.text === "count: stderr: warn: slow")).toBe(true);
  });

  test("script: inline code is substituted in script mode, named scripts resolve through the loader, $ARGUMENTS is argv", async () => {
    expect(isInlineScript("analyze-metrics")).toBe(false);
    expect(isInlineScript("console.log(1)")).toBe(true);
    expect(isInlineScript("a\nb")).toBe(true);
    const h = harness({ bash: () => ({ code: 0, stdout: '{"title":"T"}', stderr: "" }) });
    const result = await run(h, [
      { id: "fetch", bash: "x" } as NodeDoc,
      { id: "inline", script: "const data = $fetch.output;\nconsole.log(data.title);", runtime: "bun", depends_on: ["fetch"] } as NodeDoc,
      { id: "named", script: "analyze-metrics", runtime: "uv", deps: ["pandas>=2.0"] } as NodeDoc,
      { id: "missing", script: "nope", runtime: "bun" } as NodeDoc,
    ], { arguments: "12" }, {}, { scripts: { "analyze-metrics": "/w/scripts/analyze-metrics.py" } });
    expect(h.scriptCalls).toHaveLength(2);
    expect(h.scriptCalls.find((c) => c.spec.inline)!).toEqual({ spec: { runtime: "bun", deps: undefined, inline: 'const data = {"title":"T"};\nconsole.log(data.title);' }, argv: ["12"] });
    expect(h.scriptCalls.find((c) => c.spec.path)!.spec).toEqual({ runtime: "uv", deps: ["pandas>=2.0"], path: "/w/scripts/analyze-metrics.py" });
    expect(result.nodes.inline.output).toEqual({ ran: true });
    expect(result.nodes.missing).toMatchObject({ status: "failed", attempts: 1, error: expect.stringContaining("named script not found: nope") });
  });

  test("command nodes need a command file", async () => {
    const h = harness();
    const result = await run(h, [{ id: "c", command: "nope" } as NodeDoc]);
    expect(result.nodes.c).toMatchObject({ status: "failed", attempts: 1, error: expect.stringContaining("command file not found: nope") });
  });

  test("mcp_tool substitutes args deeply (exact refs become values) and fails without a bridge", async () => {
    const calls: unknown[] = [];
    const h = harness({ bash: () => ({ code: 0, stdout: '{"title":"Login fails","tags":["a"]}', stderr: "" }), mcpTool: async (server, tool, args) => { calls.push([server, tool, args]); return { hits: 2 }; } });
    const result = await run(h, [
      { id: "fetch", bash: "x" } as NodeDoc,
      { id: "search", mcp_tool: { server: "infranodus", tool: "search", args: { query: "$fetch.output.title", raw: "id=$ARGUMENTS", obj: "$fetch.output", list: ["$fetch.output.tags", 3], nested: { k: " $fetch.output.tags " } } }, depends_on: ["fetch"] } as NodeDoc,
    ], { arguments: "12" }, { returns: "search" });
    expect(calls).toEqual([["infranodus", "search", { query: "Login fails", raw: "id=12", obj: { title: "Login fails", tags: ["a"] }, list: [["a"], 3], nested: { k: ["a"] } }]]);
    expect(result.returns).toEqual({ hits: 2 });
    expect(readFileSync(join(h.runDir, "artifacts", "nodes", "search.md"), "utf8")).toBe('{\n  "hits": 2\n}\n');
    const none = harness();
    const failed = await run(none, [{ id: "m", mcp_tool: { server: "s", tool: "t" } } as NodeDoc]);
    expect(failed.nodes.m).toMatchObject({ status: "failed", attempts: 1, error: expect.stringContaining("deps.mcpTool is absent") });
  });

  test("workflow nodes run children through deps.runWorkflow, fan out over an array and join", async () => {
    const calls: Array<[string, Record<string, unknown>]> = [];
    const child = async (name: string, inputs: Record<string, unknown>): Promise<RunResult> => {
      calls.push([name, inputs]);
      const item = inputs.item as string | undefined;
      return item === "bad" ? { runId: `r-${item}`, status: "failed", nodes: {}, error: "child broke" } : { runId: `r-${item ?? "single"}`, status: "completed", nodes: {}, returns: { did: item ?? "single" } };
    };
    const h = harness({ runWorkflow: child, bash: () => ({ code: 0, stdout: '{"items":["a","b"]}', stderr: "" }) });
    const result = await run(h, [
      { id: "list", bash: "x" } as NodeDoc,
      { id: "single", workflow: { name: "sub", isolation: "worktree" } } as NodeDoc,
      { id: "fan", workflow: { name: "sub", fan_out: { source: "$list.output.items", as: "item" } }, depends_on: ["list"] } as NodeDoc,
    ], { inputs: { spec: "s.md" } }, { inputs: { spec: { required: true } } });
    expect(result.status).toBe("completed");
    expect(calls).toEqual([["sub", { spec: "s.md", __isolation: "worktree" }], ["sub", { spec: "s.md", item: "a" }], ["sub", { spec: "s.md", item: "b" }]]);
    expect(result.nodes.single.output).toEqual({ did: "single" });
    expect(result.nodes.fan.output).toEqual([{ did: "a" }, { did: "b" }]);
    expect(meta(h, "fan")).toMatchObject({ childRunIds: ["r-a", "r-b"], join: "all_success", fanOut: 2 });

    const bad = harness({ runWorkflow: child, bash: () => ({ code: 0, stdout: '{"items":["a","bad"]}', stderr: "" }) });
    const joined = await run(bad, [{ id: "list", bash: "x" } as NodeDoc, { id: "fan", workflow: { name: "sub", fan_out: { source: "$list.output.items", as: "item" } }, depends_on: ["list"] } as NodeDoc]);
    expect(joined.nodes.fan).toMatchObject({ status: "failed", error: "fan-out of sub: 1/2 child workflows did not complete" });
    expect(joinChildren([{ runId: "1", status: "failed", nodes: {} }, { runId: "2", status: "completed", nodes: {} }], "one_success").ok).toBe(true);
    expect(joinChildren([{ runId: "1", status: "failed", nodes: {} }], "all_done").ok).toBe(true);
    expect(joinChildren([{ runId: "1", status: "failed", nodes: {} }, { runId: "2", status: "completed", nodes: {} }], "none_failed_min_one_success")).toEqual({ ok: false, reason: "1 child workflow failed" });

    const none = harness();
    const failed = await run(none, [{ id: "w", workflow: { name: "sub" } } as NodeDoc]);
    expect(failed.nodes.w).toMatchObject({ status: "failed", attempts: 1, error: expect.stringContaining("deps.runWorkflow is absent") });
  });

  // verify / best_of / interleave / hypothesis stopped being stubs in P4: see tests/runners.test.ts and tests/patterns.test.ts.
});

describe("executor: inputs, parallelism, dry run and abort", () => {
  test("inputs: required, defaults and $inputs.key", async () => {
    const doc = { inputs: { spec: { required: true }, design: { default: "design/dashboard.png" } } } as Partial<WorkflowDoc>;
    expect(resolveInputs({ apiVersion: "titan.harness/v1", name: "t", nodes: [], ...doc } as WorkflowDoc, { spec: "s.md", extra: 1 })).toEqual({ spec: "s.md", design: "design/dashboard.png", extra: 1 });
    const h = harness();
    await expect(run(h, [{ id: "a", prompt: "x" } as NodeDoc], {}, doc)).rejects.toThrow(/missing required input: spec/);
    expect(h.agentCalls).toHaveLength(0);
    await run(h, [{ id: "a", prompt: "Read $inputs.spec against $input.design" } as NodeDoc], { inputs: { spec: "docs/spec.md" } }, doc);
    expect(h.agentCalls[0].prompt).toBe("Read docs/spec.md against design/dashboard.png");
  });

  test("a layer runs concurrently up to maxParallel (settings.maxConcurrentChildren by default)", async () => {
    const slow: Answer = () => new Promise((resolve) => setTimeout(() => resolve({ text: "ok" }), 15));
    const nodes = ["p1", "p2", "p3"].map((id) => ({ id, prompt: "x" }) as NodeDoc);
    const wide = harness({ answers: { p1: [slow], p2: [slow], p3: [slow] } });
    await run(wide, nodes);
    expect(wide.peakConcurrency()).toBe(3);
    const narrow = harness({ answers: { p1: [slow], p2: [slow], p3: [slow] } });
    await run(narrow, nodes, { maxParallel: 1 });
    expect(narrow.peakConcurrency()).toBe(1);
    const capped = harness({ answers: { p1: [slow], p2: [slow], p3: [slow] }, maxConcurrentChildren: 2 });
    await run(capped, nodes);
    expect(capped.peakConcurrency()).toBe(2);
  });

  test("dryRun prints the layer plan and calls nothing", async () => {
    const h = harness();
    const nodes: NodeDoc[] = [
      { id: "fetch", bash: "x" },
      { id: "classify", prompt: "p", depends_on: ["fetch"], output_format: ISSUE_SCHEMA, role: "architect" },
      { id: "fix", prompt: "p", depends_on: ["classify"], when: "$classify.output.issue_type == 'bug'" },
      { id: "plan", prompt: "p", depends_on: ["classify"], when: "$classify.output.issue_type == 'feature'" },
      { id: "done", prompt: "p", depends_on: ["fix", "plan"], trigger_rule: "one_success" },
    ] as NodeDoc[];
    const result = await run(h, nodes, { dryRun: true }, { returns: "done" });
    expect(result).toEqual({ runId: h.runId, status: "completed", nodes: {}, plan: [["fetch"], ["classify"], ["fix", "plan"], ["done"]] });
    expect(result.plan).toEqual(layers(loaded(nodes).doc));
    expect(h.agentCalls).toHaveLength(0);
    expect(h.bashCalls).toHaveLength(0);
    expect(existsSync(join(h.runDir, "events.jsonl"))).toBe(false);
    const printed = h.notices[0].text;
    expect(printed).toBe(formatPlan(loaded(nodes, { returns: "done" }).doc, result.plan!));
    expect(printed.split("\n")).toEqual([
      "dry run — t: 4 layers, 5 nodes",
      "  1. fetch (bash)",
      "  2. classify (prompt) · role architect · output_format",
      "  3. fix (prompt) · when $classify.output.issue_type == 'bug'  |  plan (prompt) · when $classify.output.issue_type == 'feature'",
      "  4. done (prompt) · trigger_rule one_success",
      "  returns: done",
    ]);
  });

  test("the abort signal cancels a running node and the run", async () => {
    const controller = new AbortController();
    const h = harness({ answers: { slow: [() => new Promise(() => {})] }, signal: controller.signal });
    setTimeout(() => controller.abort(), 20);
    const result = await run(h, [{ id: "slow", prompt: "x" } as NodeDoc, { id: "next", prompt: "y", depends_on: ["slow"] } as NodeDoc]);
    expect(result.status).toBe("cancelled");
    expect(result.error).toBeDefined();
    expect(statuses(result)).toEqual({ slow: "cancelled", next: "cancelled" });
    expect(result.nodes.slow.attempts).toBe(1);
    expect(h.agentCalls).toHaveLength(1);
    expect(h.store.listAgents(h.runDir)[0].state).toBe("cancelled");
    expect(h.store.readRun(h.runDir).status).toBe("aborted");
    expect(events(h).some((r) => r.type === "agent.end" && (r.data as any).aborted === true)).toBe(true);

    const already = new AbortController();
    already.abort(new Error("stopped before start"));
    const pre = harness({ signal: already.signal });
    const none = await run(pre, [{ id: "a", prompt: "x" } as NodeDoc]);
    expect(none.status).toBe("cancelled");
    expect(none.error).toBe("stopped before start");
    expect(pre.agentCalls).toHaveLength(0);
  });
});

// ═══ The shipped Archon port, end to end (parsed with yaml, no loader dependency) ═══════

const PACKAGE_WORKFLOWS = join(import.meta.dir, "..", "..", "..", ".pi", "titan-harness", "workflows");

describe("executor: the shipped classify-and-fix package workflow", () => {
  const dir = join(PACKAGE_WORKFLOWS, "classify-and-fix");
  const file = join(dir, "classify-and-fix.yaml");
  const text = readFileSync(file, "utf8");
  const doc = parseYaml(text) as WorkflowDoc;
  const shipped = (): LoadedWorkflow =>
    ({ doc, normalized: doc, name: doc.name, dir, path: file, sha256: sha256(text), source: "package", commands: {}, scripts: {}, validation: { ok: true, errors: [], warnings: [] } }) as LoadedWorkflow;
  const issue = { title: "Login fails", body: "Clicking login throws", labels: ["bug"] };

  test("bug route: fetch → classify → investigate → implement → create-pr, state only through $ARTIFACTS_DIR", async () => {
    const h = harness({
      answers: { classify: ['{"issue_type": "bug"}'], investigate: ["# Investigation\n\nRoot cause: null session"], implement: ["branch fix/login"], "create-pr": ["https://github.com/o/r/pull/7"] },
      bash: (cmd) => (cmd.startsWith("gh issue view '12' --json title,body,labels") ? { code: 0, stdout: `${JSON.stringify(issue)}\n`, stderr: "" } : { code: 1, stdout: "", stderr: `unexpected: ${cmd}` }),
    });
    expect(layers(doc)).toEqual([["fetch-issue"], ["classify"], ["investigate", "plan"], ["implement"], ["create-pr"]]);
    const result = await executeWorkflow(shipped(), h.deps, { arguments: "12" });
    expect(result.status).toBe("completed");
    expect(result.returns).toBe("https://github.com/o/r/pull/7");
    expect(statuses(result)).toEqual({ "fetch-issue": "success", classify: "success", investigate: "success", plan: "skipped", implement: "success", "create-pr": "success" });
    expect(result.nodes["fetch-issue"].output).toEqual(issue);
    const byId = Object.fromEntries(h.agentCalls.map((c) => [c.nodeId, c]));
    expect(Object.keys(byId)).toEqual(["classify", "investigate", "implement", "create-pr"]);
    expect(byId.classify).toMatchObject({ model: "cerebras/qwen-3.8-27b", tools: "none", context: "fresh" });
    expect(byId.classify.prompt).toContain('Classify this issue: {\n  "title": "Login fails"');
    expect(byId.investigate.prompt).toContain('"labels": [\n    "bug"\n  ]');
    expect(byId.investigate.prompt).toContain(`Write your findings to ${h.deps.artifactsDir}/investigation.md`);
    expect(byId.implement.prompt).toContain(`Read ${h.deps.artifactsDir}/investigation.md or ${h.deps.artifactsDir}/plan.md`);
    expect(byId["create-pr"].prompt).toContain("a reference to issue #12.");
    for (const call of h.agentCalls) expect(call.context).toBe("fresh");
    expect(readLedger(h.runDir)).toHaveLength(4);
    expect(verifyChain(join(h.runDir, "events.jsonl")).ok).toBe(true);
    expect(readFileSync(join(h.runDir, "artifacts", "nodes", "create-pr.md"), "utf8")).toBe("https://github.com/o/r/pull/7");
  });

  test("feature route skips investigate and still reaches create-pr through one_success", async () => {
    const h = harness({ answers: { classify: ["```json\n{\"issue_type\": \"feature\"}\n```"] }, bash: () => ({ code: 0, stdout: JSON.stringify(issue), stderr: "" }) });
    const result = await executeWorkflow(shipped(), h.deps, { arguments: "12" });
    expect(statuses(result)).toEqual({ "fetch-issue": "success", classify: "success", investigate: "skipped", plan: "success", implement: "success", "create-pr": "success" });
    expect(h.agentCalls.map((c) => c.nodeId)).toEqual(["classify", "plan", "implement", "create-pr"]);
  });

  test("a failing gh call fails the run before any agent is spawned", async () => {
    const h = harness({ bash: () => ({ code: 1, stdout: "", stderr: "gh: issue not found" }) });
    const result = await executeWorkflow(shipped(), h.deps, { arguments: "999" });
    expect(result.status).toBe("failed");
    expect(result.error).toBe("fetch-issue: exit code 1: gh: issue not found");
    expect(h.agentCalls).toHaveLength(0);
    expect(Object.values(result.nodes).filter((n) => n.status === "skipped")).toHaveLength(5);
  });
});
