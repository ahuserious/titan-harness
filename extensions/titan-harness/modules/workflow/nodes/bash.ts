/**
 * nodes/bash.ts — `bash:` nodes: the script is substituted in bash mode (every value
 * single-quote escaped) and run through deps.bash with `timeout` (default 120000 ms) and
 * the node env (ARTIFACTS_DIR, TITAN_*). stdout is the node output — trailing newline
 * trimmed, parsed as JSON when it starts with `{` or `[` — stderr is forwarded as a
 * warning and never fails the node, a non-zero exit does. Also exports the stdout/exit
 * contract (`processOutcome`) that script nodes share.
 */
import type { NodeContext, NodeHandler, NodeOutcome, ProcessResult } from "../executor.ts";

/** Last `max` characters of a stream, whitespace trimmed. */
export function tail(text: string, max = 600): string {
	const trimmed = text.trim();
	return trimmed.length > max ? `…${trimmed.slice(-max)}` : trimmed;
}

/** stdout → {text (one trailing newline trimmed), output (JSON when it looks like JSON, else the text)}. */
export function parseStdout(stdout: string): { text: string; output: unknown } {
	const text = stdout.replace(/\r?\n$/, "");
	const trimmed = text.trim();
	if (/^[[{]/.test(trimmed)) {
		try {
			return { text, output: JSON.parse(trimmed) };
		} catch {
			/* plain text that happens to start with a bracket */
		}
	}
	return { text, output: text };
}

/** The shared exit-code / stdout / stderr contract of bash and script nodes. */
export function processOutcome(ctx: NodeContext, result: ProcessResult): NodeOutcome {
	const stderr = result.stderr ?? "";
	if (stderr.trim()) ctx.notify(`${ctx.node.id}: stderr: ${tail(stderr)}`, "warning");
	const { text, output } = parseStdout(result.stdout ?? "");
	if (result.code !== 0) {
		return { status: "failed", output: undefined, text, error: `exit code ${result.code}${stderr.trim() ? `: ${tail(stderr, 300)}` : ""}` };
	}
	return { status: "success", output, text };
}

export const runBashNode: NodeHandler = async (ctx) => {
	const command = ctx.subst((ctx.node as { bash: string }).bash, "bash");
	const result = await ctx.deps.bash(command, { cwd: ctx.deps.cwd, timeoutMs: ctx.timeoutMs("process"), env: ctx.env, signal: ctx.signal });
	return processOutcome(ctx, result);
};
