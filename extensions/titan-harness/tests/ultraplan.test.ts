import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import { readChain, sha256 } from "../modules/hash-chain.ts";
import { readLedger } from "../modules/ledger.ts";
import { cloneStack, loadModelStack, type ModelSlot, type ModelStack } from "../modules/model-stack.ts";
import { createPlanMode, type PlanModeDeps } from "../modules/plan-mode.ts";
import { EVENTS_FILE, RunStore } from "../modules/run-store.ts";
import { type AgentRun, READONLY_TOOLS } from "../modules/runtime.ts";
import {
	ackTable,
	answersText,
	contextPack,
	createUltraplan,
	draftsText,
	MIN_LIVE_SEATS,
	parseJudgeYaml,
	parseUltraplanArgs,
	planIdFor,
	registerUltraplanCommand,
	renderQuestions,
	seatLetter,
	type UltraplanDeps,
	ultraplanTeam,
} from "../modules/cmd-ultraplan.ts";

const SHIPPED = join(import.meta.dir, "..", "..", "..", ".pi", "titan-harness", "model-stack-ultraplan.yaml");

const dirs: string[] = [];
afterEach(() => {
	while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});
const scratch = (): string => {
	const dir = mkdtempSync(join(tmpdir(), "titan-ultraplan-"));
	dirs.push(dir);
	return dir;
};

/** The host's fallback resolution, simulated: Fable seats → opus, the optional Muse seat vacant. */
function resolvedStack(opts: { vacant?: string[]; judgeModel?: string; fuserModel?: string } = {}): { stack: ModelStack; notes: string[]; vacant: string[] } {
	const stack = cloneStack(loadModelStack(SHIPPED));
	const notes: string[] = [];
	const vacant = new Set(opts.vacant ?? ["lumen"]);
	for (const slot of stack.slots) {
		if (slot.model.startsWith("anthropic/") && slot.fallback) {
			notes.push(`${slot.name}: ${slot.model} → ${slot.fallback} (fallback)`);
			slot.model = slot.fallback;
		}
		if (vacant.has(slot.name)) (slot as { vacant?: boolean }).vacant = true;
		if (slot.name === "gavel" && opts.judgeModel) slot.model = opts.judgeModel;
		if (slot.name === "loom" && opts.fuserModel) slot.model = opts.fuserModel;
	}
	return { stack, notes, vacant: [...vacant] };
}

const MODEL_MARKERS = ["anthropic/", "antigravity/", "xai/", "openai-codex/", "openrouter/", "claude", "opus", "grok", "gemini", "gpt-6", "muse-spark", "qwen"];

interface Call {
	role: string;
	slot?: string;
	prompt: string;
	systemPrompt?: string;
	tools: string;
	thinking: string;
	sessionId?: string;
	resume?: string;
	sessionDir: string;
	signal?: AbortSignal;
}

const QUESTIONS_JSON = JSON.stringify({
	questions: [
		{ n: 1, question: "Which storage backend?", recommendation: "SQLite", why: "already a dependency" },
		{ n: 2, question: "Ship behind a flag?", recommendation: "yes", why: "reversible" },
		{ n: 3, question: "Target browsers?", recommendation: "evergreen only" },
	],
});

const JUDGE_YAML = ["```yaml", "ranking: [B, A, C]", "seats:", "  A: { score: 70, strengths: [clear phases], risks: [thin tests], invented_facts: [] }", "  B: { score: 85, strengths: [evidence per phase], risks: [], invented_facts: [] }", "  C: { score: 40, strengths: [], risks: [skips verification], invented_facts: [claims a CI file exists] }", "disagreements:", "  - topic: storage", "    positions: { A: sqlite, B: sqlite, C: postgres }", "    resolution: sqlite per the decision", "must_keep:", "  - { seat: A, item: rollback note }", 'summary: "B leads; keep A\'s rollback note."', "```"].join("\n");

