/**
 * cmd-ultraplan.ts — /ultraplan: plan mode + the fusion planning team (plan §2 H6, §4.5, P7).
 *
 *   /ultraplan <brief>            enter plan mode (writes blocked), open .titan/plans/<planId>/
 *                                 and a store run, and run the GRILLING round: the architect
 *                                 seat asks 3–8 numbered frontier questions, each with a
 *                                 recommendation (structured output v1)
 *   /ultraplan answer <n> <text>  answer one question (unanswered → the recommendation)
 *   /ultraplan fuse               every live fusion seat drafts the plan concurrently as an
 *                                 anonymous letter (seats/A.md …, fresh read-only sessions);
 *                                 the judge ranks the drafts (judge.yaml); the fuser merges
 *                                 them (fused-plan.md); every seat then ACKs the fused bytes
 *                                 (`ACK FUSION <runId>` + sha256 → acks.json + a table)
 *   /ultraplan done               leave plan mode; next step /create-workflow --from-plan <id>
 *   /ultraplan abort | status
 *
 * Invariants: seats never see model names (letters only in every prompt); the judge model
 * must differ from the fuser model (refused before spawning); fewer than three live seats
 * degrades to /titan-opinion with a notify; vacant seats are named. Every child is
 * ledgered on the plan run (origin fusion | judge | fuser; the grilling architect as run)
 * and handed to the host's recordRun for the session ledger. Read-only everywhere: the
 * host writes the artifacts, no child does. The command is registered through a deps
 * seam (only the ExtensionAPI type is imported); the host supplies runChild, the store,
 * the resolved ultraplan stack and the plan-mode object.
 */
