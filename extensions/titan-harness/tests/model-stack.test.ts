import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readdirSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { cloneStack, expandFanout, lanesFor, loadModelStack, orderedSlots, printedFanout, slotRole, synthesizeLegacyStack } from "../modules/model-stack.ts";

const dirs: string[] = [];
afterEach(() => { while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true }); });
function fixture(body: string, name = "model-stack-test.yaml") {
  const dir = mkdtempSync(join(tmpdir(), "titan-stack-test-")); dirs.push(dir);
  const file = join(dir, name); writeFileSync(file, body); return { dir, file };
}

const valid = `
- name: architect
  model: anthropic/claude-fable-5
  architect: true
  thinking: high
  color: "#A78BFA"
- name: main
  model: openai/gpt-5.6-sol
  primary: true
  thinking: xhigh
  color: "#F59E0B"
- name: reviewer
  model: google/gemini-3.6-flash
`;

describe("model stack", () => {
  test("loads and orders architect, Main, then builders", () => {
    const stack = loadModelStack(fixture(valid, "model-stack-trio.yaml").file);
    expect(stack.codename).toBe("trio");
    expect(orderedSlots(stack).map((s) => s.id)).toEqual(["architect", "main", "reviewer"]);
    expect(stack.primaryBuilder.primary).toBe(true);
    expect(stack.architect.primary).toBe(false);
    expect(stack.slots.every((s) => /^#[0-9A-F]{6}$/.test(s.color))).toBe(true);
  });

  test("stable-hash colors are deterministic", () => {
    const a = loadModelStack(fixture(valid, "model-stack-trio.yaml").file);
    const b = loadModelStack(fixture(valid, "model-stack-trio.yaml").file);
    expect(a.slots.map((s) => s.color)).toEqual(b.slots.map((s) => s.color));
  });

  test.each([
    ["no architect", valid.replace("  architect: true\n", "")],
    ["architect primary", valid.replace("  architect: true\n", "  architect: true\n  primary: true\n")],
    ["no primary builder", valid.replace("  primary: true\n", "")],
    ["duplicate names", valid.replace("- name: reviewer", "- name: main")],
    ["bad color", valid.replace('"#F59E0B"', '"amber"')],
    ["unknown key", valid.replace("  primary: true", "  primry: true")],
    ["model whitespace", valid.replace("openai/gpt-5.6-sol", "openai/gpt 5.6 sol")],
  ])("rejects %s", (_label, body) => {
    expect(() => loadModelStack(fixture(body).file)).toThrow("model-stack config invalid");
  });

  test("rejects six slots", () => {
    const extra = [1,2,3].map((n) => `- name: extra${n}\n  model: google/gemini-${n}\n`).join("");
    expect(() => loadModelStack(fixture(valid + extra).file)).toThrow("slot count must be between 2 and 5");
  });

  test("resolves a system prompt relative to YAML", () => {
    const { dir, file } = fixture(valid.replace("  thinking: high", "  thinking: high\n  system_prompt: ./architect.md"));
    writeFileSync(join(dir, "architect.md"), "ARCHITECT CUSTOM");
    expect(loadModelStack(file).architect.systemPrompt).toBe("ARCHITECT CUSTOM");
  });

  test("append_system_prompt accepts one inline entry", () => {
    const { file } = fixture(valid.replace("  thinking: high", "  thinking: high\n  append_system_prompt: Always cite evidence"));
    const stack = loadModelStack(file);
    expect(stack.architect.appendSystemPrompts).toEqual(["Always cite evidence"]);
    expect(stack.architect.systemPrompt).toBeUndefined(); // append never replaces the base
  });

  test("append_system_prompt accepts a list mixing files and inline text, in order", () => {
    const { dir, file } = fixture(
      valid.replace("  thinking: high", "  thinking: high\n  append_system_prompt:\n    - ./house-rules.md\n    - Inline second append"),
    );
    writeFileSync(join(dir, "house-rules.md"), "HOUSE RULES");
    expect(loadModelStack(file).architect.appendSystemPrompts).toEqual(["HOUSE RULES", "Inline second append"]);
  });

  test("append_system_prompt rejects a missing file path", () => {
    const { file } = fixture(valid.replace("  thinking: high", "  thinking: high\n  append_system_prompt: ./missing-append.md"));
    expect(() => loadModelStack(file)).toThrow("append_system_prompt[0]");
  });

  test("legacy stack preserves architect and host builder", () => {
    const stack = synthesizeLegacyStack({ architectModel: "a/model", builderModel: "b/model", architectThinking: "high", builderThinking: "medium" });
    expect(stack.slots).toHaveLength(2);
    expect(stack.primaryBuilder.model).toBe("b/model");
  });

  test("v1 files report version 1 with the builder lane derived from the non-architect slots", () => {
    const stack = loadModelStack(fixture(valid, "model-stack-trio.yaml").file);
    expect(stack.version).toBe(1);
    expect(stack.level).toBeUndefined();
    expect(stack.slots.map(slotRole)).toEqual(["architect", "builder", "builder"]);
    expect(stack.lanes.builders.map((s) => s.id)).toEqual(["main", "reviewer"]);
    expect(stack.lanes.workers).toEqual([]);
    expect(stack.lanes.exa).toEqual([]);
    expect(stack.lanes.judge).toBeUndefined();
    expect(printedFanout(stack)).toEqual({ builders: 2, workers: 0, watchdogs: 0, verifiers: 0, exa: 0 });
    expect(stack.slots[1].fanout).toBeUndefined(); // v1 slots are untouched: no lane fields
    expect(stack.slots[1].requestedThinking).toBeUndefined();
    const legacy = synthesizeLegacyStack({ architectModel: "a/model", builderModel: "b/model", architectThinking: "high", builderThinking: "medium" });
    expect(legacy.lanes.builders.map((s) => s.id)).toEqual(["main"]);
  });
});

// ─── schema v2 ──────────────────────────────────────────────────────────────

const level3 = `
version: 2
level: 3
label: engineering
plan_command: /ultraplan
requires: [terraform]
exa: { enabled: true, fanout: 10, children: on }
verification: { default_tier: production-swe, review: required, elevation: default }
watchdog: { enabled: true, per_fanout: 1, counted: false, on_compaction: halt-inspect }
slots:
  - { name: rune,   role: architect, architect: true, model: openai-codex/gpt-6-astra, thinking: xhigh, fallback: xai/grok-4.6 }
  - { name: forge,  role: builder, primary: true, model: anthropic/claude-fable-5-1, thinking: high, fanout: 3, fallback: antigravity/claude-opus-4-6 }
  - { name: scout,  role: worker, model: antigravity/gemini-3.8-flash, thinking: high, fanout: 5 }
  - { name: ledger, role: worker, profile: db-ops-findings-curation, model: xai/grok-4.6, thinking: high, fanout: 2, pool: scout }
  - { name: hound,  role: watchdog, model: cerebras/qwen-3.8-27b, thinking: medium, fanout: 5, counted: false }
  - { name: assay,  role: verifier, model: xai/grok-4.6, thinking: xhigh, fanout: 5 }
  - { name: lantern, role: exa, model: cerebras/qwen-3.8-27b, thinking: medium, fanout: 10, counted: false }
  - { name: ward,   role: auditor, model: auto, thinking: high }
`;

const level0 = `
version: 2
level: 0
label: ultrafast
exa: { enabled: true, fanout: 5, children: on }
verification: { default_tier: web-general, review: optional }
watchdog: { enabled: false }
slots:
  - { name: rune,  role: architect, architect: true, model: cerebras/qwen-3.8-27b, thinking: xhigh }
  - { name: scout, role: worker, primary: true, model: cerebras/qwen-3.8-27b, thinking: high, fanout: 5 }
  - { name: lantern, role: exa, model: cerebras/qwen-3.8-27b, thinking: medium, fanout: 5, counted: false }
`;

const fusionTeam = `
version: 2
label: ultraplan
slots:
  - { name: rune,  role: architect, architect: true, model: openai-codex/gpt-6-astra, thinking: xhigh, fallback: xai/grok-4.6 }
  - { name: quill, role: fusion, model: anthropic/claude-fable-5-1, thinking: xhigh, fallback: antigravity/claude-opus-4-6 }
  - { name: slate, role: fusion, model: xai/grok-4.6, thinking: xhigh }
  - { name: lumen, role: fusion, model: openrouter/meta/muse-spark-1.3, thinking: max, optional: true }
  - { name: gavel, role: judge, model: antigravity/gemini-3.8-flash, thinking: xhigh }
  - { name: loom,  role: fuser, primary: true, model: anthropic/claude-fable-5-1, thinking: xhigh, fallback: antigravity/claude-opus-4-6 }
`;

describe("model stack v2", () => {
  test("level-3 loads its header, lanes and the printed fan-out 3/5/5/5/10", () => {
    const stack = loadModelStack(fixture(level3, "model-stack-level-3.yaml").file);
    expect(stack.codename).toBe("level-3");
    expect(stack.version).toBe(2);
    expect(stack.level).toBe(3);
    expect(stack.label).toBe("engineering");
    expect(stack.plan_command).toBe("/ultraplan");
    expect(stack.requires).toEqual(["terraform"]);
    expect(stack.exa).toEqual({ enabled: true, fanout: 10, children: true }); // `on` → true
    expect(stack.verification).toEqual({ default_tier: "production-swe", review: "required", elevation: "default" });
    expect(stack.watchdog).toEqual({ enabled: true, per_fanout: 1, counted: false, on_compaction: "halt-inspect" });
    expect(stack.architect.id).toBe("rune");
    expect(stack.primaryBuilder.id).toBe("forge");
    expect(stack.lanes.builders.map((s) => s.id)).toEqual(["forge"]);
    expect(stack.lanes.workers.map((s) => s.id)).toEqual(["scout", "ledger"]);
    expect(stack.lanes.watchdogs.map((s) => s.id)).toEqual(["hound"]);
    expect(stack.lanes.verifiers.map((s) => s.id)).toEqual(["assay"]);
    expect(stack.lanes.exa.map((s) => s.id)).toEqual(["lantern"]);
    expect(stack.lanes.auditors.map((s) => s.id)).toEqual(["ward"]);
    expect(stack.lanes.fusion).toEqual([]);
    expect(stack.lanes.judge).toBeUndefined();
    expect(stack.lanes.fuser).toBeUndefined();
    expect(printedFanout(stack)).toEqual({ builders: 3, workers: 5, watchdogs: 5, verifiers: 5, exa: 10 });
    // legacy view still lists every non-architect slot; templates are NOT expanded here
    expect(stack.builders).toHaveLength(7);
    expect(stack.slots).toHaveLength(8);
    expect(orderedSlots(stack).slice(0, 2).map((s) => s.id)).toEqual(["rune", "forge"]);
  });

  test("level-3 slot fields: fanout, pool, counted defaults, fallback, optional, profile, model auto", () => {
    const stack = loadModelStack(fixture(level3, "model-stack-level-3.yaml").file);
    const by = (id: string) => stack.slots.find((s) => s.id === id)!;
    expect(by("forge").fanout).toBe(3);
    expect(by("forge").fallback).toBe("antigravity/claude-opus-4-6");
    expect(by("forge").counted).toBe(true);
    expect(by("rune").fanout).toBe(1);
    expect(by("ledger").pool).toBe("scout");
    expect(by("ledger").fanout).toBe(2);
    expect(by("ledger").profile).toBe("db-ops-findings-curation");
    expect(by("scout").pool).toBeUndefined();
    expect(by("hound").counted).toBe(false);
    expect(by("lantern").counted).toBe(false);
    expect(by("assay").counted).toBe(true);
    expect(by("ward").model).toBe("auto");
    expect(by("ward").role).toBe("auditor");
    expect(by("ward").counted).toBe(true);
    expect(by("ward").optional).toBeUndefined();
    const colors = stack.slots.map((s) => s.color);
    expect(new Set(colors).size).toBe(8);
    expect(colors.every((c) => /^#[0-9A-F]{6}$/.test(c))).toBe(true);
  });

  test("v2 sends the provider ceiling and keeps the requested level", () => {
    const stack = loadModelStack(fixture(level3, "model-stack-level-3.yaml").file);
    const by = (id: string) => stack.slots.find((s) => s.id === id)!;
    expect(by("rune")).toMatchObject({ thinking: "xhigh", requestedThinking: "xhigh" });   // gpt-6-astra: pass-through
    expect(by("assay")).toMatchObject({ thinking: "xhigh", requestedThinking: "xhigh" });  // grok-4.6: pass-through
    expect(by("hound")).toMatchObject({ thinking: "medium", requestedThinking: "medium" });
    expect(by("ward")).toMatchObject({ thinking: "high", requestedThinking: "high" });     // model auto: untouched
    const ultrafast = loadModelStack(fixture(level0, "model-stack-level-0.yaml").file);
    expect(ultrafast.architect).toMatchObject({ thinking: "high", requestedThinking: "xhigh" }); // qwen: xhigh↘high
    const gemini = loadModelStack(fixture(level3.replace("model: antigravity/gemini-3.8-flash, thinking: high", "model: antigravity/gemini-3.8-flash, thinking: xhigh"), "model-stack-level-3.yaml").file);
    expect(gemini.slots.find((s) => s.id === "scout")).toMatchObject({ thinking: "high", requestedThinking: "xhigh" });
  });

  test("level-0: a primary worker is the host seat and the builder lane is empty", () => {
    const stack = loadModelStack(fixture(level0, "model-stack-level-0.yaml").file);
    expect(stack.level).toBe(0);
    expect(stack.primaryBuilder.id).toBe("scout");
    expect(stack.primaryBuilder.role).toBe("worker");
    expect(stack.lanes.builders).toEqual([]);
    expect(stack.lanes.workers.map((s) => s.id)).toEqual(["scout"]);
    expect(printedFanout(stack)).toEqual({ builders: 0, workers: 5, watchdogs: 0, verifiers: 0, exa: 5 });
    expect(stack.watchdog).toEqual({ enabled: false });
    expect(stack.verification).toEqual({ default_tier: "web-general", review: "optional" });
    expect(stack.plan_command).toBeUndefined();
  });

  test("fusion team: fusion lane, judge, fuser as the primary seat", () => {
    const stack = loadModelStack(fixture(fusionTeam, "model-stack-ultraplan.yaml").file);
    expect(stack.level).toBeUndefined();
    expect(stack.label).toBe("ultraplan");
    expect(stack.lanes.fusion.map((s) => s.id)).toEqual(["quill", "slate", "lumen"]);
    expect(stack.lanes.judge?.id).toBe("gavel");
    expect(stack.lanes.fuser?.id).toBe("loom");
    expect(stack.primaryBuilder.id).toBe("loom");
    expect(stack.slots.find((s) => s.id === "lumen")?.optional).toBe(true);
    expect(stack.lanes.judge).toMatchObject({ thinking: "high", requestedThinking: "xhigh" }); // gemini judge: xhigh↘high
    expect(printedFanout(stack)).toEqual({ builders: 0, workers: 0, watchdogs: 0, verifiers: 0, exa: 0 });
  });

  test.each([
    ["fanout shared", level3.replace("fanout: 2, pool: scout", "fanout: shared"), "fanout must be a positive integer"],
    ["fanout zero", level3.replace("fanout: 3,", "fanout: 0,"), "fanout must be a positive integer"],
    ["fanout fractional", level3.replace("fanout: 3,", "fanout: 1.5,"), "fanout must be a positive integer"],
    ["fanout quoted number", level3.replace("fanout: 3,", 'fanout: "3",'), "fanout must be a positive integer"],
    ["pool unknown slot", level3.replace("pool: scout", "pool: nobody"), "names an unknown slot"],
    ["pool self", level3.replace("pool: scout", "pool: ledger"), "cannot name itself"],
    ["pool across roles", level3.replace("pool: scout", "pool: assay"), "must share its pool's role"],
    ["pool chain", level3.replace("model: antigravity/gemini-3.8-flash, thinking: high, fanout: 5 }", "model: antigravity/gemini-3.8-flash, thinking: high, fanout: 5, pool: ledger }"), "pools do not chain"],
    ["model auto outside auditor", level3.replace("model: xai/grok-4.6, thinking: xhigh, fanout: 5", "model: auto, thinking: xhigh, fanout: 5"), "auto is only allowed for role: auditor"],
    ["two primaries", level3.replace("role: worker, model: antigravity", "role: worker, primary: true, model: antigravity"), "exactly one non-architect slot must set primary"],
    ["no primary", level3.replace("primary: true, ", ""), "exactly one non-architect slot must set primary"],
    ["architect primary", level3.replace("architect: true, model", "architect: true, primary: true, model"), "cannot be primary"],
    ["architect fan-out", level3.replace("thinking: xhigh, fallback: xai/grok-4.6 }", "thinking: xhigh, fallback: xai/grok-4.6, fanout: 2 }"), "single seat"],
    ["architect flag with another role", level3.replace("role: architect, architect: true", "role: worker, architect: true"), "the architect's role"],
    ["unknown role", level3.replace("role: verifier", "role: checker"), "role must be one of"],
    ["unknown top-level key", level3.replace("label: engineering", "label: engineering\nsidebar: true"), "unknown in shape schema v2"],
    ["unknown slot key", level3.replace("counted: false }", "counted: false, colour: red }"), "unknown key"],
    ["bad fallback", level3.replace("fallback: xai/grok-4.6", "fallback: grok"), "fallback must be fully qualified"],
    ["bad profile", level3.replace("profile: db-ops-findings-curation", "profile: 'db ops'"), "profile must match"],
    ["level out of range", level3.replace("level: 3", "level: 4"), "level must be an integer between 0 and 3"],
    ["bad review policy", level3.replace("review: required", "review: sometimes"), "verification.review must be one of"],
    ["bad on_compaction", level3.replace("on_compaction: halt-inspect", "on_compaction: panic"), "watchdog.on_compaction must be one of"],
    ["bad exa children", level3.replace("children: on", "children: sideways"), "exa.children must be on/off"],
    ["bad plan_command", level3.replace("plan_command: /ultraplan", "plan_command: ultraplan"), "plan_command must be a slash command"],
    ["version 3", level3.replace("version: 2", "version: 3"), "must declare version: 2"],
    ["judge shares the fuser model", fusionTeam.replace("name: gavel, role: judge, model: antigravity/gemini-3.8-flash", "name: gavel, role: judge, model: anthropic/claude-fable-5-1"), "must not share a model"],
    ["two fusers", fusionTeam.replace("name: slate, role: fusion", "name: slate, role: fuser"), "at most one slot may have role: fuser"],
  ])("v2 rejects %s", (_label, body, message) => {
    expect(() => loadModelStack(fixture(body, "model-stack-level-3.yaml").file)).toThrow(message);
  });

  test("v2 rejects thirteen slots", () => {
    const extra = Array.from({ length: 5 }, (_, i) => `  - { name: extra${i}, role: worker, model: google/gemini-${i}, thinking: low }\n`).join("");
    expect(() => loadModelStack(fixture(level3 + extra).file)).toThrow("slot count must be between 2 and 12");
  });

  test("a v2 mapping without slots is rejected, and a scalar document too", () => {
    expect(() => loadModelStack(fixture("version: 2\nlabel: empty\n").file)).toThrow("slots must be a list");
    expect(() => loadModelStack(fixture("just a string\n").file)).toThrow("top-level YAML value must be a list of model slots (v1) or a mapping with version: 2");
  });

  test("expandFanout clones forge into forge-1..forge-3 with one primary; n = 1 is the template itself", () => {
    const stack = loadModelStack(fixture(level3, "model-stack-level-3.yaml").file);
    const forge = stack.lanes.builders[0];
    const clones = expandFanout(forge, 3);
    expect(clones.map((s) => s.id)).toEqual(["forge-1", "forge-2", "forge-3"]);
    expect(clones.map((s) => s.name)).toEqual(["forge-1", "forge-2", "forge-3"]);
    expect(clones.map((s) => s.primary)).toEqual([true, false, false]);
    expect(clones.every((s) => s.template === "forge" && s.fanout === 1 && s.model === forge.model && s.color === forge.color && s.fallback === forge.fallback && s.role === "builder")).toBe(true);
    expect(clones[0].appendSystemPrompts).not.toBe(forge.appendSystemPrompts);
    expect(expandFanout(forge, 1)).toEqual([forge]);
    expect(expandFanout(forge, 1)[0]).toBe(forge);
    expect(() => expandFanout(forge, 0)).toThrow("positive integer");
    const lantern = stack.lanes.exa[0];
    expect(expandFanout(lantern, 10).at(-1)?.id).toBe("lantern-10");
    expect(expandFanout(lantern, 10).every((s) => s.counted === false && !s.primary)).toBe(true);
  });

  test("cloneStack copies v2 metadata and re-derives lanes onto the cloned slots", () => {
    const stack = loadModelStack(fixture(level3, "model-stack-level-3.yaml").file);
    const clone = cloneStack(stack);
    expect(clone.level).toBe(3);
    expect(clone.exa).toEqual(stack.exa);
    expect(clone.exa).not.toBe(stack.exa);
    expect(clone.requires).toEqual(["terraform"]);
    expect(clone.requires).not.toBe(stack.requires);
    const scout = clone.slots.find((s) => s.id === "scout")!;
    expect(clone.lanes.workers[0]).toBe(scout);
    expect(scout).not.toBe(stack.lanes.workers[0]);
    expect(clone.primaryBuilder).toBe(clone.slots.find((s) => s.id === "forge"));
    expect(printedFanout(clone)).toEqual(printedFanout(stack));
    // lanesFor re-derives the role view after a reshaping that drops slots
    const reshaped = lanesFor(clone.slots.filter((s) => s.role !== "watchdog"));
    expect(reshaped.watchdogs).toEqual([]);
    expect(reshaped.builders.map((s) => s.id)).toEqual(["forge"]);
  });

  test("every shipped shape in .pi/titan-harness loads", () => {
    const shipped = fileURLToPath(new URL("../../../.pi/titan-harness/", import.meta.url));
    const files = readdirSync(shipped).filter((f) => /^model-stack-.+\.ya?ml$/.test(f)).sort();
    expect(files).toEqual(expect.arrayContaining(["model-stack-level-0.yaml", "model-stack-level-1.yaml", "model-stack-level-2.yaml", "model-stack-level-3.yaml", "model-stack-ultraplan.yaml", "model-stack-consult.yaml"]));
    const versions: Record<string, number | undefined> = {};
    for (const file of files) versions[file] = loadModelStack(join(shipped, file)).version;
    expect(versions["model-stack-consult.yaml"]).toBe(1);
    expect(versions["model-stack-level-3.yaml"]).toBe(2);
    expect(versions["model-stack-ultraplan.yaml"]).toBe(2);
    const ultraplan = loadModelStack(join(shipped, "model-stack-ultraplan.yaml"));
    expect(ultraplan.lanes.fusion.map((s) => s.id)).toEqual(["quill", "slate", "prism", "lumen"]);
    expect(ultraplan.lanes.judge?.model).not.toBe(ultraplan.lanes.fuser?.model);
    expect(ultraplan.lanes.fuser?.fallback).toBe("antigravity/claude-opus-4-6");
    expect(ultraplan.primaryBuilder.id).toBe("loom");
  });
});