/**
 * A fake runChild: settles the run the way child-runner would, answering by prompt
 * shape (grill → JSON questions, seat → a draft, judge → YAML, fuser → the plan, ACK →
 * the exact ACK line). `fail` names callsigns whose draft call fails.
 */
function fakeChild(opts: { fail?: string[]; judgeText?: string; ackWrong?: string[] } = {}) {
	const calls: Call[] = [];
	let counter = 0;
	const runChild = async (o: any): Promise<AgentRun> => {
		counter += 1;
		const run = o.run as AgentRun;
		calls.push({ role: run.role, slot: run.slot?.name, prompt: o.prompt, systemPrompt: o.systemPrompt, tools: o.tools, thinking: o.thinking, sessionId: o.sessionId, resume: o.resume, sessionDir: o.sessionDir, signal: o.signal });
		run.sessionRef = `sess-${counter}`;
		run.tokensIn = 100;
		run.tokensOut = 50;
		run.costUsd = 0.01;
		run.tpsSeconds = 1;
		run.status = "done";
		const prompt: string = o.prompt;
		if (prompt.includes("grill the brief")) run.text = `Here you go:\n${QUESTIONS_JSON}`;
		else if (prompt.includes("CONTEXT SYNCHRONIZATION ONLY")) {
			const runId = prompt.match(/for run (\S+)\./)?.[1];
			run.text = opts.ackWrong?.includes(run.slot?.name ?? "") ? "nope" : `ACK FUSION ${runId}`;
		} else if (prompt.includes("You are the JUDGE")) run.text = opts.judgeText ?? JUDGE_YAML;
		else if (prompt.includes("You are the FUSER")) run.text = "# Fused plan\n\n1. Phase one\n2. Phase two\n\n## Consensus and divergence\nall agreed";
		else if (prompt.includes("You are Seat")) {
			const letter = prompt.match(/You are Seat (\w+)/)?.[1];
			if (opts.fail?.includes(run.slot?.name ?? "")) {
				run.status = "failed";
				run.exitCode = 1;
				run.errorMessage = "provider down";
				run.text = "";
			} else run.text = `Draft from seat ${letter}: ## Plan\n1. do the thing`;
		} else run.text = "OK";
		return run;
	};
	return { runChild: runChild as any, calls };
}

function harness(opts: { stack?: ReturnType<typeof resolvedStack>; child?: ReturnType<typeof fakeChild>; hasVision?: boolean } = {}) {
	const cwd = scratch();
	if (opts.hasVision !== false) writeFileSync(join(cwd, "vision.md"), "# Vision\nA calm product with SQLite storage.\n");
	const storeRoot = join(scratch(), "runs");
	const store = new RunStore(storeRoot);
	const child = opts.child ?? fakeChild();
	const stack = opts.stack ?? resolvedStack();
	const notes: string[] = [];
	const panels: Array<{ title: string; body: string }> = [];
	const recorded: AgentRun[] = [];
	const opinions: string[] = [];
	let active = ["read", "bash", "edit", "write"];
	const planDeps: PlanModeDeps = {
		getActiveTools: () => [...active],
		setActiveTools: (names) => {
			active = [...names];
		},
		notify: () => {},
		setStatus: () => {},
		setWidget: () => {},
		persist: () => {},
	};
	const planMode = createPlanMode(planDeps);
	const deps: UltraplanDeps = {
		resolveStack: () => stack,
		runChild: child.runChild,
		store: () => store,
		cwd: () => cwd,
		notify: (_ctx, text) => notes.push(text),
		panel: (_ctx, title, body) => panels.push({ title, body }),
		planMode,
		childTimeoutMs: () => 1000,
		recordRun: (run) => recorded.push(run),
		opinionFallback: async (prompt) => {
			opinions.push(prompt);
		},
		now: () => new Date("2026-09-15T10:00:00Z"),
	};
	return { cwd, store, child, stack, notes, panels, recorded, opinions, planMode, deps, active: () => active, controller: createUltraplan(deps) };
}

