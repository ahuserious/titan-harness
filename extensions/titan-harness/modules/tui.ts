/**
 * tui.ts — the little the harness still draws (titan-harness edit).
 *
 * The layout primitives (TwoCol, AgentGrid, FullWidth), the live streaming columns,
 * and the transcript panel renderer are gone: results are plain markdown messages and
 * live progress is a status line. What remains is the label/cell text used by the
 * belowEditor MODEL BAR: one role-colored cell per slot plus the FAN-OUT row.
 */

import type { ModelSlot } from "./model-stack.ts";
import { fgHex, fmtSecs, ROLE_COLOR, ROLE_GLYPH, shortModel, thinkingTag, type AgentStat, type Role } from "./runtime.ts";

/** `◆ ARCHITECT | name | model` — the role-colored label that opens every cell. */
export const roleLabelStr = (theme: any, role: Role, model: string, bold = true, sep = " | ", slot?: ModelSlot) => {
	const roleName = slot ? (slot.architect ? "ARCHITECT" : "BUILDER") : role;
	const label = `${ROLE_GLYPH[role]} ${roleName}${slot ? ` | ${slot.name}` : ""}`;
	if (slot) return fgHex(slot.color, bold ? theme.bold(label) : label) + theme.fg("dim", sep) + fgHex(slot.color, shortModel(model));
	return theme.fg(ROLE_COLOR[role], bold ? theme.bold(label) : label) + theme.fg("dim", sep) + theme.fg(ROLE_COLOR[role], shortModel(model));
};

export const statLabelStr = (theme: any, stat: AgentStat): string => {
	if (!stat.color || !stat.slotName) return roleLabelStr(theme, stat.role, stat.model);
	const roleName = stat.architect ? "ARCHITECT" : "BUILDER";
	return fgHex(stat.color, theme.bold(`${ROLE_GLYPH[stat.role]} ${roleName} | ${stat.slotName}`)) + theme.fg("dim", " | ") + fgHex(stat.color, shortModel(stat.model));
};

/**
 * One model-bar cell: `◆ ARCHITECT | model (med) | [██--------] 12% | 87 tps | $0.0123`.
 * Every content segment carries the role's own color; only the `|` separators are
 * theme-dim, so a cell reads as one colored line and the role stays identifiable.
 */
export const cellStr = (theme: any, role: Role, model: string, thinking: string | undefined, barStr: string, slot?: ModelSlot, perfStr?: string): string => {
	const sep = theme.fg("dim", " | ");
	if (slot) return roleLabelStr(theme, role, model, false, " | ", slot) + fgHex(slot.color, thinkingTag(thinking)) + sep + fgHex(slot.color, barStr) + (perfStr ? sep + fgHex(slot.color, perfStr) : "");
	return roleLabelStr(theme, role, model, false, " | ") + theme.fg(ROLE_COLOR[role], thinkingTag(thinking)) + sep + theme.fg(ROLE_COLOR[role], barStr) + (perfStr ? sep + theme.fg(ROLE_COLOR[role], perfStr) : "");
};

export interface FanOutSnapshot {
	running: number; // children streaming right now
	total: number; // children the current command spawned
	stackSize: number; // configured slots
	command?: string; // the /titan-* command in flight, if any
	elapsedMs: number;
}

/**
 * The FAN-OUT row: `⇶ FAN-OUT | 2 running / 3 spawned | stack 3 | /titan-opinion 14s`.
 * Idle: `⇶ FAN-OUT | idle | stack 3`. Accent-colored while something runs, dim when idle.
 */
export const fanOutCellStr = (theme: any, snap: FanOutSnapshot): string => {
	const sep = theme.fg("dim", " | ");
	const color = snap.running > 0 ? "accent" : "dim";
	const head = theme.fg(color, theme.bold("⇶ FAN-OUT"));
	const state = snap.command ? `${snap.running} running / ${snap.total} spawned` : "idle";
	const bits = [theme.fg(color, state), theme.fg(color, `stack ${snap.stackSize}`)];
	if (snap.command) bits.push(theme.fg(color, `/${snap.command} ${fmtSecs(snap.elapsedMs)}`));
	return head + sep + bits.join(sep);
};

