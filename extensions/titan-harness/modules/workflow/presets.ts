/**
 * presets.ts — the content presets catalog and approval receipts (plan §5.6, H3f).
 *
 * A preset is `.titan/presets/content/<key>.yaml` in the project (shadows the package copy
 * under .pi/titan-harness/presets/content/): {key, industry, content_type,
 * preference_profile {voice, tone, banned_claims[], style_guide_ref}, rubric [{criterion,
 * threshold}], reviewers {human_min (default 3), roles[]}, receipts_dir?}.
 *
 * An `approval:` node with `preset_key` records one `approval-receipt` artifact per decision
 * under <artifactsDir>/receipts/<key>/<contentSha256>-<n>.json:
 * {presetKey, reviewer, decision, rubricScores, ts, contentSha256}. The node's output then
 * carries `receipts` = distinct approve receipts for that content hash, so a ship node's
 * `when: $approve.output.receipts >= 3` gates on real human receipts, never on prose.
 * Pure: files only, no pi.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { parse as parseYaml } from "yaml";
import { packageRoot } from "./loader.ts";

export const DEFAULT_HUMAN_MIN = 3;
export const RECEIPTS_DIR = "receipts";
export const PRESET_KEY_RE = /^[a-z0-9][a-z0-9-]{0,79}$/;

export interface ContentPreset {
	key: string;
	industry: string;
	content_type: string;
	preference_profile: { voice?: string; tone?: string; banned_claims: string[]; style_guide_ref?: string };
	rubric: Array<{ criterion: string; threshold?: number }>;
	reviewers: { human_min: number; roles: string[] };
	receipts_dir?: string;
	path: string;
	source: "project" | "package";
}

export interface PresetDirOverrides {
	project?: string;
	package?: string;
}

export function presetDirs(cwd: string, overrides?: PresetDirOverrides): { project: string; package: string } {
	return {
		project: overrides?.project ?? path.join(path.resolve(cwd), ".titan", "presets", "content"),
		package: overrides?.package ?? path.join(packageRoot(), ".pi", "titan-harness", "presets", "content"),
	};
}

const isRecord = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);
const str = (value: unknown): string | undefined => (typeof value === "string" && value.trim() ? value.trim() : undefined);
const strings = (value: unknown): string[] => (Array.isArray(value) ? value.filter((v): v is string => typeof v === "string" && v.trim().length > 0).map((v) => v.trim()) : []);

/** Parse one preset document; throws with the file path on a malformed document. */
export function parsePreset(text: string, file: string, source: ContentPreset["source"] = "project"): ContentPreset {
	let raw: unknown;
	try {
		raw = parseYaml(text);
	} catch (error) {
		throw new Error(`titan-harness: preset ${file} is not valid YAML: ${error instanceof Error ? error.message : String(error)}`);
	}
	if (!isRecord(raw)) throw new Error(`titan-harness: preset ${file} must be a mapping`);
	const problems: string[] = [];
	const key = str(raw.key);
	if (!key || !PRESET_KEY_RE.test(key)) problems.push("key must match ^[a-z0-9][a-z0-9-]{0,79}$");
	const industry = str(raw.industry);
	if (!industry) problems.push("industry is required");
	const contentType = str(raw.content_type);
	if (!contentType) problems.push("content_type is required");
	const profile = isRecord(raw.preference_profile) ? raw.preference_profile : undefined;
	if (!profile) problems.push("preference_profile must be a mapping {voice, tone, banned_claims, style_guide_ref}");
	const rubricRaw = Array.isArray(raw.rubric) ? raw.rubric : undefined;
	if (!rubricRaw || !rubricRaw.length) problems.push("rubric must be a non-empty list of {criterion, threshold?}");
	const rubric: ContentPreset["rubric"] = [];
	for (const [index, item] of (rubricRaw ?? []).entries()) {
		const criterion = isRecord(item) ? str(item.criterion) : str(item);
		if (!criterion) {
			problems.push(`rubric[${index}] needs a criterion`);
			continue;
		}
		const threshold = isRecord(item) && typeof item.threshold === "number" && Number.isFinite(item.threshold) ? item.threshold : undefined;
		if (isRecord(item) && item.threshold !== undefined && threshold === undefined) problems.push(`rubric[${index}].threshold must be a number`);
		rubric.push(threshold === undefined ? { criterion } : { criterion, threshold });
	}
	const reviewersRaw = isRecord(raw.reviewers) ? raw.reviewers : {};
	const humanMinRaw = reviewersRaw.human_min;
	const humanMin = humanMinRaw === undefined ? DEFAULT_HUMAN_MIN : typeof humanMinRaw === "number" && Number.isInteger(humanMinRaw) && humanMinRaw >= 1 && humanMinRaw <= 20 ? humanMinRaw : NaN;
	if (Number.isNaN(humanMin)) problems.push("reviewers.human_min must be an integer 1–20");
	const receiptsDir = raw.receipts_dir === undefined ? undefined : str(raw.receipts_dir);
	if (raw.receipts_dir !== undefined && !receiptsDir) problems.push("receipts_dir must be a non-empty relative path");
	if (receiptsDir && (path.isAbsolute(receiptsDir) || receiptsDir.split(/[\\/]/).includes(".."))) problems.push("receipts_dir must stay inside the artifacts directory (relative, no ..)");
	if (problems.length) throw new Error(`titan-harness: preset ${file} is invalid:\n${problems.map((p) => `  - ${p}`).join("\n")}`);
	return {
		key: key!,
		industry: industry!,
		content_type: contentType!,
		preference_profile: { voice: str(profile!.voice), tone: str(profile!.tone), banned_claims: strings(profile!.banned_claims), style_guide_ref: str(profile!.style_guide_ref) },
		rubric,
		reviewers: { human_min: humanMin, roles: strings(reviewersRaw.roles) },
		...(receiptsDir ? { receipts_dir: receiptsDir } : {}),
		path: file,
		source,
	};
}

