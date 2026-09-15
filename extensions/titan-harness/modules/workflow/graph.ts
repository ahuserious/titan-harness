/**
 * graph.ts — `graph.html`, the offline DAG inspector (plan A5, P9). One self-contained
 * HTML file: an inline SVG (layers left → right, one rounded rect per node with its type
 * glyph, edges as cubic paths, missing depends_on targets as dashed phantoms), a side
 * panel that shows the clicked node's fields as JSON (inline script, no network), and the
 * Mermaid text in a <details>. No external scripts, styles, fonts or images: the file
 * opens from disk with nothing else present.
 *
 *   layoutGraph(doc)      the geometry (exported for tests and the monitor's ASCII view)
 *   graphHtml(doc, opts)  the HTML text; opts.mermaid embeds the Mermaid source when the
 *                         caller has it (cmd-workflow passes mermaidFor(doc)), opts.title
 *                         overrides the <title>
 *
 * Tolerant of invalid documents: cycles and unknown dependencies still draw (a back edge
 * is drawn, a missing target becomes a phantom), so `/workflow graph --html` works on a
 * workflow the validator rejects. Pure: no pi, no fs.
 */
import type { NodeDoc, NodeType, WorkflowDoc } from "./schema.ts";
import { nodeType } from "./schema.ts";

/** Type glyphs (kept in step with cmd-workflow's TYPE_GLYPH; duplicated to avoid a module cycle). */
export const NODE_GLYPH: Record<NodeType, string> = {
	command: "⌘",
	prompt: "✎",
	bash: "$",
	script: "⚙",
	loop: "↻",
	approval: "✋",
	cancel: "⊘",
	verify: "✓",
	best_of: "⚖",
	interleave: "⫴",
	hypothesis: "?",
	mcp_tool: "⚡",
	workflow: "⧉",
};

export interface GraphNode {
	id: string;
	type: NodeType | "missing" | "unknown";
	glyph: string;
	layer: number;
	row: number;
	x: number;
	y: number;
	w: number;
	h: number;
	role?: string;
	phase?: string;
	when?: string;
	returns: boolean;
	missing: boolean;
}

export interface GraphEdge {
	from: string;
	to: string;
	missing: boolean;
	back: boolean;
}

export interface GraphLayout {
	nodes: GraphNode[];
	edges: GraphEdge[];
	width: number;
	height: number;
}

export const NODE_W = 188;
export const NODE_H = 58;
export const COL_GAP = 72;
export const ROW_GAP = 28;
export const MARGIN = 32;

const docNodes = (doc: Pick<WorkflowDoc, "nodes">): NodeDoc[] =>
	Array.isArray(doc.nodes) ? doc.nodes.filter((node): node is NodeDoc => !!node && typeof node === "object" && typeof (node as NodeDoc).id === "string") : [];

/** Layer of every node: 1 + the deepest known dependency; a cycle's back edge counts as depth 0 (drawn, not layered). */
export function tolerantLayers(nodes: NodeDoc[]): { depth: Map<string, number>; back: Set<string> } {
	const byId = new Map(nodes.map((node) => [node.id, node]));
	const depth = new Map<string, number>();
	const back = new Set<string>(); // "from->to" edges that would close a cycle
	const visiting = new Set<string>();
	const visit = (id: string): number => {
		const known = depth.get(id);
		if (known !== undefined) return known;
		if (visiting.has(id)) return -1; // cycle: the caller records the back edge
		visiting.add(id);
		let best = 0;
		for (const dep of byId.get(id)?.depends_on ?? []) {
			if (!byId.has(dep)) continue; // phantoms sit in layer 0
			const d = visit(dep);
			if (d < 0) {
				back.add(`${dep}->${id}`);
				continue;
			}
			best = Math.max(best, d + 1);
		}
		visiting.delete(id);
		depth.set(id, best);
		return best;
	};
	for (const node of nodes) visit(node.id);
	return { depth, back };
}

