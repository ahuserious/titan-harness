/**
 * monitor/frame.ts — text frames for the overlay, the split pane and the bar row
 * (plan D4, §5.4, H4). Pure string rendering, width- and height-aware, no pi:
 *
 *   renderFrame(view, opts)   line 1  `◆ MONITOR <workflow|command> · <runId> · <status> · <elapsed>`
 *                                     plus ` · <totals>` when it fits, else the totals on line 2
 *                             rail    `[✓ plan]─[● build]─[○ verify]` (from `phases:`)
 *                             rows    `<glyph> <callsign> · <role> · <model> (<thinking>) · <state> · <tok> tok · $<cost> · <tps> tps[ · wd:n]`
 *                                     depth-1 rows indented `  └ `; the header notes "nested sub-rows: one level"
 *                             footer  `verified k/n · rows a–b of n · ↑↓ scroll · q close`
 *                             Lines never exceed `width` (truncated with …) and the row window
 *                             never exceeds `height` (scrolled with `offset`).
 *   renderBarRow(view)        the always-on model-bar cell text (the lead adds it to renderFooterWidget)
 *   renderList(views, width)  the `/workflow-monitor list` table: name · phase · roster · progress · result
 *
 * Colour: `opts.color(hex, text)` paints a finished, width-fitted line; the default is the
 * identity so snapshots are plain text. The row colour is its state's hex (§5.4); the
 * header, rail and footer use fixed hexes. scripts/titan-monitor.mjs reproduces the plain
 * text of renderFrame byte for byte (tests/monitor.test.ts pins it).
 */
import { fmtTokens, fmtUsd } from "../ledger.ts";
import { fmtSecs } from "../runtime.ts";
import { type MonitorRow, type RunView, workingCount } from "./rows.ts";
import { colorOf, STATE_GLYPH } from "./state.ts";

export interface FrameOptions {
	width: number;
	height: number;
	tick: number;
	title?: string;
	showRail?: boolean;
	/** Paints one finished line; default identity (plain text). */
	color?: (hex: string, text: string) => string;
	/** First row shown when the rows do not fit `height`. */
	offset?: number;
}

export const HEADER_COLOR = "#e2e8f0";
export const RAIL_COLOR = "#94a3b8";
export const FOOTER_COLOR = "#475569"; // distinct from every STATE_COLORS value
const identity = (_hex: string, text: string): string => text;

/** Truncate to `width` code points with an ellipsis. */
export function fit(text: string, width: number): string {
	const chars = [...text];
	if (width <= 0) return "";
	if (chars.length <= width) return text;
	if (width === 1) return "…";
	return `${chars.slice(0, width - 1).join("")}…`;
}

/** Model without its provider prefix. */
export const shortModel = (model: string): string => (model.includes("/") ? model.slice(model.lastIndexOf("/") + 1) : model);

/** The run's display name: workflow, else command, else "run". */
export const viewName = (view: Pick<RunView, "workflow" | "command">): string => view.workflow ?? view.command ?? "run";

/** One row's text (before width fitting and colour). */
export function rowText(row: MonitorRow, tick: number): string {
	const bits = [`${STATE_GLYPH(row.state, tick)} ${row.callsign}`, row.role, `${shortModel(row.model)} (${row.thinking})`, String(row.state), `${fmtTokens(row.tokens)} tok`, fmtUsd(row.costUsd)];
	if (row.tps !== undefined) bits.push(`${Math.round(row.tps)} tps`);
	if (row.wd) bits.push(`wd:${row.wd}`);
	const line = bits.join(" · ");
	return row.depth === 1 ? `  └ ${line}` : line;
}

/** `[✓ plan]─[● build]─[○ verify]` */
export function railText(view: RunView): string {
	const glyph = { done: "✓", active: "●", pending: "○" } as const;
	return view.phases.map((phase) => `[${glyph[phase.state]} ${phase.title}]`).join("─");
}

export function headerText(view: RunView, hasNested: boolean, title?: string): string {
	const bits = [`◆ ${title ?? "MONITOR"} ${viewName(view)}`, view.runId, view.status, fmtSecs(view.elapsedMs)];
	if (view.source === "pi-dynamic-workflows") bits.push("pi-dynamic-workflows");
	if (hasNested) bits.push("nested sub-rows: one level");
	return bits.join(" · ");
}

