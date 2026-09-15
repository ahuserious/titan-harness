/**
 * trigger.ts — `trigger:` workflows (plan §5.7, P9): when a workflow fires, the
 * resident-run lock that keeps two fires of the same workflow from overlapping, the
 * catch-up rule, the in-process scheduler a Pi session runs while it is open, and the
 * `orca automations create …` recipe for firing a workflow without a session.
 *
 *   parseEvery("15m") → ms          "30s" | "15m" | "6h" | "1d" (ms too); anything else throws
 *   parseCron("0 9 * * 1-5")        five fields, lists / ranges / steps / `*`, month and
 *                                   weekday names (jan…dec, sun…sat); `.nextRun(after)`
 *   nextFire(spec, after)           the next fire strictly after `after`; undefined for
 *                                   event triggers (those are fired by whoever sees the event)
 *   acquireLock(root, workflow)     <root>/<workflow>.lock created O_EXCL with {pid,
 *                                   startedAt, heartbeatAt}; a holder whose pid is dead or
 *                                   whose heartbeat is older than staleMs (10 min) is stale
 *                                   and cleared ONCE, then the create is retried once
 *   schedulePlan(specs, now)        due / catchUp / next per workflow: a missed window runs
 *                                   once (`catchUp: latest`), never once per missed slot
 *   createScheduler(deps)           tick(): due workflows run under the lock; a fire that
 *                                   finds the lock held is `skipped-overlap`; start()/stop()
 *                                   wrap tick() in an unref'd interval
 *   orcaAutomationRecipe(...)       one `orca automations create` line: --precheck runs
 *                                   scripts/titan-lock-check.mjs (exit 1 while a live lock
 *                                   exists) and --prompt runs `pi -p "/workflow run <name>"`
 *
 * Pure Node: files, timers and process.kill(pid, 0) for liveness. No pi imports.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

export interface TriggerSpec {
	cron?: string;
	every?: string;
	event?: string;
	entity_profile?: string;
}

/** Where run locks live unless a caller names another root. */
export const DEFAULT_LOCK_ROOT = path.join(os.homedir(), ".pi", "titan-harness", "locks");
/** A holder that has not heartbeat for this long is stale. */
export const DEFAULT_STALE_MS = 10 * 60 * 1000;
/** The scheduler's default tick. */
export const DEFAULT_TICK_MS = 30 * 1000;

// ═══ every / cron ════════════════════════════════════════════════════════════

const EVERY_UNITS: Record<string, number> = { ms: 1, s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 };

/** "30s" | "15m" | "6h" | "1d" (and "250ms") → milliseconds; throws on anything else or on zero. */
export function parseEvery(text: string): number {
	const match = /^\s*(\d+)\s*(ms|s|m|h|d)\s*$/.exec(String(text ?? ""));
	if (!match) throw new Error(`trigger.every must look like 30s, 15m, 6h or 1d; found ${JSON.stringify(text)}`);
	const ms = Number(match[1]) * EVERY_UNITS[match[2]];
	if (!(ms > 0)) throw new Error(`trigger.every must be positive; found ${JSON.stringify(text)}`);
	return ms;
}

export interface CronSpec {
	minute: number[];
	hour: number[];
	dom: number[];
	month: number[];
	dow: number[];
	/** True when the day-of-month field is `*` (then dow alone restricts the day, and vice versa — Vixie cron semantics). */
	anyDom: boolean;
	anyDow: boolean;
	source: string;
	/** The next fire strictly after `after` (local time), or throws when none exists within four years. */
	nextRun(after: Date): Date;
	/** The latest fire at or before `at` (local time), or undefined when none exists within four years. */
	prevRun(at: Date): Date | undefined;
}

const MONTH_NAMES = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
const DOW_NAMES = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];

