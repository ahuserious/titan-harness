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
