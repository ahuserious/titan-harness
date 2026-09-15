/**
 * provenance.ts — observed file provenance (§6.4 of the v0.3 plan): after every
 * `tool_execution_end` the host names the files a tool touched and hashes their bytes
 * RIGHT THEN, so reviewers link claims to content identities instead of prose.
 *
 *   write / edit          → one output edge, hashed after the call        (observed)
 *   read                  → one input edge, hashed                         (observed)
 *   grep / find / ls      → the explicit `path` argument as an input edge  (observed)
 *   bash                  → path-like tokens of the command: redirect, -o, tee/touch/cp/mv
 *                           targets and `sed -i` files are outputs, rm targets are
 *                           deletions, everything else is an input      (inferred)
 *   anything else         → path-like tokens in its string arguments     (inferred, unknown)
 *
 * `change` for a write is "created" when the caller says the file did not exist before
 * (`existedBefore: false`), "modified" when it did or when this run already recorded
 * the path; without either, birthtime ≈ mtime is read as a fresh file. A missing file
 * yields an edge with `degraded: "unhashed"`; a directory `degraded: "directory"`; a
 * file past the hash cap `degraded: "truncated"`. Nothing here throws on a bad path.
 * Every edge recorded here is `identityAt: "live"`; harvest-time identities are
 * labelled by the ingesting code, never re-labelled here. Pure Node, no pi imports.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { appendChained, readChain, sha256File } from "./hash-chain.ts";

export const PROVENANCE_FILE = "provenance.jsonl";
/** Bash commands can name many files; past this many edges a step is truncated (flagged on the step). */
export const MAX_EDGES_PER_STEP = 24;

export type ProvenanceChange = "created" | "modified" | "deleted" | "read" | "unknown";
export type ProvenanceConfidence = "observed" | "inferred" | "declared";

/** One file identity attached to a tool step. */
export interface ProvenanceEdge {
	path: string;
	sha256?: string;
	size?: number;
	mtimeMs?: number;
	change: ProvenanceChange;
	confidence: ProvenanceConfidence;
	identityAt: "live" | "harvest";
	degraded?: string;
}

/** One provenance.jsonl row: a tool call and the edges it produced. */
export interface ProvenanceStep {
	ts: string;
	runId: string;
	agentId?: string;
	toolCallId?: string;
	tool: string;
	inputs: ProvenanceEdge[];
	outputs: ProvenanceEdge[];
	truncated?: boolean;
}

/** What `recordToolEnd` needs from a tool_execution_end event plus its run context. */
export interface ToolEndArgs {
	runId: string;
	agentId?: string;
	toolCallId?: string;
	tool: string;
	toolArgs: any;
	cwd: string;
	isError?: boolean;
	/** For write-like tools: whether the named path existed before the call (captured at tool_execution_start). */
	existedBefore?: boolean;
}

interface Draft {
	path: string;
	side: "input" | "output";
	change: ProvenanceChange | "auto";
	confidence: ProvenanceConfidence;
}

// ═══ Path classification ═════════════════════════════════════════════════════

const REDIRECTS = new Set([">", ">>", "1>", "2>", "&>", "1>>", "2>>", ">|"]);
const OUTPUT_FLAGS = new Set(["-o", "--output", "--out", "--output-file", "-of"]);
const DEST_LAST = new Set(["cp", "mv", "install", "ln", "rsync"]); // last path is the destination
const CREATE_ALL = new Set(["touch", "tee", "mkdir"]); // every path is an output
const DELETE_ALL = new Set(["rm", "unlink", "rmdir"]);
const SEGMENT_SPLIT = /\s*(?:&&|\|\||;|\|)\s*/;

/** Split one shell segment on whitespace, honouring single and double quotes and dropping them. */
function shellTokens(segment: string): string[] {
	const tokens: string[] = [];
	let current = "";
	let quote: string | undefined;
	let seen = false;
	for (const ch of segment) {
		if (quote) {
			if (ch === quote) quote = undefined;
			else current += ch;
		} else if (ch === '"' || ch === "'") {
			quote = ch;
			seen = true;
		} else if (/\s/.test(ch)) {
			if (seen || current) tokens.push(current);
			current = "";
			seen = false;
		} else {
			current += ch;
			seen = true;
		}
	}
	if (seen || current) tokens.push(current);
	return tokens;
}