function parseField(field: string, lo: number, hi: number, names: string[] | undefined, label: string): { values: number[]; any: boolean } {
	const named = (token: string): number => {
		const lower = token.toLowerCase();
		if (names) {
			const index = names.indexOf(lower);
			if (index >= 0) return index + lo;
		}
		if (!/^\d+$/.test(token)) throw new Error(`cron ${label}: unknown value ${JSON.stringify(token)}`);
		return Number(token);
	};
	const values = new Set<number>();
	let any = false;
	for (const part of field.split(",")) {
		if (!part) throw new Error(`cron ${label}: empty list item in ${JSON.stringify(field)}`);
		const [rangeText, stepText] = part.split("/");
		const step = stepText === undefined ? 1 : Number(stepText);
		if (!(Number.isInteger(step) && step >= 1)) throw new Error(`cron ${label}: bad step in ${JSON.stringify(part)}`);
		let start: number;
		let end: number;
		if (rangeText === "*") {
			start = lo;
			end = hi;
			if (step === 1) any = true;
		} else if (rangeText.includes("-")) {
			const [a, b] = rangeText.split("-");
			start = named(a);
			end = named(b);
		} else {
			start = named(rangeText);
			end = stepText === undefined ? start : hi;
		}
		if (start < lo || end > hi || start > end) throw new Error(`cron ${label}: ${JSON.stringify(part)} is outside ${lo}-${hi}`);
		for (let v = start; v <= end; v += step) values.add(v);
	}
	// Vixie cron accepts 7 for Sunday.
	if (names === DOW_NAMES && values.has(7)) {
		values.delete(7);
		values.add(0);
	}
	return { values: [...values].sort((a, b) => a - b), any };
}

/** Five-field cron (minute hour day-of-month month day-of-week) with lists, ranges, steps, `*` and month/weekday names. A sixth (year) field is refused. */
export function parseCron(expr: string): CronSpec {
	const fields = String(expr ?? "")
		.trim()
		.split(/\s+/)
		.filter(Boolean);
	if (fields.length !== 5) throw new Error(`cron expression needs exactly 5 fields (minute hour day-of-month month day-of-week); found ${fields.length} in ${JSON.stringify(expr)}`);
	const minute = parseField(fields[0], 0, 59, undefined, "minute");
	const hour = parseField(fields[1], 0, 23, undefined, "hour");
	const dom = parseField(fields[2], 1, 31, undefined, "day-of-month");
	const month = parseField(fields[3], 1, 12, MONTH_NAMES, "month");
	const dow = parseField(fields[4], 0, 7, DOW_NAMES, "day-of-week");
	const spec: CronSpec = {
		minute: minute.values,
		hour: hour.values,
		dom: dom.values,
		month: month.values,
		dow: dow.values,
		anyDom: dom.any,
		anyDow: dow.any,
		source: fields.join(" "),
		nextRun: (after) => cronNext(spec, after),
		prevRun: (at) => cronPrev(spec, at),
	};
	return spec;
}

const dayMatches = (spec: CronSpec, date: Date): boolean => {
	const domOk = spec.dom.includes(date.getDate());
	const dowOk = spec.dow.includes(date.getDay());
	if (spec.anyDom && spec.anyDow) return true;
	if (spec.anyDom) return dowOk;
	if (spec.anyDow) return domOk;
	return domOk || dowOk; // both restricted → either matches (Vixie cron)
};

const FOUR_YEARS_MINUTES = 4 * 366 * 24 * 60;

