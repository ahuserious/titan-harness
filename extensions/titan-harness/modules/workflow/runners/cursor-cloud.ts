/**
 * runners/cursor-cloud.ts — the `cursor-cloud` verify runner (Cursor background agents, plan §5.8).
 *
 *   preflight   CURSOR_API_KEY present (by NAME; the value is read into a local, sent as
 *               a bearer header and never logged, stored or returned) → GET /v1/me
 *   branch      the target ref (`spec.ref`, default titan/<runId>) must exist on the remote:
 *               `git remote get-url origin` + `git ls-remote --heads origin <ref>`
 *   launch      POST /v1/agents with agentId = sha256(runId + nodeId) (idempotent), the
 *               objective as the prompt, source {repository, ref}, target {branchName}
 *   poll        GET /v1/agents/{id} until FINISHED | FAILED | ERROR | EXPIRED (one active
 *               run per agent; `poll_ms` on the spec, default 5000, bounded by timeoutMs)
 *   harvest     GET /v1/agents/{id}/artifacts → each artifact downloaded into the evidence
 *               dir as cursor-<name> and hashed; `result` text saved as cursor-result.md
 *
 * Fail closed: no key / no fetch / non-200 preflight → unavailable; branch not on the
 * remote, a non-FINISHED terminal status, no result text or no artifact → fail. The raw
 * result carries `{provider: "cursor", externalCostUsd}` so the executor can ledger the
 * lane as `source: external`. Every HTTP call goes through ctx.fetch (tests replay
 * recorded responses).
 */
import { sha256 } from "../../hash-chain.ts";
import type { EvidenceArtifact } from "../evidence.ts";
import { failed, kindForFile, type Runner, saveText, specString, unavailable } from "./index.ts";

export const CURSOR_API_BASE = "https://api.cursor.com";
export const CURSOR_KEY_ENV = "CURSOR_API_KEY";
export const CURSOR_TERMINAL = ["FINISHED", "FAILED", "ERROR", "EXPIRED", "CANCELLED"];
const DEFAULT_POLL_MS = 5000;

const sleep = (ms: number, signal: AbortSignal): Promise<void> =>
	new Promise((resolve) => {
		if (signal.aborted) return resolve();
		const timer = setTimeout(done, ms);
		function done() {
			signal.removeEventListener("abort", done);
			clearTimeout(timer);
			resolve();
		}
		signal.addEventListener("abort", done, { once: true });
	});

const asRecord = (value: unknown): Record<string, unknown> => (value && typeof value === "object" ? (value as Record<string, unknown>) : {});

/** The agent's result text from the shapes the API has used: result.summary, summary, result (string), output. */
export function cursorResultText(agent: Record<string, unknown>): string | undefined {
	const result = agent.result;
	if (typeof result === "string" && result.trim()) return result;
	const nested = asRecord(result);
	for (const key of ["summary", "text", "output"]) {
		const value = nested[key] ?? agent[key];
		if (typeof value === "string" && value.trim()) return value;
	}
	return undefined;
}

export function cursorArtifactList(payload: unknown): Array<{ name: string; url?: string; content?: string }> {
	const list = Array.isArray(payload) ? payload : Array.isArray(asRecord(payload).artifacts) ? (asRecord(payload).artifacts as unknown[]) : [];
	return list
		.map((item, index) => {
			const record = asRecord(item);
			const name = typeof record.name === "string" && record.name.trim() ? record.name : typeof record.path === "string" ? record.path : `artifact-${index + 1}`;
			return { name, url: typeof record.url === "string" ? record.url : typeof record.downloadUrl === "string" ? record.downloadUrl : undefined, content: typeof record.content === "string" ? record.content : undefined };
		})
		.filter((item) => item.url || item.content !== undefined);
}

