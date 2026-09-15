import { describe, expect, test } from "bun:test";
import { AUDIT_VERDICT_SCHEMA, jsonTypeOf, resolveRef, validateJson } from "../modules/workflow/json-schema.ts";
import {
  AI_NODE_TYPES,
  API_VERSION,
  ARCHITECT_NODE_TYPES,
  ID_RE,
  NAME_RE,
  NODE_KEYS,
  NODE_TYPES,
  PI_TOOL_NAMES,
  READONLY_TOOL_NAMES,
  VARIABLE_NAMES,
  WRITE_TOOLS,
  isAiNode,
  nodeType,
  nodeTypesOf,
  outputRefs,
  parseWhen,
} from "../modules/workflow/schema.ts";

describe("workflow schema constants", () => {
  test("apiVersion, node types and tool tables match the contract", () => {
    expect(API_VERSION).toBe("titan.harness/v1");
    expect(NODE_TYPES).toEqual(["command", "prompt", "bash", "script", "loop", "approval", "cancel", "verify", "best_of", "interleave", "hypothesis", "mcp_tool", "workflow"]);
    expect(AI_NODE_TYPES).toEqual(["command", "prompt", "loop", "best_of", "interleave", "hypothesis"]);
    expect(ARCHITECT_NODE_TYPES).toEqual(["prompt", "command", "approval"]);
    expect(VARIABLE_NAMES).toEqual(["ARGUMENTS", "ARTIFACTS_DIR", "WORKFLOW_ID", "RUN_ID", "BASE_BRANCH", "CONTEXT", "LOOP_USER_INPUT", "REJECTION_REASON", "LOOP_COUNT"]);
    expect(PI_TOOL_NAMES).toEqual(["read", "bash", "edit", "write", "grep", "find", "ls"]);
    expect(WRITE_TOOLS).toEqual(["write", "edit", "bash"]);
    expect(READONLY_TOOL_NAMES).toEqual(["read", "grep", "find", "ls"]);
    for (const type of NODE_TYPES) expect(NODE_KEYS.has(type)).toBe(true);
  });

  test("id and name patterns", () => {
    for (const ok of ["a", "fetch-issue", "spec_map", "n1", "x".repeat(32)]) expect(ID_RE.test(ok)).toBe(true);
    for (const bad of ["", "-a", "Fetch", "a b", "x".repeat(33), "a.b"]) expect(ID_RE.test(bad)).toBe(false);
    for (const ok of ["classify-and-fix", "wf", "a1", "x".repeat(64)]) expect(NAME_RE.test(ok)).toBe(true);
    for (const bad of ["", "Classify", "a_b", "-x", "x".repeat(65)]) expect(NAME_RE.test(bad)).toBe(false);
  });
});

describe("nodeType / isAiNode", () => {
  test.each([
    ["command", { id: "a", command: "investigate" }],
    ["prompt", { id: "a", prompt: "hi" }],
    ["bash", { id: "a", bash: "ls" }],
    ["script", { id: "a", script: "x.py", runtime: "uv" }],
    ["loop", { id: "a", loop: { prompt: "p", until: "DONE", max_iterations: 2 } }],
    ["approval", { id: "a", approval: { message: "ok?" } }],
    ["cancel", { id: "a", cancel: "stop" }],
    ["verify", { id: "a", verify: { runner: "kane" } }],
    ["best_of", { id: "a", best_of: { n: 3, prompt: "p" } }],
    ["interleave", { id: "a", interleave: { segments: 2, prompt: "p" } }],
    ["hypothesis", { id: "a", hypothesis: { hypotheses: [], decide_by: "x" } }],
    ["mcp_tool", { id: "a", mcp_tool: { server: "s", tool: "t" } }],
    ["workflow", { id: "a", workflow: { name: "other" } }],
  ])("recognizes a %s node", (type, node) => {
    expect(nodeType(node)).toBe(type as never);
    expect(isAiNode(node)).toBe(AI_NODE_TYPES.includes(type as never));
  });

  test("zero or two discriminators → undefined; nodeTypesOf lists them all", () => {
    expect(nodeType({ id: "a" })).toBeUndefined();
    expect(nodeType({ id: "a", prompt: "p", bash: "ls" })).toBeUndefined();
    expect(nodeTypesOf({ id: "a", prompt: "p", bash: "ls" })).toEqual(["prompt", "bash"]);
    expect(nodeType({ id: "a", prompt: null })).toBeUndefined(); // a null discriminator does not count
    expect(nodeType("prompt")).toBeUndefined();
    expect(nodeType(null)).toBeUndefined();
    expect(isAiNode({ id: "a" })).toBe(false);
  });
});

