import { afterEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { acquireLock, createScheduler, DEFAULT_STALE_MS, lockIsStale, lockPath, nextFire, orcaAutomationRecipe, orcaTrigger, parseCron, parseEvery, pidAlive, readLock, schedulePlan, type TriggerSpec } from "../modules/workflow/trigger.ts";

const dirs: string[] = [];
afterEach(() => {
	while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});
const scratch = (): string => {
	const dir = mkdtempSync(join(tmpdir(), "titan-trigger-"));
	dirs.push(dir);
	return dir;
};
const local = (y: number, m: number, d: number, h = 0, min = 0): Date => new Date(y, m - 1, d, h, min, 0, 0);
const DEAD_PID = 4_194_305; // above Linux pid_max: never a live process
const SCRIPT = fileURLToPath(new URL("../../../scripts/titan-lock-check.mjs", import.meta.url));

describe("parseEvery / parseCron", () => {
	test.each([
		["30s", 30_000],
		["15m", 900_000],
		["6h", 21_600_000],
		["1d", 86_400_000],
		["250ms", 250],
		[" 2h ", 7_200_000],
	])("parseEvery(%p) → %p", (text, ms) => {
		expect(parseEvery(text)).toBe(ms);
	});

	test("parseEvery refuses other spellings and zero", () => {
		for (const bad of ["15", "1w", "h", "", "0m", "1.5h"]) expect(() => parseEvery(bad)).toThrow();
	});

	test("cron fields: lists, ranges, steps, names, wildcards", () => {
		const spec = parseCron("*/15 9-11 1,15 jan-mar mon-fri");
		expect(spec.minute).toEqual([0, 15, 30, 45]);
		expect(spec.hour).toEqual([9, 10, 11]);
		expect(spec.dom).toEqual([1, 15]);
		expect(spec.month).toEqual([1, 2, 3]);
		expect(spec.dow).toEqual([1, 2, 3, 4, 5]);
		expect(spec.anyDom).toBe(false);
		expect(parseCron("0 0 * * 7").dow).toEqual([0]); // 7 = Sunday
		expect(parseCron("5/20 * * * *").minute).toEqual([5, 25, 45]);
		expect(parseCron("* * * * *").anyDom).toBe(true);
	});

	test("cron refuses the wrong field count, out-of-range values and bad steps", () => {
		expect(() => parseCron("0 9 * *")).toThrow("exactly 5 fields");
		expect(() => parseCron("0 9 * * * 2026")).toThrow("exactly 5 fields");
		expect(() => parseCron("60 9 * * *")).toThrow("outside");
		expect(() => parseCron("0 9 * 13 *")).toThrow("outside");
		expect(() => parseCron("*/0 * * * *")).toThrow("bad step");
		expect(() => parseCron("0 9 * * xyz")).toThrow("unknown value");
	});

	test.each([
		["*/15 * * * *", local(2026, 9, 15, 10, 7), local(2026, 9, 15, 10, 15)],
		["*/15 * * * *", local(2026, 9, 15, 10, 15), local(2026, 9, 15, 10, 30)], // strictly after
		["0 9 * * 1-5", local(2026, 9, 19, 12, 0), local(2026, 9, 21, 9, 0)], // Saturday → Monday
		["30 2 1 * *", local(2026, 9, 15, 10, 7), local(2026, 10, 1, 2, 30)],
		["0 0 29 feb *", local(2026, 1, 1), local(2028, 2, 29, 0, 0)],
		["0 12 1 * mon", local(2026, 9, 15), local(2026, 9, 21, 12, 0)], // dom OR dow when both restricted
	])("nextRun(%p after %p) → %p", (expr, after, expected) => {
		expect(parseCron(expr).nextRun(after).getTime()).toBe(expected.getTime());
	});

	test("prevRun is the latest fire at or before the instant", () => {
		expect(parseCron("0 9 * * mon-fri").prevRun(local(2026, 9, 19, 12, 0))!.getTime()).toBe(local(2026, 9, 18, 9, 0).getTime());
		expect(parseCron("*/15 * * * *").prevRun(local(2026, 9, 15, 10, 15))!.getTime()).toBe(local(2026, 9, 15, 10, 15).getTime());
	});

	test("nextFire: every counts from `from`, cron uses the expression, events have no clock", () => {
		expect(nextFire({ every: "6h" }, new Date("2026-09-15T10:07:00Z"), new Date("2026-09-15T00:00:00Z"))!.toISOString()).toBe("2026-09-15T12:00:00.000Z");
		expect(nextFire({ every: "15m" }, new Date("2026-09-15T10:07:00Z"))!.toISOString()).toBe("2026-09-15T10:22:00.000Z");
		expect(nextFire({ cron: "0 9 * * *" }, local(2026, 9, 15, 10, 0))!.getTime()).toBe(local(2026, 9, 16, 9, 0).getTime());
		expect(nextFire({ event: "file-signal" }, new Date())).toBeUndefined();
	});
});

describe("run locks", () => {
	test("exclusive: a second acquirer sees `running` with the holder; release frees it; heartbeat refreshes", () => {
		const root = scratch();
		const first = acquireLock(root, "nightly");
		expect(first.ok).toBe(true);
		if (!first.ok) return;
		expect(existsSync(lockPath(root, "nightly"))).toBe(true);
		const second = acquireLock(root, "nightly");
		expect(second).toMatchObject({ ok: false, reason: "running" });
		if (second.ok) return;
		expect(second.holder?.pid).toBe(process.pid);
		const before = readLock(first.lock.path)!.heartbeatAt;
		first.heartbeat();
		expect(Date.parse(readLock(first.lock.path)!.heartbeatAt)).toBeGreaterThanOrEqual(Date.parse(before));
		first.release();
		expect(existsSync(first.lock.path)).toBe(false);
		first.release(); // idempotent
		const third = acquireLock(root, "nightly");
		expect(third.ok).toBe(true);
		if (third.ok) third.release();
	});

	test("a stale holder (dead pid, or a heartbeat older than staleMs) is cleared once and the lock taken", () => {
		const root = scratch();
		const file = lockPath(root, "nightly");
		writeFileSync(file, JSON.stringify({ pid: DEAD_PID, startedAt: new Date().toISOString(), heartbeatAt: new Date().toISOString(), workflow: "nightly" }));
		expect(pidAlive(DEAD_PID)).toBe(false);
		expect(lockIsStale(readLock(file), DEFAULT_STALE_MS)).toBe(true);
		const taken = acquireLock(root, "nightly");
		expect(taken.ok).toBe(true);
		if (taken.ok) {
			expect(readLock(file)!.pid).toBe(process.pid);
			taken.release();
		}
		const old = new Date(Date.now() - 11 * 60_000).toISOString();
		writeFileSync(file, JSON.stringify({ pid: process.pid, startedAt: old, heartbeatAt: old, workflow: "nightly" }));
		expect(lockIsStale(readLock(file), DEFAULT_STALE_MS)).toBe(true);
		expect(lockIsStale(readLock(file), 60 * 60_000)).toBe(false); // a longer staleness window keeps it live
		const again = acquireLock(root, "nightly");
		expect(again.ok).toBe(true);
		if (again.ok) again.release();
		expect(() => lockPath(root, "../escape")).toThrow();
	});

	test("titan-lock-check.mjs: exit 0 when free or stale, 1 while a live lock exists, 2 on usage errors", () => {
		const root = scratch();
		const run = (...args: string[]) => spawnSync("node", [SCRIPT, ...args], { encoding: "utf8" });
		expect(run("nightly", "--root", root).status).toBe(0);
		const held = acquireLock(root, "nightly");
		expect(held.ok).toBe(true);
		const live = run("nightly", "--root", root, "--json");
		expect(live.status).toBe(1);
		expect(JSON.parse(live.stdout)).toMatchObject({ workflow: "nightly", state: "running", holder: { pid: process.pid } });
		if (held.ok) held.release();
		writeFileSync(lockPath(root, "nightly"), JSON.stringify({ pid: DEAD_PID, startedAt: "2026-01-01T00:00:00Z", heartbeatAt: "2026-01-01T00:00:00Z", workflow: "nightly" }));
		const stale = run("nightly", "--root", root);
		expect(stale.status).toBe(0);
		expect(stale.stdout).toContain("free");
		expect(existsSync(lockPath(root, "nightly"))).toBe(true); // read-only: never deletes
		expect(run().status).toBe(2);
		expect(run("Bad Name", "--root", root).status).toBe(2);
	});
});

describe("schedulePlan", () => {
	const now = new Date("2026-09-15T10:00:00Z");
	const ago = (minutes: number): Date => new Date(now.getTime() - minutes * 60_000);

	test("every: first arm fires at once; one missed window is due; two or more missed windows are one catch-up run", () => {
		const rows = schedulePlan(
			[
				{ workflow: "fresh", trigger: { every: "15m" } },
				{ workflow: "recent", trigger: { every: "15m" }, lastRun: ago(5) },
				{ workflow: "due", trigger: { every: "15m" }, lastRun: ago(20) },
				{ workflow: "missed", trigger: { every: "15m" }, lastRun: ago(40) },
			],
			now,
		);
		expect(rows.map((row) => [row.workflow, row.due, row.catchUp])).toEqual([
			["fresh", true, false],
			["recent", false, false],
			["due", true, false],
			["missed", true, true],
		]);
		expect(rows[1].next!.toISOString()).toBe(new Date(ago(5).getTime() + 15 * 60_000).toISOString());
	});

	test("cron: no lastRun waits for the next slot; a passed slot is due; several passed slots are one catch-up", () => {
		const spec = { cron: "*/15 * * * *" };
		const at = local(2026, 9, 15, 10, 7);
		const rows = schedulePlan(
			[
				{ workflow: "pending", trigger: spec },
				{ workflow: "due", trigger: spec, lastRun: local(2026, 9, 15, 9, 50) },
				{ workflow: "missed", trigger: spec, lastRun: local(2026, 9, 15, 9, 20) },
				{ workflow: "done", trigger: spec, lastRun: local(2026, 9, 15, 10, 0) },
			],
			at,
		);
		expect(rows.map((row) => [row.workflow, row.due, row.catchUp])).toEqual([
			["pending", false, false],
			["due", true, false],
			["missed", true, true],
			["done", false, false],
		]);
		expect(rows[0].note).toContain("first cron slot pending");
		expect(rows[0].next!.getTime()).toBe(local(2026, 9, 15, 10, 15).getTime());
	});

	test("event triggers and malformed specs are never due, with a note", () => {
		const rows = schedulePlan(
			[
				{ workflow: "evt", trigger: { event: "file-signal" } },
				{ workflow: "bad", trigger: { every: "soon" } },
				{ workflow: "none", trigger: {} },
			],
			now,
		);
		expect(rows.every((row) => !row.due)).toBe(true);
		expect(rows[0].note).toContain("event trigger");
		expect(rows[1].note).toContain("trigger.every");
		expect(rows[2].note).toContain("no cron or every");
	});
});

describe("createScheduler", () => {
	const deferred = () => {
		let resolve!: () => void;
		const promise = new Promise<void>((r) => {
			resolve = r;
		});
		return { promise, resolve };
	};

	test("a due workflow runs under the lock; a fire that overlaps it is skipped; lastRun is recorded", async () => {
		const root = scratch();
		const gate = deferred();
		const runs: string[] = [];
		const recorded: Array<[string, string]> = [];
		let last: Date | undefined = new Date(Date.now() - 20 * 60_000);
		const scheduler = createScheduler({
			list: () => [{ workflow: "nightly", trigger: { every: "15m" } }],
			lastRun: () => last,
			run: async (workflow) => {
				runs.push(workflow);
				await gate.promise;
			},
			recordRun: (workflow, at, outcome) => {
				recorded.push([workflow, outcome]);
				last = at;
			},
			lockRoot: root,
			log: () => {},
		});
		const first = scheduler.tick();
		await new Promise((r) => setTimeout(r, 10));
		expect(existsSync(lockPath(root, "nightly"))).toBe(true);
		const second = await scheduler.tick();
		expect(second).toEqual([{ workflow: "nightly", action: "skipped-overlap", note: "still running in this process" }]);
		gate.resolve();
		expect(await first).toEqual([{ workflow: "nightly", action: "ran" }]);
		expect(runs).toEqual(["nightly"]);
		expect(recorded).toEqual([["nightly", "ran"]]);
		expect(existsSync(lockPath(root, "nightly"))).toBe(false);
		expect(await scheduler.tick()).toEqual([{ workflow: "nightly", action: "not-due", note: undefined }]);
	});

	test("catch-up: latest — several missed windows run once, then the workflow waits for its next slot", async () => {
		const root = scratch();
		let last: Date | undefined = new Date(Date.now() - 3 * 60 * 60_000);
		const runs: string[] = [];
		const scheduler = createScheduler({
			list: () => [{ workflow: "hourly", trigger: { every: "1h" } }],
			lastRun: () => last,
			run: async (workflow) => {
				runs.push(workflow);
			},
			recordRun: (_workflow, at) => {
				last = at;
			},
			lockRoot: root,
			log: () => {},
		});
		expect(await scheduler.tick()).toEqual([{ workflow: "hourly", action: "caught-up" }]);
		expect(await scheduler.tick()).toEqual([{ workflow: "hourly", action: "not-due", note: undefined }]);
		expect(runs).toEqual(["hourly"]);
	});

	test("a lock held by another live process skips the fire; a failing run is reported and released", async () => {
		const root = scratch();
		const stamp = new Date().toISOString();
		writeFileSync(lockPath(root, "held"), JSON.stringify({ pid: process.pid, startedAt: stamp, heartbeatAt: stamp, workflow: "held" }));
		const logs: string[] = [];
		const scheduler = createScheduler({
			list: () => [
				{ workflow: "held", trigger: { every: "1m" } },
				{ workflow: "boom", trigger: { every: "1m" } },
			],
			lastRun: () => undefined,
			run: async (workflow) => {
				if (workflow === "boom") throw new Error("exploded");
			},
			lockRoot: root,
			log: (text) => logs.push(text),
		});
		const results = await scheduler.tick();
		expect(results.find((row) => row.workflow === "held")).toMatchObject({ action: "skipped-overlap", note: `lock held by pid ${process.pid}` });
		expect(results.find((row) => row.workflow === "boom")).toMatchObject({ action: "failed", note: "exploded" });
		expect(existsSync(lockPath(root, "boom"))).toBe(false);
		expect(logs.some((line) => line.includes("boom failed: exploded"))).toBe(true);
		expect(scheduler.running()).toBe(false);
		scheduler.start();
		expect(scheduler.running()).toBe(true);
		scheduler.stop();
		expect(scheduler.running()).toBe(false);
	});
});

describe("orcaAutomationRecipe", () => {
	test("one orca automations create line with the lock precheck and the pi -p prompt", () => {
		const recipe = orcaAutomationRecipe("nightly", { every: "1d" }, "/srv/app", { packageRoot: "/opt/titan" });
		expect(recipe.startsWith("orca automations create")).toBe(true);
		expect(recipe).toContain("--name titan-nightly");
		expect(recipe).toContain('--trigger "daily"');
		expect(recipe).toContain('--precheck "node /opt/titan/scripts/titan-lock-check.mjs nightly"');
		expect(recipe).toContain(`--prompt 'pi -p "/workflow run nightly"'`);
		expect(recipe).toContain("--provider claude");
		expect(recipe).toContain('--workspace "path:/srv/app"');
		expect(orcaAutomationRecipe("x", { cron: "0 9 * * 1-5" }, "/srv", { packageRoot: "/p" })).toContain('--trigger "0 9 * * 1-5"');
		expect(orcaAutomationRecipe("x", { every: "1h" }, "/srv", { packageRoot: "/p", provider: "codex" })).toContain("--provider codex");
		expect(orcaAutomationRecipe("x", { event: "file-signal" }, "/srv", { packageRoot: "/p" }).startsWith("# x: trigger.event")).toBe(true);
		expect(() => orcaAutomationRecipe("Bad Name", { every: "1h" }, "/srv")).toThrow();
	});

	test.each([
		[{ every: "1h" } as TriggerSpec, "hourly"],
		[{ every: "1d" } as TriggerSpec, "daily"],
		[{ every: "15m" } as TriggerSpec, "*/15 * * * *"],
		[{ every: "6h" } as TriggerSpec, "0 */6 * * *"],
		[{ every: "2d" } as TriggerSpec, "0 0 */2 * *"],
		[{ cron: "30 2 1 * *" } as TriggerSpec, "30 2 1 * *"],
	])("orcaTrigger(%p) → %p", (spec, expected) => {
		expect(orcaTrigger(spec)).toBe(expected);
	});

	test("orcaTrigger refuses an every with no cron equivalent", () => {
		expect(() => orcaTrigger({ every: "90s" })).toThrow("no cron equivalent");
	});
});

describe("lock file format", () => {
	test("readLock tolerates garbage and reports the fields the precheck script reads", () => {
		const root = scratch();
		const file = join(root, "x.lock");
		writeFileSync(file, "not json");
		expect(readLock(file)).toBeUndefined();
		writeFileSync(file, JSON.stringify({ pid: 12, startedAt: "2026-01-01T00:00:00Z", workflow: "x" }));
		expect(readLock(file)).toEqual({ path: file, pid: 12, startedAt: "2026-01-01T00:00:00Z", heartbeatAt: "2026-01-01T00:00:00Z", workflow: "x" });
		expect(readFileSync(file, "utf8")).toContain('"pid"');
	});
});
