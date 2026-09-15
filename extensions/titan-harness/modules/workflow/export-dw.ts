/**
 * export-dw.ts — `/workflow export --dw`: a titan YAML DAG → a pi-dynamic-workflows
 * 3.10.1 script (plan D1, Appendix B.2, P9). The output is JavaScript in that package's
 * envelope — `export const meta = {…}` as a pure literal first, then a body that already
 * runs inside an async function and uses only its runtime globals — never YAML.
 *
 * What maps (3.10.1 runtime globals, per its README capability index):
 *   prompt / command   agent(`…`, { label, phase?, schema?, model? })
 *   layer with > 1 node   parallel([async () => …, …]) with the results assigned back
 *   when                  a JS condition from the same grammar (parseWhen ast): refs read
 *                         `field(out[id], [path])`, literals stay literals
 *   trigger_rule          `ready(ids, rule)` over the dependency results (null = skipped or
 *                         failed — pi-dw returns null for recoverable failures)
 *   output_format         `schema:` (titan:// refs inlined via resolveRef)
 *   approval              checkpoint(`…`, { kind: "confirm" }); a rejection throws
 *   cancel                throw new Error("cancelled: …") under the node's guard
 *   best_of               parallel(n candidates) + judgePanel(candidates, { rubric })
 *   workflow              workflow("<name>", inputs) — the child must be a SAVED pi-dw
 *                         workflow of that name (warned)
 *   bash / script         3.10.1 has no bash() global: an agent() is asked to run the
 *                         command and answer with stdout only (warned)
 *   loop / verify / interleave / hypothesis / mcp_tool   `// TODO` blocks + warnings
 *
 * Constraints honoured: no imports, no Date.now()/Math.random()/new Date(), labels unique
 * (node ids), only used phases declared, an explicit `return`. Pure: no pi, no fs.
 */
import { resolveRef } from "./json-schema.ts";
import type { LoadedWorkflow } from "./loader.ts";
import { layers } from "./scheduler.ts";
import { type NodeDoc, type NodeType, nodeType, parseWhen, type WhenAst, type WhenOperand, type WorkflowDoc } from "./schema.ts";

export interface DwExport {
	script: string;
	warnings: string[];
	/** Node ids exported as TODO blocks. */
	unsupported: string[];
}

export const DW_VERSION = "3.10.1";
const TODO_TYPES: NodeType[] = ["loop", "verify", "interleave", "hypothesis", "mcp_tool"];

/** A JS string/number/boolean/null literal (JSON is a JS literal subset for these). */
export const jsLiteral = (value: unknown): string => JSON.stringify(value ?? null);

/** A JS object literal for a plain JSON value (pretty, two-space); used for schemas and inputs. */
export const jsObject = (value: unknown, indent = 2): string => JSON.stringify(value ?? null, null, indent).replace(/\n/g, `\n${" ".repeat(indent)}`);

const REF_RE = /\$([A-Za-z0-9][A-Za-z0-9_-]{0,31})\.output((?:\.[A-Za-z0-9_-]+)*)/g;
const VAR_RE = /\$(ARGUMENTS|ARTIFACTS_DIR|WORKFLOW_ID|RUN_ID|BASE_BRANCH|CONTEXT|LOOP_USER_INPUT|REJECTION_REASON|LOOP_COUNT)\b/g;
const INPUT_RE = /\$inputs?\.([A-Za-z_][A-Za-z0-9_]*)/g;