function cronNext(spec: CronSpec, after: Date): Date {
	// Minute resolution: start at the next whole minute after `after`.
	const t = new Date(after.getTime());
	t.setSeconds(0, 0);
	t.setMinutes(t.getMinutes() + 1);
	for (let i = 0; i < FOUR_YEARS_MINUTES; ) {
		if (!spec.month.includes(t.getMonth() + 1)) {
			// jump to the first day of the next month
			t.setMonth(t.getMonth() + 1, 1);
			t.setHours(0, 0, 0, 0);
			i += 60 * 24;
			continue;
		}
		if (!dayMatches(spec, t)) {
			t.setDate(t.getDate() + 1);
			t.setHours(0, 0, 0, 0);
			i += 60 * 24;
			continue;
		}
		if (!spec.hour.includes(t.getHours())) {
			t.setHours(t.getHours() + 1, 0, 0, 0);
			i += 60;
			continue;
		}
		if (!spec.minute.includes(t.getMinutes())) {
			t.setMinutes(t.getMinutes() + 1, 0, 0);
			i += 1;
			continue;
		}
		return t;
	}
	throw new Error(`cron ${JSON.stringify(spec.source)} never fires within four years`);
}

function cronPrev(spec: CronSpec, at: Date): Date | undefined {
	const t = new Date(at.getTime());
	t.setSeconds(0, 0);
	for (let i = 0; i < FOUR_YEARS_MINUTES; ) {
		if (!spec.month.includes(t.getMonth() + 1)) {
			t.setDate(0); // last day of the previous month
			t.setHours(23, 59, 0, 0);
			i += 60 * 24;
			continue;
		}
		if (!dayMatches(spec, t)) {
			t.setDate(t.getDate() - 1);
			t.setHours(23, 59, 0, 0);
			i += 60 * 24;
			continue;
		}
		if (!spec.hour.includes(t.getHours())) {
			t.setHours(t.getHours() - 1, 59, 0, 0);
			i += 60;
			continue;
		}
		if (!spec.minute.includes(t.getMinutes())) {
			t.setMinutes(t.getMinutes() - 1, 0, 0);
			i += 1;
			continue;
		}
		return t;
	}
	return undefined;
}

/** The next fire strictly after `after`; `every` counts from `from` (default `after`); event triggers have no clock. */
export function nextFire(spec: TriggerSpec, after: Date, from?: Date): Date | undefined {
	if (spec.cron) return parseCron(spec.cron).nextRun(after);
	if (spec.every) {
		const ms = parseEvery(spec.every);
		const base = (from ?? after).getTime();
		const elapsed = after.getTime() - base;
		const slots = Math.floor(Math.max(0, elapsed) / ms) + 1;
		return new Date(base + slots * ms);
	}
	return undefined;
}

// ═══ Run locks ═══════════════════════════════════════════════════════════════

export interface RunLock {
	path: string;
	pid: number;
	startedAt: string;
	heartbeatAt: string;
	workflow: string;
}

export type LockResult = { ok: true; lock: RunLock; release(): void; heartbeat(): void } | { ok: false; reason: "running" | "stale-cleared-retry"; holder?: RunLock };

const LOCK_NAME_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;

export function lockPath(root: string, workflow: string): string {
	if (!LOCK_NAME_RE.test(workflow)) throw new Error(`workflow name ${JSON.stringify(workflow)} cannot name a lock file`);
	return path.join(root, `${workflow}.lock`);
}

/** True when a process with this pid exists (EPERM counts as alive). */
export function pidAlive(pid: number): boolean {
	if (!Number.isInteger(pid) || pid <= 0) return false;
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		return (error as NodeJS.ErrnoException).code === "EPERM";
	}
}

export function readLock(file: string): RunLock | undefined {
	try {
		const raw = JSON.parse(fs.readFileSync(file, "utf8"));
		if (!raw || typeof raw !== "object" || typeof raw.pid !== "number") return undefined;
		return { path: file, pid: raw.pid, startedAt: String(raw.startedAt ?? ""), heartbeatAt: String(raw.heartbeatAt ?? raw.startedAt ?? ""), workflow: String(raw.workflow ?? "") };
	} catch {
		return undefined;
	}
}

