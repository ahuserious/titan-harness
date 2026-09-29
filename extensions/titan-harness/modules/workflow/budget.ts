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

/** A declared budget's per-call worst case (per_call_*), only the dimensions it names (> 0). */
export function perCallFrom(budget: DeclaredBudget | undefined): Partial<BudgetAmount> {
	const out: Partial<BudgetAmount> = {};
	if (budget && finite(budget.per_call_usd) && budget.per_call_usd > 0) out.usdMicros = usdToMicrosCeil(budget.per_call_usd);
	if (budget && finite(budget.per_call_tokens) && budget.per_call_tokens > 0) out.tokens = tokensInt(budget.per_call_tokens);
	return out;
}

// ═══ Scopes ══════════════════════════════════════════════════════════════════

interface Root {
	waiters: Array<() => void>;
	nextReservation: number;
}

export interface BudgetScopeOptions {
	/** "workflow" for a run's titan.budget scope, "node" for a node's (default). */
	kind?: "workflow" | "node";
	/** The per_call_* this scope's document declares (perCallFrom). Inherited by every scope below it. */
	perCall?: Partial<BudgetAmount>;
	/** Workflow scopes: titan.budget.allow_unmetered_runners. */
	allowUnmeteredRunners?: boolean;
}

export class BudgetScope {
	readonly spent: BudgetAmount = { usdMicros: 0, tokens: 0 };
	readonly reserved: BudgetAmount = { usdMicros: 0, tokens: 0 };
	/** Charges above their reservation, summed (already included in `spent`). */
	readonly overrun: BudgetAmount = { usdMicros: 0, tokens: 0 };
	private readonly root: Root;
	readonly kind: "workflow" | "node";
	readonly perCall: Partial<BudgetAmount>;
	readonly allowUnmeteredRunners: boolean;

	constructor(
		readonly label: string,
		readonly limit: BudgetLimit = {},
		readonly parent?: BudgetScope,
		options: BudgetScopeOptions = {},
	) {
		this.root = parent ? parent.root : { waiters: [], nextReservation: 0 };
		this.kind = options.kind ?? "node";
		this.perCall = { ...(options.perCall ?? {}) };
		this.allowUnmeteredRunners = options.allowUnmeteredRunners === true;
	}

	child(label: string, limit: BudgetLimit = {}, options: BudgetScopeOptions = {}): BudgetScope {
		return new BudgetScope(label, limit, this, options);
	}

	/**
	 * The per-call worst case this scope inherits: per dimension, the LARGEST per_call_* declared
	 * anywhere on the chain (so a child workflow or a node can never lower what its ancestors
	 * reserve per call), else the default.
	 */
	effectivePerCall(): BudgetAmount {
		let usd: number | undefined;
		let tokens: number | undefined;
		for (const s of this.chain()) {
			if (s.perCall.usdMicros !== undefined) usd = Math.max(usd ?? 0, s.perCall.usdMicros);
			if (s.perCall.tokens !== undefined) tokens = Math.max(tokens ?? 0, s.perCall.tokens);
		}
		return { usdMicros: usd ?? usdToMicrosCeil(DEFAULT_PER_CALL_USD), tokens: tokens ?? DEFAULT_PER_CALL_TOKENS };
	}

	/** True when any scope of the chain limits `dimension`. */
	limits(dimension: BudgetDimension): boolean {
		return this.chain().some((s) => (dimension === "usd" ? s.limit.usdMicros : s.limit.tokens) !== undefined);
	}

	/** The smallest limit − spent (reservations NOT subtracted) over the chain's limited scopes; undefined when none limits `dimension`. */
	unspent(dimension: BudgetDimension): number | undefined {
		let min: number | undefined;
		for (const s of this.chain()) {
			const limit = dimension === "usd" ? s.limit.usdMicros : s.limit.tokens;
			if (limit === undefined) continue;
			const left = limit - s.used(dimension);
			min = min === undefined ? left : Math.min(min, left);
		}
		return min;
	}

	/** The smallest limit − spent − reserved over the chain's limited scopes; undefined when none limits `dimension`. */
	chainRemaining(dimension: BudgetDimension): number | undefined {
		let min: number | undefined;
		for (const s of this.chain()) {
			const left = s.remaining(dimension);
			if (left === undefined) continue;
			min = min === undefined ? left : Math.min(min, left);
		}
		return min;
	}

