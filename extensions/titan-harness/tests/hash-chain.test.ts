import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync, appendFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GENESIS, appendChained, canonicalJson, chainTail, readChain, sha256, sha256File, verifyChain } from "../modules/hash-chain.ts";

const dirs: string[] = [];
afterEach(() => { while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true }); });
function scratch(): string { const dir = mkdtempSync(join(tmpdir(), "titan-hash-chain-")); dirs.push(dir); return dir; }

describe("canonical JSON", () => {
  test("sorts keys recursively, keeps array order, drops undefined, no whitespace", () => {
    const a = { z: 1, a: { y: [3, 1, { b: 2, a: 1 }], x: undefined, w: null }, m: "s" };
    const b = { m: "s", a: { w: null, y: [3, 1, { a: 1, b: 2 }] }, z: 1 };
    expect(canonicalJson(a)).toBe('{"a":{"w":null,"y":[3,1,{"a":1,"b":2}]},"m":"s","z":1}');
    expect(canonicalJson(a)).toBe(canonicalJson(b));
  });

  test("honours toJSON and maps undefined array members to null", () => {
    const when = new Date("2026-09-15T03:14:55.000Z");
    expect(canonicalJson({ when, list: [1, undefined, "x"] })).toBe('{"list":[1,null,"x"],"when":"2026-09-15T03:14:55.000Z"}');
  });
});

describe("sha256", () => {
  test("matches the known vector for 'abc'", () => {
    expect(sha256("abc")).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
    expect(sha256(Buffer.from("abc"))).toBe(sha256("abc"));
  });

  test("sha256File streams the whole file and flags a capped prefix", async () => {
    const dir = scratch();
    const file = join(dir, "blob.bin");
    writeFileSync(file, "hello world");
    const whole = await sha256File(file);
    expect(whole).toEqual({ sha256: sha256("hello world"), bytes: 11, truncated: false });
    const capped = await sha256File(file, 5);
    expect(capped).toEqual({ sha256: sha256("hello"), bytes: 5, truncated: true });
  });
});

describe("hash chain", () => {
  test("appends link seq and prev from GENESIS and verify walks every row", () => {
    const file = join(scratch(), "events.jsonl");
    const r1 = appendChained(file, { type: "run.start", data: { n: 1 } });
    const r2 = appendChained(file, { type: "agent.state", data: { n: 2 }, ts: "2026-09-15T00:00:00.000Z" });
    const r3 = appendChained(file, { type: "run.end", data: { n: 3 }, hash: "caller-supplied-garbage" });
    expect([r1.seq, r2.seq, r3.seq]).toEqual([1, 2, 3]);
    expect(r1.prev).toBe(GENESIS);
    expect(r2.prev).toBe(r1.hash);
    expect(r3.prev).toBe(r2.hash);
    expect(r2.ts).toBe("2026-09-15T00:00:00.000Z");
    expect(r3.hash).not.toBe("caller-supplied-garbage");
    for (const row of [r1, r2, r3]) {
      const { hash, ...unsigned } = row;
      expect(hash).toBe(sha256(canonicalJson(unsigned)));
    }
    expect(readChain(file)).toEqual([r1, r2, r3]);
    expect(verifyChain(file)).toEqual({ ok: true, rows: 3 });
    expect(statSync(file).mode & 0o777).toBe(0o600);
    // rows are canonical on disk: keys sorted, one line each
    const lines = readFileSync(file, "utf8").trimEnd().split("\n");
    expect(lines).toHaveLength(3);
    expect(lines[0]).toBe(canonicalJson(r1));
  });

  test("editing one byte breaks the chain at that seq", () => {
    const file = join(scratch(), "ledger.jsonl");
    appendChained(file, { tokens: 10 });
    appendChained(file, { tokens: 20 });
    appendChained(file, { tokens: 30 });
    const lines = readFileSync(file, "utf8").trimEnd().split("\n");
    lines[1] = lines[1].replace('"tokens":20', '"tokens":21');
    writeFileSync(file, `${lines.join("\n")}\n`);
    const result = verifyChain(file);
    expect(result.ok).toBe(false);
    expect(result.brokenAt).toBe(2);
    expect(result.rows).toBe(1);
    expect(result.reason).toContain("hash");
  });

  test("removing a row or reordering rows is detected", () => {
    const file = join(scratch(), "events.jsonl");
    for (let i = 1; i <= 4; i++) appendChained(file, { i });
    const lines = readFileSync(file, "utf8").trimEnd().split("\n");
    writeFileSync(file, `${[lines[0], lines[2], lines[3]].join("\n")}\n`);
    expect(verifyChain(file)).toMatchObject({ ok: false, brokenAt: 2, rows: 1 });
    writeFileSync(file, `${[lines[1], lines[0], lines[2], lines[3]].join("\n")}\n`);
    expect(verifyChain(file)).toMatchObject({ ok: false, brokenAt: 1, rows: 0 });
  });

  test("a torn tail line is neither chained past nor silently accepted", () => {
    const file = join(scratch(), "events.jsonl");
    appendChained(file, { i: 1 });
    appendFileSync(file, '{"seq":2,"ts":"x"');
    expect(() => appendChained(file, { i: 2 })).toThrow(/torn/);
    expect(verifyChain(file)).toMatchObject({ ok: false, brokenAt: 2, rows: 1 });
    expect(() => readChain(file)).toThrow(/line 2/);
  });

  test("the tail cache notices an external change to the file", () => {
    const file = join(scratch(), "events.jsonl");
    const r1 = appendChained(file, { i: 1 });
    appendChained(file, { i: 2 });
    writeFileSync(file, `${canonicalJson(r1)}\n`); // someone truncated the chain to one row
    const r3 = appendChained(file, { i: 3 });
    expect(r3.seq).toBe(2);
    expect(r3.prev).toBe(r1.hash);
    expect(verifyChain(file)).toEqual({ ok: true, rows: 2 });
    expect(chainTail(file)).toMatchObject({ seq: 2, hash: r3.hash });
  });

  test("a missing chain is empty and valid", () => {
    const file = join(scratch(), "absent.jsonl");
    expect(verifyChain(file)).toEqual({ ok: true, rows: 0 });
    expect(readChain(file)).toEqual([]);
    expect(chainTail(file)).toMatchObject({ seq: 0, hash: GENESIS });
  });
});
