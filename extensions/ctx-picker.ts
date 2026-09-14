/**
 * Context-window picker for Codex / OpenRouter Astra.
 *
 * /ctx            → interactive picker
 * /ctx 272k|828k|1m → apply a preset directly
 *
 *   272k  Subscription (native Codex window)      openai-codex/gpt-6-astra
 *   828k  Extended, compact at 828k (872k max)     openai-codex/gpt-6-astra
 *   1m    OpenRouter / provider 1M                 openrouter/openai/gpt-6-astra
 *
 * Compaction: Pi fires at contextWindow - reserveTokens. Astra's effective
 * Codex window is 95% of the 872k max (~828.4k), so the extended preset uses
 * contextWindow 872000 and reserveTokens 44000 → compact at 828000.
 *
 * Safety rules (2026-09-13 hardening):
 *   - Nothing is written unless the target model is in the catalog AND has
 *     configured auth. A missing /login never leaves an unusable default.
 *   - settings.json / models.json are read before any write; an unreadable or
 *     malformed file aborts the whole change instead of being replaced.
 *   - Writes are atomic (temp file + rename) and keep mode 0600.
 *   - Unrelated keys and per-model override fields are preserved.
 *   - The 872k override stays on every openai-codex model in 828k and 1m
 *     mode (standing rule); only the 272k preset narrows Codex to 272k.
 *   - session_start never rewrites config; it only reports the stored mode.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

type CtxMode = "272k" | "828k" | "1m";
const MODES: CtxMode[] = ["272k", "828k", "1m"];

const HOME = os.homedir();
const MODE_PATH = path.join(HOME, ".pi", "agent", "ctx-mode.json");
const MODELS_PATH = path.join(HOME, ".pi", "agent", "models.json");
const SETTINGS_PATH = path.join(HOME, ".pi", "agent", "settings.json");

const CODEX_MODELS = ["gpt-5.4", "gpt-5.5", "gpt-5.6-luna", "gpt-5.6-sol", "gpt-5.6-terra", "gpt-6-astra"];
const CODEX_MAX_WINDOW = 872000; // Codex catalog max_context_window for Astra/Sol
const CODEX_NATIVE_WINDOW = 272000; // Codex catalog context_window (subscription default)
const OPENROUTER_ASTRA_WINDOW = 1050000;

type Preset = {
	label: string;
	provider: string;
	id: string;
	contextWindow: number;
	reserveTokens: number;
	name: string;
};

const PRESETS: Record<CtxMode, Preset> = {
	"272k": {
		label: "Subscription 272k (native Codex)",
		provider: "openai-codex",
		id: "gpt-6-astra",
		contextWindow: CODEX_NATIVE_WINDOW,
		reserveTokens: 16384,
		name: "GPT-6 Astra · subscription 272k",
	},
	"828k": {
		label: "Extended 828k compact (Codex max 872k)",
		provider: "openai-codex",
		id: "gpt-6-astra",
		contextWindow: CODEX_MAX_WINDOW,
		reserveTokens: 44000,
		name: "GPT-6 Astra · 828k compact",
	},
	"1m": {
		label: "OpenRouter / provider 1M",
		provider: "openrouter",
		id: "openai/gpt-6-astra",
		contextWindow: OPENROUTER_ASTRA_WINDOW,
		reserveTokens: 50000,
		name: "GPT-6 Astra · OpenRouter 1M",
	},
};

type JsonObject = Record<string, unknown>;

class ConfigReadError extends Error {}

/** Missing file → {}. Unreadable or malformed file → throws (never rewrite it). */
function readJsonObject(file: string): JsonObject {
	let raw: string;
	try {
		raw = fs.readFileSync(file, "utf8");
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
		throw new ConfigReadError(`${file}: ${String(error)}`);
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch (error) {
		throw new ConfigReadError(`${file} is not valid JSON; refusing to rewrite it (${String(error)})`);
	}
	if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
		throw new ConfigReadError(`${file} top-level value is not an object; refusing to rewrite it`);
	}
	return parsed as JsonObject;
}

function writeJsonAtomic(file: string, value: unknown) {
	fs.mkdirSync(path.dirname(file), { recursive: true });
	const tmp = `${file}.ctx-picker.${process.pid}.tmp`;
	fs.writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
	fs.renameSync(tmp, file);
}

function asObject(value: unknown): JsonObject {
	return value && typeof value === "object" && !Array.isArray(value) ? (value as JsonObject) : {};
}

function isMode(value: string): value is CtxMode {
	return (MODES as string[]).includes(value);
}

function currentMode(): CtxMode {
	try {
		const stored = readJsonObject(MODE_PATH).mode;
		if (typeof stored === "string" && isMode(stored)) return stored;
	} catch {
		/* unreadable mode file → default */
	}
	return "828k";
}

function describe(mode: CtxMode): string {
	const preset = PRESETS[mode];
	return `${preset.name} · window ${preset.contextWindow} · compact at ${preset.contextWindow - preset.reserveTokens} (reserve ${preset.reserveTokens})`;
}

/**
 * Rewrite models.json + settings.json + ctx-mode.json for `mode`.
 * Reads everything first; a read failure aborts before any write.
 */
