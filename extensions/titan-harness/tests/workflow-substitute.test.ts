import { describe, expect, test } from "bun:test";
import { type SubstitutionContext, listReferences, renderValue, resolveReference, shellQuote, substitute } from "../modules/workflow/substitute.ts";

const ctx: SubstitutionContext = {
  inputs: { spec: "docs/spec.md", x: "ex", count: 3, config: { host: "localhost", ports: [80, 443] } },
  outputs: {
    "fetch-issue": "Issue #12: login fails",
    classify: { issue_type: "bug", meta: { severity: "high", tags: ["auth", "ui"] }, note: null },
    tricky: `it's $5 and "quoted" \`ticks\``,
    n: 42,
  },
  artifactsDir: "/runs/r1/artifacts",
  workflowId: "classify-and-fix",
  runId: "run-20260915T000000Z-abc123",
  arguments: "12",
  loopCount: 2,
};

describe("substitute: prompt mode", () => {
  test("run variables and $ARTIFACTS_DIR paths", () => {
    expect(substitute("Read $ARTIFACTS_DIR/investigation.md for issue $ARGUMENTS in $WORKFLOW_ID ($RUN_ID) round $LOOP_COUNT", ctx, "prompt")).toBe(
      "Read /runs/r1/artifacts/investigation.md for issue 12 in classify-and-fix (run-20260915T000000Z-abc123) round 2",
    );
  });

  test("known but unset variables render empty; variables never take a chain", () => {
    expect(substitute("[$LOOP_USER_INPUT][$REJECTION_REASON][$BASE_BRANCH][$CONTEXT]", ctx, "prompt")).toBe("[][][][]");
    expect(substitute("log: $RUN_ID.log", ctx, "prompt")).toBe("log: run-20260915T000000Z-abc123.log");
  });

  test("$inputs.x and $input.x, nested keys and array indices", () => {
    expect(substitute("spec=$inputs.spec x=$input.x n=$inputs.count", ctx, "prompt")).toBe("spec=docs/spec.md x=ex n=3");
    expect(substitute("$inputs.config.host:$inputs.config.ports.1", ctx, "prompt")).toBe("localhost:443");
    expect(substitute("file $inputs.x.txt", ctx, "prompt")).toBe("file ex.txt");
  });

  test("$node.output and $node.output.field.sub; objects pretty-printed", () => {
    expect(substitute("Classify this issue: $fetch-issue.output", ctx, "prompt")).toBe("Classify this issue: Issue #12: login fails");
    expect(substitute("type=$classify.output.issue_type sev=$classify.output.meta.severity tag=$classify.output.meta.tags.0 note=$classify.output.note", ctx, "prompt")).toBe(
      "type=bug sev=high tag=auth note=null",
    );
    expect(substitute("all: $classify.output", ctx, "prompt")).toBe(`all: ${JSON.stringify(ctx.outputs.classify, null, 2)}`);
    expect(substitute("n=$n.output", ctx, "prompt")).toBe("n=42");
  });

  test("unknown refs are left untouched and reported", () => {
    const unknown: string[] = [];
    const out = substitute("$nope.output $classify.output.missing $inputs.nada $UNKNOWN_VAR $HOME ${x} $1 $ $classify.outputs", ctx, "prompt", (ref) => unknown.push(ref));
    expect(out).toBe("$nope.output $classify.output.missing $inputs.nada $UNKNOWN_VAR $HOME ${x} $1 $ $classify.outputs");
    expect(unknown).toEqual(["$nope.output", "$classify.output.missing", "$inputs.nada", "$UNKNOWN_VAR", "$HOME", "$1", "$classify.outputs"]);
    expect(substitute("no refs here", ctx, "prompt")).toBe("no refs here");
    expect(substitute("bare $inputs", ctx, "prompt")).toBe("bare $inputs");
  });
});

describe("substitute: bash mode", () => {
  test("every value is single-quote escaped, quotes and $ included", () => {
    expect(shellQuote(`it's $5`)).toBe(`'it'\\''s $5'`);
    expect(substitute("echo $tricky.output", ctx, "bash")).toBe(`echo 'it'\\''s $5 and "quoted" \`ticks\`'`);
    expect(substitute("gh issue view $ARGUMENTS --json title", ctx, "bash")).toBe("gh issue view '12' --json title");
  });

  test("objects are compact JSON inside the quotes; paths concatenate; shell variables survive", () => {
    expect(substitute("cat $ARTIFACTS_DIR/plan.md", ctx, "bash")).toBe("cat '/runs/r1/artifacts'/plan.md");
    expect(substitute("printf %s $classify.output.meta", ctx, "bash")).toBe(`printf %s '{"severity":"high","tags":["auth","ui"]}'`);
    expect(substitute("echo $HOME $? ${PATH} $inputs.count", ctx, "bash")).toBe("echo $HOME $? ${PATH} '3'");
  });
});

describe("substitute: script and raw modes", () => {
  test("strings verbatim, objects compact JSON, no quoting", () => {
    expect(substitute("const data = $classify.output;", ctx, "script")).toBe(`const data = {"issue_type":"bug","meta":{"severity":"high","tags":["auth","ui"]},"note":null};`);
    expect(substitute("const s = `$tricky.output`;", ctx, "script")).toBe("const s = `it's $5 and \"quoted\" `ticks``;");
    expect(substitute("x = $inputs.count + $n.output", ctx, "raw")).toBe("x = 3 + 42");
    expect(substitute("$classify.output", ctx, "raw")).toBe(substitute("$classify.output", ctx, "script"));
  });
});

describe("substitute helpers", () => {
  test("resolveReference resolves values and reports unknown bases", () => {
    expect(resolveReference("$classify.output.meta.tags", ctx)).toEqual({ found: true, value: ["auth", "ui"], rest: "" });
    expect(resolveReference("$inputs.x.txt", ctx)).toEqual({ found: true, value: "ex", rest: ".txt" });
    expect(resolveReference("$ARGUMENTS", ctx)).toEqual({ found: true, value: "12", rest: "" });
    expect(resolveReference("$nope.output", ctx).found).toBe(false);
    expect(resolveReference("not a ref", ctx).found).toBe(false);
  });

  test("renderValue per mode and listReferences", () => {
    expect(renderValue(undefined, "prompt")).toBe("");
    expect(renderValue(true, "bash")).toBe("'true'");
    expect(renderValue({ a: 1 }, "prompt")).toBe('{\n  "a": 1\n}');
    expect(renderValue({ a: 1 }, "script")).toBe('{"a":1}');
    expect(listReferences("$a.output and $a.output again, $b.output.x, $ARGUMENTS")).toEqual(["$a.output", "$b.output.x", "$ARGUMENTS"]);
  });
});