/** A holder is stale when its process is gone or its heartbeat is older than staleMs; an unreadable lock file is stale too. */
export function lockIsStale(holder: RunLock | undefined, staleMs: number, now: number = Date.now()): boolean {
	if (!holder) return true;
	if (!pidAlive(holder.pid)) return true;
	const beat = Date.parse(holder.heartbeatAt || holder.startedAt);
	return !Number.isFinite(beat) || now - beat > staleMs;
}

const writeLockFile = (file: string, lock: RunLock, exclusive: boolean): void => {
	const body = `${JSON.stringify({ pid: lock.pid, startedAt: lock.startedAt, heartbeatAt: lock.heartbeatAt, workflow: lock.workflow }, null, 2)}\n`;
	if (exclusive) {
		fs.writeFileSync(file, body, { flag: "wx", mode: 0o600 });
		return;
	}
	const tmp = `${file}.${process.pid}.${Math.random().toString(16).slice(2)}.tmp`;
	fs.writeFileSync(tmp, body, { mode: 0o600 });
	fs.renameSync(tmp, file);
};

/**
 * Take the resident-run lock for `workflow`. Exclusive create; a live holder → `running`;
 * a stale holder is cleared once and the create retried once (a lost race after the
 * clear → `stale-cleared-retry`, the caller may try again).
 */
export function acquireLock(root: string, workflow: string, opts: { staleMs?: number; now?: () => number } = {}): LockResult {
	const staleMs = opts.staleMs ?? DEFAULT_STALE_MS;
	const now = opts.now ?? Date.now;
	const file = lockPath(root, workflow);
	fs.mkdirSync(root, { recursive: true, mode: 0o700 });
	const attempt = (): LockResult | undefined => {
		const stamp = new Date(now()).toISOString();
		const lock: RunLock = { path: file, pid: process.pid, startedAt: stamp, heartbeatAt: stamp, workflow };
		try {
			writeLockFile(file, lock, true);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
			return undefined;
		}
		let released = false;
		const mine = (): boolean => readLock(file)?.pid === process.pid && readLock(file)?.startedAt === lock.startedAt;
		return {
			ok: true,
			lock,
			heartbeat: () => {
				if (released || !mine()) return;
				lock.heartbeatAt = new Date(now()).toISOString();
				writeLockFile(file, lock, false);
			},
			release: () => {
				if (released) return;
				released = true;
				if (!mine()) return;
				try {
					fs.unlinkSync(file);
				} catch {
					/* already gone */
				}
			},
		};
	};
	const first = attempt();
	if (first) return first;
	const holder = readLock(file);
	if (!lockIsStale(holder, staleMs, now())) return { ok: false, reason: "running", holder };
	// Stale: clear it once, retry the exclusive create once.
	try {
		fs.unlinkSync(file);
	} catch {
		/* someone else cleared it */
	}
	const second = attempt();
	if (second) return second;
	return { ok: false, reason: "stale-cleared-retry", holder: readLock(file) ?? holder };
}

// ═══ Planning and the in-process scheduler ══════════════════════════════════

export interface ScheduleInput {
	workflow: string;
	trigger: TriggerSpec;
	lastRun?: Date;
}

export interface SchedulePlanRow {
	workflow: string;
	due: boolean;
	/** More than one window was missed; the run that follows stands in for all of them (catchUp: latest). */
	catchUp: boolean;
	next?: Date;
	/** Why the row is not due (event trigger, first cron slot pending, …). */
	note?: string;
}

/**
 * Due when at least one fire time lies in (lastRun, now]. `every` with no lastRun fires
 * at once (arming is the first slot); `cron` with no lastRun waits for its next slot.
 * catchUp is true when more than one slot was missed — the scheduler still runs it once.
 */
