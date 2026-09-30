/**
 * child-sandbox.ts — approval-store isolation for hosted runs (P3 prerequisite, ruling
 * 2026-09-29 22:50 on N3-03). A hosted runner keeps pending approvals, consumed-approval
 * records, run.json and runner.lock under its runner store root. Every child process a
 * hosted run starts (bash and script nodes, verify runners through deps.bash, agent
 * children) is spawned inside a bubblewrap sandbox:
 *
 *   - the whole host filesystem is read-only (`--ro-bind / /`);
 *   - /tmp is a private tmpfs (TMPDIR=/tmp), so nothing under the host's /tmp is visible;
 *   - only the workflow cwd, the run's node scratch dir and host-listed `writable` paths are
 *     bound writable. A writable path may not contain or lie inside a hidden path, so a
 *     child can never rename a parent of the store root out of the way;
 *   - the runner store root (as given and as its realpath) and host-listed `hide` paths are
 *     covered by an empty read-only tmpfs, mounted last: the child cannot list, read,
 *     create, edit, delete or replace anything in the store (approvals.jsonl, run.json,
 *     runner.lock, sibling runs), and cannot remove the mask (mount points are EBUSY);
 *   - a new pid namespace with its own /proc, so `/proc/<runner pid>/root` cannot reach
 *     the unmasked host view; `--die-with-parent` ties the sandbox to its runner;
 *   - TITAN_RUN_DIR is never passed, and any variable whose value names a hidden path is
 *     removed.
 *
 * Construction runs a preflight inside the sandbox and throws when bwrap is missing or the
 * root is not masked (fail closed: no sandbox, no hosted run).
 *
 * The scratch dir is child-writable, so the runner itself must not follow a child-planted
 * symlink out of it (confused deputy: a node artifact mirrored to
 * `<scratch>/nodes/<id>.md` through a symlink into the store would let a child choose the
 * bytes of approvals.jsonl). `registerScratchRoot` marks a scratch root, and
 * `guardedWriteFileSync` / `guardedMkdirSync` walk every component below a registered root
 * with O_NOFOLLOW (openat-style through /proc/self/fd) and refuse multiply-linked files.
 * Outside a registered root they are plain fs calls. Pure Node, no pi.
 */
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";

/** Rewrites one spawn: the command, its argv and its full environment. */
export type SpawnWrap = (command: string, args: string[], env: Record<string, string | undefined>) => { command: string; args: string[]; env: Record<string, string> };

export interface ChildSandboxOptions {
	/** bwrap binary; default: `bwrap` on PATH, then /usr/bin/bwrap. */
	bwrap?: string;
	/** Extra writable paths (e.g. an agent child's ~/.pi/agent or a uv cache). */
	writable?: string[];
	/** Extra paths to mask (e.g. a shared parent of every runner root on the host). */
	hide?: string[];
}

export interface ChildSandbox {
	wrap: SpawnWrap;
	/** Masked paths (absolute, as given and realpath). */
	readonly hidden: string[];
	/** Writable paths (realpath). */
	readonly writable: string[];
	readonly bwrap: string;
}

/** Env names never passed to a sandboxed child. */
export const SANDBOX_DROPPED_ENV = ["TITAN_RUN_DIR"];

export function realish(p: string): string {
	try { return fs.realpathSync.native(p); } catch { return path.resolve(p); }
}

/** `b` is `a` or inside it. */
export function isInside(a: string, b: string): boolean {
	const rel = path.relative(a, b);
	return rel === "" || (rel !== ".." && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel));
}

function findBwrap(explicit?: string): string | undefined {
	const candidates = explicit ? [explicit] : [...(process.env.PATH ?? "").split(path.delimiter).filter(Boolean).map(d => path.join(d, "bwrap")), "/usr/bin/bwrap"];
	for (const candidate of candidates) {
		try {
			fs.accessSync(candidate, fs.constants.X_OK);
			return candidate;
		} catch {}
	}
	return undefined;
}

const unique = (items: string[]) => [...new Set(items)];

/**
 * The sandbox for one hosted run. `runnerRoot` is masked; `cwd` and `scratchDir` must not
 * overlap it; no writable path may overlap a hidden path in either direction.
 */