export interface SubagentSnapshot {
	model: string; // provider/id pi-subagents uses by default
	thinking: string;
	registered: boolean; // model id exists in Pi's catalog
	authed: boolean | undefined; // provider has configured auth (undefined when unknown)
	childMode: string; // all | builders | off — which harness children carry the subagent tool
}

/**
 * The SUBAGENT row: `⇢ SUBAGENT | qwen-3.8-27b (hi) | cerebras ✓ | children: all`.
 * Warning-colored when the provider is not authed (the default is Cerebras, which
 * needs /login cerebras), dim when the model id is not even in the catalog.
 */
export const subagentCellStr = (theme: any, s: SubagentSnapshot): string => {
	const sep = theme.fg("dim", " | ");
	const slash = s.model.indexOf("/");
	const provider = slash > 0 ? s.model.slice(0, slash) : "?";
	const id = slash > 0 ? s.model.slice(slash + 1) : s.model;
	const color = !s.registered ? "dim" : s.authed === false ? "warning" : "success";
	const auth = !s.registered ? "not in catalog" : s.authed === false ? `${provider} ✗ /login ${provider}` : `${provider} ✓`;
	return theme.fg(color, theme.bold("⇢ SUBAGENT")) + sep + theme.fg(color, `${id}${thinkingTag(s.thinking)}`) + sep + theme.fg(color, auth) + sep + theme.fg(color, `children: ${s.childMode}`);
};

export interface ExaSnapshot {
	installed: boolean; // pi-exa registered at least one tool
	active: number; // exa tools active in the host session
	total: number; // exa tools registered
	children: boolean; // harness children get the exa tools
}

/** The EXA row: `⌕ EXA | live · 4/4 tools | children: on` (success), or a dim "not installed". */
export const exaCellStr = (theme: any, e: ExaSnapshot): string => {
	const sep = theme.fg("dim", " | ");
	if (!e.installed) return theme.fg("dim", theme.bold("⌕ EXA")) + sep + theme.fg("dim", "not installed (pi install npm:pi-exa)");
	const color = e.active > 0 ? "success" : "warning";
	const state = e.active > 0 ? `live · ${e.active}/${e.total} tools` : `registered, inactive (${e.total} tools) · /exa-enable`;
	return theme.fg(color, theme.bold("⌕ EXA")) + sep + theme.fg(color, state) + sep + theme.fg(color, `children: ${e.children ? "on" : "off"}`);
};

export interface AuditorSnapshot {
	name: string; // auditor callsign
	forName: string; // the builder it audits
	model: string;
	thinking: string;
	authed: boolean | undefined;
	state: string; // idle | reviewing | last verdict
	color: HexColorLike;
}
type HexColorLike = `#${string}`;

/** The AUDITOR row: `⚖ AUDITOR | ward · audits forge | claude-opus-4-6 (hi) | idle`. Amber when the provider is not authed. */
export const auditorCellStr = (theme: any, a: AuditorSnapshot): string => {
	const sep = theme.fg("dim", " | ");
	const paint = (text: string) => (a.authed === false ? theme.fg("warning", text) : fgHex(a.color, text));
	return paint(theme.bold(`${ROLE_GLYPH.AUDITOR} AUDITOR`)) + sep + paint(`${a.name} · audits ${a.forName}`) + sep + paint(`${shortModel(a.model)}${thinkingTag(a.thinking)}`) + sep + paint(a.authed === false ? `not authed · /login ${a.model.split("/")[0]}` : a.state);
};

/** The Σ TOTALS row: `Σ TOTALS | 1.24M tok · $3.87 · 41 tps/agent · verified 86 % (12/14) | L3 engineering`. Accent when a run is live, dim when idle. */
export const totalsCellStr = (theme: any, totals: string, live: boolean, suffix?: string): string => {
	const sep = theme.fg("dim", " | ");
	const color = live ? "accent" : "dim";
	const bits = [theme.fg(color, totals || "no runs yet")];
	if (suffix) bits.push(theme.fg(color, suffix));
	return theme.fg(color, theme.bold("Σ TOTALS")) + sep + bits.join(sep);
};

export interface LevelSnapshot {
	level: number | null; // null = shape-driven (no level active)
	label: string; // "engineering", "ultrafast", … or the shape codename
	fanout: { builders: number; workers: number; watchdogs: number; verifiers: number; exa: number };
	planCommand?: string; // "/ultraplan" at level 3
	terraformMissing?: boolean; // level 3 without a terraform pack
	shiftTab: boolean; // shift+tab bound to level cycling (after the rebind)
}

