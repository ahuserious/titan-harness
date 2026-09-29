/**
 * budget.ts — runner-side budget enforcement for workflow runs (LANE-3 N3-09, a K1 hand-port;
 * semantics only, nothing imported from k-dense or the N3-04 meter).
 *
 * Money is integer micro-USD, tokens are integer tokens: no float ever reaches a comparison.
 * Scopes form a tree: the workflow scope (titan.budget) holds one scope per node
 * (node.budget); a nested workflow's scope hangs under the parent's `workflow:` node scope, so
 * every ancestor's remainder applies to a child run whatever the child declares.
 *
 *   reserve(scope, amount)   synchronous, so atomic on the event loop: checks every scope from
 *                            `scope` to the root, in each limited dimension, against
 *                            spent + reserved + amount ≤ limit. Ok → the reservation counts as
 *                            reserved in every scope of the chain. Refused → the first failing
 *                            scope, its dimension, remaining and needed; `transient` when the
 *                            refusal would clear once in-flight reservations settle (the caller
 *                            may wait: waitForSettlement), else hard (the caller must fail).
 *   settle(reservation, actual)
 *                            releases the reservation and charges the actual usage. A dimension
 *                            the child did not report (undefined / non-finite) is charged at the
 *                            full reservation, never zero. Actual above the reservation is
 *                            charged in full and reported as an overrun. Idempotent.
 *   waitForSettlement(scope, signal)
 *                            resolves at the next settle anywhere under the scope's root; rejects
 *                            with an AbortError when `signal` fires.
 *
 * A scope chain with no limit anywhere is not enforced (`enforced()` false): the executor then
 * skips reservations entirely and behaves exactly as before budgets existed.
 */

export type BudgetDimension = "usd" | "tokens";

export interface BudgetAmount {
	usdMicros: number;
	tokens: number;
}

export interface BudgetLimit {
	usdMicros?: number;
	tokens?: number;
}

/** A declared budget as written in YAML (`titan.budget` / node `budget`). */
export interface DeclaredBudget {
	usd?: number;
	tokens?: number;
	per_call_usd?: number;
	per_call_tokens?: number;
}

/** Worst case per agent call when neither the node nor titan.budget names one: one full agentic child session. */
export const DEFAULT_PER_CALL_USD = 5;
export const DEFAULT_PER_CALL_TOKENS = 2_000_000;

const MICROS = 1_000_000;

const finite = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);

/** USD → micro-USD, rounded up (charges and reservations never round in the spender's favour). */
export function usdToMicrosCeil(usd: number): number {
	return Math.max(0, Math.ceil(Math.round(usd * 1e9) / 1e3));
}

/** USD → micro-USD, rounded down (limits never round in the spender's favour). */
export function usdToMicrosFloor(usd: number): number {
	return Math.max(0, Math.floor(Math.round(usd * 1e9) / 1e3));
}

export const tokensInt = (tokens: number): number => Math.max(0, Math.ceil(tokens));

export function formatUsdMicros(micros: number): string {
	const sign = micros < 0 ? "-" : "";
	const abs = Math.abs(micros);
	const whole = Math.floor(abs / MICROS);
	const frac = String(abs % MICROS).padStart(6, "0").replace(/0+$/, "");
	return `${sign}$${whole}${frac ? `.${frac}` : ""}`;
}

export function formatAmount(dimension: BudgetDimension, value: number): string {
	return dimension === "usd" ? formatUsdMicros(value) : `${value} tokens`;
}

/** The limits a declared budget sets (usd/tokens); undefined when it declares neither. */
export function limitFrom(budget: DeclaredBudget | undefined): BudgetLimit {
	const limit: BudgetLimit = {};
	if (budget && finite(budget.usd) && budget.usd >= 0) limit.usdMicros = usdToMicrosFloor(budget.usd);
	if (budget && finite(budget.tokens) && budget.tokens >= 0) limit.tokens = Math.floor(budget.tokens);
	return limit;
}

/**
 * The worst case one agent call may cost: the node's per-call cap, else the workflow's
 * (titan.budget.per_call_*), else the defaults; never more than the node's own total budget.
 * The defaults are deliberately not clamped to a workflow total: an undeclared worst case is
 * one full child session, and a budget smaller than that must say what one call may cost.
 */
