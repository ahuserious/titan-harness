import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parse as parseYaml } from "yaml";
import { formatIssues, isInlineScript, parseWhen, validateFile, validateWorkflow, type ValidateContext, type ValidationResult } from "../modules/workflow/validator.ts";

const dirs: string[] = [];
afterEach(() => { while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true }); });

function scratch(): string { const dir = mkdtempSync(join(tmpdir(), "titan-wf-validator-")); dirs.push(dir); return dir; }

/** A workflow directory named after the document (so the name rule holds), with optional files under it. */
function workflowDir(name: string, files: Record<string, string> = {}): string {
  const dir = join(scratch(), name);
  mkdirSync(dir, { recursive: true });
  for (const [rel, body] of Object.entries(files)) { mkdirSync(dirname(join(dir, rel)), { recursive: true }); writeFileSync(join(dir, rel), body); }
  return dir;
}

type Extra = Partial<ValidateContext> & { files?: Record<string, string> };
function validate(yaml: string, extra: Extra = {}): ValidationResult {
  const doc = parseYaml(yaml);
  const name = doc && typeof doc === "object" && typeof doc.name === "string" ? doc.name : "wf";
  const { files, ...ctx } = extra;
  const dir = ctx.dir ?? workflowDir(name, files);
  return validateWorkflow(doc, { dir, commandDirs: [dir], scriptDirs: [dir], ...ctx });
}
const rules = (r: ValidationResult): string[] => [...new Set(r.errors.map((e) => e.rule))];
const warnRules = (r: ValidationResult): string[] => [...new Set(r.warnings.map((w) => w.rule))];
const indent = (body: string, n: number): string => body.split("\n").map((line) => (line ? " ".repeat(n) + line : line)).join("\n");
/** One node `n1` with the given fields, plus optional top-level lines. */
const one = (body: string, top = ""): string => `apiVersion: titan.harness/v1\nname: wf\n${top}nodes:\n  - id: n1\n${indent(body, 4)}\n`;
/** Several nodes written as YAML list items. */
const many = (nodes: string, top = ""): string => `apiVersion: titan.harness/v1\nname: wf\n${top}nodes:\n${nodes}\n`;

const BASE = `
apiVersion: titan.harness/v1
name: wf
description: three nodes, one route
nodes:
  - id: fetch
    bash: "echo hi"
    timeout: 5000
  - id: classify
    prompt: "Classify: $fetch.output"
    depends_on: [fetch]
    allowed_tools: []
    output_format:
      type: object
      properties: { kind: { type: string, enum: [bug, feature] } }
      required: [kind]
  - id: fix
    prompt: "Fix it"
    depends_on: [classify]
    when: "$classify.output.kind == 'bug'"
`;