import { randomBytes, randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { parse as parseYaml } from "yaml";
import type { runChild as RunChild } from "./child-runner.ts";
import { sha256 } from "./hash-chain.ts";
import { appendLedger, type LedgerOrigin, rowFromAgentRun } from "./ledger.ts";
import { type ModelSlot, type ModelStack, slotRole } from "./model-stack.ts";
import type { PlanMode } from "./plan-mode.ts";
import { fill, fusionContextAckPrompt, promptTemplate } from "./prompt-library.ts";
import { RunStore } from "./run-store.ts";
import { type AgentRun, newRun, READONLY_TOOLS, runError, runOk, type SpawnIdentity } from "./runtime.ts";
import { normalizeThinking, thinkingLabel } from "./thinking.ts";
import type { JsonSchema } from "./workflow/schema.ts";
import { parseStructured, schemaPromptSuffix } from "./workflow/structured-output.ts";

// ═══ Types ═══════════════════════════════════════════════════════════════════

export interface ResolvedUltraplanStack {
	stack: ModelStack;
	/** Fallback substitutions the host made ("quill: anthropic/… → antigravity/… (fallback)"). */
	notes: string[];
	/** Seat names dropped because neither model nor fallback is usable. */
	vacant: string[];
}

export interface UltraplanDeps {
	resolveStack(codename: "ultraplan"): ResolvedUltraplanStack;
	runChild: typeof RunChild;
	store(): RunStore;
	cwd(ctx: any): string;
	notify(ctx: any, text: string, level?: "info" | "warning" | "error"): void;
	panel(ctx: any, title: string, markdown: string): void;
	planMode: PlanMode;
	childTimeoutMs(): number;
	/** Session-ledger bookkeeping for every child (the host's recordRun). */
	recordRun(run: AgentRun): void;
	/** Fewer than three live seats: run /titan-opinion instead. */
	opinionFallback(prompt: string, ctx: any): Promise<void>;
	/** Optional spawn identity for a seat; the default is a fresh session under the run dir. */
	slotSpawn?(slot: ModelSlot, ctx: any, dir: string): SpawnIdentity;
	now?(): Date;
	contextPackMaxChars?: number;
}

export interface GrillQuestion {
	n: number;
	question: string;
	recommendation: string;
	why?: string;
	answer?: string;
	answered: "human" | "recommendation" | "pending";
}

export interface SeatRecord {
	letter: string;
	callsign: string;
	model: string;
	thinking: { requested: string; effective: string };
	path: string;
	ok?: boolean;
	sessionRef?: string;
	error?: string;
	tokens?: number;
	costUsd?: number;
}

export interface AckRecord {
	seat: string;
	callsign: string;
	ok: boolean;
	hash: string;
	response: string;
	error?: string;
}

export type UltraplanPhase = "grilling" | "fusing" | "fused" | "done" | "aborted";

export interface UltraplanSession {
	planId: string;
	planDir: string;
	runId: string;
	runDir: string;
	brief: string;
	phase: UltraplanPhase;
	questions: GrillQuestion[];
	seats: SeatRecord[];
	judge?: { callsign: string; model: string };
	fuser?: { callsign: string; model: string };
	vacant: string[];
	notes: string[];
	fusedPath?: string;
	fusedHash?: string;
	acks: AckRecord[];
	controller: AbortController;
	startedAt: number;
}

export interface UltraplanController {
	run(args: string, ctx: any): Promise<void>;
	start(ctx: any, brief: string): Promise<UltraplanSession | undefined>;
	answer(ctx: any, n: number, text: string): boolean;
	fuse(ctx: any): Promise<UltraplanSession | undefined>;
	done(ctx: any): boolean;
	abort(ctx: any): boolean;
	status(ctx: any): string;
	session(): UltraplanSession | undefined;
}

export const MIN_LIVE_SEATS = 3;
export const ULTRAPLAN_HELP = [
	"/ultraplan <brief>            grill the brief (plan mode on), then /ultraplan fuse",
	"/ultraplan answer <n> <text>  answer question n (unanswered → the recommendation)",
	"/ultraplan fuse               seats draft → judge ranks → fuser merges → seats ACK",
	"/ultraplan done               leave plan mode; next: /create-workflow --from-plan <planId>",
	"/ultraplan status | abort",
].join("\n");

/** The grilling round's structured output. */
export const QUESTIONS_SCHEMA: JsonSchema = {
	type: "object",
	properties: {
		questions: {
			type: "array",
			items: {
				type: "object",
				properties: { n: { type: "integer" }, question: { type: "string" }, recommendation: { type: "string" }, why: { type: "string" } },
				required: ["question", "recommendation"],
			},
		},
	},
	required: ["questions"],
};

// ═══ Pure helpers ════════════════════════════════════════════════════════════

export type UltraplanArgs =
	| { verb: "start"; brief: string }
	| { verb: "answer"; n: number; text: string }
	| { verb: "fuse" | "done" | "abort" | "status" | "help" };

export function parseUltraplanArgs(raw: string): UltraplanArgs {
	const text = (raw ?? "").trim();
	if (!text || text === "help" || text === "--help") return { verb: "help" };
	const [head, ...rest] = text.split(/\s+/);
	const word = head.toLowerCase();
	if (word === "answer") {
		const n = Number.parseInt(rest[0] ?? "", 10);
		const answer = rest.slice(1).join(" ").trim();
		if (!Number.isFinite(n) || n < 1 || !answer) return { verb: "help" };
		return { verb: "answer", n, text: answer };
	}
	if (word === "fuse" || word === "done" || word === "abort" || word === "status") return { verb: word };
	return { verb: "start", brief: text };
}

/** A, B, …, Z, AA, AB … */
export function seatLetter(index: number): string {
	let n = index;
	let out = "";
	do {
		out = String.fromCharCode(65 + (n % 26)) + out;
		n = Math.floor(n / 26) - 1;
	} while (n >= 0);
	return out;
}

export function planIdFor(now: Date = new Date()): string {
	const stamp = now.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
	return `plan-${stamp}-${randomBytes(3).toString("hex")}`;
}

export interface ContextPack {
	text: string;
	files: Array<{ path: string; bytes: number; sha256: string; truncated: boolean }>;
}

const PACK_CANDIDATES = ["vision.md", "intent.md", "AGENTS.md", "README.md"];

/** The curated project documents every seat sees, bounded and hashed. */
export function contextPack(cwd: string, maxChars = 60_000): ContextPack {
	const found: Array<{ rel: string; text: string }> = [];
	for (const name of PACK_CANDIDATES) {
		const file = path.join(cwd, name);
		try {
			if (fs.statSync(file).isFile()) found.push({ rel: name, text: fs.readFileSync(file, "utf8") });
		} catch {}
	}
	const terraform = path.join(cwd, ".titan", "terraform");
	try {
		for (const entry of fs.readdirSync(terraform).sort()) {
			if (!entry.endsWith(".md")) continue;
			found.push({ rel: path.join(".titan", "terraform", entry), text: fs.readFileSync(path.join(terraform, entry), "utf8") });
		}
	} catch {}
	if (!found.length) return { text: "(no project documents found)", files: [] };
	const total = found.reduce((sum, file) => sum + file.text.length, 0);
	const budget = Math.max(1, maxChars);
	const files: ContextPack["files"] = [];
	const sections: string[] = [];
	for (const file of found) {
		const share = total > budget ? Math.max(2_000, Math.floor((budget * file.text.length) / total)) : file.text.length;
		const truncated = file.text.length > share;
		const body = truncated ? `${file.text.slice(0, share)}\n… [truncated ${file.text.length - share} chars]` : file.text;
		files.push({ path: file.rel, bytes: Buffer.byteLength(file.text), sha256: sha256(file.text), truncated });
		sections.push(`## ${file.rel}\n${body}`);
	}
	return { text: sections.join("\n\n"), files };
}

/** The questions as the human reads them. */
export function renderQuestions(questions: GrillQuestion[]): string {
	if (!questions.length) return "(the architect asked no questions — /ultraplan fuse proceeds on the brief alone)";
	return questions
		.map((q) => {
			const state = q.answered === "human" ? `✓ answered: ${q.answer}` : q.answered === "recommendation" ? `→ recommendation accepted` : "○ pending (recommendation applies at /ultraplan fuse)";
			return `**${q.n}. ${q.question}**\n   recommendation: ${q.recommendation}${q.why ? `\n   why: ${q.why}` : ""}\n   ${state}`;
		})
		.join("\n\n");
}

/** The binding decisions block every seat, the judge and the fuser receive. */
export function answersText(questions: GrillQuestion[]): string {
	if (!questions.length) return "(no grilling questions; plan from the brief alone)";
	return questions.map((q) => `${q.n}. ${q.question}\n   decision: ${q.answer ?? q.recommendation}${q.answered === "human" ? "" : " (recommendation accepted)"}`).join("\n");
}

/** Anonymous drafts for the judge and the fuser. */
export function draftsText(seats: Array<{ letter: string; text: string; ok: boolean }>): string {
	return seats.map((seat) => `## Seat ${seat.letter}\n${seat.ok ? seat.text : "(this seat produced no draft)"}`).join("\n\n");
}

/** The judge's YAML: fenced or bare; `yaml` is the unfenced document text when it parsed as a mapping. */
export function parseJudgeYaml(text: string): { ok: boolean; value?: Record<string, unknown>; raw: string; yaml?: string; error?: string } {
	const fenced = text.match(/```(?:yaml|yml)?\s*\n([\s\S]*?)```/i);
	const body = (fenced ? fenced[1] : text).trim();
	try {
		const value = parseYaml(body);
		if (!value || typeof value !== "object" || Array.isArray(value)) return { ok: false, raw: text, error: "judge output is not a YAML mapping" };
		return { ok: true, value: value as Record<string, unknown>, raw: text, yaml: body };
	} catch (error) {
		return { ok: false, raw: text, error: error instanceof Error ? error.message : String(error) };
	}
}

export function ackTable(acks: AckRecord[]): string {
	const rows = acks.map((ack) => `| ${ack.seat} | ${ack.callsign} | ${ack.ok ? "✓ ACK" : "✗ missing"} | ${ack.hash.slice(0, 16)}… |`);
	return ["## Seat ACKs", "", "| seat | callsign | ack | sha256 (plan text above this table) |", "|---|---|---|---|", ...rows].join("\n");
}

/** Live fusion seats, the judge and the fuser of a resolved ultraplan stack. */
export function ultraplanTeam(stack: ModelStack): { seats: ModelSlot[]; judge?: ModelSlot; fuser?: ModelSlot; architect: ModelSlot } {
	const live = stack.slots.filter((slot) => !(slot as { vacant?: boolean }).vacant);
	return {
		seats: live.filter((slot) => slotRole(slot) === "fusion"),
		judge: live.find((slot) => slotRole(slot) === "judge") ?? stack.lanes?.judge,
		fuser: live.find((slot) => slotRole(slot) === "fuser") ?? stack.lanes?.fuser,
		architect: stack.architect,
	};
}

const requestedThinking = (slot: ModelSlot): string => slot.requestedThinking ?? slot.thinking;
const thinkingOf = (slot: ModelSlot) => normalizeThinking(slot.model, slot.thinking);
/** "xhigh↘high" — the YAML's requested level against the provider ceiling. */
const labelOf = (slot: ModelSlot): string => thinkingLabel(normalizeThinking(slot.model, requestedThinking(slot) as never));
const tokensOf = (run: AgentRun): number => run.tokensIn + run.tokensOut;
const fmtUsd = (value: number): string => `$${value.toFixed(4)}`;

// ═══ The controller ══════════════════════════════════════════════════════════

export function createUltraplan(deps: UltraplanDeps): UltraplanController {
	let current: UltraplanSession | undefined;
	const now = () => deps.now?.() ?? new Date();

	const write = (dir: string, name: string, body: string): string => {
		fs.mkdirSync(path.dirname(path.join(dir, name)), { recursive: true });
		fs.writeFileSync(path.join(dir, name), body);
		return path.join(dir, name);
	};
	const event = (session: UltraplanSession, type: string, data: Record<string, unknown>, agentId?: string) => {
		try {
			deps.store().appendEvent(session.runDir, type, data, agentId);
		} catch {}
	};
	const ledger = (session: UltraplanSession, run: AgentRun, origin: LedgerOrigin, agentId: string) => {
		try {
			// D7: the row carries the YAML's requested level and the provider-normalized effective level.
			const row = rowFromAgentRun(run, session.runId, origin, run.slot ? thinkingOf(run.slot).effective : run.thinking, agentId);
			if (run.slot) row.thinking = { requested: requestedThinking(run.slot), effective: thinkingOf(run.slot).effective };
			appendLedger(session.runDir, row);
		} catch {}
		try {
			deps.recordRun(run);
		} catch {}
	};
	const spawnFresh = (session: UltraplanSession): SpawnIdentity => ({ sessionDir: path.join(session.runDir, "sessions"), sessionId: randomUUID() });
	const spawnFor = (session: UltraplanSession, slot: ModelSlot, ctx: any): SpawnIdentity => (deps.slotSpawn ? deps.slotSpawn(slot, ctx, path.join(session.runDir, "sessions", slot.id)) : spawnFresh(session));

	const inFlight = (): boolean => !!current && (current.phase === "grilling" || current.phase === "fusing" || current.phase === "fused");

	const controller: UltraplanController = {
		session: () => current,

		async run(args, ctx) {
			const parsed = parseUltraplanArgs(args);
			switch (parsed.verb) {
				case "help":
					deps.notify(ctx, ULTRAPLAN_HELP);
					return;
				case "start":
					await controller.start(ctx, parsed.brief);
					return;
				case "answer":
					controller.answer(ctx, parsed.n, parsed.text);
					return;
				case "fuse":
					await controller.fuse(ctx);
					return;
				case "done":
					controller.done(ctx);
					return;
				case "abort":
					controller.abort(ctx);
					return;
				case "status":
					deps.notify(ctx, controller.status(ctx));
					return;
			}
		},

		async start(ctx, brief) {
			if (inFlight()) {
				deps.notify(ctx, `ultraplan ${current!.planId} is in flight (${current!.phase}). /ultraplan done or /ultraplan abort first.`, "warning");
				return undefined;
			}
			const resolved = deps.resolveStack("ultraplan");
			const team = ultraplanTeam(resolved.stack);
			if (team.seats.length < MIN_LIVE_SEATS) {
				deps.notify(ctx, `ultraplan needs ${MIN_LIVE_SEATS} live fusion seats; found ${team.seats.length}${resolved.vacant.length ? ` (vacant: ${resolved.vacant.join(", ")})` : ""} — running /titan-opinion instead.`, "warning");
				await deps.opinionFallback(brief, ctx);
				return undefined;
			}
			if (!team.judge || !team.fuser) {
				deps.notify(ctx, "ultraplan shape has no judge or no fuser seat — fix model-stack-ultraplan.yaml.", "error");
				return undefined;
			}
			if (team.judge.model === team.fuser.model) {
				deps.notify(ctx, `ultraplan refused: the judge (${team.judge.name}) and the fuser (${team.fuser.name}) resolve to the same model; the judge must differ from the fuser.`, "error");
				return undefined;
			}
			const cwd = deps.cwd(ctx);
			const planId = planIdFor(now());
			const planDir = path.join(cwd, ".titan", "plans", planId);
			fs.mkdirSync(planDir, { recursive: true });
			const store = deps.store();
			const opened = store.open({ projectSlug: RunStore.projectSlug(cwd), cwd, command: "ultraplan", status: "running", phases: ["grill", "fuse", "done"], currentPhase: "grill" });
			const session: UltraplanSession = {
				planId,
				planDir,
				runId: opened.runId,
				runDir: opened.dir,
				brief,
				phase: "grilling",
				questions: [],
				seats: [],
				judge: { callsign: team.judge.name, model: team.judge.model },
				fuser: { callsign: team.fuser.name, model: team.fuser.model },
				vacant: [...resolved.vacant],
				notes: [...resolved.notes],
				acks: [],
				controller: new AbortController(),
				startedAt: Date.now(),
			};
			current = session;
			fs.mkdirSync(path.join(session.runDir, "sessions"), { recursive: true, mode: 0o700 });
			deps.planMode.enable(ctx);
			write(planDir, "brief.md", `${brief}\n`);
			const pack = contextPack(cwd, deps.contextPackMaxChars);
			write(planDir, "context-manifest.json", `${JSON.stringify({ planId, files: pack.files }, null, 2)}\n`);
			event(session, "ultraplan.start", { planId, brief: sha256(brief), seats: team.seats.map((slot) => slot.name), judge: team.judge.name, fuser: team.fuser.name, vacant: session.vacant, notes: session.notes });

			// Grilling round: the architect asks; structured output v1 (schema in the prompt).
			const architect = team.architect;
			const run = newRun("ARCHITECT", architect.model, architect);
			const prompt = `${fill("USER_PROMPT_ULTRAPLAN_GRILL.md", { BRIEF: brief, CONTEXT_PACK: pack.text })}${schemaPromptSuffix(QUESTIONS_SCHEMA)}`;
			await deps.runChild({ run, prompt, systemPrompt: architect.systemPrompt, appendSystemPrompts: architect.appendSystemPrompts, tools: READONLY_TOOLS, thinking: architect.thinking, ...spawnFor(session, architect, ctx), cwd, timeoutMs: deps.childTimeoutMs(), signal: session.controller.signal });
			ledger(session, run, "run", "architect");
			if (runOk(run)) {
				const parsed = parseStructured(run.text, QUESTIONS_SCHEMA);
				if (parsed.ok) {
					const raw = (parsed.value as { questions: Array<{ question: string; recommendation: string; why?: string }> }).questions;
					session.questions = raw.slice(0, 12).map((q, index) => ({ n: index + 1, question: String(q.question), recommendation: String(q.recommendation), why: q.why ? String(q.why) : undefined, answered: "pending" as const }));
				} else {
					deps.notify(ctx, `ultraplan: the architect's questions did not match the schema (${parsed.errors.map((e) => `${e.path} ${e.message}`).join("; ")}); fusing on the brief alone is allowed.`, "warning");
				}
			} else {
				deps.notify(ctx, `ultraplan: grilling round failed (${runError(run)}); /ultraplan fuse proceeds on the brief alone.`, "warning");
			}
			write(planDir, "questions.json", `${JSON.stringify(session.questions, null, 2)}\n`);
			write(planDir, "questions.md", `# Grilling questions — ${planId}\n\n${renderQuestions(session.questions)}\n`);
			event(session, "ultraplan.questions", { count: session.questions.length, ok: runOk(run) });
			deps.panel(ctx, `◆ ULTRAPLAN ${planId} — QUESTIONS`, [`**brief:** ${brief}`, "", renderQuestions(session.questions), "", `answer with \`/ultraplan answer <n> <text>\`, then \`/ultraplan fuse\` (unanswered questions take the recommendation)`, session.notes.length ? `\nfallbacks: ${session.notes.join("; ")}` : "", session.vacant.length ? `vacant seats: ${session.vacant.join(", ")}` : ""].filter((line) => line !== "").join("\n"));
			return session;
		},

		answer(ctx, n, text) {
			const session = current;
			if (!session || session.phase !== "grilling") {
				deps.notify(ctx, "No ultraplan grilling round is open. /ultraplan <brief> first.", "warning");
				return false;
			}
			const question = session.questions.find((q) => q.n === n);
			if (!question) {
				deps.notify(ctx, `No question ${n}; the round has ${session.questions.length}.`, "warning");
				return false;
			}
			question.answer = text;
			question.answered = "human";
			write(session.planDir, "answers.md", `# Decisions — ${session.planId}\n\n${answersText(session.questions)}\n`);
			write(session.planDir, "questions.json", `${JSON.stringify(session.questions, null, 2)}\n`);
			event(session, "ultraplan.answer", { n, answer: sha256(text) });
			deps.notify(ctx, `answered ${n}/${session.questions.length}${session.questions.some((q) => q.answered === "pending") ? "" : " — every question answered; /ultraplan fuse"}`);
			return true;
		},

		async fuse(ctx) {
			const session = current;
			if (!session || session.phase !== "grilling") {
				deps.notify(ctx, session ? `ultraplan ${session.planId} is ${session.phase}; nothing to fuse.` : "No ultraplan session. /ultraplan <brief> first.", "warning");
				return undefined;
			}
			const resolved = deps.resolveStack("ultraplan");
			const team = ultraplanTeam(resolved.stack);
			if (team.seats.length < MIN_LIVE_SEATS || !team.judge || !team.fuser || team.judge.model === team.fuser.model) {
				deps.notify(ctx, "ultraplan roster changed and is no longer valid (seats < 3 or judge = fuser); /ultraplan abort and start again.", "error");
				return session;
			}
			for (const q of session.questions) if (q.answered === "pending") q.answered = "recommendation";
			write(session.planDir, "answers.md", `# Decisions — ${session.planId}\n\n${answersText(session.questions)}\n`);
			session.phase = "fusing";
			const cwd = deps.cwd(ctx);
			const store = deps.store();
			try {
				store.updateRun(session.runDir, { currentPhase: "fuse" });
			} catch {}
			const pack = contextPack(cwd, deps.contextPackMaxChars);
			const answers = answersText(session.questions);
			const signal = session.controller.signal;
			const seatsDir = path.join(session.planDir, "seats");
			fs.mkdirSync(seatsDir, { recursive: true });

			// 1. Seats draft concurrently — anonymous letters, fresh read-only sessions.
			const seatRuns = team.seats.map((slot, index) => {
				const letter = seatLetter(index);
				const run = newRun("FUSION", slot.model, slot);
				const record: SeatRecord = { letter, callsign: slot.name, model: slot.model, thinking: { requested: requestedThinking(slot), effective: thinkingOf(slot).effective }, path: path.join(seatsDir, `${letter}.md`) };
				return { slot, letter, run, record };
			});
			session.seats = seatRuns.map((seat) => seat.record);
			const seatSpawns = new Map(seatRuns.map((seat) => [seat.letter, spawnFor(session, seat.slot, ctx)]));
			event(session, "ultraplan.seats", { seats: seatRuns.map((seat) => ({ letter: seat.letter, callsign: seat.slot.name })) });
			await Promise.all(
				seatRuns.map(async ({ slot, letter, run, record }) => {
					const prompt = fill("USER_PROMPT_ULTRAPLAN_SEAT.md", { SEAT_LETTER: letter, SEAT_COUNT: String(seatRuns.length), RUN_ID: session.runId, BRIEF: session.brief, ANSWERS: answers, CONTEXT_PACK: pack.text });
					const system = fill("SYSTEM_PROMPT_ULTRAPLAN_SEAT.md", { SEAT_LETTER: letter });
					await deps.runChild({ run, prompt, systemPrompt: system, appendSystemPrompts: [], tools: READONLY_TOOLS, thinking: slot.thinking, ...seatSpawns.get(letter)!, cwd, timeoutMs: deps.childTimeoutMs(), signal });
					record.ok = runOk(run);
					record.sessionRef = run.sessionRef;
					record.error = record.ok ? undefined : runError(run);
					record.tokens = tokensOf(run);
					record.costUsd = run.costUsd;
					write(seatsDir, `${letter}.md`, record.ok ? run.text : `FAILED: ${record.error}`);
					ledger(session, run, "fusion", `seat-${letter}`);
				}),
			);
			if (signal.aborted) return session;
			const drafts = seatRuns.map(({ letter, run }) => ({ letter, text: run.text, ok: runOk(run) }));
			const liveDrafts = drafts.filter((draft) => draft.ok);
			if (liveDrafts.length < MIN_LIVE_SEATS) {
				session.phase = "grilling";
				deps.notify(ctx, `ultraplan: only ${liveDrafts.length} of ${drafts.length} seats produced a draft (need ${MIN_LIVE_SEATS}); fix the roster or retry /ultraplan fuse.`, "error");
				event(session, "ultraplan.fuse_failed", { liveDrafts: liveDrafts.length });
				return session;
			}
			const draftsBlock = draftsText(drafts);

			// 2. Judge ranks the anonymous drafts (YAML).
			const judge = team.judge;
			const judgeRun = newRun("FUSION", judge.model, judge);
			await deps.runChild({ run: judgeRun, prompt: fill("USER_PROMPT_ULTRAPLAN_JUDGE.md", { RUN_ID: session.runId, SEAT_COUNT: String(drafts.length), BRIEF: session.brief, ANSWERS: answers, DRAFTS: draftsBlock }), systemPrompt: judge.systemPrompt, appendSystemPrompts: judge.appendSystemPrompts, tools: READONLY_TOOLS, thinking: judge.thinking, ...spawnFor(session, judge, ctx), cwd, timeoutMs: deps.childTimeoutMs(), signal });
			ledger(session, judgeRun, "judge", "judge");
			if (signal.aborted) return session;
			const judgeParsed = runOk(judgeRun) ? parseJudgeYaml(judgeRun.text) : { ok: false, raw: `FAILED: ${runError(judgeRun)}`, error: runError(judgeRun) };
			write(session.planDir, "judge.yaml", judgeParsed.ok ? `${judgeParsed.yaml}\n` : `# judge output could not be parsed as YAML (${judgeParsed.error})\n# raw output follows\n${judgeParsed.raw}\n`);
			if (!judgeParsed.ok) deps.notify(ctx, `ultraplan: judge output is not valid YAML (${judgeParsed.error}); the fuser receives the raw text.`, "warning");
			event(session, "ultraplan.judge", { ok: judgeParsed.ok, ranking: judgeParsed.ok ? (judgeParsed.value as { ranking?: unknown }).ranking ?? null : null });

			// 3. Fuser merges; the host writes fused-plan.md (the fuser is read-only).
			const fuser = team.fuser;
			const fuserRun = newRun("FUSION", fuser.model, fuser);
			await deps.runChild({ run: fuserRun, prompt: fill("USER_PROMPT_ULTRAPLAN_FUSE.md", { RUN_ID: session.runId, SEAT_COUNT: String(drafts.length), BRIEF: session.brief, ANSWERS: answers, JUDGE: judgeParsed.raw, DRAFTS: draftsBlock }), systemPrompt: fuser.systemPrompt, appendSystemPrompts: fuser.appendSystemPrompts, tools: READONLY_TOOLS, thinking: fuser.thinking, ...spawnFor(session, fuser, ctx), cwd, timeoutMs: deps.childTimeoutMs(), signal });
			ledger(session, fuserRun, "fuser", "fuser");
			if (signal.aborted) return session;
			if (!runOk(fuserRun)) {
				session.phase = "grilling";
				deps.notify(ctx, `ultraplan: the fuser failed (${runError(fuserRun)}); seats and judge are on disk under ${session.planDir}. Retry /ultraplan fuse.`, "error");
				event(session, "ultraplan.fuse_failed", { fuser: runError(fuserRun) });
				return session;
			}
			const fusedText = fuserRun.text;
			const fusedPath = write(session.planDir, "fused-plan.md", `${fusedText}\n`);
			const ack = fusionContextAckPrompt(session.runId, fusedText);
			session.fusedPath = fusedPath;
			session.fusedHash = ack.hash;
			event(session, "ultraplan.fused", { sha256: ack.hash, bytes: Buffer.byteLength(fusedText) });

			// 4. Every live seat ACKs the fused bytes (resume its own session; one retry).
			const expected = `ACK FUSION ${session.runId}`;
			const acks: AckRecord[] = [];
			await Promise.all(
				seatRuns
					.filter(({ run }) => runOk(run))
					.map(async ({ slot, letter, run }) => {
						const identity: SpawnIdentity = run.sessionRef ? { sessionDir: seatSpawns.get(letter)!.sessionDir, resume: run.sessionRef } : spawnFor(session, slot, ctx);
						let final = newRun("FUSION", slot.model, slot);
						await deps.runChild({ run: final, prompt: ack.prompt, systemPrompt: fill("SYSTEM_PROMPT_ULTRAPLAN_SEAT.md", { SEAT_LETTER: letter }), appendSystemPrompts: [], tools: "none", thinking: slot.thinking, ...identity, cwd, timeoutMs: deps.childTimeoutMs(), signal });
						ledger(session, final, "fusion", `seat-${letter}-ack`);
						if (!signal.aborted && (!runOk(final) || final.text.trim() !== expected)) {
							const retry = newRun("FUSION", slot.model, slot);
							const retryIdentity: SpawnIdentity = final.sessionRef ? { sessionDir: identity.sessionDir, resume: final.sessionRef } : identity;
							await deps.runChild({ run: retry, prompt: ack.prompt, systemPrompt: fill("SYSTEM_PROMPT_ULTRAPLAN_SEAT.md", { SEAT_LETTER: letter }), appendSystemPrompts: [], tools: "none", thinking: slot.thinking, ...retryIdentity, cwd, timeoutMs: deps.childTimeoutMs(), signal });
							ledger(session, retry, "fusion", `seat-${letter}-ack`);
							final = retry;
						}
						const ok = runOk(final) && final.text.trim() === expected && final.toolCalls === 0;
						acks.push({ seat: letter, callsign: slot.name, ok, hash: ack.hash, response: final.text.trim(), error: ok ? undefined : runOk(final) ? `expected exact ${expected}` : runError(final) });
					}),
			);
			acks.sort((a, b) => a.seat.localeCompare(b.seat));
			session.acks = acks;
			write(session.planDir, "acks.json", `${JSON.stringify({ runId: session.runId, sha256: ack.hash, acks }, null, 2)}\n`);
			fs.appendFileSync(fusedPath, `\n${ackTable(acks)}\n`);
			event(session, "ultraplan.acks", { ok: acks.every((a) => a.ok), acked: acks.filter((a) => a.ok).length, seats: acks.length, sha256: ack.hash });
			session.phase = "fused";
			try {
				store.updateRun(session.runDir, { currentPhase: "done" });
			} catch {}

			const seatRows = session.seats.map((seat) => `| ${seat.letter} | ${seat.callsign} | ${seat.model} | ${thinkingLabel(normalizeThinking(seat.model, seat.thinking.requested as never))} | ${seat.ok ? "✓" : "✗"} | ${seat.tokens ?? 0} | ${fmtUsd(seat.costUsd ?? 0)} |`);
			deps.panel(
				ctx,
				`◆ ULTRAPLAN ${session.planId} — FUSED`,
				[
					`**brief:** ${session.brief}`,
					"",
					"| seat | callsign | model | thinking | draft | tokens | cost |",
					"|---|---|---|---|---|---|---|",
					...seatRows,
					`| judge | ${judge.name} | ${judge.model} | ${labelOf(judge)} | ${judgeParsed.ok ? "✓ yaml" : "✗ raw"} | ${tokensOf(judgeRun)} | ${fmtUsd(judgeRun.costUsd)} |`,
					`| fuser | ${fuser.name} | ${fuser.model} | ${labelOf(fuser)} | ✓ | ${tokensOf(fuserRun)} | ${fmtUsd(fuserRun.costUsd)} |`,
					"",
					judgeParsed.ok && typeof (judgeParsed.value as { summary?: unknown }).summary === "string" ? `**judge:** ${(judgeParsed.value as { summary: string }).summary}` : "",
					`**fused plan:** \`${fusedPath}\` · sha256 ${ack.hash}`,
					`**ACKs:** ${acks.filter((a) => a.ok).length}/${acks.length}${acks.some((a) => !a.ok) ? ` (missing: ${acks.filter((a) => !a.ok).map((a) => a.seat).join(", ")})` : ""}`,
					session.vacant.length ? `**vacant seats:** ${session.vacant.join(", ")}` : "",
					session.notes.length ? `**fallbacks:** ${session.notes.join("; ")}` : "",
					"",
					"`/ultraplan done` to leave plan mode, then `/create-workflow --from-plan " + session.planId + "`",
				]
					.filter((line) => line !== "")
					.join("\n"),
			);
			return session;
		},

		done(ctx) {
			const session = current;
			if (!session || session.phase === "done" || session.phase === "aborted") {
				deps.notify(ctx, "No open ultraplan session.", "warning");
				return false;
			}
			if (session.phase !== "fused") deps.notify(ctx, `ultraplan ${session.planId} closed before fusion (${session.phase}); no fused plan was produced.`, "warning");
			session.phase = "done";
			deps.planMode.disable(ctx);
			try {
				deps.store().updateRun(session.runDir, { status: "completed", endedAt: now().toISOString(), currentPhase: "done" });
			} catch {}
			event(session, "ultraplan.done", { planId: session.planId, fused: !!session.fusedPath, sha256: session.fusedHash ?? null });
			deps.notify(ctx, session.fusedPath ? `ultraplan ${session.planId} done · plan mode off · next: /create-workflow --from-plan ${session.planId}` : `ultraplan ${session.planId} closed · plan mode off`);
			return true;
		},

		abort(ctx) {
			const session = current;
			if (!session || session.phase === "done" || session.phase === "aborted") {
				deps.notify(ctx, "No open ultraplan session.", "warning");
				return false;
			}
			session.controller.abort();
			session.phase = "aborted";
			deps.planMode.disable(ctx);
			try {
				deps.store().updateRun(session.runDir, { status: "aborted", endedAt: now().toISOString() });
			} catch {}
			event(session, "ultraplan.abort", { planId: session.planId });
			deps.notify(ctx, `ultraplan ${session.planId} aborted · plan mode off`, "warning");
			return true;
		},

		status() {
			const session = current;
			if (!session) return "ultraplan: no session. /ultraplan <brief> to start.";
			const pending = session.questions.filter((q) => q.answered === "pending").length;
			return [
				`ultraplan ${session.planId} · ${session.phase} · run ${session.runId}`,
				`questions ${session.questions.length} (${pending} pending) · seats ${session.seats.length ? session.seats.map((seat) => `${seat.letter}=${seat.callsign}${seat.ok === false ? "✗" : ""}`).join(" ") : "not drafted"}${session.vacant.length ? ` · vacant ${session.vacant.join(",")}` : ""}`,
				session.fusedPath ? `fused ${session.fusedPath} · sha256 ${session.fusedHash} · ACKs ${session.acks.filter((a) => a.ok).length}/${session.acks.length}` : `plan dir ${session.planDir}`,
			].join("\n");
		},
	};
	return controller;
}

// ═══ Registration ════════════════════════════════════════════════════════════

export function registerUltraplanCommand(pi: ExtensionAPI, deps: UltraplanDeps): UltraplanController {
	const controller = createUltraplan(deps);
	pi.registerCommand("ultraplan", {
		description: "Plan mode + fusion team: grill the brief, anonymous seat drafts, judge, fuse, seat ACKs. /ultraplan <brief> | answer <n> <text> | fuse | done | abort | status",
		getArgumentCompletions: (prefix: string) => {
			const verbs = ["answer", "fuse", "done", "abort", "status", "help"];
			const items = verbs.filter((verb) => verb.startsWith(prefix.trim().toLowerCase())).map((verb) => ({ value: verb, label: verb }));
			return items.length ? items : null;
		},
		handler: async (args: string, ctx: any) => {
			await controller.run(args ?? "", ctx);
		},
	} as any);
	return controller;
}

/** Guard against an unused import when the prompt directory is probed at load time. */
export const ULTRAPLAN_PROMPT_FILES = ["SYSTEM_PROMPT_ULTRAPLAN_SEAT.md", "USER_PROMPT_ULTRAPLAN_GRILL.md", "USER_PROMPT_ULTRAPLAN_SEAT.md", "USER_PROMPT_ULTRAPLAN_JUDGE.md", "USER_PROMPT_ULTRAPLAN_FUSE.md"];
export const promptFilesPresent = (): string[] => ULTRAPLAN_PROMPT_FILES.filter((file) => {
	try {
		promptTemplate(file);
		return true;
	} catch {
		return false;
	}
});