export function schedulePlan(specs: ScheduleInput[], now: Date): SchedulePlanRow[] {
	return specs.map((spec) => {
		const { workflow, trigger, lastRun } = spec;
		if (trigger.cron) {
			let cron: CronSpec;
			try {
				cron = parseCron(trigger.cron);
			} catch (error) {
				return { workflow, due: false, catchUp: false, note: (error as Error).message };
			}
			const next = cron.nextRun(now);
			if (!lastRun) return { workflow, due: false, catchUp: false, next, note: "first cron slot pending" };
			const latest = cron.prevRun(now);
			if (!latest || latest.getTime() <= lastRun.getTime()) return { workflow, due: false, catchUp: false, next };
			const previous = cron.prevRun(new Date(latest.getTime() - 60_000));
			const catchUp = !!previous && previous.getTime() > lastRun.getTime();
			return { workflow, due: true, catchUp, next };
		}
		if (trigger.every) {
			let ms: number;
			try {
				ms = parseEvery(trigger.every);
			} catch (error) {
				return { workflow, due: false, catchUp: false, note: (error as Error).message };
			}
			if (!lastRun) return { workflow, due: true, catchUp: false, next: new Date(now.getTime() + ms) };
			const elapsed = now.getTime() - lastRun.getTime();
			const due = elapsed >= ms;
			return { workflow, due, catchUp: due && elapsed >= 2 * ms, next: due ? new Date(now.getTime() + ms) : new Date(lastRun.getTime() + ms) };
		}
		return { workflow, due: false, catchUp: false, note: trigger.event ? `event trigger (${trigger.event}); fired by the event source` : "no cron or every" };
	});
}

export type TickAction = "ran" | "skipped-overlap" | "not-due" | "caught-up" | "failed";

export interface SchedulerDeps {
	list(): Array<{ workflow: string; trigger: TriggerSpec }>;
	lastRun(workflow: string): Date | undefined;
	run(workflow: string): Promise<void>;
	/** Called after a fire settles (ran, caught-up or failed) so the caller can persist lastRun. */
	recordRun?(workflow: string, at: Date, outcome: "ran" | "caught-up" | "failed", error?: string): void;
	lockRoot: string;
	now?(): Date;
	tickMs?: number;
	staleMs?: number;
	log(text: string): void;
}

export interface Scheduler {
	start(): void;
	stop(): void;
	running(): boolean;
	tick(): Promise<Array<{ workflow: string; action: TickAction; note?: string }>>;
}

/** The in-process scheduler: alive while the Pi session is; every tick fires what is due under the run lock. */
export function createScheduler(deps: SchedulerDeps): Scheduler {
	let timer: ReturnType<typeof setInterval> | undefined;
	const now = deps.now ?? (() => new Date());
	const inFlight = new Set<string>();
	const tick: Scheduler["tick"] = async () => {
		const rows = schedulePlan(
			deps.list().map((entry) => ({ ...entry, lastRun: deps.lastRun(entry.workflow) })),
			now(),
		);
		const results: Array<{ workflow: string; action: TickAction; note?: string }> = [];
		await Promise.all(
			rows.map(async (row) => {
				if (!row.due) {
					results.push({ workflow: row.workflow, action: "not-due", note: row.note });
					return;
				}
				if (inFlight.has(row.workflow)) {
					results.push({ workflow: row.workflow, action: "skipped-overlap", note: "still running in this process" });
					return;
				}
				const lock = acquireLock(deps.lockRoot, row.workflow, { staleMs: deps.staleMs, now: () => now().getTime() });
				if (!lock.ok) {
					results.push({ workflow: row.workflow, action: "skipped-overlap", note: lock.reason === "running" ? `lock held by pid ${lock.holder?.pid ?? "?"}` : "lock contended after a stale clear" });
					deps.log(`titan schedule: ${row.workflow} skipped (${results[results.length - 1].note})`);
					return;
				}
				inFlight.add(row.workflow);
				const beat = setInterval(() => lock.heartbeat(), 60_000);
				beat.unref?.();
				const startedAt = now();
				const outcome: "ran" | "caught-up" = row.catchUp ? "caught-up" : "ran";
				try {
					deps.log(`titan schedule: ${row.workflow} firing${row.catchUp ? " (catch-up: latest)" : ""}`);
					await deps.run(row.workflow);
					results.push({ workflow: row.workflow, action: outcome });
					deps.recordRun?.(row.workflow, startedAt, outcome);
				} catch (error) {
					const message = error instanceof Error ? error.message : String(error);
					results.push({ workflow: row.workflow, action: "failed", note: message });
					deps.recordRun?.(row.workflow, startedAt, "failed", message);
					deps.log(`titan schedule: ${row.workflow} failed: ${message}`);
				} finally {
					clearInterval(beat);
					inFlight.delete(row.workflow);
					lock.release();
				}
			}),
		);
		return results;
	};
	return {
		start: () => {
			if (timer) return;
			timer = setInterval(() => {
				void tick().catch((error) => deps.log(`titan schedule: tick failed: ${error instanceof Error ? error.message : String(error)}`));
			}, deps.tickMs ?? DEFAULT_TICK_MS);
			timer.unref?.();
		},
		stop: () => {
			if (timer) clearInterval(timer);
			timer = undefined;
		},
		running: () => timer !== undefined,
		tick,
	};
}

