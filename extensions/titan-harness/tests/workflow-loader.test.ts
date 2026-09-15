import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  aiNodeIds,
  commandFile,
  defaultValidateContext,
  listWorkflows,
  loadWorkflow,
  packageRoot,
  parseFrontmatter,
  readWorkflowFile,
  resolveWorkflow,
  resourceRoots,
  workflowDirs,
  workflowFileIn,
} from "../modules/workflow/loader.ts";

const dirs: string[] = [];
afterEach(() => { while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true }); });
function scratch(): string { const dir = mkdtempSync(join(tmpdir(), "titan-wf-loader-")); dirs.push(dir); return dir; }

/** Write files under a root; keys are relative paths. */
function tree(root: string, files: Record<string, string>): string {
  for (const [rel, body] of Object.entries(files)) { mkdirSync(dirname(join(root, rel)), { recursive: true }); writeFileSync(join(root, rel), body); }
  return root;
}

const simple = (name: string, description: string, nodes = `  - id: hello\n    bash: "echo hello"\n`): string => `apiVersion: titan.harness/v1\nname: ${name}\ndescription: ${description}\nreturns: hello\nnodes:\n${nodes}`;

/** A cwd with a project root plus isolated user and package roots — `roots` are the overrides for every loader call. */
function sandbox() {
  const cwd = scratch();
  const user = join(scratch(), "workflows");
  const pkg = join(scratch(), ".pi", "titan-harness", "workflows");
  mkdirSync(user, { recursive: true });
  mkdirSync(pkg, { recursive: true });
  const project = join(cwd, ".titan", "workflows");
  return { cwd, user, pkg, project, roots: { user, package: pkg } };
}

describe("workflow directories", () => {
  test("workflowDirs: project under cwd, user under ~/.pi/titan-harness, package under the repo", () => {
    const cwd = scratch();
    const dirs = workflowDirs(cwd);
    expect(dirs.project).toBe(join(cwd, ".titan", "workflows"));
    expect(dirs.user.endsWith(join(".pi", "titan-harness", "workflows"))).toBe(true);
    expect(dirs.package).toBe(join(packageRoot(), ".pi", "titan-harness", "workflows"));
    expect(packageRoot()).toBe(fileURLToPath(new URL("../../../", import.meta.url)).replace(/\/$/, ""));
    expect(workflowDirs(cwd, { user: "/u", package: "/p" })).toEqual({ project: join(cwd, ".titan", "workflows"), user: "/u", package: "/p" });
  });

  test("resourceRoots and defaultValidateContext: workflow dir, <cwd>/.titan, user root, package root", () => {
    const { cwd, user, pkg, roots } = sandbox();
    const wf = join(cwd, ".titan", "workflows", "x");
    expect(resourceRoots(wf, cwd, roots)).toEqual([wf, join(cwd, ".titan"), dirname(user), dirname(dirname(pkg))]);
    const ctx = defaultValidateContext(wf, cwd, roots);
    expect(ctx.dir).toBe(wf);
    expect(ctx.commandDirs).toEqual(resourceRoots(wf, cwd, roots));
    expect(ctx.scriptDirs).toEqual(ctx.commandDirs);
    expect(ctx.personaDirs).toEqual([...ctx.commandDirs, packageRoot()]); // + <pkg>/personas/*.md (personas.ts)
    expect(ctx.workflowNames).toEqual([]);
    expect(resourceRoots(wf, cwd)[2].endsWith(join(".pi", "titan-harness"))).toBe(true);
    expect(resourceRoots(wf, cwd)[3]).toBe(join(packageRoot(), ".pi", "titan-harness"));
  });

  test("workflowFileIn accepts .yaml then .yml and needs the file named after the directory", () => {
    const root = scratch();
    tree(root, { "a/a.yaml": "x", "b/b.yml": "x", "c/other.yaml": "x", "d/d.yaml": "x", "d/d.yml": "x" });
    expect(workflowFileIn(join(root, "a"))).toBe(join(root, "a", "a.yaml"));
    expect(workflowFileIn(join(root, "b"))).toBe(join(root, "b", "b.yml"));
    expect(workflowFileIn(join(root, "c"))).toBeUndefined();
    expect(workflowFileIn(join(root, "d"))).toBe(join(root, "d", "d.yaml"));
    expect(workflowFileIn(join(root, "missing"))).toBeUndefined();
  });
});