describe("validator: green fixtures", () => {
  test("the base fixture is valid with no warnings and a normalized copy", () => {
    const result = validate(BASE);
    expect(result.ok).toBe(true);
    expect(result.errors).toEqual([]);
    expect(result.warnings).toEqual([]);
    expect(result.normalized?.nodes.map((n) => n.id)).toEqual(["fetch", "classify", "fix"]);
  });

  test.each(([
    ["every base field type", one(`prompt: "go"\ndepends_on: []\ntrigger_rule: all_done\nidle_timeout: 1000\ntimeout: 1000\nretry: { max_attempts: 3, delay_ms: 0 }\nrole: worker\ncallsign: scout\nmimeograph: m\ntier: web-general\nevidence: { produces: [log], require: [] }\nreview: optional\non_fail: { action: retry, max: 2 }\nwatchdog: { policy: strict }\nbudget: { usd: 1, tokens: 100 }\ncontext_budget: 1000\nisolation: worktree\nanonymize: true\nmodel: xai/grok-4.6\nthinking: xhigh\ncontext: fresh\noutput_format: { type: object }\nallowed_tools: [read, bash]\ndenied_tools: [write]\nsystem_prompt: sp\nappend_system_prompt: [a, b]\nmcp: [infranodus]\nskills: [x]\nsubagents: { enabled: false, tools: [read], cap: 2 }\noutput_type: report`)],
    ["top level: version, inputs, returns, phases, provider, model+thinking, trigger, titan", one(`prompt: "go"\nphase: plan`, `version: 2\ndescription: d\ninputs:\n  spec: { required: true, description: path }\n  design: { default: x.png }\n  bare:\nreturns: n1\nphases: [{ title: plan, detail: think }]\nprovider: pi\nmodel: xai/grok-4.6\nthinking: high\ntrigger: { every: 6h, entity_profile: acme }\ntitan:\n  level: 2\n  shape: level-2\n  tier: web-general\n  modes: [spec]\n  elevation: default\n  watchdog: { enabled: true, model: xai/grok-4.6, thinking: high, cadence_tools: 5, stalemate_repeats: 3, on_compaction: summary-only, inspector_timeout_ms: 20000 }\n  budget: { usd: 5, tokens: 1000, max_concurrent_children: 16, context_budget: 50000 }\n  personas: [contrarian]\n`)],
    ["trigger cron with 5 fields", one(`bash: "true"`, `trigger: { cron: "0 */6 * * *" }\n`)],
    ["trigger cron with 6 fields and names", one(`bash: "true"`, `trigger: { cron: "0 0 9 * * mon-fri" }\n`)],
    ["elevation ladder mapping", one(`bash: "true"`, `titan: { elevation: { fail_1: thinking, fail_2: max-model } }\n`)],
    ["command node with its file", one(`command: investigate`), { files: { "commands/investigate.md": "# investigate" } }],
    ["command node in a subfolder", one(`command: issues/investigate`), { files: { "commands/issues/investigate.md": "# investigate" } }],
    ["inline bun script", one(`script: |\n  console.log(JSON.stringify({ ok: true }))\nruntime: bun`)],
    ["inline uv script with deps", one(`script: |\n  import httpx\n  print(1)\nruntime: uv\ndeps: ["httpx>=0.27"]`)],
    ["named uv script", one(`script: analyze\nruntime: uv`), { files: { "scripts/analyze.py": "print(1)" } }],
    ["named bun script in a subfolder", one(`script: metrics/summarize\nruntime: bun`), { files: { "scripts/metrics/summarize.ts": "console.log(1)" } }],
    ["loop with until", one(`loop: { prompt: "work <promise>DONE</promise>", until: DONE, max_iterations: 10, fresh_context: true }`)],
    ["loop with until_bash only", one(`loop: { prompt: "work", until_bash: "bun test", max_iterations: 1 }`)],
    ["interactive loop with gate", one(`loop: { prompt: "draft $LOOP_USER_INPUT", until: DONE, max_iterations: 5, interactive: true, gate_message: "Feedback?" }`)],
    ["approval", one(`approval: { message: "Ship it?", capture_response: true, on_reject: { prompt: "Revise: $REJECTION_REASON", max_attempts: 10 }, preset_key: blog-post }`)],
    ["cancel", one(`cancel: "coverage below 100 %"`)],
    ["verify kane with evidence", one(`verify: { runner: kane, objective: "log in", devices: [desktop], headless: true }\nevidence: { require: [screenshot] }`)],
    ["verify bash runner", one(`verify: { runner: bash, command: "bun test" }\nevidence: { require: [test-log] }`)],
    ["best_of", one(`best_of: { n: 8, judge: gavel, criteria: "clarity", prompt: "write" }`)],
    ["interleave by count", one(`interleave: { segments: 16, by: files, synthesize: true, reauthor: false, prompt: "review" }`)],
    ["interleave by names", one(`interleave: { segments: [a, b], prompt: "review" }`)],
    ["hypothesis", one(`hypothesis: { hypotheses: [{ id: h1, claim: "x", predicts: "y" }, { id: h2, claim: "z" }], decide_by: "most supports links" }`)],
    ["mcp_tool", one(`mcp_tool: { server: infranodus, tool: generate_ontology_graph, args: { text: "$ARGUMENTS" } }`)],
    ["workflow node", one(`workflow: { name: other-flow, fan_out: { source: "$ARGUMENTS", as: item, join: all_done }, isolation: worktree }`), { workflowNames: ["other-flow"] }],
    ["workflow node without a name list to check", one(`workflow: { name: other-flow }`)],
    ["architect prompt with read-only tools", one(`role: architect\nprompt: "plan"\nallowed_tools: [read, grep, find, ls]`)],
    ["architect approval", one(`role: architect\napproval: { message: "ok?" }`)],
    ["architect command", one(`role: architect\ncommand: plan`), { files: { "commands/plan.md": "plan" } }],
    ["builder reviewed by an auditor", many(`  - id: build\n    role: builder\n    prompt: "build"\n  - id: audit\n    role: auditor\n    prompt: "audit"\n    depends_on: [build]`)],
    ["builder reviewed by a verify node before returns", many(`  - id: build\n    role: builder\n    prompt: "build"\n  - id: check\n    verify: { runner: kane }\n    evidence: { require: [screenshot] }\n    depends_on: [build]\n  - id: report\n    prompt: "report"\n    depends_on: [check]`, `returns: report\n`)],
    ["builder with review optional needs no reviewer", one(`role: builder\nprompt: "build"\nreview: optional`)],
    ["builder with review none", one(`role: builder\nprompt: "build"\nreview: none`)],
    ["two pooled callsigns", many(`  - id: a\n    prompt: "x"\n    callsign: pool\n  - id: b\n    prompt: "y"\n    callsign: pool`)],
    ["hooks deny bash + post-tool message + stop", one(`prompt: "analyze"\nhooks:\n  PreToolUse:\n    - matcher: "bash"\n      response: { hookSpecificOutput: { hookEventName: PreToolUse, permissionDecision: deny, permissionDecisionReason: "read-only" } }\n      timeout: 30\n  PostToolUse:\n    - matcher: "read"\n      response: { systemMessage: "stay focused" }\n    - response: { hookSpecificOutput: { additionalContext: "verify relevance" } }\n  Stop:\n    - response: { continue: false, stopReason: "done" }`)],
    ["context shared in a sequential chain", many(`  - id: a\n    prompt: "x"\n  - id: b\n    prompt: "y"\n    depends_on: [a]\n    context: shared`)],
    ["context resume of an upstream node", many(`  - id: a\n    prompt: "x"\n  - id: b\n    prompt: "y"\n    depends_on: [a]\n    context: { resume: a }`)],
    ["tier evidence produced by a node", one(`prompt: "x"\nevidence: { produces: [screenshot, log] }`, `titan: { tier: web-general, evidence: { require: [screenshot], dir: evidence } }\n`)],
    ["platform-update ship node with a kane ancestor", many(`  - id: build\n    prompt: "x"\n  - id: sim\n    verify: { runner: kane }\n    evidence: { require: [screenshot] }\n    depends_on: [build]\n  - id: ship\n    bash: "deploy"\n    depends_on: [sim]`, `titan: { tier: platform-update }\n`)],
    ["platform-update fuser returns node with an orca-browser ancestor", many(`  - id: sim\n    verify: { runner: orca-browser }\n    evidence: { require: [screenshot] }\n  - id: final\n    role: fuser\n    prompt: "fuse"\n    depends_on: [sim]`, `titan: { tier: platform-update }\nreturns: final\n`)],
    ["persona present", one(`prompt: "x"\npersona: contrarian`), { files: { "personas/contrarian.md": "# contrarian" }, personaDirs: undefined }],
    ["persona unchecked without personaDirs", one(`prompt: "x"\npersona: missing`)],
    ["output_format $ref audit verdict", one(`prompt: "x"\noutput_format: { $ref: "titan://schemas/audit-verdict" }`)],
    ["when over a $ref schema field (status alias)", many(`  - id: audit\n    prompt: "audit"\n    output_format: { $ref: "titan://schemas/audit-verdict" }\n  - id: report\n    prompt: "report"\n    depends_on: [audit]\n    when: "$audit.output.status == 'PASS' || $audit.output.verdict == 'PASS'"`)],
    ["when over a schema with additionalProperties", many(`  - id: a\n    prompt: "a"\n    output_format: { type: object, properties: { x: { type: string } }, additionalProperties: true }\n  - id: b\n    prompt: "b"\n    depends_on: [a]\n    when: "$a.output.y == 'z'"`)],
    ["transitive upstream reference", many(`  - id: a\n    prompt: "a"\n  - id: b\n    prompt: "b"\n    depends_on: [a]\n  - id: c\n    prompt: "c reads $a.output"\n    depends_on: [b]`)],
    ["thinking at the model ceiling", one(`prompt: "x"\nmodel: cerebras/qwen-3.8-27b\nthinking: high`)],
    ["thinking under a caller-supplied ceiling", one(`prompt: "x"\nmodel: cerebras/qwen-3.8-27b\nthinking: xhigh`), { thinkingCeiling: (_m: string, r: string) => r }],
    ["model status ok", one(`prompt: "x"\nmodel: xai/grok-4.6`), { modelStatus: () => "ok" as const }],
    ["one_success join of two routed branches", many(`  - id: a\n    prompt: "a"\n    output_format: { type: object }\n  - id: b\n    prompt: "b"\n    depends_on: [a]\n    when: "$a.output.k == 1"\n  - id: c\n    prompt: "c"\n    depends_on: [a]\n    when: "$a.output.k == 2"\n  - id: d\n    prompt: "d"\n    depends_on: [b, c]\n    trigger_rule: one_success`)],
  ] as Array<[string, string, Extra?]>).map((row) => [row[0], row[1], row[2] ?? {}] as [string, string, Extra]))("accepts %s", (_label, yaml, extra) => {
    const result = validate(yaml, extra);
    expect(result.errors).toEqual([]);
    expect(result.warnings).toEqual([]);
    expect(result.ok).toBe(true);
  });
});

