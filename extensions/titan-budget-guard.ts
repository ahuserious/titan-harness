/**
 * titan-budget-guard.ts — the child-side per-turn spend bound for workflow budgets
 * (N3-09 repair 3). Active only in a titan child (TITAN_HARNESS_CHILD=1) that the parent
 * handed a budget (TITAN_BUDGET_USD_MICROS / TITAN_BUDGET_TOKENS, see modules/turn-budget.ts);
 * everywhere else it registers nothing.
 *
 * The parent (child-runner.ts runChild) passes this file with an explicit `--extension`, so a
 * budgeted child that cannot load it fails at startup (pi exits on an extension load error)
 * before any model call. It is deliberately NOT in package.json's extension list (a host never
 * needs it); a global flag still keeps an accidental second load from registering twice.
 *
 *   before_provider_request  bound the turn (turn-budget.ts planTurn): the payload's output cap
 *                            is clamped so input bound × input rate + cap × output rate fits the
 *                            remainder; when it cannot, the refusal is written to the state file
 *                            and the child exits with BUDGET_REFUSED_EXIT before the request is sent.
 *   message_end (assistant)  charge the turn's reported usage (its worst case when none/interrupted).
 *   session_before_compact   cancelled: summarisation calls do not pass through
 *                            before_provider_request, so they could not be bounded.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { BUDGET_REFUSED_EXIT, TurnBudgetGuard, turnBudgetFromEnv } from "./titan-harness/modules/turn-budget.ts";

const CHILD_ENV = "TITAN_HARNESS_CHILD";
const LOADED = Symbol.for("titan.budget-guard.loaded");

export interface BudgetGuardOptions {
	env?: Record<string, string | undefined>;
	/** Terminates the child after a refusal (process.exit in production; a stub in tests). */
	exit?: (code: number) => void;
	/** Skip the one-registration-per-process flag (tests create several guards). */
	allowReload?: boolean;
}

function writeState(statePath: string | undefined, state: Record<string, unknown>): void {
	if (!statePath) return;
	try {
		fs.mkdirSync(path.dirname(statePath), { recursive: true, mode: 0o700 });
		const tmp = `${statePath}.${process.pid}.tmp`;
		fs.writeFileSync(tmp, `${JSON.stringify(state)}\n`, { mode: 0o600 });
		fs.renameSync(tmp, statePath);
	} catch {
		/* the parent treats a missing/unreadable state file as an unguarded child */
	}
}

/** Returns the guard it registered (undefined when inactive), so tests can inspect it. */
export function registerBudgetGuard(pi: ExtensionAPI, options: BudgetGuardOptions = {}): TurnBudgetGuard | undefined {
	const env = options.env ?? process.env;
	if (env[CHILD_ENV] !== "1") return undefined;
	const config = turnBudgetFromEnv(env);
	if (!config.active) return undefined;
	const g = globalThis as Record<symbol, unknown>;
	if (!options.allowReload) {
		if (g[LOADED]) return undefined;
		g[LOADED] = true;
	}
	const exit = options.exit ?? ((code: number) => process.exit(code));
	const guard = new TurnBudgetGuard({ usdMicros: config.usdMicros, tokens: config.tokens });
	const refuse = (reason: string): undefined => {
		guard.refusal ??= { ok: false, reason };
		writeState(config.statePath, guard.snapshot("refused"));
		process.stderr.write(`titan-budget-guard: model turn refused: ${guard.refusal.reason}\n`);
		exit(BUDGET_REFUSED_EXIT);
		return undefined;
	};
	for (const problem of config.problems) process.stderr.write(`titan-budget-guard: ${problem}\n`);
	writeState(config.statePath, guard.snapshot("armed"));

	(pi as any).on("before_provider_request", (event: any, ctx: any) => {
		// Malformed budget env: nothing can be bounded, so every turn is refused.
		if (config.problems.length) return refuse(config.problems.join("; "));
		let model: unknown;
		try {
			model = ctx?.model;
		} catch {
			model = undefined;
		}
		// Pi swallows a handler exception and sends the original payload, so nothing here may throw: any failure refuses.
		try {
			const plan = guard.beforeRequest(model as any, event?.payload);
			if (!plan.ok) return refuse(plan.reason);
			writeState(config.statePath, guard.snapshot("turn"));
			return plan.payload;
		} catch (error) {
			return refuse(`the turn could not be bounded: ${error instanceof Error ? error.message : String(error)}`);
		}
	});
	(pi as any).on("message_end", (event: any) => {
		const message = event?.message;
		if (message?.role !== "assistant") return;
		try {
			guard.afterTurn(message.usage ?? undefined, message.stopReason);
			writeState(config.statePath, guard.snapshot("turn"));
		} catch {
			/* the next before_provider_request plans against the last known remainder */
		}
	});
	(pi as any).on("session_before_compact", () => ({ cancel: true }));
	return guard;
}

export default function (pi: ExtensionAPI) {
	registerBudgetGuard(pi);
}
