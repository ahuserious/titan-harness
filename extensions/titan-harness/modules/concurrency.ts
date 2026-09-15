/**
 * concurrency.ts — the one cap on simultaneous titan children.
 *
 * Fan-out numbers in a shape are POOL sizes (how many builders, workers, watchdogs,
 * verifiers or exa lanes a run may address); this semaphore is how many child
 * processes may be alive at once (settings.maxConcurrentChildren, default 8, ≤ 16).
 * The limit is read on every acquire so a /stack change applies to the next spawn.
 * Inspectors and watchdog reviews acquire with `priority: true`, which bypasses the
 * queue: a reviewer must never wait behind the builders it is reviewing.
 */

export interface SlotLease {
	release(): void;
}

export class DynamicSemaphore {
	private active = 0;
	private readonly waiters: Array<() => void> = [];

	constructor(private readonly limitFn: () => number) {}

	/** Current limit (clamped to ≥ 1). */
	limit(): number {
		const raw = this.limitFn();
		return Number.isFinite(raw) && raw >= 1 ? Math.floor(raw) : 1;
	}

	/** Leases held right now (priority leases included). */
	inUse(): number {
		return this.active;
	}

	/** Callers queued behind the cap. */
	queued(): number {
		return this.waiters.length;
	}

	/**
	 * Wait for a slot (or take one immediately with `priority`). Resolves to a lease
	 * whose release() is idempotent. An aborted signal before the slot is granted
	 * rejects with the signal's reason.
	 */
	acquire(opts: { priority?: boolean; signal?: AbortSignal } = {}): Promise<SlotLease> {
		return new Promise<SlotLease>((resolve, reject) => {
			const grant = () => {
				this.active++;
				let released = false;
				resolve({
					release: () => {
						if (released) return;
						released = true;
						this.active--;
						this.pump();
					},
				});
			};
			if (opts.signal?.aborted) {
				reject(opts.signal.reason ?? new Error("aborted"));
				return;
			}
			if (opts.priority || this.active < this.limit()) {
				grant();
				return;
			}
			const waiter = () => {
				opts.signal?.removeEventListener("abort", onAbort);
				grant();
			};
			const onAbort = () => {
				const index = this.waiters.indexOf(waiter);
				if (index >= 0) this.waiters.splice(index, 1);
				reject(opts.signal?.reason ?? new Error("aborted"));
			};
			opts.signal?.addEventListener("abort", onAbort, { once: true });
			this.waiters.push(waiter);
		});
	}

	private pump() {
		while (this.waiters.length && this.active < this.limit()) {
			const next = this.waiters.shift()!;
			next();
		}
	}
}
