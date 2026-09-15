import * as fs from "node:fs";
import * as path from "node:path";
import { parse as parseYaml } from "yaml";
import { normalizeThinking } from "./thinking.ts";

export type Thinking = "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
export type HexColor = `#${string}`;

/**
 * The lane a slot plays in (shape schema v2, plan §4.1). A v1 bare-list file only ever
 * describes an architect and builders; every other role arrives with `version: 2`.
 */
export type SlotRole = "architect" | "builder" | "worker" | "watchdog" | "verifier" | "auditor" | "exa" | "fusion" | "judge" | "fuser";
export const SLOT_ROLES: SlotRole[] = ["architect", "builder", "worker", "watchdog", "verifier", "auditor", "exa", "fusion", "judge", "fuser"];
/** Roles that are one seat by construction: `fanout` above 1 is rejected for them. */
const SINGLE_SEAT_ROLES = new Set<SlotRole>(["architect", "judge", "fuser"]);

export interface ModelSlot {
	id: string;
	name: string;
	model: string;
	thinking: Thinking;
	color: HexColor;
	architect: boolean;
	primary: boolean;
	systemPrompt?: string;
	systemPromptSource?: string;
	/**
	 * Extra prompts APPENDED after the slot's base system prompt — the base being the
	 * `system_prompt` override when set, or pi's own default when not (children receive
	 * these via pi's repeatable --append-system-prompt, so the default is never rebuilt
	 * here). YAML: `append_system_prompt` takes one entry or a list; each entry is
	 * inline text or a file path relative to the YAML.
	 */
	appendSystemPrompts: string[];
	/** Lane. v1 slots are "architect" or "builder"; v2 slots default the same way. */
	role?: SlotRole;
	/** Pool size (v2, default 1): the factory expands the template into `${id}-1…${id}-n` at spawn time. */
	fanout?: number;
	/** Id of another slot of the same role whose allowance this lane draws from (v2). A pooled lane never adds to its lane total. */
	pool?: string;
	/** Counts toward the user-facing fan-out (v2; default true, false for watchdog and exa lanes). */
	counted?: boolean;
	/** provider/id used when `model` is not usable (unauthed or not in the catalog). */
	fallback?: string;
	/** An optional seat is skipped silently when neither model nor fallback is usable. */
	optional?: boolean;
	/** Named prompt profile for the lane (e.g. db-ops-findings-curation). */
	profile?: string;
	/** The YAML thinking value before provider normalization (v2); `thinking` is the value to send. */
	requestedThinking?: Thinking;
	/** Set on expandFanout clones: the id of the template slot they were cloned from. */
	template?: string;
}

/** The role view of a stack. Lanes hold slot TEMPLATES; fan-out is expanded at spawn time. */
export interface StackLanes {
	builders: ModelSlot[];
	workers: ModelSlot[];
	watchdogs: ModelSlot[];
	verifiers: ModelSlot[];
	exa: ModelSlot[];
	auditors: ModelSlot[];
	fusion: ModelSlot[];
	judge?: ModelSlot;
	fuser?: ModelSlot;
}

export interface StackExa {
	enabled: boolean;
	fanout: number;
	children: boolean;
}
export type ReviewPolicy = "optional" | "required";
export interface StackVerification {
	default_tier?: string;
	review?: ReviewPolicy;
	elevation?: string;
}
export interface StackWatchdog {
	enabled: boolean;
	per_fanout?: number;
	counted?: boolean;
	on_compaction?: string;
}

export interface ModelStack {
	codename: string;
	configPath?: string;
	slots: ModelSlot[];
	architect: ModelSlot;
	/** The primary (host) seat. In v2 it may be a non-builder: level 0's worker, the ultraplan fuser. */
	primaryBuilder: ModelSlot;
	/** Every non-architect slot — the legacy view, identical for both schema versions. `lanes` is the role view. */
	builders: ModelSlot[];
	version?: 1 | 2;
	level?: number;
	label?: string;
	exa?: StackExa;
	verification?: StackVerification;
	watchdog?: StackWatchdog;
	plan_command?: string;
	requires?: string[];
	entry?: string;
	lanes: StackLanes;
}

export interface LegacyStackOptions {
	architectModel: string;
	builderModel: string;
	architectThinking: Thinking;
	builderThinking: Thinking;
	architectSystemPrompt?: string;
	builderSystemPrompt?: string;
}

