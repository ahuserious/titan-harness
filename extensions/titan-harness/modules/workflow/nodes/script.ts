/**
 * nodes/script.ts — `script:` nodes (runtime bun | uv). A value with a newline or any
 * shell metacharacter is INLINE code (substituted in script mode: strings verbatim,
 * objects as JSON — assign directly, never interpolate into shell syntax); a bare
 * identifier is a NAMED script resolved by the loader into LoadedWorkflow.scripts
 * (<workflow dir>/scripts/<name>.ts|.js|.py). Dispatch (bun --no-env-file -e / run,
 * uv run [--with dep] python -c / <path>) belongs to deps.script; `$ARGUMENTS` is passed
 * as argv[0]. Same stdout / stderr / exit contract as bash nodes.
 */
import type { NodeHandler, ScriptSpec } from "../executor.ts";
import { processOutcome } from "./bash.ts";

/** Archon's rule: a newline or any of space ; ( ) { } & | < > $ ` " ' makes the value inline code. */
export const SHELL_META = /[\s;(){}&|<>$`"']/;

export function isInlineScript(value: string): boolean {
	return value.includes("\n") || SHELL_META.test(value);
}

export const runScriptNode: NodeHandler = async (ctx) => {
	const node = ctx.node as { script: string; runtime: "bun" | "uv"; deps?: string[] };
	const spec: ScriptSpec = { runtime: node.runtime, deps: node.deps };
	if (isInlineScript(node.script)) {
		spec.inline = ctx.subst(node.script, "script");
	} else {
		const file = ctx.loaded.scripts?.[node.script];
		if (!file) {
			return { status: "failed", output: undefined, error: `named script not found: ${node.script} (expected ${ctx.loaded.dir}/scripts/${node.script}.{ts,js,py})`, retryable: false };
		}
		spec.path = file;
	}
	const args = ctx.substitution().arguments;
	const result = await ctx.deps.script(spec, { cwd: ctx.deps.cwd, timeoutMs: ctx.timeoutMs("process"), env: ctx.env, signal: ctx.signal, argv: args === undefined ? [] : [args] });
	return processOutcome(ctx, result);
};
