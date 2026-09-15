/**
 * loader.ts — find, read, hash and validate workflows (plan §3: `.titan/workflows/<name>/
 * <name>.yaml` (+ commands/*.md, scripts/*), global `~/.pi/titan-harness/workflows/`, and
 * the workflows shipped in the package's own `.pi/titan-harness/workflows/`).
 *
 *   workflowDirs(cwd)        the three roots: project (<cwd>/.titan/workflows) > user
 *                            (~/.pi/titan-harness/workflows) > package (<pkg>/.pi/titan-harness/workflows)
 *   listWorkflows(cwd)       every <root>/<name>/<name>.yaml, project shadowing user shadowing package
 *   loadWorkflow(x, cwd)     by name (through the precedence above) or by path (a .yaml file or a
 *                            workflow directory); sha256 of the YAML bytes; validated, and thrown
 *                            with the formatted issues when validation has errors; command bodies
 *                            (frontmatter stripped) and named-script paths resolved alongside
 *   commandFile(name, dirs)  <dir>/commands/<name>.md with its frontmatter (description,
 *                            argument-hint) parsed into `meta` and stripped from `text`
 *
 * Command, script and persona roots, in precedence order: the workflow directory itself,
 * <cwd>/.titan, ~/.pi/titan-harness, <pkg>/.pi/titan-harness (each holding commands/,
 * scripts/, personas/). Node built-ins and the yaml dependency only; no pi imports.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { parse as parseYaml } from "yaml";
import { sha256 } from "../hash-chain.ts";
import { isAiNode, nodeType, type WorkflowDoc } from "./schema.ts";
import { findCommandFile, findScriptFile, formatIssues, isInlineScript, validateWorkflow, type ValidateContext, type ValidationResult } from "./validator.ts";

export type WorkflowSource = "project" | "user" | "package";

export interface LoadedWorkflow {
	doc: WorkflowDoc;
	normalized: WorkflowDoc;
	name: string;
	dir: string;
	path: string;
	sha256: string;
	source: WorkflowSource;
	/** command name → the command file's body (frontmatter stripped), for every `command:` node. */
	commands: Record<string, string>;
	/** named script → resolved file path, for every `script:` node that names a file. */
	scripts: Record<string, string>;
	validation: ValidationResult;
}

export interface WorkflowListing {
	name: string;
	dir: string;
	source: WorkflowSource;
}

/** Test/host overrides for the user and package roots (the project root always follows cwd). */
export interface WorkflowDirOverrides {
	user?: string;
	package?: string;
}

const WORKFLOW_EXTENSIONS = [".yaml", ".yml"];

/** The package root: four levels above modules/workflow/ (extensions/titan-harness/modules/workflow → the repo). */
export function packageRoot(): string {
	return fileURLToPath(new URL("../../../../", import.meta.url)).replace(/[\\/]+$/, "");
}

/** ~/.pi/titan-harness — the user's titan directory (home is read at call time so HOME overrides apply). */
export function userRoot(): string {
	return path.join(os.homedir(), ".pi", "titan-harness");
}

export function workflowDirs(cwd: string, overrides?: WorkflowDirOverrides): { project: string; user: string; package: string } {
	return {
		project: path.join(path.resolve(cwd), ".titan", "workflows"),
		user: overrides?.user ?? path.join(userRoot(), "workflows"),
		package: overrides?.package ?? path.join(packageRoot(), ".pi", "titan-harness", "workflows"),
	};
}

/** `<dir>/<basename(dir)>.yaml` (or .yml) when it exists. */
export function workflowFileIn(dir: string): string | undefined {
	const name = path.basename(dir);
	for (const ext of WORKFLOW_EXTENSIONS) {
		const candidate = path.join(dir, `${name}${ext}`);
		if (isFile(candidate)) return candidate;
	}
	return undefined;
}

function isFile(file: string): boolean {
	try {
		return fs.statSync(file).isFile();
	} catch {
		return false;
	}
}