describe("validator: red fixtures (one per rule)", () => {
  test("a non-mapping document", () => {
    expect(rules(validateWorkflow("just text", { dir: "", commandDirs: [], scriptDirs: [] }))).toEqual(["doc"]);
    expect(rules(validateWorkflow([{ id: "a" }], { dir: "", commandDirs: [], scriptDirs: [] }))).toEqual(["doc"]);
    expect(rules(validateWorkflow(null, { dir: "", commandDirs: [], scriptDirs: [] }))).toEqual(["doc"]);
  });

  test.each(([
    ["steps", `${BASE}steps: []\n`, "steps", "use nodes:"],
    ["steps in place of nodes", `apiVersion: titan.harness/v1\nname: wf\nsteps:\n  - id: a\n    prompt: x\n`, "steps", "use nodes:"],
    ["apiVersion wrong", BASE.replace("titan.harness/v1", "archon/v1"), "apiVersion", "titan.harness/v1"],
    ["apiVersion missing", BASE.replace("apiVersion: titan.harness/v1\n", ""), "apiVersion", "found undefined"],
    ["name pattern", BASE.replace("name: wf", "name: Bad_Name"), "name", "must match"],
    ["provider", `${BASE}provider: claude\n`, "provider", '"pi"'],
    ["nodes empty", `apiVersion: titan.harness/v1\nname: wf\nnodes: []\n`, "nodes", "non-empty"],
    ["nodes missing", `apiVersion: titan.harness/v1\nname: wf\n`, "nodes", "required"],
    ["nodes not a list", `apiVersion: titan.harness/v1\nname: wf\nnodes: { id: a }\n`, "nodes", "non-empty list"],
    ["node not a mapping", `apiVersion: titan.harness/v1\nname: wf\nnodes: [a]\n`, "nodes", "must be a mapping"],
    ["type: version", `${BASE}version: one\n`, "type", "version"],
    ["type: description", BASE.replace("description: three nodes, one route", "description: 3"), "type", "description"],
    ["inputs not a mapping", `${BASE}inputs: [spec]\n`, "inputs", "mapping"],
    ["inputs bad name", `${BASE}inputs:\n  "bad name": { required: true }\n`, "inputs", "bad name"],
    ["inputs required not boolean", `${BASE}inputs:\n  spec: { required: "yes" }\n`, "inputs", "required must be boolean"],
    ["inputs spec not a mapping", `${BASE}inputs:\n  spec: required\n`, "inputs", "must be a mapping"],
    ["returns unknown", `${BASE}returns: nope\n`, "returns", "not a node"],
    ["returns wrong type", `${BASE}returns: 3\n`, "returns", "must name"],
    ["phases entry without title", `${BASE}phases: [{ detail: x }]\n`, "phases", "title"],
    ["phases duplicate title", `${BASE}phases: [{ title: plan }, { title: plan }]\n`, "phases", "twice"],
    ["phases not a list", `${BASE}phases: plan\n`, "phases", "list"],
    ["phase not declared", one(`prompt: "x"\nphase: build`, `phases: [{ title: plan }]\n`), "phase", "not declared"],
    ["phase wrong type", one(`prompt: "x"\nphase: 3`), "phase", "phase title"],
    ["trigger cron fields", `${BASE}trigger: { cron: "* *" }\n`, "trigger", "5 or 6 fields"],
    ["trigger every", `${BASE}trigger: { every: soon }\n`, "trigger", "30s, 15m"],
    ["trigger empty", `${BASE}trigger: {}\n`, "trigger", "one of cron, every or event"],
    ["trigger not a mapping", `${BASE}trigger: hourly\n`, "trigger", "mapping"],
    ["titan level", `${BASE}titan: { level: 4 }\n`, "titan", "between 0 and 3"],
    ["titan level negative", `${BASE}titan: { level: -1 }\n`, "titan", "between 0 and 3"],
    ["titan max_concurrent_children", `${BASE}titan: { budget: { max_concurrent_children: 17 } }\n`, "titan", "between 1 and 16"],
    ["titan max_concurrent_children zero", `${BASE}titan: { budget: { max_concurrent_children: 0 } }\n`, "titan", "between 1 and 16"],
    ["titan on_compaction", `${BASE}titan: { watchdog: { on_compaction: panic } }\n`, "titan", "on_compaction"],
    ["titan elevation", `${BASE}titan: { elevation: ladder }\n`, "titan", "elevation"],
    ["titan not a mapping", `${BASE}titan: 3\n`, "titan", "mapping"],
    ["titan modes", `${BASE}titan: { modes: spec }\n`, "titan", "modes"],
    ["titan budget usd", `${BASE}titan: { budget: { usd: -1 } }\n`, "titan", "usd"],
    ["titan watchdog enabled", `${BASE}titan: { watchdog: { enabled: yes-please } }\n`, "titan", "enabled"],
    ["evidence kind not produced", one(`prompt: "x"\nevidence: { produces: [log] }`, `titan: { evidence: { require: [screenshot] } }\n`), "evidence", "screenshot"],
    ["evidence node not a mapping", one(`prompt: "x"\nevidence: [log]`), "evidence", "mapping"],
    ["evidence produces not a list", one(`prompt: "x"\nevidence: { produces: log }`), "evidence", "produces"],
    ["model not provider/id", one(`prompt: "x"\nmodel: haiku`), "model", "provider/id"],
    ["model top-level", `${BASE}model: haiku\n`, "model", "provider/id"],
    ["model watchdog", `${BASE}titan: { watchdog: { model: haiku } }\n`, "model", "titan.watchdog.model"],
    ["thinking level", one(`prompt: "x"\nthinking: ultra`), "thinking", "one of off, minimal"],
    ["thinking top-level", `${BASE}thinking: 11\n`, "thinking", "one of off"],
    ["id pattern", one(`prompt: "x"`).replace("id: n1", "id: N1"), "id", "must match"],
    ["id missing", `apiVersion: titan.harness/v1\nname: wf\nnodes:\n  - prompt: x\n`, "id", "nodes[0]"],
    ["id duplicate", many(`  - id: a\n    prompt: "x"\n  - id: a\n    prompt: "y"`), "id", "more than once"],
    ["node-type two discriminators", one(`prompt: "x"\nbash: "ls"`), "node-type", "found prompt, bash"],
    ["node-type none", one(`depends_on: []`), "node-type", "found none"],
    ["depends_on unknown", one(`prompt: "x"\ndepends_on: [ghost]`), "depends_on", "ghost"],
    ["depends_on not a list", many(`  - id: a\n    prompt: "x"\n  - id: b\n    prompt: "y"\n    depends_on: a`), "depends_on", "list of node ids"],
    ["cycle of two", many(`  - id: a\n    prompt: "x"\n    depends_on: [b]\n  - id: b\n    prompt: "y"\n    depends_on: [a]`), "cycle", "a, b"],
    ["cycle of three with a tail", many(`  - id: a\n    prompt: "x"\n    depends_on: [c]\n  - id: b\n    prompt: "y"\n    depends_on: [a]\n  - id: c\n    prompt: "z"\n    depends_on: [b]\n  - id: d\n    prompt: "tail"\n    depends_on: [c]`), "cycle", "a, b, c"],
    ["cycle self", one(`prompt: "x"\ndepends_on: [n1]`), "cycle", "itself"],
    ["ref unknown in prompt", one(`prompt: "use $ghost.output"`), "ref", "no node \"ghost\""],
    ["ref unknown in bash", one(`bash: "echo $ghost.output"`), "ref", "ghost"],
    ["ref unknown in inline script", one(`script: |\n  const x = $ghost.output;\nruntime: bun`), "ref", "ghost"],
    ["ref unknown in loop.prompt", one(`loop: { prompt: "do $ghost.output", until: X, max_iterations: 1 }`), "ref", "ghost"],
    ["ref unknown in verify field", one(`verify: { runner: kane, ref: "$ghost.output.branch" }\nevidence: { require: [screenshot] }`), "ref", "ghost"],
    ["ref to self", one(`prompt: "use $n1.output"`), "ref", "own output"],
    ["when grammar", BASE.replace("== 'bug'", "= 'bug'"), "when", "does not parse"],
    ["when unquoted literal", BASE.replace("'bug'", "bug"), "when", "quote string literals"],
    ["when without output_format", BASE.replace("$classify.output.kind == 'bug'", "$fetch.output == 'x'"), "when", "only read nodes with output_format"],
    ["when unknown node", BASE.replace("$classify.output.kind", "$ghost.output.kind"), "ref", "ghost"],
    ["when not a string", BASE.replace(`when: "$classify.output.kind == 'bug'"`, "when: true"), "when", "expression string"],
    ["when on own output", one(`prompt: "x"\noutput_format: { type: object }\nwhen: "$n1.output.k == 1"`), "when", "own output"],
    ["trigger_rule", one(`prompt: "x"\ntrigger_rule: any`), "trigger_rule", "one of all_success"],
    ["retry on loop", one(`loop: { prompt: "p", until: X, max_iterations: 2 }\nretry: { max_attempts: 2 }`), "retry", "loop"],
    ["retry max_attempts range", one(`prompt: "x"\nretry: { max_attempts: 11 }`), "retry", "between 1 and 10"],
    ["retry delay_ms", one(`prompt: "x"\nretry: { delay_ms: -5 }`), "retry", "delay_ms"],
    ["retry not a mapping", one(`prompt: "x"\nretry: 3`), "retry", "mapping"],
    ["command file missing", one(`command: investigate`), "command", "commands/investigate.md not found"],
    ["command escapes", one(`command: "../etc/passwd"`), "command", "bare name"],
    ["command empty", one(`command: ""`), "command", "command file"],
    ["prompt empty", one(`prompt: ""`), "prompt", "non-empty"],
    ["prompt wrong type", one(`prompt: 3`), "prompt", "non-empty string"],
    ["bash empty", one(`bash: ""`), "bash", "non-empty"],
    ["script without runtime", one(`script: "console.log(1)"`), "script", "runtime: bun or runtime: uv"],
    ["script bad runtime", one(`script: "print(1)"\nruntime: node`), "script", "runtime: bun or runtime: uv"],
    ["script named missing", one(`script: analyze\nruntime: uv`), "script", "not found as scripts/analyze"],
    ["script deps wrong type", one(`script: "print(1)"\nruntime: uv\ndeps: httpx`), "script", "deps"],
    ["script empty", one(`script: ""\nruntime: bun`), "script", "inline code or a script name"],
    ["loop max_iterations too high", one(`loop: { prompt: "p", until: X, max_iterations: 11 }`), "loop", "between 1 and 10"],
    ["loop max_iterations zero", one(`loop: { prompt: "p", until: X, max_iterations: 0 }`), "loop", "between 1 and 10"],
    ["loop max_iterations missing", one(`loop: { prompt: "p", until: X }`), "loop", "max_iterations"],
    ["loop without completion", one(`loop: { prompt: "p", max_iterations: 2 }`), "loop", "completion condition"],
    ["loop interactive without gate", one(`loop: { prompt: "p", until: X, max_iterations: 2, interactive: true }`), "loop", "gate_message"],
    ["loop prompt missing", one(`loop: { until: X, max_iterations: 2 }`), "loop", "loop.prompt"],
    ["loop not a mapping", one(`loop: "p"`), "loop", "mapping"],
    ["loop fresh_context type", one(`loop: { prompt: "p", until: X, max_iterations: 2, fresh_context: sometimes }`), "loop", "fresh_context"],
    ["approval message empty", one(`approval: { message: "" }`), "approval", "message"],
    ["approval message missing", one(`approval: { capture_response: true }`), "approval", "message"],
    ["approval on_reject max_attempts low", one(`approval: { message: "ok?", on_reject: { prompt: "redo", max_attempts: 0 } }`), "approval", "between 1 and 10"],
    ["approval on_reject max_attempts high", one(`approval: { message: "ok?", on_reject: { prompt: "redo", max_attempts: 11 } }`), "approval", "between 1 and 10"],
    ["approval on_reject without prompt", one(`approval: { message: "ok?", on_reject: { max_attempts: 2 } }`), "approval", "on_reject"],
    ["approval not a mapping", one(`approval: "ok?"`), "approval", "mapping"],
    ["cancel empty", one(`cancel: ""`), "cancel", "reason"],
    ["cancel wrong type", one(`cancel: 0`), "cancel", "reason"],
    ["verify runner", one(`verify: { runner: selenium }\nevidence: { require: [screenshot] }`), "verify", "runner must be one of"],
    ["verify runner missing", one(`verify: { objective: "x" }\nevidence: { require: [screenshot] }`), "verify", "runner"],
    ["verify without evidence.require", one(`verify: { runner: kane }`), "verify", "evidence.require"],
    ["verify empty evidence.require", one(`verify: { runner: kane }\nevidence: { require: [] }`), "verify", "evidence.require"],
    ["verify devices type", one(`verify: { runner: kane, devices: desktop }\nevidence: { require: [screenshot] }`), "verify", "devices"],
    ["best_of n low", one(`best_of: { n: 1, prompt: "p" }`), "best_of", "between 2 and 8"],
    ["best_of n high", one(`best_of: { n: 9, prompt: "p" }`), "best_of", "between 2 and 8"],
    ["best_of prompt missing", one(`best_of: { n: 3 }`), "best_of", "prompt"],
    ["interleave segments low", one(`interleave: { segments: 1, prompt: "p" }`), "interleave", "between 2 and 16"],
    ["interleave segments high", one(`interleave: { segments: 17, prompt: "p" }`), "interleave", "between 2 and 16"],
    ["interleave segment list too short", one(`interleave: { segments: [a], prompt: "p" }`), "interleave", "2-16 segment names"],
    ["interleave by", one(`interleave: { segments: 2, by: pages, prompt: "p" }`), "interleave", "interleave.by"],
    ["interleave prompt missing", one(`interleave: { segments: 2 }`), "interleave", "prompt"],
    ["hypothesis empty", one(`hypothesis: { hypotheses: [], decide_by: "x" }`), "hypothesis", "at least one"],
    ["hypothesis decide_by missing", one(`hypothesis: { hypotheses: [{ id: h1, claim: c }] }`), "hypothesis", "decide_by"],
    ["hypothesis duplicate id", one(`hypothesis: { hypotheses: [{ id: h1, claim: c }, { id: h1, claim: d }], decide_by: "x" }`), "hypothesis", "twice"],
    ["hypothesis item without claim", one(`hypothesis: { hypotheses: [{ id: h1 }], decide_by: "x" }`), "hypothesis", "non-empty id and claim"],
    ["mcp_tool without tool", one(`mcp_tool: { server: infranodus }`), "mcp_tool", "tool"],
    ["mcp_tool without server", one(`mcp_tool: { tool: x }`), "mcp_tool", "server"],
    ["mcp_tool args type", one(`mcp_tool: { server: s, tool: t, args: [1] }`), "mcp_tool", "args"],
    ["workflow name pattern", one(`workflow: { name: Other }`), "workflow", "workflow.name"],
    ["workflow self call", one(`workflow: { name: wf }`), "workflow", "call itself"],
    ["workflow unknown", one(`workflow: { name: other-flow }`, ""), "workflow", "not installed", { workflowNames: ["something-else"] }],
    ["workflow fan_out join", one(`workflow: { name: other-flow, fan_out: { source: "$ARGUMENTS", as: item, join: some } }`), "workflow", "fan_out.join"],
    ["workflow fan_out incomplete", one(`workflow: { name: other-flow, fan_out: { source: "$ARGUMENTS" } }`), "workflow", "fan_out"],
    ["workflow isolation", one(`workflow: { name: other-flow, isolation: docker }`), "workflow", "isolation"],
    ["role", one(`prompt: "x"\nrole: ceo`), "role", "one of architect"],
    ["architect allowed_tools write", one(`role: architect\nprompt: "x"\nallowed_tools: [read, write]`), "architect", "write"],
    ["architect allowed_tools edit", one(`role: architect\nprompt: "x"\nallowed_tools: [read, edit]`), "architect", "edit"],
    ["architect allowed_tools bash", one(`role: architect\nprompt: "x"\nallowed_tools: [read, bash]`), "architect", "bash"],
    ["tools allowed_tools not a list", one(`prompt: "x"\nallowed_tools: read`), "tools", "list of tool names"],
    ["tools denied_tools not a list", one(`prompt: "x"\ndenied_tools: 3`), "tools", "list of tool names"],
    ["review unreviewed builder", one(`role: builder\nprompt: "build"`), "review", "no auditor or verify node follows"],
    ["review builder with explicit required", many(`  - id: build\n    role: builder\n    prompt: "build"\n    review: required\n  - id: after\n    prompt: "summarize"\n    depends_on: [build]`), "review", "review: required"],
    ["review reviewer after returns", many(`  - id: build\n    role: builder\n    prompt: "build"\n  - id: audit\n    role: auditor\n    prompt: "audit"\n    depends_on: [build]`, `returns: build\n`), "review", "before returns"],
    ["review policy", one(`prompt: "x"\nreview: sometimes`), "review", "one of required"],
    ["callsign duplicate", many(`  - id: a\n    prompt: "x"\n    callsign: forge\n  - id: b\n    prompt: "y"\n    callsign: forge`), "callsign", "unique per workflow"],
    ["callsign type", one(`prompt: "x"\ncallsign: 7`), "callsign", "callsign"],
    ["hooks not a mapping", one(`prompt: "x"\nhooks: [deny]`), "hooks", "mapping"],
    ["hooks rules not a list", one(`prompt: "x"\nhooks: { PreToolUse: { matcher: bash } }`), "hooks", "list"],
    ["hooks response missing", one(`prompt: "x"\nhooks: { PreToolUse: [{ matcher: bash }] }`), "hooks", "response is required"],
    ["hooks matcher regex", one(`prompt: "x"\nhooks: { PreToolUse: [{ matcher: "(", response: { systemMessage: hi } }] }`), "hooks", "valid regex"],
    ["hooks hookEventName mismatch", one(`prompt: "x"\nhooks: { PreToolUse: [{ response: { hookSpecificOutput: { hookEventName: PostToolUse, permissionDecision: deny } } }] }`), "hooks", "hookEventName must be PreToolUse"],
    ["hooks permissionDecision", one(`prompt: "x"\nhooks: { PreToolUse: [{ response: { hookSpecificOutput: { permissionDecision: maybe } } }] }`), "hooks", "permissionDecision"],
    ["hooks continue type", one(`prompt: "x"\nhooks: { Stop: [{ response: { continue: "no" } }] }`), "hooks", "continue"],
    ["hooks decision", one(`prompt: "x"\nhooks: { PreToolUse: [{ response: { decision: reject } }] }`), "hooks", "decision"],
    ["context shared in a parallel layer", many(`  - id: a\n    prompt: "a"\n  - id: b\n    prompt: "b"\n    depends_on: [a]\n    context: shared\n  - id: c\n    prompt: "c"\n    depends_on: [a]`), "context", "parallel layer (with c)"],
    ["context resume unknown", one(`prompt: "x"\ncontext: { resume: ghost }`), "context", "unknown node"],
    ["context resume self", one(`prompt: "x"\ncontext: { resume: n1 }`), "context", "itself"],
    ["context value", one(`prompt: "x"\ncontext: sometimes`), "context", "fresh, shared or"],
    ["context mapping without resume", one(`prompt: "x"\ncontext: { fork: a }`), "context", "fresh, shared or"],
    ["platform-update ship without sim-user ancestor", many(`  - id: build\n    prompt: "x"\n  - id: ship-it\n    bash: "deploy"\n    depends_on: [build]`, `titan: { tier: platform-update }\n`), "platform-update", "simulated-user verify ancestor"],
    ["platform-update ship with only a bash verify", many(`  - id: check\n    verify: { runner: bash, command: "bun test" }\n    evidence: { require: [test-log] }\n  - id: ship\n    bash: "deploy"\n    depends_on: [check]`, `titan: { tier: platform-update }\n`), "platform-update", "kane, momentic, orca-browser"],
    ["platform-update fuser returns node", many(`  - id: build\n    prompt: "x"\n  - id: final\n    role: fuser\n    prompt: "fuse"\n    depends_on: [build]`, `titan: { tier: platform-update }\nreturns: final\n`), "platform-update", "ship node"],
    ["persona missing", one(`prompt: "x"\npersona: contrarian`, ""), "persona", "personas/contrarian.md", { personaDirs: ["/nonexistent"] }],
    ["persona type", one(`prompt: "x"\npersona: 3`), "persona", "persona name"],
    ["output_format not a mapping", one(`prompt: "x"\noutput_format: object`), "output_format", "JSON Schema mapping"],
    ["output_format unknown $ref", one(`prompt: "x"\noutput_format: { $ref: "titan://schemas/nope" }`), "output_format", "not a known"],
    ["output_format type", one(`prompt: "x"\noutput_format: { type: 3 }`), "output_format", "type name"],
    ["on_fail action", one(`prompt: "x"\non_fail: { action: panic }`), "on_fail", "action"],
    ["on_fail max", one(`prompt: "x"\non_fail: { action: elevate, max: 11 }`), "on_fail", "between 1 and 10"],
    ["type: idle_timeout", one(`prompt: "x"\nidle_timeout: -1`), "type", "idle_timeout"],
    ["type: timeout", one(`bash: "ls"\ntimeout: 1.5`), "type", "timeout"],
    ["type: context_budget", one(`prompt: "x"\ncontext_budget: 0`), "type", "context_budget"],
    ["type: isolation", one(`prompt: "x"\nisolation: docker`), "type", "isolation"],
    ["type: anonymize", one(`prompt: "x"\nanonymize: "yes"`), "type", "anonymize"],
    ["type: watchdog policy", one(`prompt: "x"\nwatchdog: { policy: loose }`), "type", "watchdog"],
    ["type: budget usd", one(`prompt: "x"\nbudget: { usd: -1 }`), "type", "budget.usd"],
    ["type: subagents cap", one(`prompt: "x"\nsubagents: { cap: -1 }`), "type", "subagents.cap"],
    ["type: subagents enabled", one(`prompt: "x"\nsubagents: { enabled: maybe }`), "type", "subagents.enabled"],
    ["type: mcp", one(`prompt: "x"\nmcp: infranodus`), "type", "mcp"],
    ["type: skills", one(`prompt: "x"\nskills: x`), "type", "skills"],
    ["type: append_system_prompt", one(`prompt: "x"\nappend_system_prompt: { a: 1 }`), "type", "append_system_prompt"],
    ["type: system_prompt", one(`prompt: "x"\nsystem_prompt: 3`), "type", "system_prompt"],
  ] as Array<[string, string, string, string, Extra?]>).map((row) => [row[0], row[1], row[2], row[3], row[4] ?? {}] as [string, string, string, string, Extra]))("rejects %s", (_label, yaml, rule, message, extra) => {
    const result = validate(yaml, extra);
    expect(result.ok).toBe(false);
    expect(rules(result)).toContain(rule);
    expect(result.errors.some((e) => e.rule === rule && e.message.includes(message))).toBe(true);
  });

  test("name must equal the workflow directory name", () => {
    const dir = workflowDir("other-dir");
    const result = validateWorkflow(parseYaml(BASE), { dir, commandDirs: [dir], scriptDirs: [dir] });
    expect(rules(result)).toEqual(["name"]);
    expect(result.errors[0].message).toContain('"wf" must equal the workflow directory name "other-dir"');
    // an empty dir skips the check (documents validated before they are written anywhere)
    expect(validateWorkflow(parseYaml(BASE), { dir: "", commandDirs: [], scriptDirs: [] }).ok).toBe(true);
  });

  test("model status: unknown is an error, unauthed a warning, ok silent", () => {
    const yaml = one(`prompt: "x"\nmodel: anthropic/claude-fable-5-1`);
    expect(rules(validate(yaml, { modelStatus: () => "unknown" }))).toEqual(["model"]);
    const unauthed = validate(yaml, { modelStatus: () => "unauthed" });
    expect(unauthed.ok).toBe(true);
    expect(warnRules(unauthed)).toEqual(["model"]);
    expect(unauthed.warnings[0].message).toContain("no credentials");
    expect(validate(yaml, { modelStatus: () => "ok" }).warnings).toEqual([]);
    expect(validate(yaml).warnings).toEqual([]); // no modelStatus → no registry check
  });

  test("named script extension must match the declared runtime", () => {
    const result = validate(one(`script: analyze\nruntime: bun`), { files: { "scripts/analyze.py": "print(1)" } });
    expect(rules(result)).toEqual(["script"]);
    expect(result.errors[0].message).toContain(".py → uv");
    expect(result.errors[0].message).toContain("runtime is bun");
    expect(validate(one(`script: analyze\nruntime: uv`), { files: { "scripts/analyze.py": "print(1)" } }).ok).toBe(true);
  });

  test("isInlineScript follows Archon's metacharacter rule", () => {
    for (const named of ["analyze", "metrics/summarize", "a-b_c"]) expect(isInlineScript(named)).toBe(false);
    for (const inline of ["print(1)", "a b", "x;y", "line1\nline2", "$x", "`x`", "a|b", "<x>", "{x}", "'q'", '"q"', "a&b"]) expect(isInlineScript(inline)).toBe(true);
  });

  test("hook responses with functions are rejected (static data only)", () => {
    const doc = parseYaml(one(`prompt: "x"`)) as Record<string, unknown>;
    (doc.nodes as Array<Record<string, unknown>>)[0].hooks = { PreToolUse: [{ matcher: "bash", response: { decide: () => "deny" } }] };
    const result = validateWorkflow(doc, { dir: "", commandDirs: [], scriptDirs: [] });
    expect(rules(result)).toEqual(["hooks"]);
    expect(result.errors[0].message).toContain("no functions");
  });

  test.each([
    ["architect bash", `role: architect\nbash: "ls"`],
    ["architect script", `role: architect\nscript: "print(1)"\nruntime: uv`],
    ["architect workflow", `role: architect\nworkflow: { name: other-flow }`],
    ["architect verify", `role: architect\nverify: { runner: kane }\nevidence: { require: [screenshot] }`],
    ["architect loop", `role: architect\nloop: { prompt: "p", until: X, max_iterations: 2 }`],
    ["architect best_of", `role: architect\nbest_of: { n: 2, prompt: "p" }`],
    ["architect interleave", `role: architect\ninterleave: { segments: 2, prompt: "p" }`],
    ["architect mcp_tool", `role: architect\nmcp_tool: { server: s, tool: t }`],
    ["architect cancel", `role: architect\ncancel: "no"`],
    ["architect hypothesis", `role: architect\nhypothesis: { hypotheses: [{ id: h, claim: c }], decide_by: x }`],
  ])("constraint 5: %s is rejected by node type", (_label, body) => {
    const result = validate(one(body));
    expect(rules(result)).toEqual(["architect"]);
    expect(result.errors[0].message).toContain("may only be prompt, command or approval");
  });
});