const THINKING_ALIASES: Record<string, Thinking> = {
	off: "off",
	none: "off",
	minimal: "minimal",
	min: "minimal",
	low: "low",
	medium: "medium",
	med: "medium",
	high: "high",
	hi: "high",
	xhigh: "xhigh",
	xhi: "xhigh",
	max: "max",
};

export const SLOT_COLOR_PALETTE: HexColor[] = ["#22D3EE", "#F59E0B", "#A78BFA", "#34D399", "#F472B6"];
/** v2 palette: the v1 palette first, then seven more, so up to twelve auto-coloured slots stay distinct. */
export const SLOT_COLOR_PALETTE_V2: HexColor[] = [...SLOT_COLOR_PALETTE, "#FB923C", "#60A5FA", "#4ADE80", "#E879F9", "#FACC15", "#2DD4BF", "#F87171"];
/** Preferred v2 colour per role (stable across levels: forge is always amber, scout always cyan); first unused palette colour otherwise. */
const ROLE_PREFERRED_COLOR: Record<SlotRole, HexColor> = {
	architect: "#A78BFA",
	builder: "#F59E0B",
	worker: "#22D3EE",
	watchdog: "#F87171",
	verifier: "#34D399",
	exa: "#60A5FA",
	auditor: "#9CA3AF",
	fusion: "#F472B6",
	judge: "#FACC15",
	fuser: "#FB923C",
};
const HEX_COLOR_RE = /^#[0-9A-Fa-f]{6}$/;
const SLOT_NAME_RE = /^[A-Za-z0-9_-]{1,16}$/;
const MODEL_RE = /^[^/\s]+\/[^\s]+$/;
const PROFILE_RE = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/;
const V1_SLOT_KEYS = new Set(["name", "model", "thinking", "color", "architect", "primary", "system_prompt", "append_system_prompt"]);
const V2_SLOT_KEYS = new Set([...V1_SLOT_KEYS, "role", "fanout", "pool", "counted", "fallback", "optional", "profile"]);
const V2_TOP_KEYS = new Set(["version", "level", "label", "exa", "verification", "watchdog", "plan_command", "requires", "entry", "slots"]);
const V2_MAX_LEVEL = 3;
const V2_ON_COMPACTION = ["halt-inspect", "summary-only", "off"];
const V2_REVIEW = ["optional", "required"];

export function resolveThinking(raw: unknown, fallback: Thinking = "medium"): Thinking | undefined {
	if (raw === undefined || raw === null || raw === "") return fallback;
	return typeof raw === "string" ? THINKING_ALIASES[raw.trim().toLowerCase()] : undefined;
}

export function slotId(name: string): string {
	return name.toLowerCase().replace(/[^a-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "") || "slot";
}

/** A slot's lane, defaulting v1 slots (no `role`) to architect or builder. */
export function slotRole(slot: Pick<ModelSlot, "role" | "architect">): SlotRole {
	return slot.role ?? (slot.architect ? "architect" : "builder");
}

/** Derive the role view from a slot list (used by the loader, cloneStack, and after any reshaping). */
export function lanesFor(slots: ModelSlot[]): StackLanes {
	const of = (role: SlotRole): ModelSlot[] => slots.filter((slot) => slotRole(slot) === role);
	const lanes: StackLanes = { builders: of("builder"), workers: of("worker"), watchdogs: of("watchdog"), verifiers: of("verifier"), exa: of("exa"), auditors: of("auditor"), fusion: of("fusion") };
	const judge = of("judge")[0];
	if (judge) lanes.judge = judge;
	const fuser = of("fuser")[0];
	if (fuser) lanes.fuser = fuser;
	return lanes;
}

function stableHash(input: string): number {
	let hash = 2166136261;
	for (let i = 0; i < input.length; i++) {
		hash ^= input.charCodeAt(i);
		hash = Math.imul(hash, 16777619);
	}
	return hash >>> 0;
}

const isMapping = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);
const isPositiveInt = (value: unknown): value is number => typeof value === "number" && Number.isInteger(value) && value >= 1;
const isNonNegativeInt = (value: unknown): value is number => typeof value === "number" && Number.isInteger(value) && value >= 0;