describe("outputRefs", () => {
  test("finds $id.output and $id.output.field references once each, in order", () => {
    expect(outputRefs("Classify: $fetch-issue.output and $classify.output.issue_type then $fetch-issue.output again")).toEqual(["fetch-issue", "classify"]);
    expect(outputRefs("read $ARTIFACTS_DIR/investigation.md and $inputs.spec")).toEqual([]);
    expect(outputRefs("$a.outputs is not a ref, $b.output. is")).toEqual(["b"]);
    expect(outputRefs("")).toEqual([]);
  });
});

describe("parseWhen", () => {
  test.each([
    ["$classify.output.issue_type == 'bug'", ["classify"]],
    ['$classify.output.issue_type != "feature"', ["classify"]],
    ["$a.output.n >= 2 && $b.output.n < 10", ["a", "b"]],
    ["($a.output.ok == true || $b.output == null) && $c.output.x <= -1.5", ["a", "b", "c"]],
    ["$audit.output.status == 'PASS'", ["audit"]],
    ["$x.output.deep.path.here == 'v'", ["x"]],
    ["'a' == 'a'", []],
    ["$a.output.n > 1 && $a.output.n < 3", ["a"]],
    ["  $a.output.s == 'it\\'s'  ", ["a"]],
  ])("accepts %s", (expr, refs) => {
    const parsed = parseWhen(expr);
    expect(parsed.ok).toBe(true);
    expect(parsed.error).toBeUndefined();
    expect(parsed.refs).toEqual(refs);
    expect(parsed.ast).toBeDefined();
  });

  test("builds an AST with precedence: && binds tighter than ||, parentheses group", () => {
    const parsed = parseWhen("$a.output.x == 1 || $b.output.y == 2 && $c.output.z == 3");
    expect(parsed.ast).toEqual({
      kind: "or",
      items: [
        { kind: "compare", op: "==", left: { kind: "ref", node: "a", path: ["x"], text: "$a.output.x" }, right: { kind: "literal", value: 1, text: "1" } },
        {
          kind: "and",
          items: [
            { kind: "compare", op: "==", left: { kind: "ref", node: "b", path: ["y"], text: "$b.output.y" }, right: { kind: "literal", value: 2, text: "2" } },
            { kind: "compare", op: "==", left: { kind: "ref", node: "c", path: ["z"], text: "$c.output.z" }, right: { kind: "literal", value: 3, text: "3" } },
          ],
        },
      ],
    });
    const grouped = parseWhen("($a.output.x == 1 || $b.output.y == 2) && $c.output.z == 3");
    expect(grouped.ast?.kind).toBe("and");
    expect(parseWhen("$b.output == null").ast).toEqual({ kind: "compare", op: "==", left: { kind: "ref", node: "b", path: [], text: "$b.output" }, right: { kind: "literal", value: null, text: "null" } });
  });

  test.each([
    ["", "empty when expression"],
    ["   ", "empty when expression"],
    ["$classify.output.issue_type = 'bug'", "single '='"],
    ["$classify.output.issue_type == bug", "quote string literals"],
    ["$ARGUMENTS == 'x'", "unsupported reference $ARGUMENTS"],
    ["$inputs.spec == 'x'", "unsupported reference $inputs.spec"],
    ["$a.output", "expected a comparison operator"],
    ["$a.output.x == 'open", "unterminated string literal"],
    ["$a.output.x == 'a' &&", "expected a $node.output reference or a literal"],
    ["$a.output.x == 'a' & $b.output.y == 'b'", "single '&'"],
    ["($a.output.x == 'a'", "expected ')'"],
    ["$a.output.x == 'a')", "unexpected ')'"],
    ["!$a.output.ok == true", "'!' is not supported"],
    ["$a.output.x == 'a' 'b'", "unexpected"],
    ["$a.output.x == 1 == 2", "unexpected '=='"],
    ["$a.output.x == #", "unexpected character '#'"],
  ])("rejects %s", (expr, message) => {
    const parsed = parseWhen(expr);
    expect(parsed.ok).toBe(false);
    expect(parsed.error).toContain(message);
    expect(parsed.ast).toBeUndefined();
  });

  test("refs are collected even when the expression fails later on", () => {
    expect(parseWhen("$a.output.x == 1 &&").refs).toEqual(["a"]);
  });
});