describe("validator: warnings", () => {
  test.each([
    ["unknown top-level key", `${BASE}sidebar: true\n`, "unknown-key", "sidebar"],
    ["unknown node key", one(`prompt: "x"\ncolour: red`), "unknown-key", "colour"],
    ["unknown titan key", `${BASE}titan: { levels: 3 }\n`, "unknown-key", "titan.levels"],
    ["unknown loop key", one(`loop: { prompt: "p", until: X, max_iterations: 2, retries: 3 }`), "unknown-key", "loop.retries"],
    ["unknown inputs key", `${BASE}inputs:\n  spec: { required: true, type: string }\n`, "unknown-key", "inputs.spec.type"],
    ["AI key on a bash node", one(`bash: "ls"\nmodel: xai/grok-4.6`), "ignored-key", "ignored on bash"],
    ["AI key on a script node", one(`script: "print(1)"\nruntime: uv\nallowed_tools: []`), "ignored-key", "ignored on script"],
    ["runtime on a prompt node", one(`prompt: "x"\nruntime: bun`), "ignored-key", "only applies to script"],
    ["deps with bun", one(`script: "console.log(1)"\nruntime: bun\ndeps: [left-pad]`), "script", "uv-only"],
    ["unknown hook event", one(`prompt: "x"\nhooks: { SessionStart: [{ response: { systemMessage: hi } }] }`), "hooks", "ignored on Pi"],
    ["unknown hook rule key", one(`prompt: "x"\nhooks: { PreToolUse: [{ response: { systemMessage: hi }, priority: 1 }] }`), "unknown-key", "priority"],
    ["unknown hook response key", one(`prompt: "x"\nhooks: { PreToolUse: [{ response: { systemMessage: hi, retry: true } }] }`), "unknown-key", "response.retry"],
    ["capitalized tool name", one(`prompt: "x"\nallowed_tools: [Read, grep]`), "tools", "lowercase"],
    ["thinking above the static ceiling", one(`prompt: "x"\nmodel: cerebras/qwen-3.8-27b\nthinking: xhigh`), "thinking", "requested xhigh / effective high"],
    ["thinking above a caller-supplied ceiling", one(`prompt: "x"\nmodel: xai/grok-4.6\nthinking: max`), "thinking", "requested max / effective xhigh"],
    ["top-level thinking above the ceiling", `${BASE}model: antigravity/gemini-3.8-flash\nthinking: xhigh\n`, "thinking", "requested xhigh / effective high"],
    ["ref without a dependency", many(`  - id: a\n    prompt: "a"\n  - id: b\n    prompt: "reads $a.output"`), "ref-order", "not upstream"],
    ["when ref without a dependency", many(`  - id: a\n    prompt: "a"\n    output_format: { type: object }\n  - id: b\n    prompt: "b"\n    when: "$a.output.k == 1"`), "ref-order", "fail closed"],
    ["when field not in the schema", BASE.replace("$classify.output.kind ==", "$classify.output.kinds =="), "when-field", "declares only kind"],
    ["context resume of a non-upstream node", many(`  - id: a\n    prompt: "a"\n  - id: b\n    prompt: "b"\n    context: { resume: a }`), "context", "not upstream"],
    ["required input with a default", `${BASE}inputs:\n  spec: { required: true, default: x }\n`, "inputs", "never applies"],
  ] as Array<[string, string, string, string]>)("warns on %s", (label, yaml, rule, message) => {
    const extra: Extra = label.includes("caller-supplied") ? { thinkingCeiling: (_m, r) => (r === "max" ? "xhigh" : r) } : {};
    const result = validate(yaml, extra);
    expect(result.errors).toEqual([]);
    expect(result.ok).toBe(true);
    expect(warnRules(result)).toContain(rule);
    expect(result.warnings.some((w) => w.rule === rule && w.message.includes(message))).toBe(true);
  });
});

