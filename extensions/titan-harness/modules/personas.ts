/**
 * personas.ts — personas and mimeographs (plan A12, P7).
 *
 * A persona is `personas/<name>.md`: YAML frontmatter `lens`, `bias`, `style` (required),
 * optional `model` / `thinking` (a seat override), then a markdown body. It rides the
 * child's `--append-system-prompt` (personaAppend), never the user prompt, and never
 * carries a model identity: prompts stay callsign-only (anonymize), so two personas on
 * one model produce different prompt hashes while nothing in the text names the model.
 *
 * A mimeograph is the same brief × k personas × m models (mimeographPlan): callsigns
 * `mg-1..n`, identical prompts, personas on the system append, judged like best_of
 * (nodes/ai.ts runs the grid). Roots, first wins: <cwd>/.titan/personas,
 * ~/.pi/titan-harness/personas, <package>/personas. Pure Node, no pi.
 */
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const MODULE_DIR: string = typeof __dirname !== "undefined" && __dirname ? __dirname : path.dirname(fileURLToPath(import.meta.url));
/** modules/ → extensions/titan-harness → extensions → the package root. */
export const PACKAGE_PERSONAS_DIR = path.resolve(MODULE_DIR, "..", "..", "..", "personas");

export const PERSONA_NAME_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;
export const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;

export interface Persona {
	name: string;
	lens: string;
	bias: string;
	style: string;
	model?: string;
	thinking?: string;
	body: string;
	/** sha256 of the file bytes. */
	sha256: string;
	path: string;
}

export interface MimeographCell {
	callsign: string;
	persona: string;
	model: string;
	thinking?: string;
}

const sha256 = (text: string): string => createHash("sha256").update(text).digest("hex");

/** The roots a persona name resolves against, in precedence order (project, user, package). */
export function personaRoots(cwd: string, overrides?: { user?: string; package?: string }): string[] {
	return [path.join(path.resolve(cwd), ".titan", "personas"), overrides?.user ?? path.join(os.homedir(), ".pi", "titan-harness", "personas"), overrides?.package ?? PACKAGE_PERSONAS_DIR];
}

/** `<root>/<name>.md` (or `<root>/personas/<name>.md`) in the first root that has it. */
export function findPersonaFile(name: string, roots: string[]): string | undefined {
	if (!PERSONA_NAME_RE.test(name)) return undefined;
	for (const root of roots) {
		for (const candidate of [path.join(root, `${name}.md`), path.join(root, "personas", `${name}.md`)]) {
			try {
				if (fs.statSync(candidate).isFile()) return candidate;
			} catch {
				/* next */
			}
		}
	}
	return undefined;
}