/** Booleans, plus the YAML 1.1 spellings (`on`/`off`, `yes`/`no`) the yaml 1.2 parser leaves as strings. */
function parseFlag(raw: unknown): boolean | undefined {
	if (typeof raw === "boolean") return raw;
	if (typeof raw === "string") {
		const value = raw.trim().toLowerCase();
		if (value === "on" || value === "yes" || value === "true") return true;
		if (value === "off" || value === "no" || value === "false") return false;
	}
	return undefined;
}

function resolvePrompt(raw: unknown, configDir: string, label: string, errors: string[]): { text?: string; source?: string } {
	if (raw === undefined || raw === null || raw === "") return {};
	if (typeof raw !== "string") {
		errors.push(`${label}.system_prompt must be a string (inline text or file path)`);
		return {};
	}
	const candidate = path.isAbsolute(raw) ? raw : path.resolve(configDir, raw);
	try {
		if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) {
			return { text: fs.readFileSync(candidate, "utf8"), source: candidate };
		}
	} catch (error) {
		errors.push(`${label}.system_prompt could not be read at ${candidate}: ${error instanceof Error ? error.message : String(error)}`);
		return {};
	}
	if (path.isAbsolute(raw) || raw.startsWith("./") || raw.startsWith("../") || raw.endsWith(".md") || raw.endsWith(".txt")) {
		errors.push(`${label}.system_prompt path does not exist: ${candidate}`);
		return {};
	}
	return { text: raw };
}

function codenameFromPath(configPath: string): string {
	const base = path.basename(configPath).replace(/\.(?:yaml|yml)$/i, "");
	return base.replace(/^model-stack-/, "") || "stack";
}

type SlotDraft = Omit<ModelSlot, "color"> & { color?: HexColor };

interface ParseContext {
	version: 1 | 2;
	configDir: string;
	errors: string[];
	names: Set<string>;
	ids: Set<string>;
}

/** The v2-only lane fields of one slot, with their defaults. */
function parseLaneFields(value: Record<string, unknown>, label: string, role: SlotRole, errors: string[]): Pick<ModelSlot, "fanout" | "pool" | "counted" | "fallback" | "optional" | "profile"> {
	const out: Pick<ModelSlot, "fanout" | "pool" | "counted" | "fallback" | "optional" | "profile"> = { fanout: 1, counted: !(role === "watchdog" || role === "exa") };
	if (value.fanout !== undefined) {
		if (isPositiveInt(value.fanout)) out.fanout = value.fanout;
		else errors.push(`${label}.fanout must be a positive integer (a lane that shares another lane's allowance declares pool: <slot> instead); found ${JSON.stringify(value.fanout)}`);
	}
	if ((out.fanout ?? 1) > 1 && SINGLE_SEAT_ROLES.has(role)) errors.push(`${label} has role ${role}, a single seat, and cannot fan out (fanout: ${out.fanout})`);
	if (value.pool !== undefined) {
		if (typeof value.pool === "string" && value.pool.trim()) out.pool = value.pool.trim();
		else errors.push(`${label}.pool must name another slot of the same role; found ${JSON.stringify(value.pool)}`);
	}
	if (value.counted !== undefined) {
		if (typeof value.counted === "boolean") out.counted = value.counted;
		else errors.push(`${label}.counted must be boolean`);
	}
	if (value.fallback !== undefined) {
		if (typeof value.fallback === "string" && MODEL_RE.test(value.fallback.trim())) out.fallback = value.fallback.trim();
		else errors.push(`${label}.fallback must be fully qualified as provider/id; found ${JSON.stringify(value.fallback)}`);
	}
	if (value.optional !== undefined) {
		if (typeof value.optional === "boolean") out.optional = value.optional;
		else errors.push(`${label}.optional must be boolean`);
	}
	if (value.profile !== undefined) {
		if (typeof value.profile === "string" && PROFILE_RE.test(value.profile.trim())) out.profile = value.profile.trim();
		else errors.push(`${label}.profile must match [A-Za-z0-9][A-Za-z0-9_.-]* (at most 64 characters); found ${JSON.stringify(value.profile)}`);
	}
	return out;
}

