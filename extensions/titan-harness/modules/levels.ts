/**
 * levels.ts — harness levels 0-3 as shape files (plan §4, D6, D8).
 *
 * A level is a schema-v2 shape file `model-stack-level-<n>.yaml` in ~/.pi/titan-harness.
 * Applying one writes the level, the shape codename and the per-lane pool sizes to
 * titan-harness.json — nothing else. Pure: files and the settings store only, no pi APIs.
 * The lead's /titan-level wires announce(), the model bar, the shape-changed hook and the
 * mirrored concurrency files (pi-subagents, dynamic-workflows) around these helpers.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { loadModelStack, printedFanout, type ModelStack } from "./model-stack.ts";
import {
	LEVEL_CYCLE,
	readStackSettings,
	STACK_DIR,
	STACK_SETTINGS_PATH,
	WATCHDOG_ON_COMPACTION_MODES,
	writeStackSettings,
	type StackSettings,
	type StackSettingsPatch,
	type WatchdogOnCompaction,
} from "./stack-config.ts";

/** Shape codenames of the four levels (model-stack-<codename>.yaml). */
export const LEVEL_CODENAMES = ["level-0", "level-1", "level-2", "level-3"];

export const levelCodename = (level: number): string => `level-${level}`;

/** Path of a level's shape file. */
export function levelShapePath(level: number, dir: string = STACK_DIR): string {
	return path.join(dir, `model-stack-${levelCodename(level)}.yaml`);
}

/** Levels whose shape file exists, ascending. */
export function listLevels(dir: string = STACK_DIR): number[] {
	return LEVEL_CYCLE.filter((level) => {
		try {
			return fs.statSync(levelShapePath(level, dir)).isFile();
		} catch {
			return false;
		}
	});
}

/** Load a level's shape and check it really is that level. */
export function loadLevelStack(level: number, dir: string = STACK_DIR): ModelStack {
	const stack = loadModelStack(levelShapePath(level, dir));
	if (stack.version !== 2) throw new Error(`titan-harness: ${stack.configPath} is a v1 shape; a level file needs version: 2`);
	if (stack.level !== undefined && stack.level !== level) throw new Error(`titan-harness: ${stack.configPath} declares level ${stack.level}, not ${level}`);
	return stack;
}

/** The level after `current` among `available` (wraps; unknown or no current → the lowest available). */
export function nextLevel(current: number | null | undefined, available: number[]): number {
	const sorted = [...new Set(available)].filter((level) => Number.isInteger(level)).sort((a, b) => a - b);
	if (!sorted.length) throw new Error(`titan-harness: no level shape files found (model-stack-level-<n>.yaml); copy them from the package's .pi/titan-harness/ into ${STACK_DIR}`);
	if (current === undefined || current === null) return sorted[0];
	return sorted.find((level) => level > current) ?? sorted[0];
}

export interface LevelFanout {
	builders: number;
	workers: number;
	watchdogs: number;
	verifiers: number;
	exa: number;
}

/** printedFanout, with the exa count taken from `exa.fanout` when the shape has no exa lane. */
export function fanoutForStack(stack: ModelStack): LevelFanout {
	const fan = printedFanout(stack);
	const exaLane = stack.lanes?.exa ?? [];
	return { ...fan, exa: exaLane.length ? fan.exa : (stack.exa?.fanout ?? 0) };
}

const clamp = (value: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, Math.round(value)));

/**
 * Persist a level: harnessLevel, shape (= the stack's codename), the five pool sizes
 * (builderFanOut 1-8, the rest 0-16), childExa from `exa.enabled`, auditor forced on when
 * `verification.review` is required (otherwise left alone), and watchdog.enabled (plus
 * watchdog.onCompaction when the shape names one) from the shape's `watchdog` block.
 * Never touches the pi-subagents or dynamic-workflows files. Returns the new settings.
 */
