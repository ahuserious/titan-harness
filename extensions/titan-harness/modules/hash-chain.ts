/**
 * hash-chain.ts — canonical JSON, SHA-256 and the append-only hash chain that every
 * titan-harness store file is built on (events.jsonl, ledger.jsonl, provenance.jsonl).
 *
 * A chain file is JSONL: one row per line, each `{…, seq, ts, prev, hash}` where `seq`
 * counts from 1, `prev` is the previous row's hash (GENESIS = 64 zeros for the first
 * row) and `hash = sha256(canonicalJson(row − hash))`. Rows are written in canonical
 * key order, so a verifier only has to drop `hash` and re-hash. Appends are single
 * synchronous O_APPEND writes of one line: a crash leaves at worst one torn tail line,
 * never a half-updated file, and the next append refuses to chain past a torn tail.
 * Editing a byte, reordering or removing a row breaks the chain at that row's seq;
 * truncating the tail is the one edit a chain alone cannot see, which is why run.json
 * carries totals a verifier can cross-check.
 *
 * Pure Node: no pi imports, no state beyond a small per-file tail cache.
 */
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";

/** The `prev` of a chain's first row. */
export const GENESIS = "0".repeat(64);
/** sha256File's default cap: files past this size are hashed up to the cap and flagged `truncated`. */
export const DEFAULT_HASH_CAP = 512 * 1024 * 1024;

/** One appended row: the caller's fields plus the chain's own four. */
export interface ChainRow {
	seq: number;
	ts: string;
	prev: string;
	hash: string;
	[k: string]: unknown;
}

/**
 * Deep clone with object keys sorted (code-unit order), `undefined` members dropped and
 * `toJSON` honoured (Dates become ISO strings, Buffers their JSON form). Arrays keep
 * their order; `undefined` inside an array becomes null, as JSON.stringify would.
 */
export function canonicalValue(value: unknown): unknown {
	if (value === null || typeof value !== "object") return value;
	const asJson = (value as { toJSON?: unknown }).toJSON;
	if (typeof asJson === "function") return canonicalValue(asJson.call(value));
	if (Array.isArray(value)) return value.map((item) => (item === undefined ? null : canonicalValue(item)));
	const out: Record<string, unknown> = {};
	for (const key of Object.keys(value as object).sort()) {
		const member = (value as Record<string, unknown>)[key];
		if (member === undefined) continue;
		out[key] = canonicalValue(member);
	}
	return out;
}

/** Canonical JSON: sorted keys recursively, no whitespace, arrays in order, `undefined` dropped. */
export function canonicalJson(value: unknown): string {
	return JSON.stringify(canonicalValue(value)) ?? "null";
}

/** Hex SHA-256 of a string (UTF-8) or Buffer. */
export function sha256(text: string | Buffer): string {
	return createHash("sha256").update(text).digest("hex");
}

/**
 * Streaming SHA-256 of a file. `bytes` is how many bytes were hashed; when the file is
 * larger than `maxBytes` only that prefix is hashed and `truncated` is true, so a
 * consumer never mistakes a prefix digest for a whole-file identity.
 */
export async function sha256File(filePath: string, maxBytes: number = DEFAULT_HASH_CAP): Promise<{ sha256: string; bytes: number; truncated: boolean }> {
	const size = (await fs.promises.stat(filePath)).size;
	const cap = Math.max(0, Math.floor(maxBytes));
	const truncated = size > cap;
	const hash = createHash("sha256");
	let bytes = 0;
	if (cap > 0) {
		await new Promise<void>((resolve, reject) => {
			const stream = fs.createReadStream(filePath, truncated ? { start: 0, end: cap - 1 } : {});
			stream.on("data", (chunk) => {
				const buf = typeof chunk === "string" ? Buffer.from(chunk) : chunk;
				hash.update(buf);
				bytes += buf.length;
			});
			stream.once("error", reject);
			stream.once("end", () => resolve());
		});
	}
	return { sha256: hash.digest("hex"), bytes, truncated };
}

// ═══ Tail cache ══════════════════════════════════════════════════════════════

interface Tail {
	seq: number;
	hash: string;
	size: number; // file size the reading belongs to — a size change invalidates it
}
const tails = new Map<string, Tail>();

/** The last complete line of an open file (newline stripped), reading backwards in 64 KiB chunks. */
function lastLine(fd: number, size: number): string | undefined {
	const CHUNK = 64 * 1024;
	let end = size;
	let acc = Buffer.alloc(0);
	while (end > 0) {
		const start = Math.max(0, end - CHUNK);
		const buf = Buffer.alloc(end - start);
		fs.readSync(fd, buf, 0, buf.length, start);
		acc = Buffer.concat([buf, acc]);
		let last = acc.length - 1;
		while (last >= 0 && acc[last] === 0x0a) last--;
		if (last < 0) {
			if (start === 0) return undefined;
			end = start;
			continue;
		}
		const nl = acc.lastIndexOf(0x0a, last);
		if (nl >= 0 || start === 0) return acc.subarray(nl + 1, last + 1).toString("utf8");
		end = start;
	}
	return undefined;
}

/**
 * The chain's current tip: `{seq: 0, hash: GENESIS}` for a missing or empty file, else
 * the last row's seq and hash. Cached per file and re-read whenever the size changes.
 * Throws when the last line is torn or not a chain row — nothing may chain past it.
 */