/** The LEVEL row: `⟁ LEVEL | L3 engineering | b3 w5 wd5 v5 exa10 | plan → /ultraplan | shift+tab · alt+l`. Warning when terraform is missing at level 3. */
export const levelCellStr = (theme: any, s: LevelSnapshot): string => {
	const sep = theme.fg("dim", " | ");
	const color = s.terraformMissing ? "warning" : "accent";
	const c = (t: string) => theme.fg(color, t);
	const f = s.fanout;
	const bits = [c(s.level == null ? `shape ${s.label}` : `L${s.level} ${s.label}`), c(`b${f.builders} w${f.workers} wd${f.watchdogs} v${f.verifiers} exa${f.exa}`)];
	if (s.planCommand) bits.push(c(`plan → ${s.planCommand}`));
	if (s.terraformMissing) bits.push(c("run /terraform"));
	bits.push(c(s.shiftTab ? "shift+tab · alt+l" : "alt+l · /titan-level"));
	return c(theme.bold("⟁ LEVEL")) + sep + bits.join(sep);
};

export interface ShapeSnapshot {
	shape: string;
	builders: number;
	subagentCap: number;
	auditor: boolean;
	anonymize: boolean;
}

/** The SHAPE row: `⬡ SHAPE | astra-gemini | builders 2 | subagents ≤4 | auditor on | callsigns only`. */
export const shapeCellStr = (theme: any, s: ShapeSnapshot): string => {
	const sep = theme.fg("dim", " | ");
	const c = (t: string) => theme.fg("accent", t);
	return c(theme.bold("⬡ SHAPE")) + sep + c(s.shape) + sep + c(`builders ${s.builders}`) + sep + c(s.subagentCap > 0 ? `subagents ≤${s.subagentCap}` : "subagents off") + sep + c(`auditor ${s.auditor ? "on" : "off"}`) + sep + c(s.anonymize ? "callsigns only" : "models visible");
};

// ── ⌗ WATCHDOG and ◫ MONITOR rows (plan §5.5, D4) ──
export interface WatchdogCell {
	enabled: boolean;
	state: string;
	model: string;
	inspections: number;
	spendUsd: number;
	findings: number;
	stalemate: string; // "0/3"
	onCompaction: string;
}

/** `⌗ WATCHDOG | armed · qwen-3.8-27b · halt-inspect · 2 inspections · $0.0100 · findings 1 · stalemate 0/3` */
export function watchdogCellStr(theme: any, w: WatchdogCell): string {
	const color = w.enabled ? (w.state === "halted-stalemate" || w.state === "failed" ? "#DC2626" : w.state === "inspecting" ? "#6366F1" : "#0D9488") : "#6B7280";
	const sep = theme.fg("dim", " · ");
	const label = fgHex(color, theme.bold("⌗ WATCHDOG")) + theme.fg("dim", " | ");
	if (!w.enabled) return label + fgHex(color, "off") + sep + theme.fg("dim", "/titan-watchdog on");
	return (
		label +
		fgHex(color, w.state) +
		sep +
		fgHex(color, shortModel(w.model)) +
		sep +
		fgHex(color, w.onCompaction) +
		sep +
		fgHex(color, `${w.inspections} inspection${w.inspections === 1 ? "" : "s"}`) +
		sep +
		fgHex(color, `$${w.spendUsd.toFixed(4)}`) +
		sep +
		fgHex(color, `findings ${w.findings}`) +
		sep +
		fgHex(color, `stalemate ${w.stalemate}`)
	);
}

/** `◫ MONITOR | smoke-two · running · 1/2 agents working · verified 0/2 · /workflow-monitor` (text from modules/monitor renderBarRow). */
export function monitorCellStr(theme: any, barRow: string, live: boolean): string {
	const color = live ? "#2563EB" : "#64748B";
	const body = barRow.replace(/^◫ MONITOR \| /, "");
	return fgHex(color, theme.bold("◫ MONITOR")) + theme.fg("dim", " | ") + fgHex(color, body) + theme.fg("dim", " · /workflow-monitor");
}