	/**
	 * May a paid verify runner that spends outside the agent seam run here? Only when every
	 * workflow on the chain whose own scope or node scope (on this chain) carries a limit
	 * declares titan.budget.allow_unmetered_runners: true — a child can never opt its parent in.
	 */
	unmeteredRunnersAllowed(): boolean {
		let limitedBelow = false;
		for (const s of this.chain()) {
			const limited = s.limit.usdMicros !== undefined || s.limit.tokens !== undefined;
			if (s.kind === "node") {
				limitedBelow = limitedBelow || limited;
				continue;
			}
			if ((limited || limitedBelow) && !s.allowUnmeteredRunners) return false;
			limitedBelow = false;
		}
		return !limitedBelow;
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

/**
 * The reservation one agent call takes NOW (computed at reserve time, again after every wait):
 * per limited dimension, min(effectivePerCall, the chain's smallest limit − spent), floored at
 * 1 micro-USD / 1 token — never 0, so a zero or exhausted budget always refuses and a fan-out
 * can never over-commit on free reservations. With no per_call_* anywhere the default is
 * clamped the same way, so a node or workflow budget can be spent to its last micro across
 * retries, loop iterations and fan-out calls. A dimension no scope limits reserves the
 * effective per-call amount (it is tracked, never refused).
 */
export function reservationFor(scope: BudgetScope): BudgetAmount {
	const effective = scope.effectivePerCall();
	const out: BudgetAmount = { ...effective };
	for (const dimension of ["usd", "tokens"] as const) {
		const unspent = scope.unspent(dimension);
		if (unspent === undefined) continue;
		const key = dimension === "usd" ? "usdMicros" : "tokens";
		out[key] = Math.max(1, Math.min(effective[key], unspent));
	}
	return out;
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
	// A limited dimension never reserves 0, so remaining ≤ 0 always refuses (a zero or spent budget is fail-closed).
	const floor = (dimension: BudgetDimension, value: number): number => Math.max(scope.limits(dimension) ? 1 : 0, Math.ceil(finite(value) ? value : 0));
	const need: BudgetAmount = { usdMicros: floor("usd", amount.usdMicros), tokens: floor("tokens", amount.tokens) };
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

/**
 * Where a call's usage came from (the agent runner sets it on AgentResult.usage.provenance):
 *   complete        the child ran to its own exit and reported usage → charge what it reported
 *   partial         interrupted (aborted, timed out, pre-empted, budget-halted, thrown) after
 *                   reporting some usage: the turn in progress is unbilled → charge
 *                   max(reported, reservation) per dimension
 *   none            no usage is known (thrown / aborted before any usage event / exited
 *                   without reporting) → charge the full reservation
 *   not-dispatched  provably no child was started (no model, aborted while queued, a
 *                   held-spend refusal, a synchronous agent throw) → charge 0
 * Undefined provenance (a runner that predates it) is treated as "complete": its reported
 * numbers are charged and any dimension it did not report is charged at the reservation.
 */
export type UsageProvenance = "complete" | "partial" | "none" | "not-dispatched";

export interface BudgetActual {
	usd?: number;
	tokens?: number;
	provenance?: UsageProvenance;
}

export type SettlementBasis = "reported" | "reservation" | "partial" | "not-dispatched";

export interface BudgetSettlement {
	reservationId: string;
	reserved: BudgetAmount;
	charged: BudgetAmount;
	/**
	 * Per dimension: "reported" = the child's usage; "reservation" = unknown, charged at the full
	 * reservation; "partial" = max(reported, reservation) for an interrupted call;
	 * "not-dispatched" = no child ran, charged 0.
	 */
	basis: { usd: SettlementBasis; tokens: SettlementBasis };
	/** Tokens were reported but cost was 0 under a USD limit: the USD reservation was charged instead of $0. */
	costUnknown?: boolean;
	overrun?: BudgetAmount;
}

export function settle(reservation: BudgetReservation, actual?: BudgetActual): BudgetSettlement {
	if (reservation.settled) return reservation.settled;
	const provenance: UsageProvenance = actual?.provenance ?? "complete";
	const res = reservation.amount;
	const charged: BudgetAmount = { usdMicros: 0, tokens: 0 };
	const basis: BudgetSettlement["basis"] = { usd: "not-dispatched", tokens: "not-dispatched" };
	let costUnknown = false;
	if (provenance !== "not-dispatched") {
		const usdKnown = provenance !== "none" && finite(actual?.usd) && actual!.usd! >= 0;
		const tokensKnown = provenance !== "none" && finite(actual?.tokens) && actual!.tokens! >= 0;
		const observedUsd = usdKnown ? usdToMicrosCeil(actual!.usd!) : 0;
		const observedTokens = tokensKnown ? tokensInt(actual!.tokens!) : 0;
		const pick = (known: boolean, observed: number, reserved: number): [number, SettlementBasis] =>
			!known ? [reserved, "reservation"] : provenance === "partial" ? [Math.max(observed, reserved), "partial"] : [observed, "reported"];
		[charged.usdMicros, basis.usd] = pick(usdKnown, observedUsd, res.usdMicros);
		[charged.tokens, basis.tokens] = pick(tokensKnown, observedTokens, res.tokens);
		// Tokens but a $0 cost (subscription/OAuth or unpriced models) never settles a USD budget at $0.
		if (basis.usd === "reported" && charged.usdMicros === 0 && observedTokens > 0 && reservation.scope.limits("usd")) {
			charged.usdMicros = res.usdMicros;
			basis.usd = "reservation";
			costUnknown = true;
		}
	}
	const over: BudgetAmount = { usdMicros: Math.max(0, charged.usdMicros - res.usdMicros), tokens: Math.max(0, charged.tokens - res.tokens) };
	for (const s of reservation.scope.chain()) {
		s.reserved.usdMicros -= res.usdMicros;
		s.reserved.tokens -= res.tokens;
		s.spent.usdMicros += charged.usdMicros;
		s.spent.tokens += charged.tokens;
		s.overrun.usdMicros += over.usdMicros;
		s.overrun.tokens += over.tokens;
	}
	const settlement: BudgetSettlement = { reservationId: reservation.id, reserved: { ...res }, charged, basis };
	if (costUnknown) settlement.costUnknown = true;
	if (over.usdMicros > 0 || over.tokens > 0) settlement.overrun = over;
	reservation.settled = settlement;
	wakeWaiters(reservation.scope);
	return settlement;
}

function wakeWaiters(scope: BudgetScope): void {
	const waiters = scope._root().waiters.splice(0);
	for (const wake of waiters) wake();
}

/**
 * Charge spend that had no reservation (an opted-in unmetered verify runner's reported
 * externalCostUsd) to every scope of the chain. It can push a scope past its limit; later
 * reservations are then refused.
 */
export function chargeUnreserved(scope: BudgetScope, amount: BudgetAmount): void {
	const add = { usdMicros: Math.max(0, Math.ceil(amount.usdMicros)), tokens: Math.max(0, Math.ceil(amount.tokens)) };
	for (const s of scope.chain()) {
		s.spent.usdMicros += add.usdMicros;
		s.spent.tokens += add.tokens;
	}
	wakeWaiters(scope);
}

/**
 * The live in-flight cap of a dispatched reservation, per limited dimension: min(the
 * reservation, the reservation + what the chain has left now). Re-read on every usage event
 * so an overrun elsewhere shrinks it. Undefined for a dimension no scope limits.
 */
export function spendCapOf(reservation: BudgetReservation): { usdMicros?: number; tokens?: number } {
	const cap: { usdMicros?: number; tokens?: number } = {};
	const scope = reservation.scope;
	const usdLeft = scope.chainRemaining("usd");
	if (usdLeft !== undefined) cap.usdMicros = Math.max(0, Math.min(reservation.amount.usdMicros, reservation.amount.usdMicros + usdLeft));
	const tokensLeft = scope.chainRemaining("tokens");
	if (tokensLeft !== undefined) cap.tokens = Math.max(0, Math.min(reservation.amount.tokens, reservation.amount.tokens + tokensLeft));
	return cap;
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
