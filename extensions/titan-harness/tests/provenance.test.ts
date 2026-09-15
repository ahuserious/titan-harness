import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sha256, verifyChain } from "../modules/hash-chain.ts";
import { looksLikePath, readProvenance, recordToolEnd } from "../modules/provenance.ts";

const dirs: string[] = [];
afterEach(() => { while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true }); });
function scratch(prefix = "titan-provenance-"): string { const dir = mkdtempSync(join(tmpdir(), prefix)); dirs.push(dir); return dir; }

describe("path tokens", () => {
  test("recognises files and rejects flags, urls, globs, numbers", () => {
    for (const yes of ["src/a.ts", "a.ts", "./run.sh", "/etc/hosts", "~/notes.md", "README.md", "dist/"]) expect(looksLikePath(yes)).toBe(true);
    for (const no of ["-o", "--output", "http://x.y/z", "*.ts", "1.5", "3.14", "$HOME/x", ".", "..", "/", "npm", "src/{a,b}.ts"]) expect(looksLikePath(no)).toBe(false);
  });
});

describe("recordToolEnd", () => {
  test("classifies write, edit, read and bash edges with hashed identities", async () => {
    const cwd = scratch("titan-provenance-cwd-");
    const dir = scratch("titan-provenance-run-");
    const runId = "run-p";
    const a = join(cwd, "src", "a.txt");
    mkdirSync(join(cwd, "src"));

    writeFileSync(a, "one\n");
    const wrote = await recordToolEnd(dir, { runId, agentId: "b1", toolCallId: "call-1", tool: "write", toolArgs: { path: "src/a.txt", content: "one\n" }, cwd });
    expect(wrote.inputs).toEqual([]);
    expect(wrote.outputs).toHaveLength(1);
    expect(wrote.outputs[0]).toMatchObject({ path: a, sha256: sha256("one\n"), size: 4, change: "created", confidence: "observed", identityAt: "live" });
    expect(wrote.outputs[0].degraded).toBeUndefined();
    expect(typeof wrote.outputs[0].mtimeMs).toBe("number");
    expect(wrote).toMatchObject({ runId, agentId: "b1", toolCallId: "call-1", tool: "write" });

    writeFileSync(a, "one\ntwo\n");
    const edited = await recordToolEnd(dir, { runId, agentId: "b1", tool: "edit", toolArgs: { path: a, edits: [{ oldText: "one", newText: "one\ntwo" }] }, cwd });
    expect(edited.outputs[0]).toMatchObject({ path: a, sha256: sha256("one\ntwo\n"), change: "modified", confidence: "observed" });

    writeFileSync(a, "three\n");
    const rewrote = await recordToolEnd(dir, { runId, tool: "write", toolArgs: { path: "src/a.txt", content: "three\n" }, cwd });
    expect(rewrote.outputs[0]).toMatchObject({ change: "modified", sha256: sha256("three\n") }); // this run already knows the path

    const read = await recordToolEnd(dir, { runId, agentId: "b1", tool: "read", toolArgs: { path: "src/a.txt" }, cwd });
    expect(read.outputs).toEqual([]);
    expect(read.inputs[0]).toMatchObject({ path: a, sha256: sha256("three\n"), change: "read", confidence: "observed" });

    const out = join(cwd, "out.txt");
    writeFileSync(out, "sorted\n");
    writeFileSync(join(cwd, "log.txt"), "log\n");
    const bash = await recordToolEnd(dir, { runId, agentId: "b1", tool: "bash", toolArgs: { command: "cat src/a.txt | sort > out.txt && rm old.txt; ./build.sh --flag -o dist/app.js log.txt" }, cwd });
    expect(bash.inputs.map((e) => [e.path, e.change, e.confidence])).toEqual([
      [a, "read", "inferred"],
      [join(cwd, "build.sh"), "read", "inferred"],
      [join(cwd, "log.txt"), "read", "inferred"],
    ]);
    expect(bash.inputs[0].sha256).toBe(sha256("three\n"));
    expect(bash.inputs[1]).toMatchObject({ degraded: "unhashed" });
    expect(bash.inputs[2].sha256).toBe(sha256("log\n"));
    expect(bash.outputs.map((e) => [e.path, e.change])).toEqual([
      [out, "created"],
      [join(cwd, "old.txt"), "deleted"],
      [join(cwd, "dist", "app.js"), "unknown"],
    ]);
    expect(bash.outputs[0]).toMatchObject({ sha256: sha256("sorted\n"), confidence: "inferred" });
    expect(bash.outputs[1].sha256).toBeUndefined();
    expect(bash.outputs[2]).toMatchObject({ degraded: "unhashed", confidence: "inferred" });

    const steps = readProvenance(dir);
    expect(steps.map((s) => s.tool)).toEqual(["write", "edit", "write", "read", "bash"]);
    expect(verifyChain(join(dir, "provenance.jsonl"))).toEqual({ ok: true, rows: 5 });
  });

  test("never throws on missing files, directories or errored calls", async () => {
    const cwd = scratch("titan-provenance-cwd-");
    const dir = scratch("titan-provenance-run-");
    const missing = await recordToolEnd(dir, { runId: "run-p", tool: "read", toolArgs: { path: "nope/gone.md" }, cwd, isError: true });
    expect(missing.inputs[0]).toMatchObject({ path: join(cwd, "nope", "gone.md"), change: "read", degraded: "unhashed,tool-error" });
    expect(missing.inputs[0].sha256).toBeUndefined();
    mkdirSync(join(cwd, "pkg"));
    const listed = await recordToolEnd(dir, { runId: "run-p", tool: "ls", toolArgs: { path: "pkg" }, cwd });
    expect(listed.inputs[0]).toMatchObject({ path: join(cwd, "pkg"), change: "read", degraded: "directory" });
    const noPath = await recordToolEnd(dir, { runId: "run-p", tool: "grep", toolArgs: { pattern: "todo" }, cwd });
    expect(noPath.inputs).toEqual([]);
    const existed = await recordToolEnd(dir, { runId: "run-p", tool: "write", toolArgs: { path: "fresh.txt", content: "" }, cwd, existedBefore: true });
    expect(existed.outputs[0]).toMatchObject({ change: "modified", degraded: "unhashed" });
    writeFileSync(join(cwd, "data.csv"), "a,b\n");
    const other = await recordToolEnd(dir, { runId: "run-p", tool: "titan_harness__infranodus__analyze", toolArgs: { file_path: join(cwd, "data.csv"), text: "not a path" }, cwd });
    expect(other.inputs).toHaveLength(1);
    expect(other.inputs[0]).toMatchObject({ path: join(cwd, "data.csv"), change: "unknown", confidence: "inferred", sha256: sha256("a,b\n") });
    expect(readProvenance(dir)).toHaveLength(5);
    expect(readProvenance(scratch())).toEqual([]);
  });
});
