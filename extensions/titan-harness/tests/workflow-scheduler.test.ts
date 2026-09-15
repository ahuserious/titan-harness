import { describe, expect, test } from "bun:test";
import type { NodeDoc, WorkflowDoc } from "../modules/workflow/schema.ts";
import { type NodeStatus, evaluateWhen, layers, readiness } from "../modules/workflow/scheduler.ts";

const doc = (nodes: Array<Partial<NodeDoc> & { id: string }>): WorkflowDoc =>
  ({ apiVersion: "titan.harness/v1", name: "t", nodes: nodes.map((n) => ({ prompt: "x", ...n })) }) as WorkflowDoc;

describe("layers", () => {
  test("the Archon classify-and-fix DAG layers in document order", () => {
    const d = doc([
      { id: "fetch-issue" },
      { id: "classify", depends_on: ["fetch-issue"] },
      { id: "investigate", depends_on: ["classify"] },
      { id: "plan", depends_on: ["classify"] },
      { id: "implement", depends_on: ["investigate", "plan"], trigger_rule: "one_success" },
      { id: "create-pr", depends_on: ["implement"] },
    ]);
    expect(layers(d)).toEqual([["fetch-issue"], ["classify"], ["investigate", "plan"], ["implement"], ["create-pr"]]);
  });

  test("independent roots share layer 0; a node lands one past its deepest dependency", () => {
    const d = doc([{ id: "b", depends_on: ["a"] }, { id: "a" }, { id: "c" }, { id: "d", depends_on: ["c", "b"] }, { id: "e", depends_on: ["a"] }]);
    expect(layers(d)).toEqual([["a", "c"], ["b", "e"], ["d"]]);
    expect(layers(doc([]))).toEqual([]);
  });

  test("cycles and unresolvable dependencies throw", () => {
    expect(() => layers(doc([{ id: "a", depends_on: ["b"] }, { id: "b", depends_on: ["a"] }]))).toThrow(/cycle among nodes: a, b/);
    expect(() => layers(doc([{ id: "a", depends_on: ["ghost"] }]))).toThrow(/unresolvable depends_on: ghost/);
  });
});

describe("readiness", () => {
  const node = (trigger_rule?: NodeDoc["trigger_rule"], deps = ["a", "b"]): NodeDoc => ({ id: "n", prompt: "x", depends_on: deps, trigger_rule }) as NodeDoc;
  const st = (a: NodeStatus, b: NodeStatus): Record<string, NodeStatus> => ({ a, b });

  test("no dependencies → run", () => {
    expect(readiness(node(undefined, []), {})).toBe("run");
    expect(readiness({ id: "n", prompt: "x" } as NodeDoc, {})).toBe("run");
  });

  test("all_success (default)", () => {
    expect(readiness(node(), st("success", "success"))).toBe("run");
    expect(readiness(node("all_success"), st("success", "success"))).toBe("run");
    expect(readiness(node(), st("success", "running"))).toBe("wait");
    expect(readiness(node(), st("success", "pending"))).toBe("wait");
    expect(readiness(node(), st("success", "failed"))).toBe("skip");
    expect(readiness(node(), st("skipped", "running"))).toBe("skip");
    expect(readiness(node(), st("cancelled", "success"))).toBe("skip");
    expect(readiness(node(), { a: "success" })).toBe("wait"); // unknown dep counts as pending
  });

  test("one_success", () => {
    expect(readiness(node("one_success"), st("success", "skipped"))).toBe("run");
    expect(readiness(node("one_success"), st("failed", "success"))).toBe("run");
    expect(readiness(node("one_success"), st("success", "running"))).toBe("wait");
    expect(readiness(node("one_success"), st("skipped", "skipped"))).toBe("skip");
    expect(readiness(node("one_success"), st("failed", "cancelled"))).toBe("skip");
  });

  test("none_failed_min_one_success", () => {
    expect(readiness(node("none_failed_min_one_success"), st("success", "skipped"))).toBe("run");
    expect(readiness(node("none_failed_min_one_success"), st("success", "success"))).toBe("run");
    expect(readiness(node("none_failed_min_one_success"), st("failed", "pending"))).toBe("skip");
    expect(readiness(node("none_failed_min_one_success"), st("success", "failed"))).toBe("skip");
    expect(readiness(node("none_failed_min_one_success"), st("skipped", "skipped"))).toBe("skip");
    expect(readiness(node("none_failed_min_one_success"), st("success", "waiting"))).toBe("wait");
  });

  test("all_done", () => {
    expect(readiness(node("all_done"), st("failed", "skipped"))).toBe("run");
    expect(readiness(node("all_done"), st("success", "cancelled"))).toBe("run");
    expect(readiness(node("all_done"), st("success", "running"))).toBe("wait");
  });
});

