/**
 * audit.ts — the titan-harness AUDIT GATE.
 *
 * A builder's finished WRITE task never reaches the architect unreviewed. An AUDITOR
 * (read-only child, fresh session per review, cross-family model by default) receives
 * the task, the acceptance list, the builder's report and the scoped git diff, and
 * answers with one YAML verdict block (see prompts/SYSTEM_PROMPT_AUDITOR.md).
 *
 *   PASS / PASS_WITH_WARNINGS → forwarded, verdict attached
 *   FAIL                      → bounded correction rounds (settings.auditRounds), then
 *                               AUDIT_EXHAUSTED: forwarded, verdict attached, architect arbitrates
 *   SAFETY / SCOPE_VIOLATION  → fail closed: the task does not count as done
 *   INCONCLUSIVE / AUDIT_ERROR → forwarded with the note (fail-open with visibility)
 *
 * The builder's model identity is never shown to the auditor, and vice versa: prompts
 * use callsigns only.
 */
import { spawnSync } from "node:child_process";
import * as path from "node:path";
import { runChild } from "./child-runner.ts";
import type { ModelSlot } from "./model-stack.ts";
import { auditCorrectionPrompt, auditPrompt, contractSystemPrompt } from "./prompt-library.ts";
import { type AgentRun, type AuditOutcome, type AuditRequest, type AuditStatus, newRun, READONLY_TOOLS, runError, runOk, truncateChars } from "./runtime.ts";
import { readStackSettings } from "./stack-config.ts";

export interface AuditDeps {
	auditorFor(builder: ModelSlot): ModelSlot;
	childTimeoutMs(): number;
	/** Live state for the model bar: "reviewing forge/T3", "PASS", … */
	noteAuditor?(auditorId: string, state: string): void;
	save(dir: string, name: string, body: string): Promise<void>;
	mkdir(dir: string): Promise<void>;
}

const DIFF_MAX = 60_000;

/** `git diff HEAD` (+ untracked list) for the working tree, bounded. */
export function workingTreeDiff(cwd: string): string {
	const git = (args: string[]): string => {
		const out = spawnSync("git", args, { cwd, encoding: "utf8", timeout: 20_000, maxBuffer: 8 * 1024 * 1024 });
		if (out.status !== 0) return "";
		return out.stdout ?? "";
	};
	const inside = spawnSync("git", ["rev-parse", "--is-inside-work-tree"], { cwd, encoding: "utf8", timeout: 5_000 });
	if (inside.status !== 0) return "(not a git repository — no diff available; audit from the files and the report)";
	const stat = git(["diff", "HEAD", "--stat"]).trim();
	const untracked = git(["ls-files", "--others", "--exclude-standard"]).trim();
	const full = git(["diff", "HEAD"]);
	const parts = [stat ? `## stat\n${stat}` : "## stat\n(no tracked changes)", untracked ? `## untracked files\n${untracked}` : "", full ? `## diff\n${truncateChars(full, DIFF_MAX)}` : ""].filter(Boolean);
	return parts.join("\n\n");
}

/** True when the working tree has tracked changes or untracked files (a chat-only answer has neither). */
export function hasWorkingTreeChanges(cwd: string): boolean {
	const inside = spawnSync("git", ["rev-parse", "--is-inside-work-tree"], { cwd, encoding: "utf8", timeout: 5_000 });
	if (inside.status !== 0) return true; // not a repo: cannot tell, so audit
	const stat = spawnSync("git", ["status", "--porcelain"], { cwd, encoding: "utf8", timeout: 20_000, maxBuffer: 8 * 1024 * 1024 });
	return stat.status !== 0 || (stat.stdout ?? "").trim().length > 0;
}

/** Pull the verdict word out of the auditor's YAML block. */
export function parseVerdict(text: string): { verdict: AuditStatus | "FAIL"; yaml: string } {
	const fenced = text.match(/```ya?ml\s*([\s\S]*?)```/i);
	const yaml = (fenced ? fenced[1] : text).trim();
	const m = yaml.match(/^\s*verdict:\s*([A-Z_]+)/im);
	const word = (m?.[1] ?? "").toUpperCase();
	const known: Array<AuditStatus | "FAIL"> = ["PASS", "PASS_WITH_WARNINGS", "FAIL", "INCONCLUSIVE", "SAFETY", "SCOPE_VIOLATION"];
	return { verdict: known.includes(word as AuditStatus) ? (word as AuditStatus) : "INCONCLUSIVE", yaml };
}