describe("validator: normalization", () => {
  test("architect prompt/command nodes get denied_tools write, edit, bash; the input is untouched", () => {
    const doc = parseYaml(many(`  - id: plan\n    role: architect\n    prompt: "plan"\n    allowed_tools: [read, grep]\n  - id: gate\n    role: architect\n    approval: { message: "ok?" }\n  - id: draft\n    role: architect\n    command: draft\n    denied_tools: [write, subagent]\n  - id: build\n    role: builder\n    prompt: "build"\n    review: optional\n    depends_on: [plan]`));
    const dir = workflowDir("wf", { "commands/draft.md": "draft" });
    const result = validateWorkflow(doc, { dir, commandDirs: [dir], scriptDirs: [dir] });
    expect(result.ok).toBe(true);
    const byId = (id: string) => (result.normalized!.nodes as Array<Record<string, unknown>>).find((n) => n.id === id)!;
    expect(byId("plan").denied_tools).toEqual(["write", "edit", "bash"]);
    expect(byId("plan").allowed_tools).toEqual(["read", "grep"]);
    expect(byId("gate").denied_tools).toBeUndefined(); // approval nodes hold no tools
    expect(byId("draft").denied_tools).toEqual(["write", "subagent", "edit", "bash"]); // existing entries kept, no duplicates
    expect(byId("build").denied_tools).toBeUndefined();
    // the original document is not mutated and the normalized copy is independent
    expect((doc.nodes as Array<Record<string, unknown>>)[0].denied_tools).toBeUndefined();
    (byId("plan").allowed_tools as string[]).push("bash");
    expect((doc.nodes as Array<Record<string, unknown>>)[0].allowed_tools).toEqual(["read", "grep"]);
  });

  test("normalized is present even when the document has errors, so callers can inspect it", () => {
    const result = validate(one(`role: architect\nbash: "ls"`));
    expect(result.ok).toBe(false);
    expect(result.normalized?.nodes).toHaveLength(1);
  });
});

