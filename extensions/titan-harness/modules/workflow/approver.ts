/**
 * Runner-owned approval seam. No Pi, network, or unit-side approval credentials.
 *
 * The router authenticates the reviewer; the runner binds (run, node, artifact sha256,
 * expected-actor policy, expiry) in the runner store (openRunnerStore only), snapshots the
 * delivered decision once, asks the host's ActorPolicy about the snapshot's actor, and
 * consumes once. Without an ActorPolicy every hosted decision is refused (fail closed).
 */
import { randomUUID } from "node:crypto";
import { sha256 } from "../hash-chain.ts";
import { assertRunnerStore, type RunStore, snapshotDecision } from "../run-store.ts";

export interface ApprovalRequest {
	requestId: string;
	runId: string;
	nodeId: string;
	attempt: number;
	artifactSha256: string;
	message: string;
	createdAt: string;
	expiresAt: string;
	captureResponse: boolean;
	/** With a preset gate: the preset key the runner-store tally is keyed by. */
	presetKey?: string;
	/** The expected-actor policy recorded at request time; consumption refuses actors outside it. */
	actorPolicy: { policyId: string | null; allowedActors?: string[] };
}
/**
 * Host policy for hosted approvals: `authorize` must return exactly `true` for the
 * router-authenticated actor (e.g. holds the prod-reviewer grant). Throwing or anything
 * else refuses. `policyId` is recorded on every request for audit.
 */
export interface ActorPolicy {
	policyId: string;
	authorize(actor: string, req: ApprovalRequest): boolean;
}
export interface ApprovalDecision {
	requestId: string;
	runId: string;
	nodeId: string;
	artifactSha256: string;
	actor: string;
	decision: "approve" | "reject";
	response?: string;
	decidedAt: string;
	nonce: string;
}
export type ApprovalAnswer = ApprovalDecision | { timeout: true } | { unavailable: true };
export interface Approver {
	/** Called again with the SAME request after a refusal; the host supplies the next decision. */
	request(req: ApprovalRequest): Promise<ApprovalAnswer>;
}
export interface ApprovalOptions {
	captureResponse?: boolean;
	nodeId?: string;
	attempt?: number;
	/** Runner callback: re-read substituted content at consumption, not just at request time. */
	content?: () => string;
	/** The approval spec's optional `reviewers:` list, intersected with the host policy. */
	reviewers?: string[];
	presetKey?: string;
	signal?: AbortSignal;
}
/** What a gate returns. `hosted`/`actor` are set only by the runner-store path. */
export interface ApprovalOutcome {
	approved: boolean;
	response?: string;
	hosted?: true;
	actor?: string;
}
export const DEFAULT_APPROVAL_TTL_MS = 24 * 60 * 60 * 1000;

/** An in-memory transport double; deliberately does not validate decisions for the runner. */
export class QueueApprover implements Approver {
	readonly requests: ApprovalRequest[] = [];
	private answers: ApprovalAnswer[] = [];
	private waiters: Array<(answer: ApprovalAnswer) => void> = [];
	request(req: ApprovalRequest): Promise<ApprovalAnswer> {
		this.requests.push(structuredClone(req));
		if (this.answers.length) return Promise.resolve(this.answers.shift()!);
		return new Promise(resolve => this.waiters.push(resolve));
	}
	deliver(answer: ApprovalAnswer): void {
		const waiter = this.waiters.shift();
		if (waiter) waiter(answer);
		else this.answers.push(answer);
	}
}

/** Wait using the runner's wall clock. The host cannot extend TTL by withholding a reply. */
function waitForAnswer(approver: Approver, req: ApprovalRequest, signal?: AbortSignal): Promise<ApprovalAnswer> {
	return new Promise((resolve) => {
		let done = false;
		let timer: ReturnType<typeof setTimeout>;
		const finish = (answer: ApprovalAnswer) => {
			if (done) return;
			done = true;
			clearTimeout(timer);
			signal?.removeEventListener("abort", abort);
			resolve(answer);
		};
		const abort = () => finish({ unavailable: true });
		const tick = () => {
			const left = Date.parse(req.expiresAt) - Date.now();
			if (left < 0) finish({ timeout: true });
			else timer = setTimeout(tick, Math.min(left + 1, 2_147_483_647));
		};
		if (signal?.aborted) return abort();
		signal?.addEventListener("abort", abort, { once: true });
		tick();
		if (!done) Promise.resolve().then(() => approver.request(structuredClone(req))).then(finish, () => finish({ unavailable: true }));
	});
}

