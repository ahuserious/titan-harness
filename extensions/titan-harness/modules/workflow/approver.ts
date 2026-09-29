/** Runner-owned approval seam. No Pi, network, or unit-side approval credentials. */
import { randomUUID } from "node:crypto";
import { sha256 } from "../hash-chain.ts";
import type { RunStore } from "../run-store.ts";

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
	signal?: AbortSignal;
}
export const DEFAULT_APPROVAL_TTL_MS = 24 * 60 * 60 * 1000;

/** An in-memory transport double; deliberately does not validate decisions for the runner. */
export class QueueApprover implements Approver {
	readonly requests: ApprovalRequest[] = [];
	private answers: ApprovalAnswer[] = [];
	private waiters: Array<(answer: ApprovalAnswer) => void> = [];
	request(req: ApprovalRequest): Promise<ApprovalAnswer> {
		this.requests.push({ ...req });
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
		if (!done) Promise.resolve().then(() => approver.request({ ...req })).then(finish, () => finish({ unavailable: true }));
	});
}

export function createHostedApproval(host: { approver: Approver; store: RunStore; runDir: string; runId: string; approvalTtlMs?: number }) {
	const ttl = host.approvalTtlMs ?? DEFAULT_APPROVAL_TTL_MS;
	if (!Number.isFinite(ttl) || ttl <= 0 || ttl > 8.64e15 - Date.now()) throw new Error("approvalTtlMs must be a positive, representable duration");
	return async (message: string, opts?: ApprovalOptions): Promise<{ approved: boolean; response?: string }> => {
		if (!opts?.nodeId || !opts.content) return { approved: false, response: "approval binding unavailable" };
		const now = Date.now();
		const req: ApprovalRequest = {
			requestId: randomUUID(), runId: host.runId, nodeId: opts.nodeId, attempt: opts.attempt ?? 1,
			artifactSha256: sha256(opts.content()), message, createdAt: new Date(now).toISOString(),
			expiresAt: new Date(now + ttl).toISOString(), captureResponse: Boolean(opts.captureResponse),
		};
		host.store.requestApproval(host.runDir, req); // durable before handing the request to the host
		for (;;) {
			const answer = await waitForAnswer(host.approver, req, opts.signal);
			if ("timeout" in answer) {
				host.store.expireApproval(host.runDir, req.requestId);
				return { approved: false, response: "approval timed out" };
			}
			if ("unavailable" in answer) return { approved: false, response: "approval prompt unavailable" };
			const consumed = host.store.consumeDecision(host.runDir, answer, { requestId: req.requestId, artifactSha256: sha256(opts.content()) });
			if (consumed.ok) return { approved: answer.decision === "approve", response: answer.response };
			if (!host.store.listPendingApprovals(host.runDir).some(p => p.requestId === req.requestId)) {
				return { approved: false, response: `approval refused: ${consumed.reason}` };
			}
		}
	};
}