function parseSlot(raw: unknown, index: number, ctx: ParseContext): SlotDraft | undefined {
	const { version, configDir, errors } = ctx;
	const label = `slot[${index}]`;
	if (!isMapping(raw)) {
		errors.push(`${label} must be a mapping`);
		return undefined;
	}
	const value = raw;
	const allowedKeys = version === 2 ? V2_SLOT_KEYS : V1_SLOT_KEYS;
	for (const key of Object.keys(value)) if (!allowedKeys.has(key)) errors.push(`${label} contains unknown key ${JSON.stringify(key)}`);
	const name = typeof value.name === "string" ? value.name.trim() : "";
	if (!SLOT_NAME_RE.test(name)) errors.push(`${label}.name must match [A-Za-z0-9_-]+ and be 1-16 characters; found ${JSON.stringify(value.name)}`);
	const id = slotId(name || `slot-${index + 1}`);
	if (ctx.names.has(name.toLowerCase())) errors.push(`${label}.name duplicates another slot: ${name}`);
	if (ctx.ids.has(id)) errors.push(`${label}.id duplicates another slot after normalization: ${id}`);
	ctx.names.add(name.toLowerCase());
	ctx.ids.add(id);

	if (value.architect !== undefined && typeof value.architect !== "boolean") errors.push(`${label}.architect must be boolean`);
	if (value.primary !== undefined && typeof value.primary !== "boolean") errors.push(`${label}.primary must be boolean`);
	// role: explicit in v2; `architect: true` → architect, anything else → builder.
	let role: SlotRole = value.architect === true ? "architect" : "builder";
	if (version === 2 && value.role !== undefined) {
		if (typeof value.role === "string" && (SLOT_ROLES as string[]).includes(value.role)) role = value.role as SlotRole;
		else errors.push(`${label}.role must be one of ${SLOT_ROLES.join(", ")}; found ${JSON.stringify(value.role)}`);
	}
	if (value.architect === true && role !== "architect") errors.push(`${label} sets architect: true but role: ${role}; the architect's role is "architect"`);
	const architect = value.architect === true || role === "architect";
	const primary = value.primary === true;
	if (architect && primary) errors.push(`${label} is the architect and cannot be primary; primary is only for the Main builder`);

	const model = typeof value.model === "string" ? value.model.trim() : "";
	if (version === 2 && model === "auto") {
		if (role !== "auditor") errors.push(`${label}.model: auto is only allowed for role: auditor (a cross-family auditor is chosen at run time); found on role ${role}`);
	} else if (!MODEL_RE.test(model)) {
		errors.push(`${label}.model must be fully qualified as provider/id; found ${JSON.stringify(value.model)}`);
	}

	const requested = resolveThinking(value.thinking);
	if (!requested) errors.push(`${label}.thinking is invalid: ${JSON.stringify(value.thinking)}`);
	// v2 sends the provider ceiling and keeps the request for display (`xhigh↘high`).
	const thinking = version === 2 && requested && model !== "auto" ? normalizeThinking(model, requested).effective : requested;

	let color: HexColor | undefined;
	if (value.color !== undefined && value.color !== null && value.color !== "") {
		if (typeof value.color !== "string" || !HEX_COLOR_RE.test(value.color.trim())) {
			errors.push(`${label}.color must be a quoted six-digit #RRGGBB value; found ${JSON.stringify(value.color)}`);
		} else {
			color = value.color.trim().toUpperCase() as HexColor;
		}
	}
	const prompt = resolvePrompt(value.system_prompt, configDir, label, errors);
	// append_system_prompt: one entry or a list; each entry inline text or a file
	// path relative to the YAML — same resolution rules as system_prompt.
	const appendSystemPrompts: string[] = [];
	if (value.append_system_prompt !== undefined && value.append_system_prompt !== null && value.append_system_prompt !== "") {
		const rawAppends = Array.isArray(value.append_system_prompt) ? value.append_system_prompt : [value.append_system_prompt];
		for (let appendIndex = 0; appendIndex < rawAppends.length; appendIndex++) {
			const resolved = resolvePrompt(rawAppends[appendIndex], configDir, `${label}.append_system_prompt[${appendIndex}]`, errors);
			if (resolved.text?.trim()) appendSystemPrompts.push(resolved.text);
		}
	}
	const draft: SlotDraft = {
		id,
		name: name || `slot-${index + 1}`,
		model,
		thinking: thinking ?? "medium",
		architect,
		primary,
		systemPrompt: prompt.text,
		systemPromptSource: prompt.source,
		appendSystemPrompts,
		color,
		role,
	};
	if (version === 2) Object.assign(draft, parseLaneFields(value, label, role, errors), { requestedThinking: requested ?? "medium" });
	return draft;
}