/** Geometry for the SVG: layers are columns in document order within a column; phantoms occupy column 0. */
export function layoutGraph(doc: Pick<WorkflowDoc, "nodes"> & Partial<Pick<WorkflowDoc, "returns">>): GraphLayout {
	const nodes = docNodes(doc);
	const { depth, back } = tolerantLayers(nodes);
	const known = new Set(nodes.map((node) => node.id));
	const phantoms: string[] = [];
	for (const node of nodes) for (const dep of node.depends_on ?? []) if (!known.has(dep) && !phantoms.includes(dep)) phantoms.push(dep);
	const shift = phantoms.length ? 1 : 0; // phantoms take column 0, real layers start at 1
	const columns = new Map<number, GraphNode[]>();
	const place = (id: string, layer: number, extra: Partial<GraphNode>): GraphNode => {
		const column = columns.get(layer) ?? [];
		const node: GraphNode = { id, type: "unknown", glyph: "▢", layer, row: column.length, x: 0, y: 0, w: NODE_W, h: NODE_H, returns: false, missing: false, ...extra };
		column.push(node);
		columns.set(layer, column);
		return node;
	};
	for (const id of phantoms) place(id, 0, { type: "missing", glyph: "?", missing: true });
	for (const node of nodes) {
		const type = nodeType(node);
		place(node.id, (depth.get(node.id) ?? 0) + shift, { type: type ?? "unknown", glyph: type ? NODE_GLYPH[type] : "▢", role: node.role, phase: node.phase, when: node.when, returns: doc.returns === node.id });
	}
	const layers = [...columns.keys()].sort((a, b) => a - b);
	let width = MARGIN;
	let height = MARGIN;
	const placed: GraphNode[] = [];
	for (const layer of layers) {
		const column = columns.get(layer)!;
		const x = MARGIN + layer * (NODE_W + COL_GAP);
		column.forEach((node, row) => {
			node.x = x;
			node.y = MARGIN + row * (NODE_H + ROW_GAP);
			placed.push(node);
			height = Math.max(height, node.y + NODE_H + MARGIN);
		});
		width = Math.max(width, x + NODE_W + MARGIN);
	}
	const edges: GraphEdge[] = [];
	for (const node of nodes) {
		for (const dep of node.depends_on ?? []) edges.push({ from: dep, to: node.id, missing: !known.has(dep), back: back.has(`${dep}->${node.id}`) });
	}
	return { nodes: placed, edges, width, height };
}

const escapeHtml = (text: string): string => text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
/** JSON safe inside a <script>: no `<` survives, so `</script>` and `<!--` cannot appear. */
export const scriptJson = (value: unknown): string => JSON.stringify(value).replace(/</g, "\\u003c").replace(/[\u2028\u2029]/g, (ch) => (ch === "\u2028" ? "\\u2028" : "\\u2029"));
const clip = (text: string, max: number): string => (text.length <= max ? text : `${text.slice(0, max - 1)}…`);

/** The fields the side panel shows for a node: the node document itself (every key), in document order. */
export function nodeFields(node: NodeDoc): Record<string, unknown> {
	return { ...node };
}

const edgePath = (from: GraphNode, to: GraphNode): string => {
	const x1 = from.x + from.w;
	const y1 = from.y + from.h / 2;
	const x2 = to.x;
	const y2 = to.y + to.h / 2;
	const dx = Math.max(24, (x2 - x1) / 2);
	return `M ${x1} ${y1} C ${x1 + dx} ${y1}, ${x2 - dx} ${y2}, ${x2} ${y2}`;
};

/** Build the single-file inspector. */
export function graphHtml(doc: WorkflowDoc, opts: { title?: string; mermaid?: string } = {}): string {
	const layout = layoutGraph(doc);
	const nodes = docNodes(doc);
	const title = opts.title ?? `${doc.name ?? "workflow"} — titan graph`;
	const fields: Record<string, unknown> = {};
	for (const node of nodes) fields[node.id] = nodeFields(node);
	const svgNodes = layout.nodes
		.map((node) => {
			const label = clip(`${node.glyph} ${node.id}`, 22);
			const sub = clip([node.type === "missing" ? "missing dependency" : node.type, node.role, node.when ? `when ${node.when}` : ""].filter(Boolean).join(" · "), 26);
			const cls = ["node", node.missing ? "missing" : "", node.returns ? "returns" : ""].filter(Boolean).join(" ");
			return [
				`<g class="${cls}" data-id="${escapeHtml(node.id)}" transform="translate(${node.x},${node.y})" tabindex="0" role="button" aria-label="${escapeHtml(node.id)}">`,
				`<rect width="${node.w}" height="${node.h}" rx="10" ry="10"></rect>`,
				`<text class="label" x="12" y="24">${escapeHtml(label)}</text>`,
				`<text class="sub" x="12" y="44">${escapeHtml(sub)}</text>`,
				"</g>",
			].join("");
		})
		.join("\n");
	const positions = new Map(layout.nodes.map((node) => [node.id, node]));
	const svgEdges = layout.edges
		.map((edge) => {
			const from = positions.get(edge.from);
			const to = positions.get(edge.to);
			if (!from || !to) return "";
			const cls = ["edge", edge.missing ? "missing" : "", edge.back ? "back" : ""].filter(Boolean).join(" ");
			return `<path class="${cls}" d="${edgePath(from, to)}" marker-end="url(#arrow)"></path>`;
		})
		.filter(Boolean)
		.join("\n");
	const phases = (doc.phases ?? []).map((phase) => phase.title);
	const summary = [`${nodes.length} node${nodes.length === 1 ? "" : "s"}`, `${layout.edges.length} edge${layout.edges.length === 1 ? "" : "s"}`, phases.length ? `phases: ${phases.join(" → ")}` : "", doc.returns ? `returns: ${doc.returns}` : ""].filter(Boolean).join(" · ");
	const mermaid = opts.mermaid ?? layout.edges.map((edge) => `${edge.from} --> ${edge.to}`).join("\n");
	return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}</title>