describe("evaluateWhen", () => {
  const outputs = {
    classify: { issue_type: "bug", score: 7, ok: true, nothing: null, tags: ["a", "b"], nested: { level: 2 } },
    count: 5,
    name: "zeta",
    numeric: "10",
  };
  const cases: Array<[string, boolean]> = [
    ["$classify.output.issue_type == 'bug'", true],
    ['$classify.output.issue_type == "feature"', false],
    ["$classify.output.issue_type != 'feature'", true],
    ["$classify.output.score > 5", true],
    ["$classify.output.score < 5", false],
    ["$classify.output.score >= 7", true],
    ["$classify.output.score <= 6", false],
    ["$count.output == 5", true],
    ["$numeric.output > 9", true], // numeric string vs number compares numerically
    ["$name.output > 'alpha'", true], // two strings compare lexicographically
    ["$classify.output.ok == true", true],
    ["$classify.output.ok != false", true],
    ["$classify.output.nothing == null", true],
    ["$classify.output.nothing != null", false],
    ["$classify.output.nested.level == 2", true],
    ["$classify.output.tags.1 == 'b'", true],
    ["$classify.output.tags == ['a', 'b']", false], // arrays are not literals — the parse fails closed
    ["$classify.output.score > 5 && $classify.output.issue_type == 'bug'", true],
    ["$classify.output.score > 50 || $classify.output.issue_type == 'bug'", true],
    ["$classify.output.score > 50 && $classify.output.issue_type == 'bug'", false],
    ["($classify.output.score > 50 || $count.output == 5) && $classify.output.ok", true],
    ["!( $classify.output.score > 50 )", true],
    ["!$classify.output.ok", false],
    ["$classify.output.ok", true],
    ["$classify.output.nothing", false],
    ["true", true],
    ["false || 0", false],
    ["1 < 2 && 'a' != 'b'", true],
    ["$classify.output.score == -1.5", false],
  ];
  for (const [expr, expected] of cases) {
    test(`${expr} → ${expected}`, () => {
      const result = evaluateWhen(expr, outputs);
      expect(result.value).toBe(expected);
      if (expected) expect(result.error).toBeUndefined();
    });
  }

  test("unresolved refs fail closed with an error", () => {
    expect(evaluateWhen("$missing.output == 'x'", outputs)).toEqual({ value: false, error: expect.stringContaining('node "missing" has no output') });
    expect(evaluateWhen("$classify.output.nope == 'x'", outputs)).toEqual({ value: false, error: expect.stringContaining('missing field "nope"') });
    expect(evaluateWhen("$classify.output.issue_type.deeper == 'x'", outputs).error).toMatch(/on a string/);
    expect(evaluateWhen("$classify.result == 'x'", outputs).error).toMatch(/expected \$classify\.output/);
    expect(evaluateWhen("$classify.output.tags.9 == 'x'", outputs).error).toMatch(/index 9/);
  });

  test("malformed expressions fail closed with an error", () => {
    expect(evaluateWhen("$classify.output.issue_type = 'bug'", outputs).error).toMatch(/unexpected/);
    expect(evaluateWhen("$classify.output.score > ", outputs).error).toMatch(/unexpected end/);
    expect(evaluateWhen("($classify.output.score > 1", outputs).error).toMatch(/missing \)/);
    expect(evaluateWhen("$classify.output.issue_type == 'bug", outputs).error).toMatch(/unterminated string/);
    expect(evaluateWhen("classify.output == 'bug'", outputs).error).toMatch(/unknown identifier/);
    expect(evaluateWhen("", outputs)).toEqual({ value: false, error: "empty expression" });
    expect(evaluateWhen("$classify.output.ok > true", outputs).error).toMatch(/cannot order/);
    expect(evaluateWhen("$classify.output.nested > 1", outputs).error).toMatch(/cannot order/);
    expect(evaluateWhen("$count.output == 5 5", outputs).error).toMatch(/unexpected token/);
  });
});
