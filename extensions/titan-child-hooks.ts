/**
 * titan-child-hooks.ts — titan's NARROW child mode (plan D12, §7 P3): the one titan
 * extension that does anything inside a `pi --mode json -p` child, and only when the
 * workflow executor asked for it through the environment.
 *
 *   host process (TITAN_HARNESS_CHILD unset)              → returns immediately
 *   child without TITAN_NODE_HOOKS / TITAN_NODE_SCHEMA     → returns immediately
 *   child with TITAN_NODE_HOOKS                           → tool_call + tool_result handlers
 *                                                           applying the node's static hooks
 *   child with TITAN_NODE_SCHEMA (+ TITAN_NODE_RESULT_PATH) → the terminating `submit_result`
 *                                                           tool whose parameters ARE the schema
 *
 * Nothing else is registered — no commands, widgets, status or shortcuts — so the recursion
 * guard the rest of titan relies on (stack-config.ts isStackChild) is untouched. All logic
 * is in titan-harness/modules/child-hooks.ts (pure, tested); its header documents the env
 * contract, the Archon-hook → Pi mapping and the --tools wiring the executor owns:
 * `submit_result` must be in the child's --tools allowlist (never --no-tools for a schema
 * node), and the node prompt should end with SUBMIT_RESULT_INSTRUCTION.
 *
 * `parameters` is handed to pi.registerTool as a plain JSON schema object (no TypeBox):
 * pi-ai's validateToolArguments takes the non-TypeBox path (coerceWithJsonSchema) for
 * schemas without the TypeBox Kind symbol, which is the same wire shape pi-exa's MCP
 * tools register through Type.Unsafe(inputSchema) — minus a dependency this package
 * does not declare.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
	applyPostToolUse,
	applyPreToolUse,
	applyStop,
	childModeFromEnv,
	type ContentBlock,
	replaceInput,
	SUBMIT_RESULT_ACK,
	SUBMIT_RESULT_INSTRUCTION,
	SUBMIT_RESULT_TOOL,
	submitResultParameters,
	unwrapResult,
	writeResult,
} from "./titan-harness/modules/child-hooks.ts";
import type { HooksDoc, JsonSchema } from "./titan-harness/modules/workflow/schema.ts";

export default function (pi: ExtensionAPI) {
	const mode = childModeFromEnv(process.env);
	for (const problem of mode.problems) process.stderr.write(`titan-child-hooks: ${problem}\n`);
	if (!mode.active) return;
	if (mode.hooks) registerHooks(pi, mode.hooks);
	if (mode.schema && mode.resultPath) registerSubmitResult(pi, mode.schema, mode.resultPath);
}

/** PreToolUse / Stop → tool_call; PostToolUse → tool_result. Context stashed at tool_call rides on that call's result. */
function registerHooks(pi: ExtensionAPI, hooks: HooksDoc): void {
	const pending = new Map<string, string>(); // toolCallId → "[hook] …" lines for its result
	let armedStop: string | undefined; // set by a PostToolUse continue:false; fires at the next tool call

	pi.on("tool_call", (event: any) => {
		if (event.toolName === SUBMIT_RESULT_TOOL) return undefined;
		if (armedStop) return { block: true, terminate: true, reason: armedStop };
		const stop = applyStop(hooks.Stop, event.toolName);
		if (stop) return stop;
		const input = (event.input && typeof event.input === "object" ? event.input : {}) as Record<string, unknown>;
		const pre = applyPreToolUse(hooks.PreToolUse, event.toolName, input);
		if (pre.block) return { block: true, reason: pre.reason, ...(pre.terminate ? { terminate: true } : {}) };
		if (pre.input && event.input && typeof event.input === "object") replaceInput(event.input, pre.input);
		if (pre.additionalContext) pending.set(event.toolCallId, pre.additionalContext);
		return undefined;
	});

	pi.on("tool_result", (event: any) => {
		if (event.toolName === SUBMIT_RESULT_TOOL) return undefined;
		const stashed = pending.get(event.toolCallId);
		pending.delete(event.toolCallId);
		const content = (Array.isArray(event.content) ? event.content : []) as ContentBlock[];
		const post = applyPostToolUse(hooks.PostToolUse, event.toolName, content, stashed);
		if (post.stop) armedStop = post.stop;
		if (!post.changed) return undefined;
		return { content: post.content, ...(post.isError ? { isError: true } : {}) };
	});
}

/** The structured-output tool: parameters = the node's schema; execute writes the result file and terminates the turn. */
function registerSubmitResult(pi: ExtensionAPI, schema: JsonSchema, resultPath: string): void {
	const { parameters, wrapped } = submitResultParameters(schema);
	(pi as any).registerTool({
		name: SUBMIT_RESULT_TOOL,
		label: "Submit result",
		description: `Record this workflow node's final structured result. ${SUBMIT_RESULT_INSTRUCTION}`,
		promptSnippet: "Record the node's final structured result (exactly once, as the last action)",
		promptGuidelines: [SUBMIT_RESULT_INSTRUCTION, "submit_result's arguments must match its schema exactly; put the whole answer in the call, not in prose around it."],
		parameters,
		async execute(_toolCallId: string, params: unknown) {
			writeResult(resultPath, unwrapResult(params, wrapped));
			return {
				content: [{ type: "text", text: SUBMIT_RESULT_ACK }],
				details: { path: resultPath, wrapped },
				terminate: true,
			};
		},
	});
}