export function renderFrame(view: RunView, opts: FrameOptions): string[] {
	const paint = opts.color ?? identity;
	const width = Math.max(1, Math.floor(opts.width));
	const height = Math.max(1, Math.floor(opts.height));
	const hasNested = view.rows.some((row) => row.depth === 1);
	const head: Array<[string, string]> = [];
	const header = headerText(view, hasNested, opts.title);
	const joined = `${header} · ${view.totals}`;
	if ([...joined].length <= width) head.push([joined, HEADER_COLOR]);
	else {
		head.push([header, HEADER_COLOR]);
		head.push([view.totals, HEADER_COLOR]);
	}
	if ((opts.showRail ?? true) && view.phases.length) head.push([railText(view), RAIL_COLOR]);
	const top = view.rows.filter((row) => row.depth === 0).length;
	const available = Math.max(0, height - head.length - 1);
	const rows = view.rows;
	let offset = Math.max(0, Math.floor(opts.offset ?? 0));
	if (rows.length > available) offset = Math.min(offset, Math.max(0, rows.length - available));
	else offset = 0;
	const window = available > 0 ? rows.slice(offset, offset + available) : [];
	const footerBits = [`verified ${view.verified.verified}/${top}`];
	if (rows.length > available) footerBits.push(`rows ${window.length ? offset + 1 : 0}–${offset + window.length} of ${rows.length}`);
	footerBits.push("↑↓ scroll", "q close");
	const lines: string[] = [];
	for (const [text, hex] of head) lines.push(paint(hex, fit(text, width)));
	for (const row of window) lines.push(paint(colorOf(row.state), fit(rowText(row, opts.tick), width)));
	lines.push(paint(FOOTER_COLOR, fit(footerBits.join(" · "), width)));
	return lines.slice(0, height);
}

/** `◫ MONITOR | proto-analytics-dashboard · running · 2/5 agents working · verified 1/5` */
export function renderBarRow(view: RunView | undefined): string {
	if (!view) return "◫ MONITOR | no run";
	const { working, total } = workingCount(view);
	return `◫ MONITOR | ${viewName(view)} · ${view.status} · ${working}/${total} agents working · verified ${view.verified.verified}/${total}`;
}

const LIST_COLUMNS: Array<[string, number]> = [
	["name", 26],
	["phase", 14],
	["roster", 26],
	["progress", 9],
	["result", 26],
];

/** The runs table, Grok CLI `/workflow runs` style: name · phase · roster · progress · result. */
export function renderList(views: RunView[], width: number): string[] {
	const cell = (text: string, size: number): string => fit(text, size).padEnd(size);
	const lines = [LIST_COLUMNS.map(([name, size]) => cell(name, size)).join(" · ")];
	for (const view of views) {
		const top = view.rows.filter((row) => row.depth === 0);
		const settled = top.filter((row) => row.state === "done-verified" || row.state === "done-unverified" || ["failed", "cancelled", "stalemate", "failed-review", "watchdog-failed"].includes(String(row.state))).length;
		const callsigns = [...new Set(top.map((row) => row.callsign))];
		const roster = callsigns.length > 3 ? `${callsigns.slice(0, 3).join(", ")} +${callsigns.length - 3}` : callsigns.join(", ") || "—";
		const phase = view.phases.find((p) => p.state === "active")?.title ?? (view.phases.length && view.phases.every((p) => p.state === "done") ? "done" : "—");
		const name = view.source === "pi-dynamic-workflows" ? `${viewName(view)} (pi-dw)` : viewName(view);
		const result = top.length ? `${view.status} · verified ${view.verified.verified}/${top.length}` : view.status;
		lines.push([cell(name, LIST_COLUMNS[0][1]), cell(phase, LIST_COLUMNS[1][1]), cell(roster, LIST_COLUMNS[2][1]), cell(`${settled}/${top.length}`, LIST_COLUMNS[3][1]), cell(result, LIST_COLUMNS[4][1])].join(" · "));
	}
	return lines.map((line) => fit(line.trimEnd(), width));
}
