/**
 * watchdog-limits.test.ts — plan §5.9 item 5: titan mirrors pi-subagents 0.67.0's watchdog
 * bounds, and this test pins them against the installed package's source so a future
 * bump (or a drifted LIMITS table) is noticed. Skips with a message when the package is
 * not installed where Pi keeps it.
 */
import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { LIMITS } from "../modules/watchdog/state.ts";

const PKG = join(homedir(), ".pi", "agent", "npm", "node_modules", "pi-subagents");
const PINNED = "0.67.0";
const installed = existsSync(join(PKG, "package.json"));

describe("pi-subagents watchdog limits (pinned 0.67.0)", () => {
	test("titan's LIMITS table is the plan's §5.9 numbers", () => {
		expect(LIMITS).toEqual({ stalemateRepeats: 3, maxReviewInputChars: 24_000, cadenceMinTools: 5, reviewTimeoutMs: 30_000, compactionInspectorTimeoutMs: 20_000, watchdogMdMaxChars: 8_000 });
	});

	test.skipIf(!installed)(`the installed package is ${PINNED} and its literals match LIMITS`, () => {
		const pkg = JSON.parse(readFileSync(join(PKG, "package.json"), "utf8")) as { version: string };
		expect(pkg.version).toBe(PINNED);
		const settings = readFileSync(join(PKG, "src", "watchdog", "settings.ts"), "utf8");
		expect(settings).toMatch(new RegExp(`stalemateRepeats:\\s*${LIMITS.stalemateRepeats}\\b`));
		expect(settings).toMatch(/agentEndTimeoutMs:\s*30_?000\b/);
		expect(settings).toMatch(/candidate >= 5/); // cadence.everyNTools minimum
		const runtime = readFileSync(join(PKG, "src", "watchdog", "runtime.ts"), "utf8");
		expect(runtime).toMatch(/MAX_REVIEW_INPUT_CHARS = 24_?000\b/);
		const guidance = readFileSync(join(PKG, "src", "watchdog", "guidance.ts"), "utf8");
		expect(guidance).toMatch(/WATCHDOG_GUIDANCE_MAX_CHARS = 8_?000\b/);
		// No exported watchdog API and no session_before_compact handling upstream — titan owns both (D3).
		const exportsField = JSON.parse(readFileSync(join(PKG, "package.json"), "utf8")).exports ?? {};
		expect(Object.keys(exportsField).some((k) => /watchdog/i.test(k))).toBe(false);
		const registerMain = readFileSync(join(PKG, "src", "watchdog", "register-main.ts"), "utf8");
		expect(registerMain.includes("session_before_compact")).toBe(false);
		expect(registerMain.includes("session_compact")).toBe(true);
	});

	test.skipIf(installed)("pi-subagents is not installed under ~/.pi/agent/npm — upstream literals not checked on this machine", () => {
		expect(installed).toBe(false);
	});
});