/** `pool: <slot>` → the target's id; a pool must exist, differ from the slot, share its role, and not itself be pooled. */
function resolvePools(drafts: SlotDraft[], errors: string[]): void {
	const byId = new Map(drafts.map((draft) => [draft.id, draft]));
	const byName = new Map(drafts.map((draft) => [draft.name.toLowerCase(), draft]));
	for (const draft of drafts) {
		if (!draft.pool) continue;
		const target = byId.get(draft.pool) ?? byName.get(draft.pool.toLowerCase()) ?? byId.get(slotId(draft.pool));
		if (!target) errors.push(`slot ${draft.name}.pool names an unknown slot: ${draft.pool}`);
		else if (target === draft) errors.push(`slot ${draft.name}.pool cannot name itself`);
		else if (target.pool) errors.push(`slot ${draft.name}.pool names ${target.name}, which draws from a pool itself; pools do not chain`);
		else if (target.role !== draft.role) errors.push(`slot ${draft.name}.pool names ${target.name} (role ${target.role}); a pooled lane must share its pool's role (${draft.role})`);
		else draft.pool = target.id;
	}
}

type V2Header = Pick<ModelStack, "level" | "label" | "exa" | "verification" | "watchdog" | "plan_command" | "requires" | "entry">;

function parseV2Header(value: Record<string, unknown>, errors: string[]): V2Header {
	const header: V2Header = {};
	for (const key of Object.keys(value)) if (!V2_TOP_KEYS.has(key)) errors.push(`top-level key ${JSON.stringify(key)} is unknown in shape schema v2`);
	if (value.level !== undefined) {
		if (isNonNegativeInt(value.level) && value.level <= V2_MAX_LEVEL) header.level = value.level;
		else errors.push(`level must be an integer between 0 and ${V2_MAX_LEVEL}; found ${JSON.stringify(value.level)}`);
	}
	if (value.label !== undefined) {
		if (typeof value.label === "string" && value.label.trim()) header.label = value.label.trim();
		else errors.push(`label must be a non-empty string; found ${JSON.stringify(value.label)}`);
	}
	if (value.exa !== undefined) {
		if (!isMapping(value.exa)) errors.push("exa must be a mapping { enabled, fanout, children }");
		else {
			const exa = value.exa;
			for (const key of Object.keys(exa)) if (!["enabled", "fanout", "children"].includes(key)) errors.push(`exa contains unknown key ${JSON.stringify(key)}`);
			const enabled = exa.enabled === undefined ? true : parseFlag(exa.enabled);
			if (enabled === undefined) errors.push(`exa.enabled must be boolean; found ${JSON.stringify(exa.enabled)}`);
			let fanout = 0;
			if (exa.fanout !== undefined) {
				if (isNonNegativeInt(exa.fanout)) fanout = exa.fanout;
				else errors.push(`exa.fanout must be a non-negative integer; found ${JSON.stringify(exa.fanout)}`);
			}
			const children = exa.children === undefined ? true : parseFlag(exa.children);
			if (children === undefined) errors.push(`exa.children must be on/off (boolean); found ${JSON.stringify(exa.children)}`);
			header.exa = { enabled: enabled ?? true, fanout, children: children ?? true };
		}
	}
	if (value.verification !== undefined) {
		if (!isMapping(value.verification)) errors.push("verification must be a mapping { default_tier, review, elevation }");
		else {
			const verification = value.verification;
			const out: StackVerification = {};
			for (const key of Object.keys(verification)) if (!["default_tier", "review", "elevation"].includes(key)) errors.push(`verification contains unknown key ${JSON.stringify(key)}`);
			if (verification.default_tier !== undefined) {
				if (typeof verification.default_tier === "string" && verification.default_tier.trim()) out.default_tier = verification.default_tier.trim();
				else errors.push(`verification.default_tier must be a non-empty string; found ${JSON.stringify(verification.default_tier)}`);
			}
			if (verification.review !== undefined) {
				if (typeof verification.review === "string" && V2_REVIEW.includes(verification.review)) out.review = verification.review as ReviewPolicy;
				else errors.push(`verification.review must be one of ${V2_REVIEW.join(", ")}; found ${JSON.stringify(verification.review)}`);
			}
			if (verification.elevation !== undefined) {
				if (typeof verification.elevation === "string" && verification.elevation.trim()) out.elevation = verification.elevation.trim();
				else errors.push(`verification.elevation must be a non-empty string; found ${JSON.stringify(verification.elevation)}`);
			}
			header.verification = out;
		}
	}
	if (value.watchdog !== undefined) {
		if (!isMapping(value.watchdog)) errors.push("watchdog must be a mapping { enabled, per_fanout, counted, on_compaction }");
		else {
			const watchdog = value.watchdog;
			for (const key of Object.keys(watchdog)) if (!["enabled", "per_fanout", "counted", "on_compaction"].includes(key)) errors.push(`watchdog contains unknown key ${JSON.stringify(key)}`);
			const enabled = watchdog.enabled === undefined ? false : parseFlag(watchdog.enabled);
			if (enabled === undefined) errors.push(`watchdog.enabled must be boolean; found ${JSON.stringify(watchdog.enabled)}`);
			const out: StackWatchdog = { enabled: enabled ?? false };
			if (watchdog.per_fanout !== undefined) {
				if (isPositiveInt(watchdog.per_fanout)) out.per_fanout = watchdog.per_fanout;
				else errors.push(`watchdog.per_fanout must be a positive integer; found ${JSON.stringify(watchdog.per_fanout)}`);
			}
			if (watchdog.counted !== undefined) {
				const counted = parseFlag(watchdog.counted);
				if (counted === undefined) errors.push(`watchdog.counted must be boolean; found ${JSON.stringify(watchdog.counted)}`);
				else out.counted = counted;
			}
			if (watchdog.on_compaction !== undefined) {
				if (typeof watchdog.on_compaction === "string" && V2_ON_COMPACTION.includes(watchdog.on_compaction)) out.on_compaction = watchdog.on_compaction;
				else errors.push(`watchdog.on_compaction must be one of ${V2_ON_COMPACTION.join(", ")}; found ${JSON.stringify(watchdog.on_compaction)}`);
			}
			header.watchdog = out;
		}
	}
	if (value.plan_command !== undefined) {
		if (typeof value.plan_command === "string" && /^\/[A-Za-z0-9_-]+$/.test(value.plan_command.trim())) header.plan_command = value.plan_command.trim();
		else errors.push(`plan_command must be a slash command such as /ultraplan; found ${JSON.stringify(value.plan_command)}`);
	}
	if (value.requires !== undefined) {
		const list = Array.isArray(value.requires) ? value.requires : [value.requires];
		if (list.every((entry) => typeof entry === "string" && entry.trim())) header.requires = list.map((entry) => (entry as string).trim());
		else errors.push(`requires must be a list of non-empty strings; found ${JSON.stringify(value.requires)}`);
	}
	if (value.entry !== undefined) {
		if (typeof value.entry === "string" && value.entry.trim()) header.entry = value.entry.trim();
		else errors.push(`entry must be a non-empty string; found ${JSON.stringify(value.entry)}`);
	}
	return header;
}

