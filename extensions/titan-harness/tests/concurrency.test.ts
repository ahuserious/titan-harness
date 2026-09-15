import { describe, expect, test } from "bun:test";
import { DynamicSemaphore } from "../modules/concurrency.ts";

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("DynamicSemaphore", () => {
	test("caps concurrent leases and drains the queue in order", async () => {
		let limit = 2;
		const sem = new DynamicSemaphore(() => limit);
		const a = await sem.acquire();
		const b = await sem.acquire();
		expect(sem.inUse()).toBe(2);
		let cGranted = false;
		const cPromise = sem.acquire().then((lease) => {
			cGranted = true;
			return lease;
		});
		await tick();
		expect(cGranted).toBe(false);
		expect(sem.queued()).toBe(1);
		a.release();
		a.release(); // idempotent
		const c = await cPromise;
		expect(cGranted).toBe(true);
		expect(sem.inUse()).toBe(2);
		b.release();
		c.release();
		expect(sem.inUse()).toBe(0);
	});

	test("a raised limit releases waiters; priority bypasses the queue", async () => {
		let limit = 1;
		const sem = new DynamicSemaphore(() => limit);
		const held = await sem.acquire();
		let granted = false;
		const waiting = sem.acquire().then((lease) => {
			granted = true;
			return lease;
		});
		await tick();
		expect(granted).toBe(false);
		const inspector = await sem.acquire({ priority: true });
		expect(sem.inUse()).toBe(2);
		inspector.release();
		limit = 2;
		// A release pumps the queue against the new limit.
		held.release();
		const lease = await waiting;
		expect(granted).toBe(true);
		lease.release();
	});

	test("an aborted signal rejects a queued acquire and removes it from the queue", async () => {
		const sem = new DynamicSemaphore(() => 1);
		const held = await sem.acquire();
		const controller = new AbortController();
		const queued = sem.acquire({ signal: controller.signal });
		await tick();
		expect(sem.queued()).toBe(1);
		controller.abort(new Error("stop"));
		await expect(queued).rejects.toThrow("stop");
		expect(sem.queued()).toBe(0);
		held.release();
	});
});