describe("pure helpers", () => {
	test("parseUltraplanArgs", () => {
		expect(parseUltraplanArgs("")).toEqual({ verb: "help" });
		expect(parseUltraplanArgs("help")).toEqual({ verb: "help" });
		expect(parseUltraplanArgs("ship the login flow")).toEqual({ verb: "start", brief: "ship the login flow" });
		expect(parseUltraplanArgs("answer 2 use sqlite")).toEqual({ verb: "answer", n: 2, text: "use sqlite" });
		expect(parseUltraplanArgs("answer x y")).toEqual({ verb: "help" });
		expect(parseUltraplanArgs("answer 2")).toEqual({ verb: "help" });
		for (const verb of ["fuse", "done", "abort", "status"]) expect(parseUltraplanArgs(verb)).toEqual({ verb });
		expect(parseUltraplanArgs("FUSE")).toEqual({ verb: "fuse" });
	});

	test("seatLetter, planIdFor", () => {
		expect([0, 1, 25, 26, 27].map(seatLetter)).toEqual(["A", "B", "Z", "AA", "AB"]);
		expect(planIdFor(new Date("2026-09-15T10:00:00.123Z"))).toMatch(/^plan-20260915T100000Z-[0-9a-f]{6}$/);
	});

	test("contextPack: bounded, hashed, terraform docs included, empty when nothing exists", () => {
		const cwd = scratch();
		expect(contextPack(cwd)).toEqual({ text: "(no project documents found)", files: [] });
		writeFileSync(join(cwd, "vision.md"), "v".repeat(10_000));
		mkdirSync(join(cwd, ".titan", "terraform"), { recursive: true });
		writeFileSync(join(cwd, ".titan", "terraform", "entity.md"), "e".repeat(10_000));
		const pack = contextPack(cwd, 8_000);
		expect(pack.files.map((file) => file.path)).toEqual(["vision.md", join(".titan", "terraform", "entity.md")]);
		expect(pack.files.every((file) => file.truncated && file.sha256.length === 64 && file.bytes === 10_000)).toBe(true);
		expect(pack.text).toContain("## vision.md");
		expect(pack.text).toContain("[truncated");
		expect(pack.text.length).toBeLessThan(10_000);
		const full = contextPack(cwd);
		expect(full.files.every((file) => !file.truncated)).toBe(true);
	});

	test("renderQuestions / answersText / draftsText / ackTable / parseJudgeYaml", () => {
		const questions = [
			{ n: 1, question: "Q1?", recommendation: "R1", why: "because", answered: "human" as const, answer: "A1" },
			{ n: 2, question: "Q2?", recommendation: "R2", answered: "pending" as const },
		];
		const rendered = renderQuestions(questions);
		expect(rendered).toContain("**1. Q1?**");
		expect(rendered).toContain("✓ answered: A1");
		expect(rendered).toContain("○ pending");
		expect(renderQuestions([])).toContain("no questions");
		const answers = answersText(questions);
		expect(answers).toContain("decision: A1");
		expect(answers).toContain("decision: R2 (recommendation accepted)");
		expect(answersText([])).toContain("brief alone");
		expect(draftsText([{ letter: "A", text: "a", ok: true }, { letter: "B", text: "", ok: false }])).toBe("## Seat A\na\n\n## Seat B\n(this seat produced no draft)");
		const table = ackTable([{ seat: "A", callsign: "quill", ok: true, hash: "f".repeat(64), response: "ACK" }, { seat: "B", callsign: "slate", ok: false, hash: "f".repeat(64), response: "no" }]);
		expect(table).toContain("| A | quill | ✓ ACK |");
		expect(table).toContain("| B | slate | ✗ missing |");
		expect(parseJudgeYaml(JUDGE_YAML)).toMatchObject({ ok: true, value: { ranking: ["B", "A", "C"] } });
		expect(parseJudgeYaml("ranking: [A]\nsummary: fine")).toMatchObject({ ok: true, value: { ranking: ["A"] } });
		expect(parseJudgeYaml("- just\n- a list").ok).toBe(false);
		expect(parseJudgeYaml("key: [unterminated").ok).toBe(false);
	});

	test("ultraplanTeam skips vacant seats and names judge/fuser/architect", () => {
		const { stack } = resolvedStack({ vacant: ["lumen", "slate"] });
		const team = ultraplanTeam(stack);
		expect(team.seats.map((slot) => slot.name)).toEqual(["quill", "prism"]);
		expect(team.judge?.name).toBe("gavel");
		expect(team.fuser?.name).toBe("loom");
		expect(team.architect.name).toBe("rune");
	});
});