describe("listWorkflows precedence", () => {
  test("project shadows user shadows package; directories without <name>.yaml are skipped", () => {
    const { cwd, user, pkg, project, roots } = sandbox();
    tree(pkg, { "alpha/alpha.yaml": simple("alpha", "package alpha"), "gamma/gamma.yaml": simple("gamma", "package gamma"), "broken/readme.md": "not a workflow" });
    tree(user, { "alpha/alpha.yaml": simple("alpha", "user alpha"), "beta/beta.yaml": simple("beta", "user beta") });
    tree(project, { "alpha/alpha.yaml": simple("alpha", "project alpha"), "notes.txt": "x" });
    expect(listWorkflows(cwd, roots)).toEqual([
      { name: "alpha", dir: join(project, "alpha"), source: "project" },
      { name: "beta", dir: join(user, "beta"), source: "user" },
      { name: "gamma", dir: join(pkg, "gamma"), source: "package" },
    ]);
    rmSync(join(project, "alpha"), { recursive: true });
    expect(listWorkflows(cwd, roots).find((w) => w.name === "alpha")).toEqual({ name: "alpha", dir: join(user, "alpha"), source: "user" });
  });

  test("missing roots are simply empty", () => {
    const cwd = scratch();
    expect(listWorkflows(cwd, { user: join(cwd, "nope"), package: join(cwd, "nope2") })).toEqual([]);
  });
});