/**
 * Load a shape file. A bare list is schema v1 (2-5 slots, architect + builders); a mapping
 * with `version: 2` is schema v2 (2-12 slots with roles, fan-out pools, fallbacks). Fan-out
 * is NOT expanded here — lanes hold templates and the factory expands them at spawn time.
 */
export function loadModelStack(configPathInput: string): ModelStack {
	const configPath = path.resolve(configPathInput);
	const invalid = (lines: string[]): Error => new Error(`titan-harness: model-stack config invalid (${configPath}):\n${lines.map((line) => `- ${line}`).join("\n")}`);
	let source: string;
	try {
		source = fs.readFileSync(configPath, "utf8");
	} catch (error) {
		throw invalid([`file is unreadable: ${error instanceof Error ? error.message : String(error)}`]);
	}

	let parsed: unknown;
	try {
		parsed = parseYaml(source);
	} catch (error) {
		throw invalid([`YAML parse failed: ${error instanceof Error ? error.message : String(error)}`]);
	}

	const errors: string[] = [];
	const codename = codenameFromPath(configPath);
	const configDir = path.dirname(configPath);

	let version: 1 | 2;
	let rawSlots: unknown[];
	let header: V2Header = {};
	if (Array.isArray(parsed)) {
		version = 1;
		rawSlots = parsed;
		if (rawSlots.length < 2 || rawSlots.length > 5) errors.push(`slot count must be between 2 and 5; found ${rawSlots.length}`);
	} else if (isMapping(parsed)) {
		if (parsed.version !== 2) throw invalid([`top-level mapping must declare version: 2 (a v1 shape is a bare list of slots); found version ${JSON.stringify(parsed.version)}`]);
		version = 2;
		header = parseV2Header(parsed, errors);
		if (!Array.isArray(parsed.slots)) throw invalid([...errors, "slots must be a list of 2-12 model slots"]);
		rawSlots = parsed.slots;
		if (rawSlots.length < 2 || rawSlots.length > 12) errors.push(`slot count must be between 2 and 12; found ${rawSlots.length}`);
	} else {
		throw invalid(["top-level YAML value must be a list of model slots (v1) or a mapping with version: 2"]);
	}

	const ctx: ParseContext = { version, configDir, errors, names: new Set<string>(), ids: new Set<string>() };
	const drafts: SlotDraft[] = [];
	for (let index = 0; index < rawSlots.length; index++) {
		const draft = parseSlot(rawSlots[index], index, ctx);
		if (draft) drafts.push(draft);
	}
	if (version === 2) resolvePools(drafts, errors);

	const architectDrafts = drafts.filter((slot) => slot.architect);
	const nonArchitects = drafts.filter((slot) => !slot.architect);
	const primaries = nonArchitects.filter((slot) => slot.primary);
	if (architectDrafts.length !== 1) errors.push(`exactly one slot must set architect: true; found ${architectDrafts.length}`);
	if (version === 1) {
		if (nonArchitects.length < 1) errors.push("at least one non-architect builder slot is required");
		if (primaries.length !== 1) errors.push(`exactly one non-architect builder must set primary: true; found ${primaries.length}`);
	} else {
		if (nonArchitects.length < 1) errors.push("at least one non-architect slot is required");
		if (primaries.length !== 1) errors.push(`exactly one non-architect slot must set primary: true (the host seat: a builder, a worker or the fuser); found ${primaries.length}`);
		const judges = drafts.filter((slot) => slot.role === "judge");
		const fusers = drafts.filter((slot) => slot.role === "fuser");
		if (judges.length > 1) errors.push(`at most one slot may have role: judge; found ${judges.length}`);
		if (fusers.length > 1) errors.push(`at most one slot may have role: fuser; found ${fusers.length}`);
		if (judges.length === 1 && fusers.length === 1 && judges[0].model === fusers[0].model) {
			errors.push(`the judge (${judges[0].name}) and the fuser (${fusers[0].name}) must not share a model (${judges[0].model})`);
		}
	}

	const explicitColors = new Set<string>();
	for (const slot of drafts) {
		if (!slot.color) continue;
		if (explicitColors.has(slot.color)) errors.push(`color ${slot.color} is assigned to more than one slot`);
		explicitColors.add(slot.color);
	}

	if (errors.length) throw invalid(errors);

	const usedColors = new Set(explicitColors);
	// v2: a slot takes its role's colour; a second slot of the same role (level 3's pooled
	// `ledger`) takes a palette colour no role claims, so role colours stay stable across levels.
	const roleColors = new Set<string>(Object.values(ROLE_PREFERRED_COLOR));
	const palette = version === 2 ? [...SLOT_COLOR_PALETTE_V2.filter((c) => !roleColors.has(c)), ...SLOT_COLOR_PALETTE_V2] : SLOT_COLOR_PALETTE;
	const slots: ModelSlot[] = drafts.map((draft) => {
		let color = draft.color;
		if (!color) {
			const preferred: HexColor =
				version === 2
					? ROLE_PREFERRED_COLOR[draft.role ?? "builder"]
					: draft.architect
						? "#A78BFA"
						: SLOT_COLOR_PALETTE[stableHash(`${codename}:${draft.id}`) % SLOT_COLOR_PALETTE.length];
			const ordered = [preferred, ...palette];
			color = ordered.find((candidate) => !usedColors.has(candidate)) ?? preferred;
		}
		usedColors.add(color);
		return { ...draft, color } as ModelSlot;
	});

	const architect = slots.find((slot) => slot.architect)!;
	const builders = slots.filter((slot) => !slot.architect);
	const primaryBuilder = builders.find((slot) => slot.primary)!;
	return { codename, configPath, version, ...header, slots, architect, primaryBuilder, builders, lanes: lanesFor(slots) };
}