export function createHostedApproval(host: { approver: Approver; store: RunStore; runDir: string; runId: string; approvalTtlMs?: number; actorPolicy?: ActorPolicy }) {
	assertRunnerStore(host.store, host.runDir); // fail closed: no lock/recovery, no hosted approvals
	const ttl = host.approvalTtlMs ?? DEFAULT_APPROVAL_TTL_MS;
	if (!Number.isFinite(ttl) || ttl <= 0 || ttl > 8.64e15 - Date.now()) throw new Error("approvalTtlMs must be a positive, representable duration");
	const policy = host.actorPolicy;
	if (policy !== undefined && (typeof policy.authorize !== "function" || typeof policy.policyId !== "string" || !policy.policyId.trim())) throw new Error("actorPolicy must be {policyId, authorize(actor, req)}");
	return async (message: string, opts?: ApprovalOptions): Promise<ApprovalOutcome> => {
		if (!opts?.nodeId || !opts.content) return { approved: false, response: "approval binding unavailable", hosted: true };
		assertRunnerStore(host.store, host.runDir);
		const now = Date.now();
		const allowedActors = opts.reviewers ? [...new Set(opts.reviewers.map(String))] : undefined;
		const req: ApprovalRequest = {
			requestId: randomUUID(), runId: host.runId, nodeId: opts.nodeId, attempt: opts.attempt ?? 1,
			artifactSha256: sha256(opts.content()), message, createdAt: new Date(now).toISOString(),
			expiresAt: new Date(now + ttl).toISOString(), captureResponse: Boolean(opts.captureResponse),
			...(opts.presetKey ? { presetKey: opts.presetKey } : {}),
			actorPolicy: { policyId: policy?.policyId ?? null, ...(allowedActors ? { allowedActors } : {}) },
		};
		host.store.requestApproval(host.runDir, req); // durable before handing the request to the host
		const authorized = (actor: string): boolean => {
			if (!policy) return false;
			try {
				return policy.authorize(actor, structuredClone(req)) === true;
			} catch {
				return false;
			}
		};
		for (;;) {
			const answer: unknown = await waitForAnswer(host.approver, req, opts.signal);
			if (isObject(answer) && ownTrue(answer, "timeout")) {
				host.store.expireApproval(host.runDir, req.requestId);
				return { approved: false, response: "approval timed out", hosted: true };
			}
			if (isObject(answer) && ownTrue(answer, "unavailable")) return { approved: false, response: "approval prompt unavailable", hosted: true };
			// One snapshot: the policy, the store's checks, the log and the outcome all see the same fields.
			const snap = snapshotDecision(answer);
			const delivered = snap.ok ? snap.decision : answer;
			const consumed = host.store.consumeDecision(host.runDir, delivered, {
				requestId: req.requestId, artifactSha256: sha256(opts.content()), actorAuthorized: snap.ok && authorized(snap.decision.actor),
			});
			if (consumed.ok) return { approved: consumed.decision.decision === "approve", response: consumed.decision.response, hosted: true, actor: consumed.decision.actor };
			if (!host.store.listPendingApprovals(host.runDir).some(p => p.requestId === req.requestId)) {
				return { approved: false, response: `approval refused: ${consumed.reason}`, hosted: true };
			}
			// Yield a macrotask so a transport that replays refusals cannot starve timers (TTL, other runs).
			await new Promise(resolve => setTimeout(resolve, 0));
		}
	};
}

const isObject = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object";
function ownTrue(value: Record<string, unknown>, key: string): boolean {
	try {
		return Object.prototype.hasOwnProperty.call(value, key) && value[key] === true;
	} catch {
		return false;
	}
}