function isDir(dir: string): boolean {
	try {
		return fs.statSync(dir).isDirectory();
	} catch {
		return false;
	}
}

/** Every installed workflow, name-sorted; a project workflow shadows a user one, which shadows the package one. */
export function listWorkflows(cwd: string, overrides?: WorkflowDirOverrides): WorkflowListing[] {
	const roots = workflowDirs(cwd, overrides);
	const seen = new Map<string, WorkflowListing>();
	for (const source of ["project", "user", "package"] as WorkflowSource[]) {
		const root = roots[source];
		let entries: string[];
		try {
			entries = fs.readdirSync(root);
		} catch {
			continue;
		}
		for (const name of entries.sort()) {
			if (seen.has(name)) continue;
			const dir = path.join(root, name);
			if (!isDir(dir) || !workflowFileIn(dir)) continue;
			seen.set(name, { name, dir, source });
		}
	}
	return [...seen.values()].sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * Where a name or path points: a path is anything with a separator, a leading `.`, a
 * workflow extension, or an existing file/directory relative to cwd; everything else is
 * a name looked up through the precedence order. Undefined when nothing matches.
 */
export function resolveWorkflow(nameOrPath: string, cwd: string, overrides?: WorkflowDirOverrides): { name: string; dir: string; path: string; source: WorkflowSource } | undefined {
	const roots = workflowDirs(cwd, overrides);
	const sourceOf = (dir: string): WorkflowSource => {
		const resolved = path.resolve(dir);
		for (const source of ["project", "user", "package"] as WorkflowSource[]) {
			const root = path.resolve(roots[source]);
			if (resolved === root || resolved.startsWith(root + path.sep)) return source;
		}
		return "project";
	};
	const looksLikePath = nameOrPath.includes("/") || nameOrPath.includes("\\") || nameOrPath.startsWith(".") || WORKFLOW_EXTENSIONS.some((ext) => nameOrPath.endsWith(ext));
	const candidate = path.resolve(cwd, nameOrPath);
	if (looksLikePath || isFile(candidate) || isDir(candidate)) {
		let file: string | undefined;
		if (isFile(candidate)) file = candidate;
		else if (isDir(candidate)) file = workflowFileIn(candidate);
		if (!file) return undefined;
		const dir = path.dirname(file);
		return { name: path.basename(dir), dir, path: file, source: sourceOf(dir) };
	}
	const listed = listWorkflows(cwd, overrides).find((entry) => entry.name === nameOrPath);
	if (!listed) return undefined;
	return { ...listed, path: workflowFileIn(listed.dir)! };
}

/** The roots commands/, scripts/ and personas/ resolve under, in precedence order. */
export function resourceRoots(workflowDir: string, cwd: string, overrides?: WorkflowDirOverrides): string[] {
	const pkg = overrides?.package ? path.dirname(path.dirname(overrides.package)) : path.join(packageRoot(), ".pi", "titan-harness");
	const user = overrides?.user ? path.dirname(overrides.user) : userRoot();
	return [path.resolve(workflowDir), path.join(path.resolve(cwd), ".titan"), user, pkg];
}

/** A ValidateContext for a workflow directory: dir + the resource roots above; workflowNames = every installed workflow. */
export function defaultValidateContext(workflowDir: string, cwd: string, overrides?: WorkflowDirOverrides): ValidateContext {
	const roots = resourceRoots(workflowDir, cwd, overrides);
	return { dir: path.resolve(workflowDir), commandDirs: roots, scriptDirs: roots, personaDirs: roots, workflowNames: listWorkflows(cwd, overrides).map((entry) => entry.name) };
}

/** Read the bytes of a workflow file: text, sha256 of the bytes, parsed document. Throws on a YAML syntax error. */
export function readWorkflowFile(file: string): { text: string; bytes: number; sha256: string; doc: unknown } {
	const buffer = fs.readFileSync(file);
	let doc: unknown;
	try {
		doc = parseYaml(buffer.toString("utf8"));
	} catch (error) {
		throw new Error(`titan-harness: workflow YAML invalid (${file}): ${error instanceof Error ? error.message : String(error)}`);
	}
	return { text: buffer.toString("utf8"), bytes: buffer.length, sha256: sha256(buffer), doc };
}

/**
 * Load a workflow by name or path. Validation errors throw with the formatted issue list;
 * warnings are kept on `validation`. `ctx` overrides individual ValidateContext fields
 * (a caller-supplied `modelStatus`, for example) on top of defaultValidateContext.
 */
export function loadWorkflow(nameOrPath: string, cwd: string, ctx?: Partial<ValidateContext>, overrides?: WorkflowDirOverrides): LoadedWorkflow {
	const located = resolveWorkflow(nameOrPath, cwd, overrides);
	if (!located) {
		const installed = listWorkflows(cwd, overrides).map((entry) => entry.name);
		throw new Error(`titan-harness: workflow ${JSON.stringify(nameOrPath)} not found (installed: ${installed.length ? installed.join(", ") : "none"}; roots: ${Object.values(workflowDirs(cwd, overrides)).join(", ")})`);
	}
	const read = readWorkflowFile(located.path);
	const defaults = defaultValidateContext(located.dir, cwd, overrides);
	const full: ValidateContext = { ...defaults };
	for (const [key, value] of Object.entries(ctx ?? {})) if (value !== undefined) (full as unknown as Record<string, unknown>)[key] = value;
	const validation = validateWorkflow(read.doc, full);
	if (!validation.ok || !validation.normalized) throw new Error(`titan-harness: workflow invalid (${located.path}):\n${formatIssues(validation)}`);
	const doc = read.doc as WorkflowDoc;
	const commands: Record<string, string> = {};
	const scripts: Record<string, string> = {};
	for (const node of doc.nodes) {
		const type = nodeType(node);
		const record = node as unknown as Record<string, unknown>;
		if (type === "command" && typeof record.command === "string") {
			const found = commandFile(record.command, full.commandDirs);
			if (found) commands[record.command] = found.text;
		} else if (type === "script" && typeof record.script === "string" && !isInlineScript(record.script)) {
			const found = findScriptFile(record.script, full.scriptDirs);
			if (found) scripts[record.script] = found.path;
		}
	}
	return { doc, normalized: validation.normalized, name: located.name, dir: located.dir, path: located.path, sha256: read.sha256, source: located.source, commands, scripts, validation };
}

// ═══ Command files ═══════════════════════════════════════════════════════════

export interface CommandFile {
	path: string;
	/** The body with the frontmatter block removed. */
	text: string;
	/** Frontmatter fields (`description`, `argument-hint`, anything else the file declares). */
	meta: Record<string, unknown>;
}

/** Split a leading `---\n…\n---` YAML frontmatter block off a markdown file; the body keeps its own leading whitespace trimmed of one newline. */
export function parseFrontmatter(text: string): { meta: Record<string, unknown>; body: string } {
	const match = /^---\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/.exec(text);
	if (!match) return { meta: {}, body: text };
	let meta: Record<string, unknown> = {};
	try {
		const parsed = parseYaml(match[1]);
		if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) meta = parsed as Record<string, unknown>;
	} catch {
		meta = {};
	}
	return { meta, body: text.slice(match[0].length) };
}

/** <dir>/commands/<name>.md (or <dir>/<name>.md) from the first dir that has it, frontmatter parsed into meta. */
export function commandFile(name: string, dirs: string[]): CommandFile | undefined {
	const file = findCommandFile(name, dirs);
	if (!file) return undefined;
	const { meta, body } = parseFrontmatter(fs.readFileSync(file, "utf8"));
	return { path: file, text: body, meta };
}

/** The AI nodes of a loaded workflow (command | prompt | loop | best_of | interleave | hypothesis). */
export function aiNodeIds(loaded: Pick<LoadedWorkflow, "normalized">): string[] {
	return loaded.normalized.nodes.filter((node) => isAiNode(node)).map((node) => node.id);
}
