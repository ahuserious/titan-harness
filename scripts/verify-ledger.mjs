#!/usr/bin/env node
/**
 * verify-ledger.mjs — walk the hash chains of a titan-harness run directory and say
 * whether they are intact. Node ESM, no dependencies; a stand-alone re-implementation
 * of modules/hash-chain.ts so an operator can check a run without the harness.
 *
 *   node scripts/verify-ledger.mjs <runDir>              # events.jsonl + ledger.jsonl (+ provenance.jsonl when present)
 *   node scripts/verify-ledger.mjs <file.jsonl>          # one chain file
 *   node scripts/verify-ledger.mjs <runDir> --json       # machine-readable
 *
 * Prints one line per chain — `ok` with the row count, or `broken` with the seq that
 * failed and why — and exits 0 when every chain is intact, 1 otherwise.
 *
 * Chain rules (must match hash-chain.ts): rows are JSONL; seq counts from 1; prev is the
 * previous row's hash, 64 zeros for the first; hash = sha256(canonicalJson(row − hash))
 * where canonicalJson sorts keys recursively, keeps array order, drops undefined and
 * has no whitespace.
 */
import { createHash } from "node:crypto";
import { existsSync, readFileSync, statSync } from "node:fs";
import { basename, join, resolve } from "node:path";

const GENESIS = "0".repeat(64);
const CHAIN_FILES = ["events.jsonl", "ledger.jsonl"];
const OPTIONAL_FILES = ["provenance.jsonl"];

const canonicalValue = (value) => {
	if (value === null || typeof value !== "object") return value;
	if (typeof value.toJSON === "function") return canonicalValue(value.toJSON());
	if (Array.isArray(value)) return value.map((item) => (item === undefined ? null : canonicalValue(item)));
	const out = {};
	for (const key of Object.keys(value).sort()) {
		if (value[key] === undefined) continue;
		out[key] = canonicalValue(value[key]);
	}
	return out;
};
const canonicalJson = (value) => JSON.stringify(canonicalValue(value)) ?? "null";
const sha256 = (text) => createHash("sha256").update(text).digest("hex");

/** {ok, rows, brokenAt?, reason?} for one chain file; a missing file is an empty, valid chain. */
function verifyChain(file) {
	let text;
	try {
		text = readFileSync(file, "utf8");
	} catch (error) {
		if (error?.code === "ENOENT") return { ok: true, rows: 0, missing: true };
		return { ok: false, rows: 0, reason: `unreadable: ${error?.message ?? error}` };
	}
	let prev = GENESIS;
	let rows = 0;
	const lines = text.split("\n");
	for (let i = 0; i < lines.length; i++) {
		const line = lines[i];
		if (!line.trim()) continue;
		const expectedSeq = rows + 1;
		let row;
		try {
			row = JSON.parse(line);
		} catch {
			return { ok: false, rows, brokenAt: expectedSeq, reason: `line ${i + 1} is not JSON` };
		}
		if (!row || typeof row !== "object") return { ok: false, rows, brokenAt: expectedSeq, reason: `line ${i + 1} is not a row` };
		if (row.seq !== expectedSeq) return { ok: false, rows, brokenAt: expectedSeq, reason: `seq ${row.seq} where ${expectedSeq} was expected (line ${i + 1})` };
		if (row.prev !== prev) return { ok: false, rows, brokenAt: expectedSeq, reason: "prev does not match the previous row's hash" };
		const { hash, ...unsigned } = row;
		if (typeof hash !== "string" || hash !== sha256(canonicalJson(unsigned))) return { ok: false, rows, brokenAt: expectedSeq, reason: "hash does not match the row's contents" };
		prev = hash;
		rows++;
	}
	return { ok: true, rows };
}

const args = process.argv.slice(2);
const json = args.includes("--json");
const target = args.find((arg) => !arg.startsWith("--"));
if (!target) {
	console.error("usage: node scripts/verify-ledger.mjs <runDir | file.jsonl> [--json]");
	process.exit(2);
}
const resolved = resolve(target);
if (!existsSync(resolved)) {
	console.error(`not found: ${resolved}`);
	process.exit(2);
}

const files = statSync(resolved).isDirectory()
	? [...CHAIN_FILES.map((name) => join(resolved, name)), ...OPTIONAL_FILES.map((name) => join(resolved, name)).filter((file) => existsSync(file))]
	: [resolved];

const results = files.map((file) => ({ file: basename(file), ...verifyChain(file) }));
const allOk = results.every((result) => result.ok);
if (json) {
	console.log(JSON.stringify({ ok: allOk, target: resolved, chains: results }, null, 2));
} else {
	for (const result of results) {
		if (result.ok) console.log(`ok      ${result.file}  ${result.rows} rows${result.missing ? " (absent)" : ""}`);
		else console.log(`broken  ${result.file}  at seq ${result.brokenAt ?? "?"} after ${result.rows} good rows: ${result.reason}`);
	}
	console.log(allOk ? "chain intact" : "chain broken");
}
process.exit(allOk ? 0 : 1);