/** A token the shell would treat as a file: has a `/` or a dotted extension; never a flag, URL, glob, variable or number. */
export function looksLikePath(token: string): boolean {
	if (!token || token.startsWith("-") || token === "/" || token === "." || token === "..") return false;
	if (/^[a-z][a-z0-9+.-]*:\/\//i.test(token)) return false;
	if (/[*?[\]{}$`<>|&]/.test(token)) return false;
	if (/^[\d.]+$/.test(token)) return false;
	if (token.includes("/")) return true;
	return /^[\w@+-][\w.@+-]*\.[A-Za-z0-9]{1,8}$/.test(token);
}

/** `~/x` → home, otherwise resolve against cwd. */
function resolveToken(token: string, cwd: string): string {
	const expanded = token === "~" ? os.homedir() : token.startsWith("~/") ? path.join(os.homedir(), token.slice(2)) : token;
	return path.resolve(cwd, expanded);
}

/** Classify every path-like token of a shell command into input/output/deleted drafts. */
function bashDrafts(command: string, cwd: string): Draft[] {
	const drafts: Draft[] = [];
	for (const segment of command.split(SEGMENT_SPLIT)) {
		const tokens = shellTokens(segment);
		if (!tokens.length) continue;
		let program = path.basename(tokens[0]);
		let start = 1;
		if (program === "sudo" || program === "env" || program === "time" || program === "nice") {
			program = path.basename(tokens[1] ?? "");
			start = 2;
		}
		const inPlace = program === "sed" && tokens.some((t) => /^-[a-zA-Z]*i/.test(t));
		const pathIdx: number[] = [];
		for (let i = 0; i < tokens.length; i++) {
			const tok = tokens[i];
			if (i < start) {
				if (i === 0 && (tok.startsWith("./") || tok.startsWith("../"))) drafts.push({ path: resolveToken(tok, cwd), side: "input", change: "read", confidence: "inferred" });
				continue;
			}
			const prev = tokens[i - 1];
			if (tok.startsWith(">") && tok.length > 1 && looksLikePath(tok.replace(/^>+\|?/, ""))) {
				drafts.push({ path: resolveToken(tok.replace(/^>+\|?/, ""), cwd), side: "output", change: "auto", confidence: "inferred" });
				continue;
			}
			if (!looksLikePath(tok)) continue;
			if (REDIRECTS.has(prev) || OUTPUT_FLAGS.has(prev)) {
				drafts.push({ path: resolveToken(tok, cwd), side: "output", change: "auto", confidence: "inferred" });
				continue;
			}
			pathIdx.push(i);
		}
		for (let n = 0; n < pathIdx.length; n++) {
			const tok = tokens[pathIdx[n]];
			const resolved = resolveToken(tok, cwd);
			const last = n === pathIdx.length - 1;
			if (DELETE_ALL.has(program)) drafts.push({ path: resolved, side: "output", change: "deleted", confidence: "inferred" });
			else if (CREATE_ALL.has(program) || inPlace) drafts.push({ path: resolved, side: "output", change: "auto", confidence: "inferred" });
			else if (DEST_LAST.has(program) && last && pathIdx.length >= 2) drafts.push({ path: resolved, side: "output", change: "auto", confidence: "inferred" });
			else if (program === "mv" && !last) drafts.push({ path: resolved, side: "output", change: "deleted", confidence: "inferred" });
			else drafts.push({ path: resolved, side: "input", change: "read", confidence: "inferred" });
		}
	}
	return drafts;
}

/** The single path argument Pi's file tools carry (`path`, or the aliases other tools use). */
function namedPath(toolArgs: any): string | undefined {
	if (!toolArgs || typeof toolArgs !== "object") return undefined;
	const value = toolArgs.path ?? toolArgs.file_path ?? toolArgs.filePath ?? toolArgs.file;
	return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

/** Path-like tokens inside every string argument of an unknown tool. */
function stringArgDrafts(toolArgs: any, cwd: string): Draft[] {
	if (!toolArgs || typeof toolArgs !== "object") return [];
	const drafts: Draft[] = [];
	for (const value of Object.values(toolArgs)) {
		if (typeof value !== "string" || value.length > 4000) continue;
		for (const tok of shellTokens(value)) {
			if (looksLikePath(tok)) drafts.push({ path: resolveToken(tok, cwd), side: "input", change: "unknown", confidence: "inferred" });
		}
	}
	return drafts;
}

/** Tool name + args → drafts, before any filesystem look. */
function classify(tool: string, toolArgs: any, cwd: string): Draft[] {
	const named = namedPath(toolArgs);
	switch (tool) {
		case "write":
			return named ? [{ path: resolveToken(named, cwd), side: "output", change: "auto", confidence: "observed" }] : [];
		case "edit":
			return named ? [{ path: resolveToken(named, cwd), side: "output", change: "modified", confidence: "observed" }] : [];
		case "read":
		case "grep":
		case "find":
		case "ls":
			return named ? [{ path: resolveToken(named, cwd), side: "input", change: "read", confidence: "observed" }] : [];
		case "bash": {
			const command = toolArgs && typeof toolArgs.command === "string" ? toolArgs.command : "";
			return bashDrafts(command, cwd);
		}
		default:
			return stringArgDrafts(toolArgs, cwd);
	}
}

// ═══ Materialising edges ═════════════════════════════════════════════════════

/** Paths this run has already recorded, loaded lazily from provenance.jsonl and kept per run directory. */
const seenPaths = new Map<string, Set<string>>();
function knownPaths(dir: string): Set<string> {
	const resolved = path.resolve(dir);
	let known = seenPaths.get(resolved);
	if (!known) {
		known = new Set<string>();
		try {
			for (const step of readProvenance(resolved)) for (const edge of [...(step.inputs ?? []), ...(step.outputs ?? [])]) known.add(edge.path);
		} catch {
			/* a broken provenance file is the verifier's finding, not a reason to stop recording */
		}
		seenPaths.set(resolved, known);
	}
	return known;
}

/** created / modified for a file that exists now: the caller's word, then this run's memory, then birthtime ≈ mtime. */
function outputChange(stat: fs.Stats, known: boolean, existedBefore?: boolean): ProvenanceChange {
	if (existedBefore === true) return "modified";
	if (existedBefore === false) return "created";
	if (known) return "modified";
	return stat.birthtimeMs > 0 && Math.abs(stat.mtimeMs - stat.birthtimeMs) < 50 ? "created" : "modified";
}

/** Stat + hash one draft into an edge; never throws. */
async function materialize(draft: Draft, known: Set<string>, args: ToolEndArgs): Promise<ProvenanceEdge> {
	const edge: ProvenanceEdge = { path: draft.path, change: draft.change === "auto" ? "unknown" : draft.change, confidence: draft.confidence, identityAt: "live" };
	let stat: fs.Stats | undefined;
	try {
		stat = await fs.promises.stat(draft.path);
	} catch {
		stat = undefined;
	}
	if (!stat) {
		if (draft.change !== "deleted") edge.degraded = "unhashed";
		if (draft.change === "auto" && args.existedBefore !== undefined) edge.change = args.existedBefore ? "modified" : "created";
	} else if (stat.isDirectory()) {
		edge.degraded = "directory";
		if (draft.change === "deleted") edge.change = "unknown";
		else if (draft.change === "auto") edge.change = outputChange(stat, known.has(draft.path), args.existedBefore);
	} else {
		edge.size = stat.size;
		edge.mtimeMs = stat.mtimeMs;
		if (draft.change === "deleted") edge.change = "unknown";
		else if (draft.change === "auto") edge.change = outputChange(stat, known.has(draft.path), args.existedBefore);
		try {
			const hashed = await sha256File(draft.path);
			edge.sha256 = hashed.sha256;
			if (hashed.truncated) edge.degraded = "truncated";
		} catch {
			edge.degraded = "unhashed";
		}
	}
	if (args.isError) edge.degraded = edge.degraded ? `${edge.degraded},tool-error` : "tool-error";
	return edge;
}

/**
 * Classify a finished tool call, hash what it named, append the step to
 * <dir>/provenance.jsonl and return it. Missing files, directories and oversize files
 * degrade visibly on their edges; nothing here throws for a path.
 */
export async function recordToolEnd(dir: string, args: ToolEndArgs): Promise<ProvenanceStep> {
	const drafts: Draft[] = [];
	const seen = new Set<string>();
	for (const draft of classify(args.tool, args.toolArgs, args.cwd)) {
		const key = `${draft.side}:${draft.path}`;
		if (seen.has(key)) continue;
		seen.add(key);
		drafts.push(draft);
	}
	const truncated = drafts.length > MAX_EDGES_PER_STEP;
	const kept = truncated ? drafts.slice(0, MAX_EDGES_PER_STEP) : drafts;
	const known = knownPaths(dir);
	const edges = await Promise.all(kept.map((draft) => materialize(draft, known, args)));
	const inputs: ProvenanceEdge[] = [];
	const outputs: ProvenanceEdge[] = [];
	kept.forEach((draft, i) => (draft.side === "input" ? inputs : outputs).push(edges[i]));
	for (const edge of edges) known.add(edge.path);
	const row: Record<string, unknown> = { runId: args.runId, tool: args.tool, inputs, outputs };
	if (args.agentId) row.agentId = args.agentId;
	if (args.toolCallId) row.toolCallId = args.toolCallId;
	if (truncated) row.truncated = true;
	return appendChained(path.join(dir, PROVENANCE_FILE), row) as unknown as ProvenanceStep;
}

/** Every provenance step of a run in order ([] when none were recorded). */
export function readProvenance(dir: string): ProvenanceStep[] {
	return readChain(path.join(dir, PROVENANCE_FILE)) as unknown as ProvenanceStep[];
}