export async function auditBuilderRun(deps: AuditDeps, cwd: string, req: AuditRequest): Promise<AuditOutcome> {
	const settings = readStackSettings();
	const skip = (status: AuditStatus, note: string): AuditOutcome => ({ status, report: `${req.report}\n\n## AUDIT — ${status}\n${note}`, verdicts: [], reviews: 0, corrections: 0, failClosed: false });
	if (!settings.auditor) return { status: "AUDIT_SKIPPED", report: req.report, verdicts: [], reviews: 0, corrections: 0, failClosed: false };
	const auditor = deps.auditorFor(req.builder);
	const auditDir = path.join(req.artifactsDir, "audit", req.task.id.replace(/[^A-Za-z0-9_-]+/g, "_"));
	await deps.mkdir(auditDir);
	const maxRounds = settings.auditRounds;
	let report = req.report;
	let corrections = 0;
	let reviews = 0;
	const verdicts: string[] = [];
	let status: AuditStatus = "INCONCLUSIVE";
	let auditorRun: AgentRun | undefined;
	while (true) {
		reviews++;
		auditorRun = newRun("AUDITOR", auditor.model, auditor);
		deps.noteAuditor?.(auditor.id, `reviewing ${req.builder.name}/${req.task.id} (round ${reviews})`);
		const diff = workingTreeDiff(cwd);
		await runChild({
			run: auditorRun,
			prompt: auditPrompt({ AUDITOR_NAME: auditor.name, BUILDER_NAME: req.builder.name, ROUND: reviews, MAX_ROUNDS: maxRounds + 1, TASK_ID: req.task.id, TASK_DESCRIPTION: req.task.description, TASK_OUTPUTS: req.task.outputs.length ? req.task.outputs.map((o) => `- ${o}`).join("\n") : "- a concrete task report", REPORT: report, DIFF: diff, PROMPT: req.prompt }),
			systemPrompt: contractSystemPrompt(undefined, "SYSTEM_PROMPT_AUDITOR.md"),
			tools: READONLY_TOOLS,
			thinking: auditor.thinking,
			sessionDir: path.join(auditDir, `round-${reviews}`),
			cwd,
			timeoutMs: deps.childTimeoutMs(),
			signal: req.signal,
		});
		if (req.signal?.aborted) {
			deps.noteAuditor?.(auditor.id, "stopped");
			return skip("AUDIT_ERROR", "audit stopped by the user");
		}
		if (!runOk(auditorRun)) {
			deps.noteAuditor?.(auditor.id, "error");
			await deps.save(auditDir, `round-${reviews}-error.txt`, runError(auditorRun));
			return skip("AUDIT_ERROR", `the auditor (${auditor.name}) produced no verdict: ${runError(auditorRun)}`);
		}
		const { verdict, yaml } = parseVerdict(auditorRun.text);
		verdicts.push(yaml);
		await deps.save(auditDir, `round-${reviews}.yaml`, yaml);
		if (verdict === "PASS" || verdict === "PASS_WITH_WARNINGS") {
			status = verdict;
			break;
		}
		if (verdict === "SAFETY" || verdict === "SCOPE_VIOLATION") {
			status = verdict;
			break;
		}
		if (verdict === "INCONCLUSIVE") {
			status = "INCONCLUSIVE";
			break;
		}
		// FAIL → bounded correction, then re-audit
		if (corrections >= maxRounds) {
			status = "AUDIT_EXHAUSTED";
			break;
		}
		corrections++;
		deps.noteAuditor?.(auditor.id, `FAIL → ${req.builder.name} correcting (${corrections}/${maxRounds})`);
		const resume = req.run.sessionRef ? { sessionDir: req.spawn.sessionDir, resume: req.run.sessionRef } : req.spawn;
		await runChild({
			run: req.run,
			prompt: auditCorrectionPrompt({ BUILDER_NAME: req.builder.name, ROUND: corrections, MAX_ROUNDS: maxRounds, TASK_ID: req.task.id, TASK_DESCRIPTION: req.task.description, VERDICT: yaml, PROMPT: req.prompt }),
			systemPrompt: req.builder.systemPrompt,
			appendSystemPrompts: req.builder.appendSystemPrompts,
			tools: req.tools,
			thinking: req.builder.thinking,
			...resume,
			cwd,
			timeoutMs: deps.childTimeoutMs(),
			signal: req.signal,
		});
		if (req.signal?.aborted) return skip("AUDIT_ERROR", "correction stopped by the user");
		if (!runOk(req.run)) {
			status = "AUDIT_EXHAUSTED";
			report = `${report}\n\n(correction round ${corrections} failed: ${runError(req.run)})`;
			break;
		}
		report = req.run.text;
		await deps.save(auditDir, `correction-${corrections}.md`, report);
	}
	const failClosed = status === "SAFETY" || status === "SCOPE_VIOLATION";
	deps.noteAuditor?.(auditor.id, status);
	const trailer = [`## AUDIT — ${status}`, `auditor: ${auditor.name} · reviews: ${reviews} · corrections: ${corrections}${failClosed ? " · TASK BLOCKED (fail-closed)" : status === "AUDIT_EXHAUSTED" ? " · forwarded for architect arbitration" : ""}`, "```yaml", verdicts[verdicts.length - 1] ?? "", "```"].join("\n");
	return { status, report: `${report}\n\n${trailer}`, verdicts, reviews, corrections, failClosed, auditor };
}