export function chainTail(file: string): { seq: number; hash: string; size: number } {
	const resolved = path.resolve(file);
	let size = 0;
	try {
		size = fs.statSync(resolved).size;
	} catch {
		tails.delete(resolved);
		return { seq: 0, hash: GENESIS, size: 0 };
	}
	const cached = tails.get(resolved);
	if (cached && cached.size === size) return cached;
	let line: string | undefined;
	if (size > 0) {
		const fd = fs.openSync(resolved, "r");
		try {
			line = lastLine(fd, size);
		} finally {
			fs.closeSync(fd);
		}
	}
	let tail: Tail = { seq: 0, hash: GENESIS, size };
	if (line !== undefined) {
		let parsed: unknown;
		try {
			parsed = JSON.parse(line);
		} catch {
			throw new Error(`hash chain tail unreadable in ${resolved}: the last line is torn or not JSON`);
		}
		const row = parsed as Partial<ChainRow> | null;
		if (!row || typeof row.seq !== "number" || typeof row.hash !== "string") {
			throw new Error(`hash chain tail malformed in ${resolved}: the last line has no seq/hash`);
		}
		tail = { seq: row.seq, hash: row.hash, size };
	}
	tails.set(resolved, tail);
	return tail;
}

/** Write every byte of `buf` to `fd` (fs.writeSync may return short on some targets). */
function writeAll(fd: number, buf: Buffer): void {
	let offset = 0;
	while (offset < buf.length) offset += fs.writeSync(fd, buf, offset, buf.length - offset);
}

/**
 * Append one row to a chain file, synchronously, with O_APPEND (mode 0600 on create).
 * The row's `seq`, `prev` and `hash` are the chain's to set (a caller-supplied `hash` is
 * discarded); `ts` is taken from the row when it carries a string, else now. Returns
 * the row exactly as written.
 */
export function appendChained(file: string, row: Record<string, unknown>): ChainRow {
	const resolved = path.resolve(file);
	fs.mkdirSync(path.dirname(resolved), { recursive: true });
	const tail = chainTail(resolved);
	const { hash: _untrusted, ...body } = row;
	const ts = typeof row.ts === "string" && row.ts ? row.ts : new Date().toISOString();
	const unsigned = { ...body, seq: tail.seq + 1, ts, prev: tail.hash };
	const hash = sha256(canonicalJson(unsigned));
	const chained = canonicalValue({ ...unsigned, hash }) as ChainRow;
	const line = Buffer.from(`${JSON.stringify(chained)}\n`, "utf8");
	const fd = fs.openSync(resolved, "a", 0o600);
	try {
		writeAll(fd, line);
	} finally {
		fs.closeSync(fd);
	}
	tails.set(resolved, { seq: chained.seq, hash, size: tail.size + line.length });
	return chained;
}

/** Every row of a chain file in order ([] when the file is missing); throws on a line that is not JSON. */
export function readChain(file: string): ChainRow[] {
	let text: string;
	try {
		text = fs.readFileSync(file, "utf8");
	} catch (error) {
		if ((error as NodeJS.ErrnoException)?.code === "ENOENT") return [];
		throw error;
	}
	const rows: ChainRow[] = [];
	const lines = text.split("\n");
	for (let i = 0; i < lines.length; i++) {
		const line = lines[i];
		if (!line.trim()) continue;
		try {
			rows.push(JSON.parse(line) as ChainRow);
		} catch {
			throw new Error(`${file}: line ${i + 1} is not JSON (torn write or tampering)`);
		}
	}
	return rows;
}

/**
 * Walk a chain file and check every link: consecutive seq from 1, `prev` equal to the
 * previous hash (GENESIS first) and `hash` equal to the re-hashed row. `rows` counts the
 * rows verified before the first break; `brokenAt` is the seq that failed. A missing
 * file is an empty, valid chain.
 */
export function verifyChain(file: string): { ok: boolean; rows: number; brokenAt?: number; reason?: string } {
	let text: string;
	try {
		text = fs.readFileSync(file, "utf8");
	} catch (error) {
		const err = error as NodeJS.ErrnoException;
		if (err?.code === "ENOENT") return { ok: true, rows: 0 };
		return { ok: false, rows: 0, reason: `unreadable: ${err?.message ?? String(error)}` };
	}
	let prev = GENESIS;
	let rows = 0;
	const lines = text.split("\n");
	for (let i = 0; i < lines.length; i++) {
		const line = lines[i];
		if (!line.trim()) continue;
		const expectedSeq = rows + 1;
		let row: Partial<ChainRow> | null;
		try {
			row = JSON.parse(line) as Partial<ChainRow> | null;
		} catch {
			return { ok: false, rows, brokenAt: expectedSeq, reason: `line ${i + 1} is not JSON` };
		}
		if (!row || typeof row !== "object") return { ok: false, rows, brokenAt: expectedSeq, reason: `line ${i + 1} is not a row` };
		if (row.seq !== expectedSeq) return { ok: false, rows, brokenAt: expectedSeq, reason: `seq ${String(row.seq)} where ${expectedSeq} was expected (line ${i + 1})` };
		if (row.prev !== prev) return { ok: false, rows, brokenAt: expectedSeq, reason: "prev does not match the previous row's hash" };
		const { hash, ...unsigned } = row;
		if (typeof hash !== "string" || hash !== sha256(canonicalJson(unsigned))) {
			return { ok: false, rows, brokenAt: expectedSeq, reason: "hash does not match the row's contents" };
		}
		prev = hash;
		rows++;
	}
	return { ok: true, rows };
}
