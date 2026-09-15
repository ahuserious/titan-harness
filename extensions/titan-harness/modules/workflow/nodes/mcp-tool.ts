/**
 * nodes/mcp-tool.ts — `mcp_tool: {server, tool, args}` nodes call one MCP tool through
 * deps.mcpTool (the extension bridges it to pi-mcp-adapter's namespaced tools). Args are
 * substituted deeply: a string that is exactly one reference (`"$classify.output"`)
 * becomes the referenced VALUE (object, array, number…), any other string substitutes in
 * raw mode. The tool's return value is the node output (its JSON is the artifact). A
 * runtime without an MCP bridge fails the node without retries.
 */
import type { NodeContext, NodeHandler } from "../executor.ts";
import { resolveReference } from "../substitute.ts";

const EXACT_REF = /^\$[A-Za-z0-9_][A-Za-z0-9_-]*(?:\.[A-Za-z0-9_-]+)*$/;

/** Substitute every string inside `value` (see the header). */
export function substituteArgs(value: unknown, ctx: NodeContext): unknown {
	if (typeof value === "string") {
		const trimmed = value.trim();
		if (EXACT_REF.test(trimmed)) {
			const resolved = resolveReference(trimmed, ctx.substitution());
			if (resolved.found && !resolved.rest) return resolved.value;
		}
		return ctx.subst(value, "raw");
	}
	if (Array.isArray(value)) return value.map((item) => substituteArgs(item, ctx));
	if (value && typeof value === "object") return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([k, v]) => [k, substituteArgs(v, ctx)]));
	return value;
}

export const runMcpToolNode: NodeHandler = async (ctx) => {
	const spec = (ctx.node as { mcp_tool: { server: string; tool: string; args?: Record<string, unknown> } }).mcp_tool;
	if (!ctx.deps.mcpTool) {
		return { status: "failed", output: undefined, error: `mcp_tool ${spec.server}/${spec.tool}: no MCP bridge in this runtime (deps.mcpTool is absent)`, retryable: false };
	}
	const args = substituteArgs(spec.args ?? {}, ctx) as Record<string, unknown>;
	const result = await ctx.deps.mcpTool(spec.server, spec.tool, args);
	const text = typeof result === "string" ? result : `${JSON.stringify(result, null, 2) ?? ""}\n`;
	return { status: "success", output: result, text, meta: { server: spec.server, tool: spec.tool } };
};