describe("json-schema validateJson", () => {
  test("jsonTypeOf names integers, numbers, arrays, objects and null", () => {
    expect([1, 1.5, "s", true, null, [], {}, undefined].map(jsonTypeOf)).toEqual(["integer", "number", "string", "boolean", "null", "array", "object", "undefined"]);
  });

  test.each<[string, unknown, Record<string, unknown>, string[]]>([
    ["string ok", "x", { type: "string" }, []],
    ["string wrong type", 1, { type: "string" }, ["$"]],
    ["integer accepts whole numbers only", 1.5, { type: "integer" }, ["$"]],
    ["number accepts integers", 2, { type: "number" }, []],
    ["type list", null, { type: ["string", "null"] }, []],
    ["type list miss", 3, { type: ["string", "null"] }, ["$"]],
    ["enum ok", "bug", { type: "string", enum: ["bug", "feature"] }, []],
    ["enum miss", "chore", { type: "string", enum: ["bug", "feature"] }, ["$"]],
    ["enum with objects", { a: 1 }, { enum: [{ a: 1 }] }, []],
    ["required missing", { a: 1 }, { type: "object", required: ["a", "b"] }, ["$.b"]],
    ["nested property", { a: { b: "x" } }, { type: "object", properties: { a: { type: "object", properties: { b: { type: "integer" } } } } }, ["$.a.b"]],
    ["items", [1, "two", 3], { type: "array", items: { type: "integer" } }, ["$[1]"]],
    ["additionalProperties false", { a: 1, extra: 2 }, { type: "object", properties: { a: {} }, additionalProperties: false }, ["$.extra"]],
    ["additionalProperties schema", { a: 1, extra: "s" }, { type: "object", properties: { a: {} }, additionalProperties: { type: "integer" } }, ["$.extra"]],
    ["minimum/maximum", 11, { type: "integer", minimum: 1, maximum: 10 }, ["$"]],
    ["minLength/maxLength", "", { type: "string", minLength: 1 }, ["$"]],
    ["maxLength", "abcd", { type: "string", maxLength: 3 }, ["$"]],
    ["$ref audit verdict ok", { verdict: "PASS", summary: "fine", blocking: [], warnings: [] }, { $ref: "titan://schemas/audit-verdict" }, []],
    ["$ref audit verdict bad enum + missing summary", { verdict: "MEH" }, { $ref: "titan://schemas/audit-verdict" }, ["$.summary", "$.verdict"]],
    ["$ref unknown", {}, { $ref: "titan://schemas/nope" }, ["$"]],
    ["$ref foreign", {}, { $ref: "https://example.com/x.json" }, ["$"]],
    ["unknown keywords ignored", "x", { type: "string", format: "email", pattern: "^y" }, []],
  ])("%s", (_label, value, schema, paths) => {
    expect(validateJson(value, schema as never).map((e) => e.path).sort()).toEqual([...paths].sort());
  });

  test("error messages say what was expected and found", () => {
    const [error] = validateJson(5, { type: "string" });
    expect(error.message).toContain("expected string");
    expect(error.message).toContain("found integer");
    expect(validateJson({ verdict: "FAIL" }, AUDIT_VERDICT_SCHEMA)[0]).toEqual({ path: "$.summary", message: "required property is missing" });
  });

  test("resolveRef knows the audit verdict and nothing else", () => {
    expect(resolveRef("titan://schemas/audit-verdict")).toBe(AUDIT_VERDICT_SCHEMA);
    expect(resolveRef("titan://schemas/other")).toBeUndefined();
    expect(resolveRef("audit-verdict")).toBeUndefined();
    expect(AUDIT_VERDICT_SCHEMA.properties?.verdict?.enum).toEqual(["PASS", "PASS_WITH_WARNINGS", "FAIL", "INCONCLUSIVE", "SAFETY", "SCOPE_VIOLATION"]);
    expect(AUDIT_VERDICT_SCHEMA.required).toEqual(["verdict", "summary"]);
    expect(Object.keys(AUDIT_VERDICT_SCHEMA.properties ?? {})).toEqual(expect.arrayContaining(["verdict", "status", "round", "summary", "checklist", "evidence_state", "blocking", "warnings"]));
  });
});