export function perCallCap(node: DeclaredBudget | undefined, workflow: DeclaredBudget | undefined): BudgetAmount {
	const usd = [node?.per_call_usd, workflow?.per_call_usd].find((v) => finite(v) && v >= 0) ?? DEFAULT_PER_CALL_USD;
	const tokens = [node?.per_call_tokens, workflow?.per_call_tokens].find((v) => finite(v) && v >= 0) ?? DEFAULT_PER_CALL_TOKENS;
	let usdMicros = usdToMicrosCeil(usd);
	let tok = tokensInt(tokens);
	if (node && finite(node.usd) && node.usd >= 0) usdMicros = Math.min(usdMicros, usdToMicrosFloor(node.usd));
	if (node && finite(node.tokens) && node.tokens >= 0) tok = Math.min(tok, Math.floor(node.tokens));
	return { usdMicros, tokens: tok };
}

// ═══ Scopes ══════════════════════════════════════════════════════════════════

interface Root {
	waiters: Array<() => void>;
	nextReservation: number;
}

export class BudgetScope {
	readonly spent: BudgetAmount = { usdMicros: 0, tokens: 0 };
	readonly reserved: BudgetAmount = { usdMicros: 0, tokens: 0 };
	/** Charges above their reservation, summed (already included in `spent`). */
	readonly overrun: BudgetAmount = { usdMicros: 0, tokens: 0 };
	private readonly root: Root;

	constructor(
		readonly label: string,
		readonly limit: BudgetLimit = {},
		readonly parent?: BudgetScope,
	) {
		this.root = parent ? parent.root : { waiters: [], nextReservation: 0 };
	}

	child(label: string, limit: BudgetLimit = {}): BudgetScope {
		return new BudgetScope(label, limit, this);
	}

	/** This scope and every ancestor, leaf first. */
	chain(): BudgetScope[] {
		const out: BudgetScope[] = [];
		for (let s: BudgetScope | undefined = this; s; s = s.parent) out.push(s);
		return out;
	}

	/** True when any scope of the chain declares a limit. */
	enforced(): boolean {
		return this.chain().some((s) => s.limit.usdMicros !== undefined || s.limit.tokens !== undefined);
	}

	/** limit − spent − reserved in `dimension`; undefined when this scope has no limit there. */
	remaining(dimension: BudgetDimension): number | undefined {
		const limit = dimension === "usd" ? this.limit.usdMicros : this.limit.tokens;
		if (limit === undefined) return undefined;
		return limit - this.used(dimension) - (dimension === "usd" ? this.reserved.usdMicros : this.reserved.tokens);
	}

	used(dimension: BudgetDimension): number {
		return dimension === "usd" ? this.spent.usdMicros : this.spent.tokens;
	}

	/** @internal */
	_root(): Root {
		return this.root;
	}
}

export interface BudgetReservation {
	id: string;
	scope: BudgetScope;
	amount: BudgetAmount;
	settled?: BudgetSettlement;
}

export interface BudgetRefusal {
	scope: string;
	dimension: BudgetDimension;
	limit: number;
	remaining: number;
	needed: number;
	/** True when the refusal clears if in-flight reservations settle (spent + needed ≤ limit). */
	transient: boolean;
}

export type ReserveResult = { ok: true; reservation: BudgetReservation } | { ok: false; refusal: BudgetRefusal };

export function reserve(scope: BudgetScope, amount: BudgetAmount, idPrefix = "res"): ReserveResult {
	const need: BudgetAmount = { usdMicros: Math.max(0, Math.ceil(amount.usdMicros)), tokens: tokensInt(amount.tokens) };
	let firstHard: BudgetRefusal | undefined;
	let firstTransient: BudgetRefusal | undefined;
	for (const s of scope.chain()) {
		for (const dimension of ["usd", "tokens"] as const) {
			const limit = dimension === "usd" ? s.limit.usdMicros : s.limit.tokens;
			if (limit === undefined) continue;
			const needed = dimension === "usd" ? need.usdMicros : need.tokens;
			const remaining = s.remaining(dimension)!;
			if (needed <= remaining) continue;
			const transient = s.used(dimension) + needed <= limit;
			const refusal: BudgetRefusal = { scope: s.label, dimension, limit, remaining: Math.max(0, remaining), needed, transient };
			if (transient) firstTransient ??= refusal;
			else firstHard ??= refusal;
		}
	}
	const refusal = firstHard ?? firstTransient;
	if (refusal) return { ok: false, refusal };
	for (const s of scope.chain()) {
		s.reserved.usdMicros += need.usdMicros;
		s.reserved.tokens += need.tokens;
	}
	const root = scope._root();
	root.nextReservation++;
	return { ok: true, reservation: { id: `${idPrefix}-${root.nextReservation}`, scope, amount: need } };
}

