/**
 * nodes/command.ts — `command:` nodes: the body of `<workflow dir>/commands/<name>.md`
 * (frontmatter already stripped by the loader into LoadedWorkflow.commands) becomes the
 * prompt of an AI node — Archon's "commands are prompts, not code". `$ARGUMENTS` and every
 * other reference substitute exactly as in a prompt node. A loader that recorded the file
 * PATH instead of its text is tolerated (the body is read from disk); a missing command
 * fails the node without retries.
 */
import * as fs from "node:fs";
import type { NodeHandler } from "../executor.ts";
import { runAiPrompt } from "./ai.ts";

/** The command body: the loader's text, or the file it points at. */
export function commandBody(commands: Record<string, string> | undefined, name: string): string | undefined {
	const value = commands?.[name];
	if (value === undefined) return undefined;
	if (!value.includes("\n") && value.endsWith(".md")) {
		try {
			if (fs.statSync(value).isFile()) return fs.readFileSync(value, "utf8");
		} catch {
			/* not a path — the text itself */
		}
	}
	return value;
}

export const runCommandNode: NodeHandler = async (ctx) => {
	const name = (ctx.node as { command: string }).command;
	const body = commandBody(ctx.loaded.commands, name);
	if (body === undefined) {
		return { status: "failed", output: undefined, error: `command file not found: ${name} (expected ${ctx.loaded.dir}/commands/${name}.md)`, retryable: false };
	}
	return runAiPrompt(ctx, body);
};
