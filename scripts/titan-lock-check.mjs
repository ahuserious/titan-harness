#!/usr/bin/env node
/**
 * titan-lock-check.mjs — the --precheck for `orca automations create` recipes printed by
 * `/workflow schedule recipe <name>`: exit 0 when no LIVE run lock exists for the
 * workflow (the automation may fire), exit 1 while one does (skip this fire — the
 * previous run is still going), exit 2 on usage errors. Read-only: a stale lock (dead
 * pid or a heartbeat older than --stale-ms, default 10 min) is reported and ignored,
 * never deleted here — the scheduler clears it when it takes the lock.
 *
 *   node scripts/titan-lock-check.mjs <workflow> [--root <dir>] [--stale-ms <n>] [--json]
 *
 * Lock files: <root>/<workflow>.lock (default root ~/.pi/titan-harness/locks) holding
 * {pid, startedAt, heartbeatAt, workflow} — the format modules/workflow/trigger.ts writes.
 */
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const argv = process.argv.slice(2);
let workflow;
let root = join(homedir(), ".pi", "titan-harness", "locks");
let staleMs = 10 * 60 * 1000;
let json = false;
for (let i = 0; i < argv.length; i++) {
	const arg = argv[i];
	if (arg === "--root") root = argv[++i];
	else if (arg === "--stale-ms") staleMs = Number(argv[++i]);
	else if (arg === "--json") json = true;
	else if (arg.startsWith("--")) {
		console.error(`unknown flag ${arg}`);
		process.exit(2);
	} else if (!workflow) workflow = arg;
}
if (!workflow || !/^[a-z0-9][a-z0-9-]{0,63}$/.test(workflow) || !root || !Number.isFinite(staleMs)) {
	console.error("usage: titan-lock-check.mjs <workflow> [--root <dir>] [--stale-ms <n>] [--json]");
	process.exit(2);
}

const file = join(root, `${workflow}.lock`);
const report = (state, holder, note) => {
	if (json) console.log(JSON.stringify({ workflow, file, state, holder: holder ?? null, note }));
	else console.log(`${workflow}: ${state}${note ? ` (${note})` : ""}`);
	process.exit(state === "running" ? 1 : 0);
};

let holder;
try {
	holder = JSON.parse(readFileSync(file, "utf8"));
} catch (error) {
	if (error && error.code === "ENOENT") report("free", undefined, "no lock file");
	report("free", undefined, "unreadable lock file treated as stale");
}
const pid = Number(holder?.pid);
let alive = false;
if (Number.isInteger(pid) && pid > 0) {
	try {
		process.kill(pid, 0);
		alive = true;
	} catch (error) {
		alive = error && error.code === "EPERM";
	}
}
const beat = Date.parse(holder?.heartbeatAt ?? holder?.startedAt ?? "");
const fresh = Number.isFinite(beat) && Date.now() - beat <= staleMs;
if (alive && fresh) report("running", holder, `pid ${pid} since ${holder.startedAt}`);
report("free", holder, alive ? "stale heartbeat" : `pid ${pid} is gone`);