export function createChildSandbox(input: { runnerRoot: string; cwd: string; scratchDir: string } & ChildSandboxOptions): ChildSandbox {
	const hidden = unique([input.runnerRoot, ...(input.hide ?? [])].flatMap(p => [path.resolve(p), realish(p)]));
	fs.mkdirSync(input.scratchDir, { recursive: true, mode: 0o700 });
	const writable = unique([input.cwd, input.scratchDir, ...(input.writable ?? [])].map(realish));
	for (const w of writable) {
		for (const h of hidden) {
			if (isInside(h, w) || isInside(w, h)) throw new Error(`child sandbox: writable path ${w} overlaps the hidden runner path ${h}`);
		}
	}
	const bwrap = findBwrap(input.bwrap);
	if (!bwrap) throw new Error(`child sandbox: bwrap not found${input.bwrap ? ` at ${input.bwrap}` : " on PATH"}; hosted runs require it (fail closed)`);
	const base = [
		"--die-with-parent", "--new-session", "--unshare-pid",
		"--ro-bind", "/", "/",
		"--dev", "/dev",
		"--proc", "/proc",
		"--tmpfs", "/tmp",
		...writable.filter(w => fs.existsSync(w)).flatMap(w => ["--bind", w, w]),
		...hidden.filter(h => fs.existsSync(h)).flatMap(h => ["--tmpfs", h, "--remount-ro", h]),
	];
	const scrub = (env: Record<string, string | undefined>): Record<string, string> => {
		const out: Record<string, string> = {};
		for (const [name, value] of Object.entries(env)) {
			if (value === undefined || SANDBOX_DROPPED_ENV.includes(name)) continue;
			if (hidden.some(h => value.includes(h))) continue;
			out[name] = value;
		}
		out.TMPDIR = "/tmp";
		return out;
	};
	const wrap: SpawnWrap = (command, args, env) => ({ command: bwrap, args: [...base, "--", command, ...args], env: scrub(env) });
	// Preflight: every hidden path that exists must look empty and be unwritable from inside.
	const present = hidden.filter(h => fs.existsSync(h));
	const probe = spawnSync(bwrap, [...base, "--", "/bin/sh", "-c", 'for d in "$@"; do [ -z "$(ls -A "$d" 2>/dev/null)" ] || exit 3; if (: > "$d/.titan-sandbox-probe") 2>/dev/null; then exit 4; fi; done; exit 0', "sh", ...present], { cwd: realish(input.cwd), env: scrub({ ...process.env }), encoding: "utf8", timeout: 20_000 });
	if (probe.status !== 0) throw new Error(`child sandbox: preflight failed (exit ${probe.status ?? probe.signal}${probe.stderr ? `: ${String(probe.stderr).trim().slice(0, 300)}` : ""}); hosted runs require a working sandbox (fail closed)`);
	return { wrap, hidden, writable, bwrap };
}

// ═══ Runner-side writes into child-writable scratch ═════════════════════════════

/** Every spelling of a registered scratch root (as given, and realpath) → its realpath. */
const scratchRoots = new Map<string, string>();

/** Mark `dir` (created if missing) as child-writable: guarded writes below it never follow symlinks. */
export function registerScratchRoot(dir: string): string {
	fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
	const real = realish(dir);
	scratchRoots.set(path.resolve(dir), real);
	scratchRoots.set(real, real);
	return real;
}

/** The registered scratch root `file` lies under (lexically), and the path parts below it. */
function underScratch(file: string): { root: string; parts: string[] } | undefined {
	const abs = path.resolve(file);
	for (const [spelling, real] of scratchRoots) {
		if (!isInside(spelling, abs)) continue;
		const rel = path.relative(spelling, abs);
		return { root: real, parts: rel ? rel.split(path.sep) : [] };
	}
	return undefined;
}

const O = fs.constants;
const procFd = (fd: number, name: string) => `/proc/self/fd/${fd}/${name}`;