describe("/ultraplan flow", () => {
	test("start: plan mode on (writes blocked), grilling questions from the architect, plan dir + store run opened", async () => {
		const h = harness();
		const session = await h.controller.start({}, "ship the login flow");
		expect(session).toBeDefined();
		expect(session!.phase).toBe("grilling");
		expect(h.planMode.enabled()).toBe(true);
		expect(h.active()).not.toContain("write");
		expect(h.planMode.onToolCall({ toolName: "write", input: {} })).toMatchObject({ block: true });
		expect(h.planMode.onToolCall({ toolName: "bash", input: { command: "rm -rf x" } })).toMatchObject({ block: true });
		expect(readFileSync(join(session!.planDir, "brief.md"), "utf8")).toBe("ship the login flow\n");
		expect(session!.planDir).toBe(join(h.cwd, ".titan", "plans", session!.planId));
		const questions = JSON.parse(readFileSync(join(session!.planDir, "questions.json"), "utf8"));
		expect(questions).toHaveLength(3);
		expect(questions[0]).toMatchObject({ n: 1, question: "Which storage backend?", recommendation: "SQLite", answered: "pending" });
		expect(existsSync(join(session!.planDir, "questions.md"))).toBe(true);
		const manifest = JSON.parse(readFileSync(join(session!.planDir, "context-manifest.json"), "utf8"));
		expect(manifest.files.map((file: { path: string }) => file.path)).toEqual(["vision.md"]);
		// the grilling call: the architect seat, read-only, with the brief and the context pack, structured output asked
		expect(h.child.calls).toHaveLength(1);
		const grill = h.child.calls[0];
		expect(grill.role).toBe("ARCHITECT");
		expect(grill.slot).toBe("rune");
		expect(grill.tools).toBe(READONLY_TOOLS);
		expect(grill.prompt).toContain("ship the login flow");
		expect(grill.prompt).toContain("A calm product with SQLite storage.");
		expect(grill.prompt).toContain("JSON");
		expect(grill.sessionDir).toBe(join(session!.runDir, "sessions"));
		expect(existsSync(grill.sessionDir)).toBe(true);
		const run = h.store.readRun(session!.runDir);
		expect(run).toMatchObject({ command: "ultraplan", status: "running", currentPhase: "grill", phases: ["grill", "fuse", "done"] });
		expect(h.panels.at(-1)?.title).toContain("QUESTIONS");
		expect(h.panels.at(-1)?.body).toContain("recommendation: SQLite");
		expect(h.panels.at(-1)?.body).toContain("vacant seats: lumen");
		expect(h.recorded).toHaveLength(1);
		const events = readChain(join(session!.runDir, EVENTS_FILE)).map((row) => row.type);
		expect(events).toEqual(["ultraplan.start", "ultraplan.questions"]);
		expect(h.controller.status({})).toContain("3 pending");
	});

	test("answer records a human decision; fuse drafts (≥ 3 anonymous seats), judges (YAML), fuses and collects ACK hashes", async () => {
		const h = harness();
		const session = (await h.controller.start({}, "ship the login flow"))!;
		expect(h.controller.answer({}, 2, "no flag, ship straight")).toBe(true);
		expect(h.controller.answer({}, 9, "x")).toBe(false);
		expect(readFileSync(join(session.planDir, "answers.md"), "utf8")).toContain("decision: no flag, ship straight");

		const fused = (await h.controller.fuse({}))!;
		expect(fused.phase).toBe("fused");
		// seats: quill, slate, prism (lumen vacant) → A, B, C — fresh read-only sessions
		expect(fused.seats.map((seat) => [seat.letter, seat.callsign, seat.ok])).toEqual([["A", "quill", true], ["B", "slate", true], ["C", "prism", true]]);
		for (const letter of ["A", "B", "C"]) expect(readFileSync(join(session.planDir, "seats", `${letter}.md`), "utf8")).toBe(`Draft from seat ${letter}: ## Plan\n1. do the thing`);
		const seatCalls = h.child.calls.filter((call) => call.prompt.includes("You are Seat"));
		expect(seatCalls).toHaveLength(3);
		for (const [index, call] of seatCalls.entries()) {
			const letter = seatLetter(index);
			expect(call.tools).toBe(READONLY_TOOLS);
			expect(call.sessionId).toBeDefined();
			expect(call.resume).toBeUndefined();
			expect(call.prompt).toContain(`You are Seat ${letter} of 3`);
			expect(call.prompt).toContain("ship the login flow");
			expect(call.prompt).toContain("decision: no flag, ship straight");
			expect(call.prompt).toContain("decision: SQLite (recommendation accepted)");
			expect(call.prompt).toContain("A calm product with SQLite storage.");
			expect(call.systemPrompt).toContain(`Seat ${letter}`);
			for (const marker of MODEL_MARKERS) {
				expect(call.prompt.toLowerCase()).not.toContain(marker);
				expect((call.systemPrompt ?? "").toLowerCase()).not.toContain(marker);
			}
		}
		// judge: sees letters only, returns YAML the host parses and stores
		const judgeCall = h.child.calls.find((call) => call.prompt.includes("You are the JUDGE"))!;
		expect(judgeCall.slot).toBe("gavel");
		expect(judgeCall.tools).toBe(READONLY_TOOLS);
		for (const letter of ["A", "B", "C"]) expect(judgeCall.prompt).toContain(`## Seat ${letter}\nDraft from seat ${letter}`);
		for (const marker of MODEL_MARKERS) expect(judgeCall.prompt.toLowerCase()).not.toContain(marker);
		const judgeYaml = parseYaml(readFileSync(join(session.planDir, "judge.yaml"), "utf8"));
		expect(judgeYaml.ranking).toEqual(["B", "A", "C"]);
		expect(judgeYaml.must_keep[0]).toEqual({ seat: "A", item: "rollback note" });
		// fuser: read-only, gets judge + drafts; the host writes fused-plan.md with the ACK table
		const fuserCall = h.child.calls.find((call) => call.prompt.includes("You are the FUSER"))!;
		expect(fuserCall.slot).toBe("loom");
		expect(fuserCall.tools).toBe(READONLY_TOOLS);
		expect(fuserCall.prompt).toContain("ranking: [B, A, C]");
		expect(fuserCall.prompt).toContain("## Seat C");
		for (const marker of MODEL_MARKERS) expect(fuserCall.prompt.toLowerCase()).not.toContain(marker);
		const fusedText = "# Fused plan\n\n1. Phase one\n2. Phase two\n\n## Consensus and divergence\nall agreed";
		const fusedFile = readFileSync(join(session.planDir, "fused-plan.md"), "utf8");
		expect(fusedFile.startsWith(`${fusedText}\n`)).toBe(true);
		expect(fusedFile).toContain("## Seat ACKs");
		expect(fusedFile).toContain("| A | quill | ✓ ACK |");
		expect(fused.fusedHash).toBe(sha256(fusedText));
		// ACKs: every seat resumed its own session, tool-less, and answered the exact line
		const ackCalls = h.child.calls.filter((call) => call.prompt.includes("CONTEXT SYNCHRONIZATION ONLY"));
		expect(ackCalls).toHaveLength(3);
		for (const call of ackCalls) {
			expect(call.tools).toBe("none");
			expect(call.resume).toMatch(/^sess-\d+$/);
			expect(seatCalls.some((seat) => `sess-${h.child.calls.indexOf(seat) + 1}` === call.resume)).toBe(true);
			expect(call.prompt).toContain(`sha256="${sha256(fusedText)}"`);
		}
		const acks = JSON.parse(readFileSync(join(session.planDir, "acks.json"), "utf8"));
		expect(acks.sha256).toBe(sha256(fusedText));
		expect(acks.acks.map((ack: { seat: string; ok: boolean }) => [ack.seat, ack.ok])).toEqual([["A", true], ["B", true], ["C", true]]);
		expect(acks.acks.every((ack: { response: string }) => ack.response === `ACK FUSION ${session.runId}`)).toBe(true);
		// ledger: grill (run) + 3 drafts + judge + fuser + 3 ACKs = 9 rows, origins by role; session ledger fed the same runs
		const rows = readLedger(session.runDir);
		expect(rows).toHaveLength(9);
		expect(rows.map((row) => row.origin)).toEqual(["run", "fusion", "fusion", "fusion", "judge", "fuser", "fusion", "fusion", "fusion"]);
		expect(rows.filter((row) => row.origin === "fusion").map((row) => row.agentId).sort()).toEqual(["seat-A", "seat-A-ack", "seat-B", "seat-B-ack", "seat-C", "seat-C-ack"]);
		expect(rows.find((row) => row.origin === "judge")?.thinking).toEqual({ requested: "xhigh", effective: "high" });
		expect(h.recorded).toHaveLength(9);
		const events = readChain(join(session.runDir, EVENTS_FILE)).map((row) => row.type);
		expect(events).toEqual(["ultraplan.start", "ultraplan.questions", "ultraplan.answer", "ultraplan.seats", "ultraplan.judge", "ultraplan.fused", "ultraplan.acks"]);
		// panel names the vacant seat and the fallbacks
		const panel = h.panels.at(-1)!;
		expect(panel.title).toContain("FUSED");
		expect(panel.body).toContain("**vacant seats:** lumen");
		expect(panel.body).toContain("quill: anthropic/claude-fable-5-1 → antigravity/claude-opus-4-6 (fallback)");
		expect(panel.body).toContain("**ACKs:** 3/3");
		expect(panel.body).toContain("| judge | gavel | antigravity/gemini-3.8-flash | xhigh↘high |");
		expect(panel.body).toContain("/create-workflow --from-plan " + session.planId);
		// done: plan mode off, run completed
		expect(h.controller.done({})).toBe(true);
		expect(h.planMode.enabled()).toBe(false);
		expect(h.active()).toContain("write");
		expect(h.store.readRun(session.runDir)).toMatchObject({ status: "completed", currentPhase: "done" });
		expect(h.notes.at(-1)).toContain(`/create-workflow --from-plan ${session.planId}`);
		expect(h.controller.done({})).toBe(false);
	});

	test("judge model = fuser model is refused before spawning; fewer than three live seats degrades to /titan-opinion", async () => {
		const collide = harness({ stack: resolvedStack({ fuserModel: "antigravity/gemini-3.8-flash" }) });
		expect(await collide.controller.start({}, "brief")).toBeUndefined();
		expect(collide.child.calls).toHaveLength(0);
		expect(collide.notes.at(-1)).toContain("judge must differ from the fuser");
		expect(collide.planMode.enabled()).toBe(false);
		expect(existsSync(join(collide.cwd, ".titan"))).toBe(false);

		const thin = harness({ stack: resolvedStack({ vacant: ["lumen", "slate"] }) });
		expect(await thin.controller.start({}, "small brief")).toBeUndefined();
		expect(thin.opinions).toEqual(["small brief"]);
		expect(thin.child.calls).toHaveLength(0);
		expect(thin.notes.at(-1)).toContain(`needs ${MIN_LIVE_SEATS} live fusion seats; found 2 (vacant: lumen, slate)`);
		expect(thin.planMode.enabled()).toBe(false);
	});

	test("a failed seat leaves fewer than three drafts: fuse reports it and stays in grilling; abort turns plan mode off", async () => {
		const h = harness({ child: fakeChild({ fail: ["slate"] }) });
		const session = (await h.controller.start({}, "brief"))!;
		const after = (await h.controller.fuse({}))!;
		expect(after.phase).toBe("grilling");
		expect(h.notes.at(-1)).toContain("only 2 of 3 seats produced a draft");
		expect(readFileSync(join(session.planDir, "seats", "B.md"), "utf8")).toContain("FAILED: provider down");
		expect(after.seats.find((seat) => seat.callsign === "slate")).toMatchObject({ ok: false, error: expect.stringContaining("provider down") });
		expect(existsSync(join(session.planDir, "fused-plan.md"))).toBe(false);
		expect(h.child.calls.some((call) => call.prompt.includes("You are the JUDGE"))).toBe(false);
		expect(h.controller.abort({})).toBe(true);
		expect(session.controller.signal.aborted).toBe(true);
		expect(h.planMode.enabled()).toBe(false);
		expect(h.store.readRun(session.runDir).status).toBe("aborted");
		expect(h.controller.abort({})).toBe(false);
		expect(h.controller.status({})).toContain("aborted");
	});

	test("invalid judge YAML is kept raw (fusion still completes); a wrong ACK is retried once then reported missing", async () => {
		const h = harness({ child: fakeChild({ judgeText: "- not\n- a mapping", ackWrong: ["prism"] }) });
		const session = (await h.controller.start({}, "brief"))!;
		const fused = (await h.controller.fuse({}))!;
		expect(fused.phase).toBe("fused");
		expect(readFileSync(join(session.planDir, "judge.yaml"), "utf8")).toContain("# judge output could not be parsed as YAML");
		expect(h.notes.some((note) => note.includes("judge output is not valid YAML"))).toBe(true);
		const ackCalls = h.child.calls.filter((call) => call.prompt.includes("CONTEXT SYNCHRONIZATION ONLY"));
		expect(ackCalls).toHaveLength(4); // A, B once; C twice
		expect(fused.acks.map((ack) => [ack.seat, ack.ok])).toEqual([["A", true], ["B", true], ["C", false]]);
		expect(fused.acks[2].error).toContain("expected exact ACK FUSION");
		expect(h.panels.at(-1)?.body).toContain("**ACKs:** 2/3 (missing: C)");
		expect(readLedger(session.runDir)).toHaveLength(10);
	});

	test("second start while a session is open is refused; run() dispatches every verb; registration exposes the command", async () => {
		const h = harness();
		await h.controller.run("first brief", {});
		expect(h.controller.session()?.phase).toBe("grilling");
		expect(await h.controller.start({}, "another")).toBeUndefined();
		expect(h.notes.at(-1)).toContain("in flight");
		await h.controller.run("", {});
		expect(h.notes.at(-1)).toContain("/ultraplan answer <n> <text>");
		await h.controller.run("status", {});
		expect(h.notes.at(-1)).toContain("grilling");
		await h.controller.run("answer 1 postgres", {});
		expect(h.controller.session()?.questions[0]).toMatchObject({ answer: "postgres", answered: "human" });
		await h.controller.run("abort", {});
		expect(h.controller.session()?.phase).toBe("aborted");

		const registered: Array<{ name: string; spec: any }> = [];
		const pi = { registerCommand: (name: string, spec: any) => registered.push({ name, spec }) };
		const controller = registerUltraplanCommand(pi as any, h.deps);
		expect(registered.map((entry) => entry.name)).toEqual(["ultraplan"]);
		expect(registered[0].spec.getArgumentCompletions("fu")).toEqual([{ value: "fuse", label: "fuse" }]);
		expect(registered[0].spec.getArgumentCompletions("zzz")).toBeNull();
		await registered[0].spec.handler("status", {});
		expect(h.notes.at(-1)).toContain("no session");
		expect(controller.session()).toBeUndefined();
	});
});