<style>
:root { color-scheme: light dark; --bg: #f7f7f5; --ink: #1f2328; --muted: #6b7280; --line: #94a3b8; --node: #ffffff; --edge: #64748b; --accent: #2563eb; --missing: #dc2626; --returns: #16a34a; --panel: #ffffff; }
@media (prefers-color-scheme: dark) { :root { --bg: #0f1115; --ink: #e5e7eb; --muted: #9ca3af; --line: #475569; --node: #1a1d24; --edge: #94a3b8; --accent: #60a5fa; --missing: #f87171; --returns: #4ade80; --panel: #161920; } }
* { box-sizing: border-box; }
body { margin: 0; background: var(--bg); color: var(--ink); font: 14px/1.4 system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; display: grid; grid-template-rows: auto 1fr; height: 100vh; }
header { padding: 12px 16px; border-bottom: 1px solid var(--line); display: flex; gap: 16px; align-items: baseline; flex-wrap: wrap; }
header h1 { font-size: 16px; margin: 0; }
header .summary { color: var(--muted); }
main { display: grid; grid-template-columns: 1fr minmax(280px, 34%); min-height: 0; }
.canvas { overflow: auto; padding: 8px; }
svg { display: block; }
.node rect { fill: var(--node); stroke: var(--line); stroke-width: 1.5; cursor: pointer; }
.node:hover rect, .node:focus rect, .node.selected rect { stroke: var(--accent); stroke-width: 2.5; }
.node.missing rect { stroke: var(--missing); stroke-dasharray: 6 4; }
.node.returns rect { stroke: var(--returns); }
.node text { pointer-events: none; fill: var(--ink); }
.node .label { font-weight: 600; }
.node .sub { fill: var(--muted); font-size: 12px; }
.edge { fill: none; stroke: var(--edge); stroke-width: 1.5; }
.edge.missing { stroke: var(--missing); stroke-dasharray: 6 4; }
.edge.back { stroke: var(--missing); }
aside { border-left: 1px solid var(--line); background: var(--panel); overflow: auto; padding: 12px 16px; }
aside h2 { font-size: 14px; margin: 0 0 8px; }
aside .hint { color: var(--muted); }
pre { white-space: pre-wrap; word-break: break-word; font: 12px/1.45 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; background: transparent; margin: 0; }
details { margin-top: 16px; }
details summary { cursor: pointer; color: var(--muted); }
</style>
</head>
<body>
<header><h1>${escapeHtml(doc.name ?? "workflow")}</h1><span class="summary">${escapeHtml(summary)}</span></header>
<main>
<div class="canvas">
<svg width="${layout.width}" height="${layout.height}" viewBox="0 0 ${layout.width} ${layout.height}" role="img" aria-label="workflow graph">
<defs><marker id="arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="8" markerHeight="8" orient="auto-start-reverse"><path d="M 0 0 L 10 5 L 0 10 z" fill="var(--edge)"></path></marker></defs>
${svgEdges}
${svgNodes}
</svg>
</div>
<aside id="panel">
<h2 id="panel-title">Node</h2>
<p class="hint" id="panel-hint">Click a node to see its fields.</p>
<pre id="panel-json"></pre>
<details><summary>Mermaid source</summary><pre id="mermaid">${escapeHtml(mermaid)}</pre></details>
</aside>
</main>
<script>
(function () {
  var FIELDS = ${scriptJson(fields)};
  var title = document.getElementById("panel-title");
  var hint = document.getElementById("panel-hint");
  var json = document.getElementById("panel-json");
  var selected = null;
  function show(id) {
    if (selected) selected.classList.remove("selected");
    var el = document.querySelector('[data-id="' + id.replace(/"/g, '\\\\"') + '"]');
    if (el) { el.classList.add("selected"); selected = el; }
    var fields = FIELDS[id];
    title.textContent = id;
    if (!fields) { hint.textContent = "missing dependency: no node with this id in the document"; json.textContent = ""; return; }
    hint.textContent = "";
    json.textContent = JSON.stringify(fields, null, 2);
  }
  var nodes = document.querySelectorAll("[data-id]");
  for (var i = 0; i < nodes.length; i++) {
    nodes[i].addEventListener("click", function () { show(this.getAttribute("data-id")); });
    nodes[i].addEventListener("keydown", function (event) { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); show(this.getAttribute("data-id")); } });
  }
})();
</script>
</body>
</html>
`;
}