// ═══ Orca automation recipe ═════════════════════════════════════════════════

/** The package root (…/titan-harness), for the precheck script path. */
export function packageRootForScripts(): string {
	return fileURLToPath(new URL("../../../../", import.meta.url)).replace(/[\\/]+$/, "");
}

const shellSingle = (text: string): string => `'${text.replace(/'/g, `'\\''`)}'`;
const shellDouble = (text: string): string => `"${text.replace(/(["\\$`])/g, "\\$1")}"`;

/** `every` → an Orca preset when one matches, else a 5-field cron; cron passes through. */
export function orcaTrigger(spec: TriggerSpec): string | undefined {
	if (spec.cron) return parseCron(spec.cron).source;
	if (spec.every) {
		const ms = parseEvery(spec.every);
		if (ms === 3_600_000) return "hourly";
		if (ms === 86_400_000) return "daily";
		if (ms % 86_400_000 === 0) return `0 0 */${ms / 86_400_000} * *`;
		if (ms % 3_600_000 === 0) return `0 */${ms / 3_600_000} * * *`;
		if (ms % 60_000 === 0 && ms < 3_600_000) return `*/${ms / 60_000} * * * *`;
		throw new Error(`trigger.every ${spec.every} has no cron equivalent for Orca (use whole minutes, hours or days)`);
	}
	return undefined;
}

/**
 * One `orca automations create` line that fires `/workflow run <workflow>` on the
 * trigger's schedule, guarded by the lock precheck so a fire never overlaps a live run.
 * Printed for the operator, never executed here. Event triggers have no recipe.
 */
export function orcaAutomationRecipe(workflow: string, trigger: TriggerSpec, cwd: string, opts: { packageRoot?: string; provider?: string } = {}): string {
	if (!LOCK_NAME_RE.test(workflow)) throw new Error(`workflow name ${JSON.stringify(workflow)} is not a valid workflow name`);
	const schedule = orcaTrigger(trigger);
	if (!schedule) return `# ${workflow}: trigger.event (${trigger.event ?? "?"}) has no schedule — fire it with: pi -p "/workflow run ${workflow}"`;
	const precheck = `node ${path.join(opts.packageRoot ?? packageRootForScripts(), "scripts", "titan-lock-check.mjs")} ${workflow}`;
	const prompt = `pi -p "/workflow run ${workflow}"`;
	return [
		"orca automations create",
		`--name titan-${workflow}`,
		`--trigger ${shellDouble(schedule)}`,
		`--precheck ${shellDouble(precheck)}`,
		`--prompt ${shellSingle(prompt)}`,
		`--provider ${opts.provider ?? "claude"}`,
		`--workspace ${shellDouble(`path:${cwd}`)}`,
	].join(" \\\n  ");
}