function applyMode(mode: CtxMode): Preset {
	const preset = PRESETS[mode];
	const models = readJsonObject(MODELS_PATH);
	const settings = readJsonObject(SETTINGS_PATH);
	if (Object.keys(settings).length === 0) {
		throw new ConfigReadError(`${SETTINGS_PATH} is missing or empty; refusing to create a bare settings file`);
	}

	// --- models.json: per-model overrides, preserving unrelated fields ---
	const providers = asObject(models.providers);
	const openaiCodex = asObject(providers["openai-codex"]);
	const openrouter = asObject(providers.openrouter);
	const codexWindow = mode === "272k" ? CODEX_NATIVE_WINDOW : CODEX_MAX_WINDOW;
	const codexOverrides: Record<string, JsonObject> = { ...(asObject(openaiCodex.modelOverrides) as Record<string, JsonObject>) };
	for (const id of CODEX_MODELS) {
		codexOverrides[id] = { ...asObject(codexOverrides[id]), contextWindow: codexWindow };
	}
	codexOverrides["gpt-6-astra"] = {
		...asObject(codexOverrides["gpt-6-astra"]),
		contextWindow: codexWindow,
		name: mode === "272k" ? PRESETS["272k"].name : PRESETS["828k"].name,
	};
	openaiCodex.modelOverrides = codexOverrides;
	const openrouterOverrides: Record<string, JsonObject> = { ...(asObject(openrouter.modelOverrides) as Record<string, JsonObject>) };
	openrouterOverrides["openai/gpt-6-astra"] = {
		...asObject(openrouterOverrides["openai/gpt-6-astra"]),
		contextWindow: OPENROUTER_ASTRA_WINDOW,
		name: PRESETS["1m"].name,
	};
	openrouter.modelOverrides = openrouterOverrides;
	providers["openai-codex"] = openaiCodex;
	providers.openrouter = openrouter;
	models.providers = providers;

	// --- settings.json: compaction + default model + Ctrl+P allowlist ---
	const compaction = asObject(settings.compaction);
	compaction.enabled = true;
	compaction.reserveTokens = preset.reserveTokens;
	compaction.keepRecentTokens = typeof compaction.keepRecentTokens === "number" ? compaction.keepRecentTokens : 20000;
	settings.compaction = compaction;
	settings.defaultProvider = preset.provider;
	settings.defaultModel = preset.id;
	const enabled = Array.isArray(settings.enabledModels) ? [...(settings.enabledModels as string[])] : [];
	for (const id of ["openai-codex/gpt-6-astra", "openai-codex/gpt-5.6-sol", "openrouter/openai/gpt-6-astra"]) {
		if (!enabled.includes(id)) enabled.push(id);
	}
	settings.enabledModels = enabled;

	// --- write phase (all reads succeeded) ---
	writeJsonAtomic(MODELS_PATH, models);
	writeJsonAtomic(SETTINGS_PATH, settings);
	writeJsonAtomic(MODE_PATH, {
		mode,
		contextWindow: preset.contextWindow,
		reserveTokens: preset.reserveTokens,
		compactAt: preset.contextWindow - preset.reserveTokens,
		provider: preset.provider,
		model: preset.id,
		updatedAt: new Date().toISOString(),
	});
	return preset;
}

export default function (pi: ExtensionAPI) {
	const handler = async (args: string, ctx: any) => {
		const mode = currentMode();
		const wanted = (args ?? "").trim().toLowerCase();
		let next: CtxMode | undefined;
		if (wanted === "") {
			const choices = MODES.map((key) => `${key === mode ? "●" : "○"} ${key}  ${PRESETS[key].label}`);
			const picked = await ctx.ui.select("Context window", choices);
			if (!picked) return;
			next = MODES.find((key) => picked.includes(` ${key}  `));
		} else if (isMode(wanted)) {
			next = wanted;
		} else {
			ctx.ui.notify(`Usage: /ctx [272k|828k|1m]. Current: ${mode} (${describe(mode)})`, "warning");
			return;
		}
		if (!next) return;
		const preset = PRESETS[next];

		// Verify the target is usable BEFORE anything is written.
		const model = ctx.modelRegistry?.find?.(preset.provider, preset.id);
		if (!model) {
			ctx.ui.notify(
				`/ctx ${next} not applied: ${preset.provider}/${preset.id} is not in the model catalog (OpenRouter models appear after /login openrouter). Config unchanged.`,
				"warning",
			);
			return;
		}
		const hasAuth = typeof ctx.modelRegistry?.hasConfiguredAuth === "function" ? ctx.modelRegistry.hasConfiguredAuth(model) : true;
		if (!hasAuth) {
			ctx.ui.notify(`/ctx ${next} not applied: no configured auth for ${preset.provider}/${preset.id}. Run /login ${preset.provider} first. Config unchanged.`, "warning");
			return;
		}

		let applied: Preset;
		try {
			applied = applyMode(next);
		} catch (error) {
			ctx.ui.notify(`/ctx ${next} not applied: ${error instanceof Error ? error.message : String(error)}`, "error");
			return;
		}
		if (typeof model.contextWindow === "number") model.contextWindow = applied.contextWindow;
		const ok = await pi.setModel(model);
		if (!ok) {
			ctx.ui.notify(`/ctx ${next} saved for the next launch, but switching the live session to ${preset.provider}/${preset.id} failed.`, "warning");
			return;
		}
		ctx.ui.notify(`/ctx ${next}: ${describe(next)}`, "info");
	};

	pi.registerCommand("ctx", {
		description: "Pick Codex 272k, 828k compact, or OpenRouter/provider 1M context (/ctx [272k|828k|1m])",
		handler,
	});
	pi.registerCommand("fh-ctx", {
		description: "Alias for /ctx (fusion-harness context picker)",
		handler,
	});

	// Read-only at launch: report the stored mode, never rewrite config here.
	pi.on("session_start", async (_event, ctx) => {
		const mode = currentMode();
		try {
			ctx.ui.notify(`ctx ${mode}: compact at ${PRESETS[mode].contextWindow - PRESETS[mode].reserveTokens}`, "info");
		} catch {
			/* headless */
		}
	});
}