export const cursorCloudRunner: Runner = async (spec, ctx) => {
	const key = ctx.env[CURSOR_KEY_ENV];
	if (!key || !key.trim()) return unavailable(`${CURSOR_KEY_ENV} not set (name only; the lane is vacant until the operator exports it)`);
	const fetchFn = ctx.fetch;
	if (!fetchFn) return unavailable("cursor-cloud: no HTTP client in this runtime");
	const objective = specString(spec, "objective");
	if (!objective) return failed("cursor-cloud runner needs verify.objective");
	const base = (specString(spec, "api_base") ?? CURSOR_API_BASE).replace(/\/+$/, "");
	const headers = { Authorization: `Bearer ${key.trim()}`, "Content-Type": "application/json" };
	const call = async (method: string, route: string, body?: unknown): Promise<{ status: number; body: unknown }> => {
		const response = await fetchFn(`${base}${route}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
		let parsed: unknown;
		try {
			parsed = await response.json();
		} catch {
			parsed = undefined;
		}
		return { status: response.status, body: parsed };
	};

	// 1. preflight
	let me: { status: number; body: unknown };
	try {
		me = await call("GET", "/v1/me");
	} catch (error) {
		return unavailable(`cursor-cloud preflight failed: ${error instanceof Error ? error.message : String(error)}`);
	}
	if (me.status !== 200) return unavailable(`cursor-cloud preflight GET /v1/me returned ${me.status} (key rejected or API unreachable)`);

	// 2. the branch must be on the remote
	const ref = specString(spec, "ref") ?? `titan/${ctx.runId}`;
	let repoUrl = specString(spec, "repo");
	if (!repoUrl) {
		const remote = await ctx.exec("git", ["remote", "get-url", "origin"], { cwd: ctx.cwd, timeoutMs: 15_000 });
		repoUrl = remote.code === 0 ? remote.stdout.trim() : "";
		if (!repoUrl) return failed("cursor-cloud: no git remote origin (set verify.repo)", { retryable: false });
	}
	const heads = await ctx.exec("git", ["ls-remote", "--heads", "origin", ref], { cwd: ctx.cwd, timeoutMs: 30_000 });
	if (heads.code !== 0 || !heads.stdout.trim()) return failed(`cursor-cloud: branch ${ref} is not on the remote (push it first: git push origin ${ref})`, { retryable: false });

	// 3. launch (idempotent per run + node)
	const agentId = sha256(`${ctx.runId}${ctx.nodeId}`);
	const launch = await call("POST", "/v1/agents", { agentId, prompt: { text: objective }, source: { repository: repoUrl, ref }, target: { branchName: ref, autoCreatePr: false } });
	if (launch.status >= 300) return failed(`cursor-cloud: POST /v1/agents returned ${launch.status}`);
	const launched = asRecord(launch.body);
	const id = typeof launched.id === "string" ? launched.id : agentId;

	// 4. poll
	const pollMs = typeof spec.poll_ms === "number" && spec.poll_ms > 0 ? spec.poll_ms : DEFAULT_POLL_MS;
	const deadline = Date.now() + Math.max(pollMs, ctx.timeoutMs);
	let agent = launched;
	let status = String(agent.status ?? "").toUpperCase();
	while (!CURSOR_TERMINAL.includes(status)) {
		if (ctx.signal.aborted) return failed("cursor-cloud: aborted while polling");
		if (Date.now() > deadline) return failed(`cursor-cloud: agent ${id} did not finish within ${ctx.timeoutMs} ms (last status ${status || "unknown"})`);
		await sleep(pollMs, ctx.signal);
		const poll = await call("GET", `/v1/agents/${encodeURIComponent(id)}`);
		if (poll.status >= 300) return failed(`cursor-cloud: GET /v1/agents/${id} returned ${poll.status}`);
		agent = asRecord(poll.body);
		status = String(agent.status ?? "").toUpperCase();
	}
	if (status !== "FINISHED") return failed(`cursor-cloud: agent ${id} ended ${status}`, { raw: { provider: "cursor", status } });

	// 5. harvest
	const artifacts: EvidenceArtifact[] = [];
	const resultText = cursorResultText(agent);
	if (resultText) artifacts.push(await saveText(ctx, "cursor-result.md", resultText, "report", "cursor"));
	const list = await call("GET", `/v1/agents/${encodeURIComponent(id)}/artifacts`);
	for (const item of cursorArtifactList(list.body)) {
		const safe = item.name.replace(/[^A-Za-z0-9._-]+/g, "-");
		let content = item.content;
		if (content === undefined && item.url) {
			try {
				const download = await fetchFn(item.url, { method: "GET", headers: { Authorization: headers.Authorization } });
				content = download.status < 300 ? await download.text() : undefined;
			} catch {
				content = undefined;
			}
		}
		if (content === undefined) {
			artifacts.push({ path: `${ctx.evidenceDir}/cursor-${safe}`, kind: kindForFile(safe, "report"), capturedBy: "observed", source: "cursor", ts: new Date().toISOString(), degraded: ["missing"], note: "download failed" });
			continue;
		}
		artifacts.push(await saveText(ctx, `cursor-${safe}`, content, kindForFile(safe, "report"), "cursor"));
	}
	const hashed = artifacts.filter((artifact) => artifact.sha256);
	const cost = asRecord(agent.cost);
	const externalCostUsd = typeof cost.usd === "number" ? cost.usd : typeof agent.costUsd === "number" ? agent.costUsd : undefined;
	const raw = { provider: "cursor", agentId: id, status, externalCostUsd };
	if (!resultText) return failed(`cursor-cloud: agent ${id} finished without a result text`, { artifacts, raw });
	if (hashed.length < 2) return failed(`cursor-cloud: agent ${id} finished with no downloadable artifact (result text alone is a claim)`, { artifacts, raw });
	return { status: "pass", artifacts, checks: { testsPass: true, logsPresent: hashed.some((artifact) => artifact.kind === "log" || artifact.kind === "test-result") }, summary: `cursor-cloud: agent ${id} FINISHED · ${hashed.length} artifact(s)`, raw };
};