describe("validateFile, formatIssues and the shipped workflows", () => {
  const shipped = fileURLToPath(new URL("../../../.pi/titan-harness/workflows/", import.meta.url));

  test.each(["classify-and-fix", "proto-analytics-dashboard"])("%s validates with zero errors and zero warnings", (name) => {
    const result = validateFile(join(shipped, name, `${name}.yaml`));
    expect(result.errors).toEqual([]);
    expect(result.warnings).toEqual([]);
    expect(result.ok).toBe(true);
    expect(result.path).toBe(join(shipped, name, `${name}.yaml`));
    expect((result.doc as { name: string }).name).toBe(name);
  });

  test("classify-and-fix: the Archon port keeps the routing, join and fresh contexts", () => {
    const result = validateFile(join(shipped, "classify-and-fix", "classify-and-fix.yaml"));
    const nodes = result.normalized!.nodes as Array<Record<string, unknown>>;
    expect(nodes.map((n) => n.id)).toEqual(["fetch-issue", "classify", "investigate", "plan", "implement", "create-pr"]);
    expect(nodes[1]).toMatchObject({ model: "cerebras/qwen-3.8-27b", allowed_tools: [] });
    expect(nodes.filter((n) => typeof n.prompt === "string")).toHaveLength(5);
    expect(nodes.some((n) => n.command)).toBe(false);
    expect(parseWhen(nodes[2].when as string).refs).toEqual(["classify"]);
    expect(nodes[4]).toMatchObject({ trigger_rule: "one_success", depends_on: ["investigate", "plan"] });
    expect(result.normalized!.returns).toBe("create-pr");
  });

  test("proto-analytics-dashboard: architect nodes are normalized, the review chain holds", () => {
    const result = validateFile(join(shipped, "proto-analytics-dashboard", "proto-analytics-dashboard.yaml"));
    const nodes = result.normalized!.nodes as Array<Record<string, unknown>>;
    expect(nodes.filter((n) => n.role === "architect").map((n) => [n.id, n.denied_tools])).toEqual([["spec-map", ["write", "edit", "bash"]], ["report", ["write", "edit", "bash"]]]);
    expect(result.normalized!.titan).toMatchObject({ level: 3, tier: "prototype-analytics", budget: { max_concurrent_children: 8 } });
    expect(result.normalized!.phases?.map((p) => p.title)).toEqual(["plan", "build", "verify", "audit", "report"]);
  });

  test("validateFile reports a YAML syntax error as rule yaml and a missing file as rule file", () => {
    const dir = workflowDir("wf");
    writeFileSync(join(dir, "wf.yaml"), "apiVersion: [unclosed\nname: wf\n");
    const broken = validateFile(join(dir, "wf.yaml"));
    expect(broken.ok).toBe(false);
    expect(rules(broken)).toEqual(["yaml"]);
    expect(rules(validateFile(join(dir, "missing.yaml")))).toEqual(["file"]);
  });

  test("validateFile on a steps: document errors with 'use nodes:' and defaults dir to the file's directory", () => {
    const dir = workflowDir("legacy");
    writeFileSync(join(dir, "legacy.yaml"), "apiVersion: titan.harness/v1\nname: legacy\nsteps:\n  - id: a\n    prompt: x\n");
    const result = validateFile(join(dir, "legacy.yaml"));
    expect(result.ok).toBe(false);
    expect(result.errors.find((e) => e.rule === "steps")?.message).toContain("use nodes:");
    expect(rules(result)).not.toContain("name"); // dir defaulted to the file's directory, which matches the name
  });

  test("formatIssues renders a summary line and glyph-prefixed rows", () => {
    const result = validate(`${BASE}provider: claude\nsidebar: true\n`);
    const text = formatIssues(result);
    expect(text.split("\n")[0]).toBe("invalid: 1 error, 1 warning");
    expect(text).toContain('  ✗ [provider] provider must be absent or "pi"');
    expect(text).toContain('  ⚠ [unknown-key] top-level key "sidebar" is unknown and ignored');
    expect(formatIssues(validate(BASE))).toBe("valid");
    expect(formatIssues(validate(`${BASE}sidebar: true\n`)).split("\n")[0]).toBe("valid with 1 warning");
    const withNode = formatIssues(validate(one(`prompt: ""`)));
    expect(withNode).toContain("  ✗ [prompt] n1: prompt must be a non-empty string");
  });
});