export function applyLevel(level: number, stack: ModelStack, settingsPath: string = STACK_SETTINGS_PATH): StackSettings {
	if (!LEVEL_CYCLE.includes(level)) throw new Error(`titan-harness: level must be one of ${LEVEL_CYCLE.join(", ")}; found ${String(level)}`);
	if (stack.level !== undefined && stack.level !== level) throw new Error(`titan-harness: shape ${stack.codename} declares level ${stack.level}, not ${level}`);
	const current = readStackSettings(settingsPath);
	const fan = fanoutForStack(stack);
	const patch: StackSettingsPatch = {
		// Entering a level from a plain shape snapshots what the level overwrites (leaveLevel restores it).
		levelRestore:
			current.harnessLevel === null
				? {
						builderFanOut: current.builderFanOut,
						workerFanOut: current.workerFanOut,
						watchdogFanOut: current.watchdogFanOut,
						verifierFanOut: current.verifierFanOut,
						exaFanOut: current.exaFanOut,
						childExa: current.childExa,
						auditor: current.auditor,
						watchdogEnabled: current.watchdog.enabled,
					}
				: current.levelRestore,
		harnessLevel: level,
		shape: stack.codename,
		builderFanOut: clamp(fan.builders, 1, 8),
		workerFanOut: clamp(fan.workers, 0, 16),
		watchdogFanOut: clamp(fan.watchdogs, 0, 16),
		verifierFanOut: clamp(fan.verifiers, 0, 16),
		exaFanOut: clamp(fan.exa, 0, 16),
		childExa: stack.exa?.enabled ?? current.childExa,
	};
	if (stack.verification?.review === "required") patch.auditor = true;
	if (stack.watchdog) {
		patch.watchdog = { enabled: stack.watchdog.enabled };
		const mode = stack.watchdog.on_compaction;
		if (mode && (WATCHDOG_ON_COMPACTION_MODES as string[]).includes(mode)) patch.watchdog.onCompaction = mode as WatchdogOnCompaction;
	}
	return writeStackSettings(patch, settingsPath);
}

/**
 * Leave the active level for a plain shape: harnessLevel → null and the pool sizes,
 * childExa, auditor and watchdog.enabled go back to what they were before the first
 * level was applied (no snapshot → only the level is cleared). Returns the new settings.
 */
export function leaveLevel(shape: string, settingsPath: string = STACK_SETTINGS_PATH): StackSettings {
	const current = readStackSettings(settingsPath);
	const restore = current.levelRestore;
	const patch: StackSettingsPatch = { harnessLevel: null, shape, levelRestore: null };
	if (restore) {
		patch.builderFanOut = restore.builderFanOut;
		patch.workerFanOut = restore.workerFanOut;
		patch.watchdogFanOut = restore.watchdogFanOut;
		patch.verifierFanOut = restore.verifierFanOut;
		patch.exaFanOut = restore.exaFanOut;
		patch.childExa = restore.childExa;
		patch.auditor = restore.auditor;
		patch.watchdog = { enabled: restore.watchdogEnabled };
	}
	return writeStackSettings(patch, settingsPath);
}

/** "L3 engineering · builders 3 · workers 5 · watchdogs 5 · verifiers 5 · exa 10 · plan → /ultraplan" */
export function describeLevel(stack: ModelStack, settings: StackSettings): string {
	const level = stack.level ?? settings.harnessLevel;
	const name = stack.label ?? stack.codename;
	const fan = fanoutForStack(stack);
	const parts = [
		level === null || level === undefined ? name : `L${level} ${name}`,
		`builders ${fan.builders}`,
		`workers ${fan.workers}`,
		`watchdogs ${fan.watchdogs}`,
		`verifiers ${fan.verifiers}`,
		`exa ${fan.exa}`,
	];
	if (stack.plan_command) parts.push(`plan → ${stack.plan_command}`);
	return parts.join(" · ");
}