export function synthesizeLegacyStack(options: LegacyStackOptions): ModelStack {
	const architect: ModelSlot = {
		id: "architect",
		name: "architect",
		model: options.architectModel,
		thinking: options.architectThinking,
		color: "#A78BFA",
		architect: true,
		primary: false,
		systemPrompt: options.architectSystemPrompt,
		appendSystemPrompts: [],
		role: "architect",
	};
	const primaryBuilder: ModelSlot = {
		id: "main",
		name: "main",
		model: options.builderModel,
		thinking: options.builderThinking,
		color: "#F59E0B",
		architect: false,
		primary: true,
		systemPrompt: options.builderSystemPrompt,
		appendSystemPrompts: [],
		role: "builder",
	};
	const slots = [architect, primaryBuilder];
	return { codename: "legacy", version: 1, slots, architect, primaryBuilder, builders: [primaryBuilder], lanes: lanesFor(slots) };
}

export function orderedSlots(stack: ModelStack): ModelSlot[] {
	return [stack.architect, stack.primaryBuilder, ...stack.builders.filter((slot) => slot.id !== stack.primaryBuilder.id)];
}

export function cloneStack(stack: ModelStack): ModelStack {
	const slots = stack.slots.map((slot) => ({ ...slot, appendSystemPrompts: [...slot.appendSystemPrompts] }));
	const architect = slots.find((slot) => slot.id === stack.architect.id)!;
	const primaryBuilder = slots.find((slot) => slot.id === stack.primaryBuilder.id)!;
	return {
		...stack,
		...(stack.exa ? { exa: { ...stack.exa } } : {}),
		...(stack.verification ? { verification: { ...stack.verification } } : {}),
		...(stack.watchdog ? { watchdog: { ...stack.watchdog } } : {}),
		...(stack.requires ? { requires: [...stack.requires] } : {}),
		slots,
		architect,
		primaryBuilder,
		builders: slots.filter((slot) => !slot.architect),
		lanes: lanesFor(slots),
	};
}