/** Frontmatter (`---` block of `key: value` lines, quotes stripped) + body. */
export function parsePersonaText(text: string, name: string, file = `${name}.md`): Persona {
	const normalized = text.replace(/\r\n/g, "\n");
	const match = /^---\n([\s\S]*?)\n---\n?([\s\S]*)$/.exec(normalized);
	if (!match) throw new Error(`titan-harness: persona ${name} (${file}) has no frontmatter block (--- lens/bias/style ---)`);
	const meta: Record<string, string> = {};
	for (const line of match[1].split("\n")) {
		const m = /^([A-Za-z_][\w-]*)\s*:\s*(.*)$/.exec(line.trim());
		if (!m) continue;
		meta[m[1]] = m[2].trim().replace(/^(['"])(.*)\1$/, "$2");
	}
	for (const key of ["lens", "bias", "style"] as const) {
		if (!meta[key]?.trim()) throw new Error(`titan-harness: persona ${name} (${file}) is missing frontmatter "${key}"`);
	}
	if (meta.model !== undefined && !/^[^/\s]+\/[^\s]+$/.test(meta.model)) throw new Error(`titan-harness: persona ${name}: model must be provider/id; found ${JSON.stringify(meta.model)}`);
	if (meta.thinking !== undefined && !(THINKING_LEVELS as readonly string[]).includes(meta.thinking)) throw new Error(`titan-harness: persona ${name}: thinking must be one of ${THINKING_LEVELS.join(", ")}; found ${JSON.stringify(meta.thinking)}`);
	return {
		name,
		lens: meta.lens,
		bias: meta.bias,
		style: meta.style,
		...(meta.model ? { model: meta.model } : {}),
		...(meta.thinking ? { thinking: meta.thinking } : {}),
		body: match[2].trim(),
		sha256: sha256(text),
		path: file,
	};
}

/** Load a persona by name; throws when no root has it or the file is malformed. */
export function loadPersona(name: string, roots: string[]): Persona {
	const file = findPersonaFile(name, roots);
	if (!file) throw new Error(`titan-harness: persona "${name}" not found as <root>/${name}.md under ${roots.join(", ")}`);
	return parsePersonaText(fs.readFileSync(file, "utf8"), name, file);
}

/** Every persona visible from the roots (first root wins per name), sorted by name. */
export function listPersonas(roots: string[]): Persona[] {
	const seen = new Map<string, Persona>();
	for (const root of roots) {
		let entries: string[] = [];
		try {
			entries = fs.readdirSync(root);
		} catch {
			continue;
		}
		for (const entry of entries) {
			if (!entry.endsWith(".md")) continue;
			const name = entry.slice(0, -3);
			if (!PERSONA_NAME_RE.test(name) || seen.has(name)) continue;
			try {
				seen.set(name, parsePersonaText(fs.readFileSync(path.join(root, entry), "utf8"), name, path.join(root, entry)));
			} catch {
				/* a malformed persona is skipped by the listing; loadPersona reports it */
			}
		}
	}
	return [...seen.values()].sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * The `--append-system-prompt` text. It names the persona, never a model: the seat's
 * model/thinking overrides travel on the request, not in the words.
 */
export function personaAppend(p: Persona): string {
	const lines = [
		`# Persona: ${p.name}`,
		"",
		`You work as the "${p.name}" persona for this task — a lens on the work, not an identity. Stay in it.`,
		`- Lens: ${p.lens}`,
		`- Bias: ${p.bias}`,
		`- Style: ${p.style}`,
	];
	if (p.body.trim()) lines.push("", p.body.trim());
	return lines.join("\n");
}

/** sha256 of the full system append a request would carry (tests: two personas on one model differ). */
export function personaPromptHash(p: Persona, base: string[] = []): string {
	return sha256([...base, personaAppend(p)].join("\n\n"));
}

/**
 * k × m grid: every persona on every model, callsigns `mg-1..n` in persona-major order;
 * an empty `models` list means one column on the seat's own model (the caller passes it).
 * A persona's own `model:` pins its row to that model (one cell per persona then).
 */
export function mimeographPlan(brief: string, personas: Persona[], models: string[]): MimeographCell[] {
	if (!brief.trim()) throw new Error("titan-harness: mimeograph brief is empty");
	if (!personas.length) throw new Error("titan-harness: mimeograph needs at least one persona");
	const columns = models.length ? models : [];
	if (!columns.length) throw new Error("titan-harness: mimeograph needs at least one model (the node's resolved seat or `models:`)");
	const cells: MimeographCell[] = [];
	for (const persona of personas) {
		const own = persona.model ? [persona.model] : columns;
		for (const model of own) {
			cells.push({ callsign: `mg-${cells.length + 1}`, persona: persona.name, model, ...(persona.thinking ? { thinking: persona.thinking } : {}) });
		}
	}
	return cells;
}

/** The `mimeograph:` field of a node → persona names (a comma list or the spec's list). */
export function mimeographPersonaNames(spec: string | { personas: string[] }): string[] {
	const names = typeof spec === "string" ? spec.split(",") : spec.personas;
	return [...new Set(names.map((n) => n.trim()).filter(Boolean))];
}