export interface BudgetActual {
	usd?: number;
	tokens?: number;
}

export interface BudgetSettlement {
	reservationId: string;
	reserved: BudgetAmount;
	charged: BudgetAmount;
	/** Per dimension: "reported" = the child's usage, "reservation" = unknown, charged at the full reservation. */
	basis: { usd: "reported" | "reservation"; tokens: "reported" | "reservation" };
	overrun?: BudgetAmount;
}

export function settle(reservation: BudgetReservation, actual?: BudgetActual): BudgetSettlement {
	if (reservation.settled) return reservation.settled;
	const usdKnown = finite(actual?.usd) && actual!.usd! >= 0;
	const tokensKnown = finite(actual?.tokens) && actual!.tokens! >= 0;
	const charged: BudgetAmount = {
		usdMicros: usdKnown ? usdToMicrosCeil(actual!.usd!) : reservation.amount.usdMicros,
		tokens: tokensKnown ? tokensInt(actual!.tokens!) : reservation.amount.tokens,
	};
	const over: BudgetAmount = { usdMicros: Math.max(0, charged.usdMicros - reservation.amount.usdMicros), tokens: Math.max(0, charged.tokens - reservation.amount.tokens) };
	for (const s of reservation.scope.chain()) {
		s.reserved.usdMicros -= reservation.amount.usdMicros;
		s.reserved.tokens -= reservation.amount.tokens;
		s.spent.usdMicros += charged.usdMicros;
		s.spent.tokens += charged.tokens;
		s.overrun.usdMicros += over.usdMicros;
		s.overrun.tokens += over.tokens;
	}
	const settlement: BudgetSettlement = {
		reservationId: reservation.id,
		reserved: { ...reservation.amount },
		charged,
		basis: { usd: usdKnown ? "reported" : "reservation", tokens: tokensKnown ? "reported" : "reservation" },
	};
	if (over.usdMicros > 0 || over.tokens > 0) settlement.overrun = over;
	reservation.settled = settlement;
	const root = reservation.scope._root();
	const waiters = root.waiters.splice(0);
	for (const wake of waiters) wake();
	return settlement;
}

/** Resolve at the next settle under `scope`'s root; reject (name "AbortError") when `signal` fires. */
export function waitForSettlement(scope: BudgetScope, signal?: AbortSignal): Promise<void> {
	return new Promise<void>((resolve, reject) => {
		const abortError = () => {
			const error = new Error(signal?.reason instanceof Error ? signal.reason.message : typeof signal?.reason === "string" ? signal.reason : "aborted");
			error.name = "AbortError";
			return error;
		};
		if (signal?.aborted) {
			reject(abortError());
			return;
		}
		const root = scope._root();
		const onAbort = () => {
			const i = root.waiters.indexOf(wake);
			if (i >= 0) root.waiters.splice(i, 1);
			reject(abortError());
		};
		const wake = () => {
			signal?.removeEventListener("abort", onAbort);
			resolve();
		};
		root.waiters.push(wake);
		signal?.addEventListener("abort", onAbort, { once: true });
	});
}

/** The error a hard refusal raises before dispatch; the executor fails the node with retryable:false. */
export class BudgetExceededError extends Error {
	constructor(readonly refusal: BudgetRefusal) {
		super(`budget exceeded: ${refusal.scope} remaining ${formatAmount(refusal.dimension, refusal.remaining)}, needed ${formatAmount(refusal.dimension, refusal.needed)}`);
		this.name = "BudgetExceededError";
	}
}

export const isBudgetExceeded = (error: unknown): error is BudgetExceededError => error instanceof BudgetExceededError || (error instanceof Error && error.name === "BudgetExceededError");

/** A scope's totals for events: limit, spent, reserved, overrun. */
export function scopeSnapshot(scope: BudgetScope): Record<string, unknown> {
	return {
		scope: scope.label,
		limitUsdMicros: scope.limit.usdMicros,
		limitTokens: scope.limit.tokens,
		spentUsdMicros: scope.spent.usdMicros,
		spentTokens: scope.spent.tokens,
		reservedUsdMicros: scope.reserved.usdMicros,
		reservedTokens: scope.reserved.tokens,
		overrunUsdMicros: scope.overrun.usdMicros,
		overrunTokens: scope.overrun.tokens,
	};
}