const escapeTemplate = (text: string): string => text.replace(/\\/g, "\\\\").replace(/`/g, "\\`").replace(/\$\{/g, "\\${");

/** A titan prompt → a JS template literal reading the exported `out`, `INPUTS`, `ARGUMENTS`, `ARTIFACTS_DIR`. */
export function promptToTemplate(text: string, knownIds: Set<string>, warn: (text: string) => void, nodeId: string): string {
	// Tokenize into literal segments and substitutions so escaping never touches a substitution.
	const parts: string[] = [];
	let cursor = 0;
	const matches: Array<{ start: number; end: number; js: string }> = [];
	for (const match of text.matchAll(REF_RE)) {
		const [whole, id, rest] = match;
		if (!knownIds.has(id)) continue; // unknown ref stays as text (the validator would have refused it)
		const pathParts = rest ? rest.slice(1).split(".") : [];
		matches.push({ start: match.index!, end: match.index! + whole.length, js: pathParts.length ? `\${str(field(out[${jsLiteral(id)}], ${jsLiteral(pathParts)}))}` : `\${str(out[${jsLiteral(id)}])}` });
	}
	for (const match of text.matchAll(INPUT_RE)) matches.push({ start: match.index!, end: match.index! + match[0].length, js: `\${str(INPUTS[${jsLiteral(match[1])}])}` });
	for (const match of text.matchAll(VAR_RE)) {
		const name = match[1];
		let js: string | undefined;
		if (name === "ARGUMENTS") js = "${ARGUMENTS}";
		else if (name === "ARTIFACTS_DIR") js = "${ARTIFACTS_DIR}";
		else if (name === "WORKFLOW_ID") js = "${WORKFLOW_ID}";
		else if (name === "RUN_ID") js = "${RUN_ID}";
		else if (name === "BASE_BRANCH") js = "${str(INPUTS.base_branch)}";
		else if (name === "CONTEXT") js = "${str(INPUTS.context)}";
		else {
			warn(`${nodeId}: $${name} has no pi-dynamic-workflows equivalent; left as text`);
			continue;
		}
		matches.push({ start: match.index!, end: match.index! + match[0].length, js });
	}
	matches.sort((a, b) => a.start - b.start);
	for (const match of matches) {
		if (match.start < cursor) continue; // overlapping (cannot happen with these patterns, kept defensive)
		parts.push(escapeTemplate(text.slice(cursor, match.start)));
		parts.push(match.js);
		cursor = match.end;
	}
	parts.push(escapeTemplate(text.slice(cursor)));
	return `\`${parts.join("")}\``;
}

const operandJs = (operand: WhenOperand): string => (operand.kind === "ref" ? `field(out[${jsLiteral(operand.node)}], ${jsLiteral(operand.path)})` : jsLiteral(operand.value));

const astJs = (ast: WhenAst): string => {
	if (ast.kind === "compare") {
		const op = ast.op === "==" ? "==" : ast.op === "!=" ? "!=" : ast.op;
		return `${operandJs(ast.left)} ${op} ${operandJs(ast.right)}`;
	}
	const joiner = ast.kind === "and" ? " && " : " || ";
	return `(${ast.items.map(astJs).join(joiner)})`;
};

/** `when` → a JS boolean expression over `out`, or an error when the grammar does not parse. */
export function whenToJs(expr: string): { ok: true; js: string } | { ok: false; error: string } {
	const parsed = parseWhen(expr);
	if (!parsed.ok || !parsed.ast) return { ok: false, error: parsed.error ?? "unparseable when expression" };
	return { ok: true, js: astJs(parsed.ast) };
}

interface Emitted {
	/** Statements that produce the node's value into `out[id]` (sequential form). */
	sequential: string[];
	/** An async-thunk expression returning the node's value (parallel form), or undefined when the node cannot run in parallel (throws/TODO are fine either way). */
	thunk: string;
}

/** Indent code lines, never the continuation lines of a template literal (they are prompt text). */
const indent = (lines: string[], depth: number): string[] => {
	let inTemplate = false;
	return lines.map((line) => {
		const out = !inTemplate && line ? `${"  ".repeat(depth)}${line}` : line;
		const ticks = (line.match(/(?<!\\)`/g) ?? []).length;
		if (ticks % 2 === 1) inTemplate = !inTemplate;
		return out;
	});
};

/** Export a loaded (validated, normalized) workflow. */
export function exportDynamicWorkflow(loaded: Pick<LoadedWorkflow, "name" | "normalized"> & Partial<Pick<LoadedWorkflow, "commands" | "doc">>): DwExport {
	const doc: WorkflowDoc = loaded.normalized ?? (loaded.doc as WorkflowDoc);
	const warnings: string[] = [];
	const unsupported: string[] = [];
	const warn = (text: string): void => {
		if (!warnings.includes(text)) warnings.push(text);
	};
	const nodes = doc.nodes;
	const byId = new Map(nodes.map((node) => [node.id, node]));
	const knownIds = new Set(byId.keys());
	const usedPhases = (doc.phases ?? []).map((phase) => phase.title).filter((title) => nodes.some((node) => node.phase === title));
	const meta: Record<string, unknown> = { name: loaded.name, description: doc.description ?? `titan workflow ${loaded.name} exported for pi-dynamic-workflows ${DW_VERSION}` };
	if (usedPhases.length) meta.phases = usedPhases.map((title) => ({ title }));

	const guardFor = (node: NodeDoc): { js: string; comments: string[] } => {
		const comments: string[] = [];
		const parts: string[] = [];
		const deps = node.depends_on ?? [];
		if (deps.length) parts.push(`ready(${jsLiteral(deps)}, ${jsLiteral(node.trigger_rule ?? "all_success")})`);
		if (node.when) {
			const when = whenToJs(node.when);
			comments.push(`// when: ${node.when}`);
			if (when.ok) parts.push(`(${when.js})`);
			else {
				warn(`${node.id}: when ${JSON.stringify(node.when)} could not be translated (${when.error}); the node runs unconditionally`);
				comments.push(`// TODO: translate the when expression by hand (${when.error})`);
			}
		}
		return { js: parts.length ? parts.join(" && ") : "true", comments };
	};

	const agentOptions = (node: NodeDoc, label: string, extra: Record<string, string> = {}): string => {
		const opts: string[] = [`label: ${jsLiteral(label)}`];
		if (node.phase && usedPhases.includes(node.phase)) opts.push(`phase: ${jsLiteral(node.phase)}`);
		if (node.model) opts.push(`model: ${jsLiteral(node.thinking ? `${node.model}:${node.thinking}` : node.model)}`);
		else if (node.thinking) warn(`${node.id}: thinking ${node.thinking} without a model has no pi-dynamic-workflows selector (thinking rides the model as provider/id:thinking)`);
		if (node.output_format) {
			const schema = node.output_format.$ref ? resolveRef(node.output_format.$ref) : node.output_format;
			if (schema) opts.push(`schema: ${jsObject(schema, 4).replace(/\n/g, "\n  ")}`);
			else warn(`${node.id}: output_format $ref ${node.output_format.$ref} is unknown; exported without a schema`);
		}
		for (const [key, value] of Object.entries(extra)) opts.push(`${key}: ${value}`);
		return `{ ${opts.join(", ")} }`;
	};

	const promptOf = (node: NodeDoc, type: NodeType): string | undefined => {
		if (type === "prompt") return (node as { prompt: string }).prompt;
		if (type === "command") {
			const name = (node as { command: string }).command;
			const body = loaded.commands?.[name];
			if (body !== undefined) return body;
			warn(`${node.id}: command ${JSON.stringify(name)} has no body in the loaded workflow; the agent is asked to run it by name`);
			return `Run the workflow command "${name}" with these arguments: $ARGUMENTS`;
		}
		return undefined;
	};

	const emitValue = (node: NodeDoc): { expr?: string; block?: string[]; throws?: boolean } => {
		const type = nodeType(node);
		const label = node.id;
		if (!type) {
			unsupported.push(node.id);
			warn(`${node.id}: no recognizable node type; exported as a TODO`);
			return { block: [`// TODO(${node.id}): unrecognized node type`, `out[${jsLiteral(node.id)}] = null`] };
		}
		switch (type) {
			case "prompt":
			case "command": {
				const prompt = promptToTemplate(promptOf(node, type) ?? "", knownIds, warn, node.id);
				return { expr: `await agent(${prompt}, ${agentOptions(node, label)})` };
			}
			case "bash": {
				warn(`${node.id}: bash node exported as an agent() that runs the command — pi-dynamic-workflows ${DW_VERSION} has no bash() runtime global`);
				const command = (node as { bash: string }).bash;
				const prompt = promptToTemplate(`Run exactly this shell command in the repository and reply with its stdout only, no commentary:\n\n\`\`\`bash\n${command}\n\`\`\``, knownIds, warn, node.id);
				return { expr: `await agent(${prompt}, ${agentOptions(node, label, { tier: jsLiteral("small") })})` };
			}
			case "script": {
				const spec = node as { script: string; runtime: "bun" | "uv" };
				warn(`${node.id}: script node exported as an agent() that runs it with ${spec.runtime} — pi-dynamic-workflows ${DW_VERSION} has no script runner`);
				const prompt = promptToTemplate(`Run this ${spec.runtime === "bun" ? "TypeScript (bun run)" : "Python (uv run)"} script in the repository and reply with its stdout only, no commentary:\n\n\`\`\`\n${spec.script}\n\`\`\``, knownIds, warn, node.id);
				return { expr: `await agent(${prompt}, ${agentOptions(node, label, { tier: jsLiteral("small") })})` };
			}
			case "approval": {
				const spec = (node as { approval: { message: string } }).approval;
				const message = promptToTemplate(spec.message, knownIds, warn, node.id);
				return {
					block: [`out[${jsLiteral(node.id)}] = await checkpoint(${message}, { kind: "confirm" })`, `if (!out[${jsLiteral(node.id)}]) throw new Error(${jsLiteral(`approval rejected at ${node.id}`)})`],
				};
			}
			case "cancel": {
				const reason = promptToTemplate((node as { cancel: string }).cancel, knownIds, warn, node.id);
				return { block: [`throw new Error(\`cancelled: \${${reason}}\`)`], throws: true };
			}
			case "best_of": {
				const spec = (node as { best_of: { n: number; criteria?: string; prompt: string } }).best_of;
				const n = Math.min(8, Math.max(2, spec.n ?? 4));
				const prompt = promptToTemplate(spec.prompt, knownIds, warn, node.id);
				const thunks = Array.from({ length: n }, (_, i) => `async () => await agent(${prompt}, ${agentOptions(node, `${label}-c${i + 1}`)})`);
				return {
					block: [
						`const candidates_${safeIdent(node.id)} = (await parallel([`,
						...indent(thunks.map((thunk, i) => `${thunk}${i < thunks.length - 1 ? "," : ""}`), 1),
						`])).filter((candidate) => candidate != null)`,
						`const pick_${safeIdent(node.id)} = candidates_${safeIdent(node.id)}.length ? await judgePanel(candidates_${safeIdent(node.id)}, { rubric: ${jsLiteral(spec.criteria ?? "overall quality and correctness")} }) : undefined`,
						`out[${jsLiteral(node.id)}] = pick_${safeIdent(node.id)} ? pick_${safeIdent(node.id)}.attempt : null`,
					],
				};
			}
			case "workflow": {
				const spec = (node as { workflow: { name: string; fan_out?: unknown } }).workflow;
				warn(`${node.id}: workflow node calls workflow(${JSON.stringify(spec.name)}) — save that workflow in pi-dynamic-workflows first (/workflows save ${spec.name})`);
				if (spec.fan_out) {
					warn(`${node.id}: fan_out is not translated; the child runs once with the parent's inputs`);
				}
				return { expr: `await workflow(${jsLiteral(spec.name)}, INPUTS)` };
			}
			default: {
				unsupported.push(node.id);
				warn(`${node.id}: ${type} nodes have no pi-dynamic-workflows equivalent; exported as a TODO block (${TODO_TYPES.includes(type) ? "titan-only pattern" : "unsupported"})`);
				return { block: [`// TODO(${node.id}): ${type} node — ${todoHint(type)}`, `out[${jsLiteral(node.id)}] = null`] };
			}
		}
	};

	const emitNode = (node: NodeDoc): Emitted => {
		const guard = guardFor(node);
		const value = emitValue(node);
		const id = jsLiteral(node.id);
		const sequential: string[] = [...guard.comments];
		if (value.expr) {
			sequential.push(guard.js === "true" ? `out[${id}] = ${value.expr}` : `out[${id}] = ${guard.js} ? ${value.expr} : null`);
		} else {
			const body = value.block ?? [];
			if (guard.js === "true") sequential.push(...body);
			else sequential.push(`if (${guard.js}) {`, ...indent(body, 1), "}", ...(value.throws ? [] : [`else out[${id}] = null`]));
			if (value.throws && guard.js === "true") {
				/* an unconditional cancel: the run ends here */
			}
		}
		const thunkBody: string[] = [];
		if (value.expr) thunkBody.push(guard.js === "true" ? `return ${value.expr}` : `if (!(${guard.js})) return null`, ...(guard.js === "true" ? [] : [`return ${value.expr}`]));
		else {
			const body = value.block ?? [];
			if (guard.js !== "true") thunkBody.push(`if (!(${guard.js})) return null`);
			thunkBody.push(...body, ...(value.throws ? [] : [`return out[${id}]`]));
		}
		const thunk = [`async () => {`, ...indent([...guard.comments, ...thunkBody], 1), `}`].join("\n");
		return { sequential, thunk };
	};

	const body: string[] = [];
	body.push(`const out = {}`);
	body.push(`const INPUTS = args && typeof args === "object" && !Array.isArray(args) ? args : {}`);
	body.push(`const ARGUMENTS = typeof args === "string" ? args : String(INPUTS.arguments ?? "")`);
	body.push(`const WORKFLOW_ID = ${jsLiteral(loaded.name)}`);
	body.push(`const RUN_ID = "pi-dynamic-workflows"`);
	body.push(`const ARTIFACTS_DIR = \`\${cwd}/.titan/dw-artifacts/${loaded.name}\``);
	body.push(`const parseMaybe = (text) => { try { return JSON.parse(text) } catch { return text } }`);
	body.push(`const str = (value) => (value == null ? "" : typeof value === "string" ? value : JSON.stringify(value))`);
	body.push(`const field = (value, path) => path.reduce((acc, key) => (acc == null ? undefined : acc[key]), typeof value === "string" ? parseMaybe(value) : value)`);
	body.push(`// null = the dependency was skipped or failed (pi-dynamic-workflows returns null for recoverable failures)`);
	body.push(`const ready = (ids, rule) => { const values = ids.map((id) => out[id]); if (rule === "all_done") return true; if (rule === "one_success" || rule === "none_failed_min_one_success") return values.some((value) => value != null); return values.every((value) => value != null) }`);
	body.push("");
	let currentPhase: string | undefined;
	const plan = layers(doc);
	plan.forEach((layer, index) => {
		body.push(`// layer ${index + 1}: ${layer.join(", ")}`);
		const members = layer.map((id) => byId.get(id)!).filter(Boolean);
		const phase = members.find((node) => node.phase && usedPhases.includes(node.phase))?.phase;
		if (phase && phase !== currentPhase) {
			body.push(`phase(${jsLiteral(phase)})`);
			currentPhase = phase;
		}
		if (members.length === 1) {
			body.push(...emitNode(members[0]).sequential);
		} else {
			const emitted = members.map(emitNode);
			const results = members.map((node) => `r_${safeIdent(node.id)}`);
			body.push(`const [${results.join(", ")}] = await parallel([`);
			emitted.forEach((item, i) => {
				const lines = item.thunk.split("\n");
				body.push(...indent(lines.map((line, j) => (j === lines.length - 1 && i < emitted.length - 1 ? `${line},` : line)), 1));
			});
			body.push(`])`);
			members.forEach((node, i) => body.push(`out[${jsLiteral(node.id)}] = ${results[i]}`));
		}
		body.push("");
	});
	body.push(doc.returns ? `return out[${jsLiteral(doc.returns)}]` : "return out");

	const header = [
		`// ${loaded.name} — exported from titan-harness for pi-dynamic-workflows ${DW_VERSION} (/workflow export --dw).`,
		`// Runtime globals only (agent, parallel, checkpoint, judgePanel, workflow, phase, args, cwd); no imports, no clock.`,
		...(warnings.length ? [`// Warnings:`, ...warnings.map((text) => `//   - ${text}`)] : []),
	];
	const metaLiteral = `export const meta = ${JSON.stringify(meta, null, 2)}`;
	const script = [...header, metaLiteral, "", ...body, ""].join("\n");
	return { script, warnings, unsupported };
}

const safeIdent = (id: string): string => id.replace(/[^A-Za-z0-9_]/g, "_");

const todoHint = (type: NodeType): string => {
	switch (type) {
		case "loop":
			return "wrap an agent() in retry({ attempts }) or loopUntilDry() and check the completion token yourself";
		case "verify":
			return "titan runner evidence has no counterpart; call verify(item, { reviewers }) on the upstream result instead";
		case "interleave":
			return "fan the segments out with parallel() and synthesize with one agent()";
		case "hypothesis":
			return "tally the evidence links in plain JavaScript";
		case "mcp_tool":
			return "pi-dynamic-workflows agents call MCP tools themselves; ask an agent() to call the tool";
		default:
			return "no equivalent";
	}
};