/** Open the directory `parts` below `root` one component at a time with O_NOFOLLOW (creating missing ones). Returns its fd. */
function openDirNoFollow(root: string, parts: string[], create: boolean, mode: number): number {
	let fd = fs.openSync(root, O.O_RDONLY | O.O_DIRECTORY);
	try {
		for (const part of parts) {
			if (!part || part === "." || part === "..") throw new Error(`guarded scratch path: invalid component ${JSON.stringify(part)}`);
			if (create) {
				try { fs.mkdirSync(procFd(fd, part), { mode }); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
			}
			let next: number;
			try {
				next = fs.openSync(procFd(fd, part), O.O_RDONLY | O.O_DIRECTORY | O.O_NOFOLLOW);
			} catch (error) {
				const code = (error as NodeJS.ErrnoException).code;
				if (code === "ELOOP" || code === "ENOTDIR") throw new Error(`guarded scratch path: ${part} under ${root} is a symlink or not a directory; refusing to follow it`);
				throw error;
			}
			fs.closeSync(fd);
			fd = next;
		}
		return fd;
	} catch (error) {
		try { fs.closeSync(fd); } catch {}
		throw error;
	}
}

/** mkdir -p that never follows a symlink below a registered scratch root. */
export function guardedMkdirSync(dir: string, mode = 0o700): void {
	const hit = process.platform === "linux" ? underScratch(dir) : undefined;
	if (!hit) {
		fs.mkdirSync(dir, { recursive: true, mode });
		return;
	}
	fs.closeSync(openDirNoFollow(hit.root, hit.parts, true, mode));
}

/** writeFileSync that, below a registered scratch root, never follows a symlink and refuses a multiply-linked target. */
export function guardedWriteFileSync(file: string, data: string | Buffer, mode = 0o600): void {
	const hit = process.platform === "linux" ? underScratch(file) : undefined;
	if (!hit) {
		fs.writeFileSync(file, data, { mode });
		return;
	}
	const name = hit.parts.pop();
	if (!name) throw new Error(`guarded scratch path: ${file} is the scratch root itself`);
	const dirFd = openDirNoFollow(hit.root, hit.parts, true, 0o700);
	let fd: number | undefined;
	try {
		try {
			fd = fs.openSync(procFd(dirFd, name), O.O_WRONLY | O.O_CREAT | O.O_NOFOLLOW, mode);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ELOOP") throw new Error(`guarded scratch path: ${file} is a symlink; refusing to follow it`);
			throw error;
		}
		const st = fs.fstatSync(fd);
		if (!st.isFile() || st.nlink > 1) throw new Error(`guarded scratch path: ${file} is not a regular singly-linked file; refusing to write through it`);
		fs.ftruncateSync(fd, 0);
		const buf = typeof data === "string" ? Buffer.from(data, "utf8") : data;
		for (let off = 0; off < buf.length; ) off += fs.writeSync(fd, buf, off, buf.length - off, off);
	} finally {
		if (fd !== undefined) fs.closeSync(fd);
		fs.closeSync(dirFd);
	}
}

/** readFileSync that, below a registered scratch root, never follows a symlink (the runner must not read the store for a child). */
export function guardedReadFileSync(file: string): string {
	const hit = process.platform === "linux" ? underScratch(file) : undefined;
	if (!hit) return fs.readFileSync(file, "utf8");
	const name = hit.parts.pop();
	if (!name) throw new Error(`guarded scratch path: ${file} is the scratch root itself`);
	const dirFd = openDirNoFollow(hit.root, hit.parts, false, 0o700);
	let fd: number | undefined;
	try {
		try {
			fd = fs.openSync(procFd(dirFd, name), O.O_RDONLY | O.O_NOFOLLOW);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ELOOP") throw new Error(`guarded scratch path: ${file} is a symlink; refusing to follow it`);
			throw error;
		}
		const st = fs.fstatSync(fd);
		if (!st.isFile() || st.nlink > 1) throw new Error(`guarded scratch path: ${file} is not a regular singly-linked file; refusing to read it`);
		return fs.readFileSync(fd, "utf8");
	} finally {
		if (fd !== undefined) fs.closeSync(fd);
		fs.closeSync(dirFd);
	}
}
