/**
 * tui.ts — the little the harness still draws (pi-fusion-stack edit).
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
	command?: string; // the /fh-* command in flight, if any
	elapsedMs: number;
}

/**
 * The FAN-OUT row: `⇶ FAN-OUT | 2 running / 3 spawned | stack 3 | /fh-opinion 14s`.
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