describe("loadWorkflow", () => {
  test("by name: a project workflow shadows the package one of the same name, with sha256 of the bytes", () => {
    const { cwd, pkg, project, roots } = sandbox();
    tree(pkg, { "alpha/alpha.yaml": simple("alpha", "package alpha") });
    const projectText = simple("alpha", "project alpha");
    tree(project, { "alpha/alpha.yaml": projectText });
    const loaded = loadWorkflow("alpha", cwd, undefined, roots);
    expect(loaded.source).toBe("project");
    expect(loaded.dir).toBe(join(project, "alpha"));
    expect(loaded.path).toBe(join(project, "alpha", "alpha.yaml"));
    expect(loaded.name).toBe("alpha");
    expect(loaded.doc.description).toBe("project alpha");
    expect(loaded.sha256).toBe(createHash("sha256").update(readFileSync(loaded.path)).digest("hex"));
    expect(loaded.sha256).toBe(createHash("sha256").update(projectText).digest("hex"));
    expect(loaded.validation.ok).toBe(true);
    expect(loaded.commands).toEqual({});
    expect(loaded.scripts).toEqual({});
    expect(loaded.normalized).not.toBe(loaded.doc);
    expect(loaded.normalized.nodes).toEqual(loaded.doc.nodes);
    rmSync(join(project, "alpha"), { recursive: true });
    const fallback = loadWorkflow("alpha", cwd, undefined, roots);
    expect(fallback.source).toBe("package");
    expect(fallback.doc.description).toBe("package alpha");
    expect(fallback.sha256).not.toBe(loaded.sha256);
  });

  test("by path: a yaml file, a workflow directory, or a relative path from cwd", () => {
    const { cwd, pkg, roots } = sandbox();
    tree(pkg, { "alpha/alpha.yaml": simple("alpha", "package alpha") });
    const adhoc = tree(scratch(), { "solo/solo.yaml": simple("solo", "ad hoc") });
    expect(loadWorkflow(join(pkg, "alpha", "alpha.yaml"), cwd, undefined, roots)).toMatchObject({ source: "package", name: "alpha" });
    expect(loadWorkflow(join(pkg, "alpha"), cwd, undefined, roots)).toMatchObject({ source: "package", name: "alpha" });
    expect(loadWorkflow(join(adhoc, "solo"), cwd, undefined, roots)).toMatchObject({ source: "project", name: "solo", dir: join(adhoc, "solo") });
    tree(cwd, { "local/local.yaml": simple("local", "relative") });
    expect(loadWorkflow("./local", cwd, undefined, roots)).toMatchObject({ source: "project", name: "local" });
    expect(loadWorkflow("local/local.yaml", cwd, undefined, roots)).toMatchObject({ name: "local" });
    expect(resolveWorkflow("nope", cwd, roots)).toBeUndefined();
    expect(resolveWorkflow("./nope", cwd, roots)).toBeUndefined();
  });

  test("throws with the formatted issues when validation has errors, and when the workflow is missing", () => {
    const { cwd, project, roots } = sandbox();
    tree(project, { "bad/bad.yaml": "apiVersion: titan.harness/v1\nname: bad\nnodes:\n  - id: a\n    prompt: x\n    when: \"$ghost.output == 1\"\n" });
    expect(() => loadWorkflow("bad", cwd, undefined, roots)).toThrow(/workflow invalid .*bad\.yaml.*\n.*invalid: 1 error\n {2}✗ \[ref\] a: when reads \$ghost\.output/s);
    expect(() => loadWorkflow("nope", cwd, undefined, roots)).toThrow(/workflow "nope" not found \(installed: bad;/);
    tree(project, { "steps/steps.yaml": "apiVersion: titan.harness/v1\nname: steps\nsteps: []\n" });
    expect(() => loadWorkflow("steps", cwd, undefined, roots)).toThrow("use nodes:");
    tree(project, { "torn/torn.yaml": "apiVersion: [\n" });
    expect(() => loadWorkflow("torn", cwd, undefined, roots)).toThrow("workflow YAML invalid");
  });

  test("ctx overrides reach the validator (modelStatus unknown → throws; unauthed → kept as a warning)", () => {
    const { cwd, project, roots } = sandbox();
    tree(project, { "m/m.yaml": simple("m", "model", `  - id: hello\n    prompt: "hi"\n    model: anthropic/claude-fable-5-1\n`) });
    expect(() => loadWorkflow("m", cwd, { modelStatus: () => "unknown" }, roots)).toThrow("not in Pi's model registry");
    const loaded = loadWorkflow("m", cwd, { modelStatus: () => "unauthed", workflowNames: undefined }, roots);
    expect(loaded.validation.warnings.map((w) => w.rule)).toEqual(["model"]);
    expect(loadWorkflow("m", cwd, undefined, roots).validation.warnings).toEqual([]);
  });

  test("commands: bodies are loaded with frontmatter stripped, workflow-local commands/ beats <cwd>/.titan/commands/", () => {
    const { cwd, project, roots } = sandbox();
    tree(project, {
      "cmd/cmd.yaml": simple("cmd", "commands", `  - id: hello\n    command: investigate\n  - id: shared\n    command: plan-feature\n    depends_on: [hello]\n`),
      "cmd/commands/investigate.md": "---\ndescription: Investigate an issue\nargument-hint: <issue number>\n---\n# Investigate\n\nRead $ARGUMENTS.\n",
    });
    tree(join(cwd, ".titan"), { "commands/investigate.md": "PROJECT-LEVEL (shadowed)", "commands/plan-feature.md": "Plan the feature.\n" });
    const loaded = loadWorkflow("cmd", cwd, undefined, roots);
    expect(loaded.commands).toEqual({ investigate: "# Investigate\n\nRead $ARGUMENTS.\n", "plan-feature": "Plan the feature.\n" });
    const file = commandFile("investigate", loaded.validation.ok ? resourceRoots(loaded.dir, cwd, roots) : []);
    expect(file?.path).toBe(join(project, "cmd", "commands", "investigate.md"));
    expect(file?.meta).toEqual({ description: "Investigate an issue", "argument-hint": "<issue number>" });
    expect(file?.text).toBe("# Investigate\n\nRead $ARGUMENTS.\n");
    expect(commandFile("missing", [loaded.dir])).toBeUndefined();
    expect(commandFile("../escape", [loaded.dir])).toBeUndefined();
    // a <root>/<name>.md next to a bare root also resolves (roots that already point at a commands folder)
    expect(commandFile("investigate", [join(project, "cmd", "commands")])?.text).toBe("# Investigate\n\nRead $ARGUMENTS.\n");
  });

  test("scripts: named scripts resolve to their path, inline scripts are left alone", () => {
    const { cwd, project, roots } = sandbox();
    tree(project, {
      "sc/sc.yaml": simple("sc", "scripts", `  - id: hello\n    script: analyze\n    runtime: uv\n  - id: inline\n    script: |\n      console.log(1)\n    runtime: bun\n    depends_on: [hello]\n`),
      "sc/scripts/analyze.py": "print(1)\n",
    });
    const loaded = loadWorkflow("sc", cwd, undefined, roots);
    expect(loaded.scripts).toEqual({ analyze: join(project, "sc", "scripts", "analyze.py") });
    expect(aiNodeIds(loaded)).toEqual([]);
  });

  test("readWorkflowFile hashes the exact bytes and parses the document", () => {
    const root = tree(scratch(), { "w/w.yaml": "apiVersion: titan.harness/v1\nname: w\nnodes: []\n" });
    const read = readWorkflowFile(join(root, "w", "w.yaml"));
    expect(read.sha256).toBe(createHash("sha256").update("apiVersion: titan.harness/v1\nname: w\nnodes: []\n").digest("hex"));
    expect(read.bytes).toBe(Buffer.byteLength("apiVersion: titan.harness/v1\nname: w\nnodes: []\n"));
    expect(read.doc).toEqual({ apiVersion: "titan.harness/v1", name: "w", nodes: [] });
  });

  test("the shipped package workflows load by name with no warnings and expose their AI nodes", () => {
    const { cwd, user } = sandbox();
    const classify = loadWorkflow("classify-and-fix", cwd, undefined, { user });
    expect(classify.source).toBe("package");
    expect(classify.dir).toBe(join(packageRoot(), ".pi", "titan-harness", "workflows", "classify-and-fix"));
    expect(classify.validation.errors).toEqual([]);
    expect(classify.validation.warnings).toEqual([]);
    expect(classify.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(aiNodeIds(classify)).toEqual(["classify", "investigate", "plan", "implement", "create-pr"]);
    const proto = loadWorkflow("proto-analytics-dashboard", cwd, undefined, { user });
    expect(proto.validation.warnings).toEqual([]);
    expect(aiNodeIds(proto)).toEqual(["spec-map", "test-suite", "implement", "audit", "report"]);
    expect(proto.normalized.nodes.find((n) => n.id === "spec-map")).toMatchObject({ denied_tools: ["write", "edit", "bash"] });
    expect(listWorkflows(cwd, { user }).map((w) => [w.name, w.source])).toEqual(expect.arrayContaining([["classify-and-fix", "package"], ["proto-analytics-dashboard", "package"]]));
  });
});

describe("parseFrontmatter", () => {
  test("splits a leading YAML block from the body", () => {
    expect(parseFrontmatter("---\ndescription: d\nargument-hint: <x>\n---\nbody line\n")).toEqual({ meta: { description: "d", "argument-hint": "<x>" }, body: "body line\n" });
    expect(parseFrontmatter("---\r\ndescription: d\r\n---\r\nbody")).toEqual({ meta: { description: "d" }, body: "body" });
    expect(parseFrontmatter("---\ndescription: d\n---")).toEqual({ meta: { description: "d" }, body: "" });
  });

  test("no frontmatter, a non-mapping block, or malformed YAML leaves the text alone", () => {
    expect(parseFrontmatter("# plain\n---\nnot frontmatter\n")).toEqual({ meta: {}, body: "# plain\n---\nnot frontmatter\n" });
    expect(parseFrontmatter("---\n- a\n- b\n---\nbody")).toEqual({ meta: {}, body: "body" });
    expect(parseFrontmatter("---\n[broken\n---\nbody")).toEqual({ meta: {}, body: "body" });
    expect(parseFrontmatter("")).toEqual({ meta: {}, body: "" });
  });
});