function readDir(dir: string, source: ContentPreset["source"]): ContentPreset[] {
	let entries: string[] = [];
	try {
		entries = fs.readdirSync(dir).filter((f) => /\.ya?ml$/i.test(f)).sort();
	} catch {
		return [];
	}
	return entries.map((f) => parsePreset(fs.readFileSync(path.join(dir, f), "utf8"), path.join(dir, f), source));
}

/** Every preset visible from `cwd`: project presets shadow package presets with the same key. Throws on the first invalid file. */
export function loadPresets(cwd: string, overrides?: PresetDirOverrides): ContentPreset[] {
	const dirs = presetDirs(cwd, overrides);
	const byKey = new Map<string, ContentPreset>();
	for (const preset of readDir(dirs.package, "package")) byKey.set(preset.key, preset);
	for (const preset of readDir(dirs.project, "project")) byKey.set(preset.key, preset);
	return [...byKey.values()].sort((a, b) => a.key.localeCompare(b.key));
}

export function presetByKey(cwd: string, key: string, overrides?: PresetDirOverrides): ContentPreset | undefined {
	return loadPresets(cwd, overrides).find((preset) => preset.key === key);
}

export interface ApprovalReceipt {
	presetKey: string;
	reviewer: string;
	decision: "approve" | "reject";
	rubricScores: Record<string, number>;
	ts: string;
	contentSha256: string;
	runId?: string;
	nodeId?: string;
	response?: string;
}

/** Where a preset's receipts live for this run: <artifactsDir>/<receipts_dir ?? receipts/<key>>. */
export function receiptsDirFor(artifactsDir: string, preset: Pick<ContentPreset, "key" | "receipts_dir">): string {
	return path.join(artifactsDir, preset.receipts_dir ?? path.join(RECEIPTS_DIR, preset.key));
}

/**
 * The reviewer name and rubric scores a human typed into the approval reply:
 * `reviewer: Dana; clarity=4, accuracy=5` (also `clarity: 4` or `clarity 4/5`). Unnamed → "human".
 */
export function parseReviewResponse(response: string | undefined): { reviewer: string; rubricScores: Record<string, number> } {
	const scores: Record<string, number> = {};
	let reviewer = "human";
	const textValue = (response ?? "").trim();
	if (!textValue) return { reviewer, rubricScores: scores };
	const named = textValue.match(/(?:^|[;,\n])\s*(?:reviewer|by|from)\s*[:=]\s*([^;,\n]+)/i);
	if (named) reviewer = named[1].trim();
	const scoreRe = /([A-Za-z][A-Za-z0-9_ -]{0,40}?)\s*(?:=|:|\s)\s*(\d+(?:\.\d+)?)(?:\s*\/\s*\d+)?(?=$|[;,\n])/g;
	for (const match of textValue.matchAll(scoreRe)) {
		const criterion = match[1].trim().toLowerCase();
		if (["reviewer", "by", "from"].includes(criterion)) continue;
		const value = Number.parseFloat(match[2]);
		if (Number.isFinite(value)) scores[criterion] = value;
	}
	return { reviewer, rubricScores: scores };
}

/** Append one receipt file (0600) and return its path. */
export function writeReceipt(dir: string, receipt: ApprovalReceipt): string {
	fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
	const existing = fs.readdirSync(dir).filter((f) => f.startsWith(`${receipt.contentSha256}-`) && f.endsWith(".json")).length;
	const file = path.join(dir, `${receipt.contentSha256}-${existing + 1}.json`);
	fs.writeFileSync(file, `${JSON.stringify(receipt, null, 2)}\n`, { mode: 0o600 });
	return file;
}

/** Every receipt for one content hash, in file order. */
export function readReceipts(dir: string, contentSha256: string): ApprovalReceipt[] {
	let files: string[] = [];
	try {
		files = fs
			.readdirSync(dir)
			.filter((f) => f.startsWith(`${contentSha256}-`) && f.endsWith(".json"))
			.sort((a, b) => Number.parseInt(a.slice(contentSha256.length + 1), 10) - Number.parseInt(b.slice(contentSha256.length + 1), 10));
	} catch {
		return [];
	}
	const receipts: ApprovalReceipt[] = [];
	for (const f of files) {
		try {
			const parsed = JSON.parse(fs.readFileSync(path.join(dir, f), "utf8"));
			if (parsed && typeof parsed === "object" && (parsed.decision === "approve" || parsed.decision === "reject")) receipts.push(parsed as ApprovalReceipt);
		} catch {
			/* a torn receipt never counts */
		}
	}
	return receipts;
}

/** Approve receipts for a content hash: distinct by named reviewer ("human" receipts each count once). */
export function countApprovals(dir: string, contentSha256: string): { approve: number; reject: number; reviewers: string[] } {
	const receipts = readReceipts(dir, contentSha256);
	const reviewers: string[] = [];
	const named = new Set<string>();
	let approve = 0;
	let reject = 0;
	for (const receipt of receipts) {
		if (receipt.decision === "reject") {
			reject++;
			continue;
		}
		const name = (receipt.reviewer || "human").trim();
		if (name.toLowerCase() !== "human") {
			if (named.has(name.toLowerCase())) continue;
			named.add(name.toLowerCase());
		}
		approve++;
		reviewers.push(name);
	}
	return { approve, reject, reviewers };
}