/**
 * Expand a lane template into its seats: `forge` × 3 → `forge-1`, `forge-2`, `forge-3`
 * (ids `${id}-${i}`), each carrying the template's fields with `template` set to the
 * template id and `fanout` reset to 1. Only the first clone keeps `primary`, so a stack
 * still has exactly one host seat. n = 1 returns `[slot]` unchanged.
 */
export function expandFanout(slot: ModelSlot, n: number): ModelSlot[] {
	if (!Number.isInteger(n) || n < 1) throw new Error(`titan-harness: fanout for ${slot.id} must be a positive integer; found ${String(n)}`);
	if (n === 1) return [slot];
	return Array.from({ length: n }, (_, index) => ({
		...slot,
		id: `${slot.id}-${index + 1}`,
		name: `${slot.name}-${index + 1}`,
		primary: slot.primary && index === 0,
		fanout: 1,
		template: slot.id,
		appendSystemPrompts: [...slot.appendSystemPrompts],
	}));
}

export interface PrintedFanout {
	builders: number;
	workers: number;
	watchdogs: number;
	verifiers: number;
	exa: number;
}

/**
 * The user-facing fan-out table: the sum of `fanout` per lane (a slot without one counts
 * as 1). A slot with `pool: X` draws from X's allowance and adds nothing, so level 3's
 * `ledger` lane (fanout 2, pool scout) keeps the table at 3/5/5/5/10.
 */
export function printedFanout(stack: ModelStack): PrintedFanout {
	const lanes = stack.lanes ?? lanesFor(stack.slots);
	const total = (lane: ModelSlot[]): number => lane.filter((slot) => !slot.pool).reduce((sum, slot) => sum + (slot.fanout ?? 1), 0);
	return { builders: total(lanes.builders), workers: total(lanes.workers), watchdogs: total(lanes.watchdogs), verifiers: total(lanes.verifiers), exa: total(lanes.exa) };
}
