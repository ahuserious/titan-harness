/**
 * titan-harness — FUSE 2-5 frontier models instead of racing them. AND, not OR.
 *
 * Model stack: exactly one ARCHITECT, exactly one primary/Main BUILDER (the live
 * raw-chat host), and up to three secondary builders. Explicit YAML via --titan-config;
 * legacy two-slot flags remain compatible.
 *
 * Commands:
 *   /titan-opinion      N independent read-only opinions            (modules/cmd-readonly.ts)
 *   /titan-debate       N-way all-to-all debate, no judge           (modules/cmd-readonly.ts)
 *   /titan-fusion       N sources → sole-writer FUSION → ACKs       (modules/cmd-fusion.ts)
 *   /titan-collaborate  plans → architect DAG → readiness execution (modules/cmd-build.ts)
 *   /titan-auto-validate architect + Main gate-first build loop     (modules/cmd-build.ts)
 *   /titan-only         direct one slot or arm the next plain prompt
 *   /titan-model        slot → model → thinking picker (session-only)
 *   /titan-system-prompt · /titan-reset · /titan model-bar front door
 *
 * This file is the extension FACTORY: flags/config and stack resolution, host-model
 * selection, persistent slot sessions, live widgets + the model bar, panel plumbing,
 * and the small in-place commands. The heavy lifting lives in modules/:
 *   runtime.ts        shared types, constants, formatting, the HarnessDeps seam
 *   child-runner.ts   clean-room `pi --mode json -p` child processes
 *   prompt-library.ts every model contract (templates under prompts/)
 *   tui.ts            layout primitives, labels, live columns, the panel renderer
 *   cmd-*.ts          the orchestration commands, wired through HarnessDeps
 *
 * Safety invariant: parallel agents never mutate the same checkout. Opinion, debate,
 * fusion sources, and collaboration planning are tool-enforced read-only. The temporary
 * FUSION agent is the only /titan-fusion writer. Collaboration serializes every write-enabled
 * task through one shared-CWD writer token; no worktrees.
 *
 * UI (titan-harness edit): NO panels, grids, banners, or transcript renderers. Results
 * land in the transcript as plain markdown custom messages; while children run a single
 * status line reports progress, and the belowEditor MODEL BAR (one row per slot: model,
 * thinking, context, tps, cost — plus a FAN-OUT row) is ON by default. Pi's own footer
 * is left alone. /stack (stack-settings.ts) toggles the bar and the child tool policy.
 *
 * Every child is a `pi --mode json -p` subprocess that loads the host's extensions
 * (provider extensions such as antigravity/*) but never this package. Artifacts live under
 * /tmp/titan-harness-* and persistent slot/model sessions under
 * /tmp/titan-harness-sessions/.
 */

import { createHash, randomUUID } from "node:crypto"; // persistent session ids + project hashes
import * as fs from "node:fs"; // artifacts, session manifests
import * as os from "node:os"; // tmpdir fallback when /tmp is missing
import * as path from "node:path"; // every artifact/session path
import { performance } from "node:perf_hooks"; // host-turn TPS boundaries
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { matchesKey, truncateToWidth } from "@earendil-works/pi-tui";
import { registerAutoValidateCommand, registerCollaborateCommand } from "./modules/cmd-build.ts";
import { registerFusionCommand } from "./modules/cmd-fusion.ts";
import { registerReadonlyCommands } from "./modules/cmd-readonly.ts";
import { currentWorkflowRun, registerWorkflowCommands } from "./modules/cmd-workflow.ts";
import { createWorkflowRuntime, findBinary, runProcess } from "./modules/workflow-runtime.ts";
import { registerMonitorCommand } from "./modules/cmd-monitor.ts";
import { renderBarRow } from "./modules/monitor/frame.ts";
import { buildRunView, latestRuns, type RunView } from "./modules/monitor/rows.ts";
import { createWatchdog, type Watchdog, type WatchdogDeps } from "./modules/watchdog/index.ts";
import type { LedgerNote } from "./modules/watchdog/compaction.ts";
import { stateBlockMessage } from "./modules/watchdog/state-block.ts";
import { createPlanMode, type PlanModeState } from "./modules/plan-mode.ts";
import { registerUltraplanCommand, type ResolvedUltraplanStack } from "./modules/cmd-ultraplan.ts";
import { createMcpToolBridge, type McpToolBridge } from "./modules/mcp-client.ts";
import { registerCloudSimCommand } from "./modules/cmd-cloud-sim.ts";
import { registerCreateWorkflowCommand } from "./modules/cmd-create-workflow.ts";
import { readHarnessDefaults, registerTerraformCommand } from "./modules/cmd-terraform.ts";
import { registerLocalDevVerifyCommand } from "./modules/cmd-local-dev-verify.ts";
import { ontologyStage } from "./modules/infranodus.ts";
import { loadWorkflow } from "./modules/workflow/loader.ts";
import { executeWorkflow, type ResolvedRole, type RunResult as WorkflowRunResult } from "./modules/workflow/executor.ts";
import type { NodeDoc, SlotRole } from "./modules/workflow/schema.ts";
import type { ValidateContext } from "./modules/workflow/validator.ts";
import { normalizeThinking } from "./modules/thinking.ts";
import { piInvocation, runChild } from "./modules/child-runner.ts";
import {
	cloneStack,
	expandFanout,
	type HexColor,
	lanesFor,
	loadModelStack,
	orderedSlots,
	resolveThinking as resolveStackThinking,
	synthesizeLegacyStack,
	type ModelSlot,
	type ModelStack,
	type Thinking,
} from "./modules/model-stack.ts";
import { applyLevel, describeLevel, fanoutForStack, leaveLevel, levelCodename, listLevels, nextLevel } from "./modules/levels.ts";
import { claimShiftTab, formatDoctor, importInfranodusKey, runDoctor, shiftTabFree } from "./modules/doctor.ts";
import { checkPins, dwPatchApplied } from "./modules/pins.ts";
import { RunStore } from "./modules/run-store.ts";
import { appendLedger, formatTotals, rowFromAgentRun, totalsFor, type LedgerOrigin, type LedgerRow } from "./modules/ledger.ts";
import {
	ANSWER_MAX_BYTES,
	BOOT_TYPE,
	CUSTOM_TYPE,
	FULL_TOOLS,
	READONLY_TOOLS,
	fmtSecs,
	modelTag,
	newRun,
	fgHex,
	ROLE_COLOR,
	runError,
	runOk,
	runTps,
	THINKING_SHORT,
	toStat,
	truncateBytes,
	type AgentRun,
	type AuditRequest,
	type FhDetails,
	type HarnessDeps,
	type Role,
	type SpawnIdentity,
} from "./modules/runtime.ts";
import { auditBuilderRun as runAuditGate, hasWorkingTreeChanges } from "./modules/audit.ts";
import {
	BUILDER_FANOUT_CYCLE,
	WATCHDOG_ON_COMPACTION_MODES,
	EXA_TOOL_NAMES,
	isStackChild,
	LEVEL_CYCLE,
	modelFamily,
	nextInCycle,
	readStackSettings,
	STACK_DIR,
	STACK_MODEL_BAR_HOOK,
	STACK_SHAPE_HOOK,
	SUBAGENT_FANOUT_CYCLE,
	writeStackSettings,
} from "./modules/stack-config.ts";
import { auditorCellStr, cellStr, exaCellStr, fanOutCellStr, levelCellStr, monitorCellStr, shapeCellStr, subagentCellStr, totalsCellStr, type WatchdogCell, watchdogCellStr } from "./modules/tui.ts";
import { acquireWriterLease, type WriterLease } from "./modules/writer-lease.ts";

// ═══ 1. Defaults ═════════════════════════════════════════════════════════════

const DEFAULT_ARCHITECT = "anthropic/claude-fable-5-1"; // plans, fuses, validates
const DEFAULT_BUILDER = "openai-codex/gpt-6-astra"; // last-resort builder — an unset --builder normally follows the HOST session's model

const CHILD_TIMEOUT_S_DEFAULT = 28_800; // 8h — every spawned child; real work runs for hours (--child-timeout overrides)
const BUILD_TIMEOUT_MS_FLOOR = 28_800_000; // /titan-auto-validate builder floor — never below 8h even with a small --child-timeout
const WIDGET_TICK_MS = 1_000; // live-widget refresh cadence

// ═══ 2. Extension ════════════════════════════════════════════════════════════

export default function (pi: ExtensionAPI) {
	// A harness child loads the host's extensions for their providers; it must never
	// become a harness itself (commands, hooks, status bars, session bookkeeping).
	if (isStackChild()) return;

	// ── 2.1 Flags ──────────────────────────────────────────────
	pi.registerFlag("titan-config", {
		type: "string",
		description: "Explicit path to .pi/titan-harness/model-stack-<codename>.yaml (2-5 slots, exactly one architect and one primary builder).",
	});
	pi.registerFlag("architect", {
		type: "string",
		description: `ARCHITECT model (provider/id) — legacy two-slot mode. Default ${DEFAULT_ARCHITECT}.`,
	});
	pi.registerFlag("builder", {
		type: "string",
		description: `BUILDER model (provider/id) — builds. Default ${DEFAULT_BUILDER}.`,
	});
	pi.registerFlag("max-validations", {
		type: "string",
		description: "Max gate validations (build attempts) for /titan-auto-validate before development halts. Default 5. Also overridable inline: /titan-auto-validate --max-validations 3 <prompt>.",
	});
	pi.registerFlag("escalate-to-validator-count", {
		type: "string",
		description:
			"On the Nth gate failure, escalate: the VALIDATOR inspects the builder's work and writes a directed triage brief that accompanies the raw gate output. Default 3. Inline-overridable per command.",
	});
	pi.registerFlag("architect-system-prompt", {
		type: "string",
		description:
			"Override the system prompt for ARCHITECT-family worker/titan-fusion agents (inline text, or a path to a file). VALIDATOR/TRIAGE keep their SYSTEM_PROMPT_*.md contracts — edit those files to tune them.",
	});
	pi.registerFlag("builder-system-prompt", {
		type: "string",
		description: "Override the system prompt for all BUILDER agents (inline text, or a path to a file).",
	});
	pi.registerFlag("architect-thinking", {
		type: "string",
		description: "Thinking level for EVERY architect-family execution (worker/titan-fusion/validator/triage): off|minimal|low|medium|high|xhigh|max. Default medium.",
	});
	pi.registerFlag("builder-thinking", {
		type: "string",
		description: "Thinking level for EVERY builder execution: off|minimal|low|medium|high|xhigh|max. Default medium.",
	});
	pi.registerFlag("rounds", {
		type: "string",
		description:
			"Round count for /titan-debate (clamp 1-10; default 3, minimum 2). Inline-overridable: /titan-debate --rounds 2 <prompt>.",
	});
	pi.registerFlag("child-timeout", {
		type: "string",
		description:
			"Timeout in SECONDS for every spawned child agent (/titan-opinion + /titan-fusion workers, the FUSION merge, /titan-auto-validate builder rounds and validator). Default 28800 (8h), clamp 10-86400 (24h); the /titan-auto-validate builder never drops below the 8h floor. Real work runs for hours — don't starve it.",
	});

	// ── 2.2 Flag readers + configured stack ────────────────────

	/** A string flag's trimmed value, or "" when unset. */
	const flagStr = (name: string): string => {
		const v = pi.getFlag(name);
		return typeof v === "string" ? v.trim() : "";
	};
	// Pi resolves extension flags after the factory registers them. process.argv lets the
	// config schema fail during extension load as requested, while getFlag remains canonical
	// for normal lazy reads.
	const rawCliFlag = (name: string): string => {
		const long = `--${name}`;
		for (let i = 0; i < process.argv.length; i++) {
			if (process.argv[i] === long) return process.argv[i + 1]?.trim() ?? "";
			if (process.argv[i].startsWith(`${long}=`)) return process.argv[i].slice(long.length + 1).trim();
		}
		return "";
	};
	// Custom extension flags are populated after the factory registers them, so config loading
	// must be lazy (session_start / first command), not eager during factory evaluation.
	let configLoaded = false;
	let configuredStack: ModelStack | undefined;
	let stackReadyError: string | undefined;
	const ensureConfigLoaded = () => {
		if (configLoaded) return;
		configLoaded = true;
		const configPath = flagStr("titan-config") || rawCliFlag("titan-config");
		if (!configPath) return;
		const conflicts = ["architect", "builder", "architect-thinking", "builder-thinking", "architect-system-prompt", "builder-system-prompt"].filter((name) => flagStr(name) || rawCliFlag(name));
		if (conflicts.length) {
			stackReadyError = `titan-harness: --titan-config cannot be combined with legacy role flags: ${conflicts.map((name) => `--${name}`).join(", ")}`;
			throw new Error(stackReadyError);
		}
		try {
			configuredStack = cloneStack(loadModelStack(configPath));
		} catch (error) {
			stackReadyError = error instanceof Error ? error.message : String(error);
			throw error;
		}
	};
	if (rawCliFlag("titan-config")) {
		try {
			ensureConfigLoaded();
		} catch (error) {
			process.exitCode = 1;
			throw error;
		}
	}
	const architectModel = () => {
		ensureConfigLoaded();
		return configuredStack?.architect.model ?? (flagStr("architect") || DEFAULT_ARCHITECT);
	};

	/**
	 * The HOST's live model (`provider/id`), refreshed from whatever context we're handed.
	 * The BUILDER *is* the host's agent, so an unset --builder should follow the session you
	 * actually launched — not a hardcoded vendor default. That makes the harness runnable with
	 * ONE flag: set --architect (the fusion model) and the builder rides pi's own default.
	 */
	let hostModel: string | undefined;
	let hostCtx: any; // the latest session ctx — registry + auth lookups for shapes and auditors
	const noteHost = (ctx: any): void => {
		ensureConfigLoaded();
		if (stackReadyError) throw new Error(stackReadyError);
		if (ctx?.modelRegistry) hostCtx = ctx;
		try {
			if (ctx?.model?.provider && ctx?.model?.id) hostModel = `${ctx.model.provider}/${ctx.model.id}`;
		} catch {
			/* no model on this context — keep the last known one */
		}
	};
	/** Is `provider/id` in the catalog with configured auth? (false until a ctx is known) */
	const modelUsable = (model: string): boolean => {
		try {
			const slash = model.indexOf("/");
			const found = slash > 0 ? hostCtx?.modelRegistry?.find?.(model.slice(0, slash), model.slice(slash + 1)) : undefined;
			return !!found && !!hostCtx.modelRegistry.hasConfiguredAuth(found);
		} catch {
			return false;
		}
	};
	// Precedence: explicit --builder > the host session's live model > the shipped default.
	const builderModel = () => {
		ensureConfigLoaded();
		return configuredStack?.primaryBuilder.model ?? (flagStr("builder") || hostModel || DEFAULT_BUILDER);
	};

	/** --<role>-system-prompt: inline text, or a file path (file contents win if it exists). */
	const roleSystemPrompt = (role: "architect" | "builder"): string | undefined => {
		ensureConfigLoaded();
		if (configuredStack) return role === "architect" ? configuredStack.architect.systemPrompt : configuredStack.primaryBuilder.systemPrompt;
		const v = flagStr(`${role}-system-prompt`);
		if (!v) return undefined;
		try {
			if (fs.existsSync(v) && fs.statSync(v).isFile()) return fs.readFileSync(v, "utf-8");
		} catch {
			/* treat as inline text */
		}
		return v;
	};

	/**
	 * pi's own buildSystemPrompt(), for /titan-system-prompt: when a role has no override, the
	 * prompt its children actually run with is pi's DEFAULT — which the package builds at
	 * spawn time and does not re-export from its main entry. Import it straight from the
	 * running pi installation's dist (a file URL bypasses the "exports" map); a bun-compiled
	 * binary has no real dist on disk, so this resolves undefined and the caller falls back.
	 */
	let buildSystemPromptLoad: Promise<((o: Record<string, unknown>) => string) | undefined> | undefined;
	const loadBuildSystemPrompt = (): Promise<((o: Record<string, unknown>) => string) | undefined> => {
		buildSystemPromptLoad ??= (async () => {
			try {
				const script = process.argv[1];
				if (!script || script.startsWith("/$bunfs/")) return undefined;
				const real = await fs.promises.realpath(script);
				const mod = await import(new URL(`file://${path.join(path.dirname(real), "core", "system-prompt.js")}`).href);
				return typeof mod.buildSystemPrompt === "function" ? mod.buildSystemPrompt : undefined;
			} catch {
				return undefined;
			}
		})();
		return buildSystemPromptLoad;
	};

	/** --child-timeout: seconds before ANY spawned child agent is killed. Default 28800 (8h), clamp 10-86400 (24h). */
	const childTimeoutMs = (): number => {
		const v = Number.parseInt(flagStr("child-timeout"), 10);
		const s = Number.isFinite(v) && v > 0 ? Math.max(10, Math.min(v, 86_400)) : CHILD_TIMEOUT_S_DEFAULT;
		return s * 1000;
	};
	/** The /titan-auto-validate builder does real work — never below the 8h floor, even with a small --child-timeout. */
	const buildTimeoutMs = (): number => Math.max(childTimeoutMs(), BUILD_TIMEOUT_MS_FLOOR);

	/** --<role>-thinking: one thinking level for EVERY execution of that model. Default medium. */
	const THINKING_LEVELS: Thinking[] = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];
	/**
	 * Accept BOTH the canonical level and the short form the footer prints (`high` and `hi`,
	 * `medium` and `med`, `off` and `none`, …). The footer only ever shows the short form, so
	 * refusing it would mean rejecting the exact word the UI just displayed.
	 */
	const THINKING_ALIAS: Record<string, Thinking> = {};
	for (const level of THINKING_LEVELS) {
		THINKING_ALIAS[level] = level;
		const short = THINKING_SHORT[level];
		if (short) THINKING_ALIAS[short] = level;
	}
	const resolveThinking = (raw: string): Thinking | undefined => THINKING_ALIAS[raw.trim().toLowerCase()];

	/** Legacy role-thinking overrides; configured stacks use per-slot values and /titan-model. */
	const thinkingOverride: Partial<Record<"architect" | "builder", Thinking>> = {};
	const roleThinking = (role: "architect" | "builder"): Thinking => {
		ensureConfigLoaded();
		if (configuredStack) return role === "architect" ? configuredStack.architect.thinking : configuredStack.primaryBuilder.thinking;
		const override = thinkingOverride[role];
		if (override) return override;
		// The boot flags take the same aliases, so `--architect-thinking hi` works too.
		return resolveThinking(flagStr(`${role}-thinking`)) ?? "medium";
	};

	const baseStack = (): ModelStack => {
		ensureConfigLoaded();
		return configuredStack ??
		synthesizeLegacyStack({
			architectModel: architectModel(),
			builderModel: builderModel(),
			architectThinking: roleThinking("architect"),
			builderThinking: roleThinking("builder"),
			architectSystemPrompt: roleSystemPrompt("architect"),
			builderSystemPrompt: roleSystemPrompt("builder"),
		});
	};

	// ── 2.2b The SHAPE: builder fan-out n, auditors, shape cycling (titan-harness) ──
	// Tier 1 ARCHITECT, tier 2 BUILDERS (n = settings.builderFanOut), tier 3 subagents via
	// pi-subagents inside every child. Extra builders beyond the YAML come from a
	// heterogeneous pool (correlated-failure hedge); surplus YAML builders are parked.
	const BUILDER_POOL = ["xai/grok-4.6", "antigravity/claude-opus-4-6", "antigravity/gemini-3.8-flash", "openai-codex/gpt-6-astra", "openai-codex/gpt-5.6-terra", "anthropic/claude-fable-5-1"];
	const BUILDER_NAMES = ["forge", "anvil", "mason", "welder"];
	const BUILDER_COLORS: HexColor[] = ["#F59E0B", "#22D3EE", "#F472B6", "#FB923C"];
	// Auditors: cross-family relative to the builder under review (and, when possible, the
	// architect), so a model never grades its own family's work.
	const AUDITOR_POOL = ["antigravity/claude-opus-4-6", "antigravity/gemini-3.8-flash", "xai/grok-4.6", "openai-codex/gpt-6-astra", "anthropic/claude-fable-5-1"];
	const AUDITOR_NAMES = ["ward", "sentinel", "warden", "arbiter"];
	/**
	 * Fallback resolution for schema-v2 shapes: a slot whose model is not usable takes
	 * its declared `fallback` when that is usable (recorded as substitutedFrom); an
	 * `optional` slot with no usable model is dropped as vacant. The judge and the
	 * fuser never share a model after resolution. Returns human-readable notes.
	 */
	const FUSER_FALLBACK_ORDER = ["antigravity/claude-opus-4-6", "xai/grok-4.6", "antigravity/gemini-3.8-flash"];
	const resolveFallbacks = (stack: ModelStack): string[] => {
		if (stack.version !== 2) return [];
		const notes: string[] = [];
		for (const slot of stack.slots) {
			if (slot.model === "auto") continue; // resolved below, once the builders are known
			if (modelUsable(slot.model)) continue;
			if (slot.fallback && modelUsable(slot.fallback)) {
				notes.push(`${slot.name}: ${slot.model} → ${slot.fallback} (fallback)`);
				(slot as any).substitutedFrom = slot.model;
				slot.model = slot.fallback;
				continue;
			}
			if (slot.optional) {
				notes.push(`${slot.name}: vacant (${slot.model} not usable)`);
				(slot as any).vacant = true;
			}
		}
		// `model: auto` (auditor slots only): a cross-family pick relative to the primary
		// builder and the architect after their own substitution; no cross-family model
		// authed → the slot goes vacant with a note (the per-builder auditors still apply).
		for (const slot of stack.slots) {
			if (slot.model !== "auto") continue;
			const primary = stack.slots.find((candidate) => candidate.primary && !(candidate as any).vacant) ?? stack.primaryBuilder;
			const builderFamily = modelFamily(primary.model);
			const architectFamily = modelFamily(stack.architect.model);
			const pick =
				AUDITOR_POOL.find((candidate) => modelFamily(candidate) !== builderFamily && modelFamily(candidate) !== architectFamily && modelUsable(candidate)) ??
				AUDITOR_POOL.find((candidate) => modelFamily(candidate) !== builderFamily && modelUsable(candidate));
			if (pick) {
				notes.push(`${slot.name}: auto → ${pick} (cross-family auditor)`);
				(slot as any).substitutedFrom = "auto";
				slot.model = pick;
			} else {
				notes.push(`${slot.name}: vacant (no cross-family auditor authed)`);
				(slot as any).vacant = true;
			}
		}
		const judge = stack.lanes.judge;
		const fuser = stack.lanes.fuser;
		if (judge && fuser && !(judge as any).vacant && !(fuser as any).vacant && judge.model === fuser.model) {
			const alternative = FUSER_FALLBACK_ORDER.find((candidate) => candidate !== judge.model && modelUsable(candidate));
			if (alternative) {
				notes.push(`${fuser.name}: ${fuser.model} → ${alternative} (judge and fuser must differ)`);
				(fuser as any).substitutedFrom = fuser.model;
				fuser.model = alternative;
			}
		}
		const kept = stack.slots.filter((slot) => !(slot as any).vacant);
		if (kept.length !== stack.slots.length) {
			stack.slots = kept;
			stack.builders = kept.filter((slot) => !slot.architect);
			stack.lanes = lanesFor(kept);
		}
		return notes;
	};
	const applyShape = (base: ModelStack): ModelStack => {
		const n = readStackSettings().builderFanOut;
		const stack = cloneStack(base);
		if (stack.version === 2) {
			// Schema v2: lanes are templates; the builder pool expands by the builder fan-out,
			// further builder templates keep their own fanout, and a level without builders
			// (0 and 1) runs its primary worker as the host builder so every command still works.
			const [first, ...rest] = stack.lanes.builders;
			let builders: ModelSlot[] = first ? [...expandFanout(first, Math.max(1, n)), ...rest.flatMap((template) => expandFanout(template, Math.max(1, template.fanout ?? 1)))] : [];
			const primary = stack.slots.find((slot) => slot.primary) ?? stack.primaryBuilder;
			if (!builders.some((slot) => slot.primary)) builders = [primary, ...builders.filter((slot) => slot.id !== primary.id)];
			const primaryBuilder = builders.find((slot) => slot.primary) ?? builders[0];
			const slots = [stack.architect, ...builders];
			return { ...stack, slots, builders, primaryBuilder };
		}
		const extras = stack.builders.filter((slot) => !slot.primary);
		const builders: ModelSlot[] = [stack.primaryBuilder, ...extras.slice(0, Math.max(0, n - 1))];
		if (builders.length < n) {
			const used = new Set(stack.slots.map((slot) => slot.model));
			const takenNames = new Set(stack.slots.map((slot) => slot.name.toLowerCase()));
			const takenIds = new Set(stack.slots.map((slot) => slot.id));
			let index = extras.length;
			for (const model of BUILDER_POOL) {
				if (builders.length >= n) break;
				if (used.has(model) || !modelUsable(model)) continue;
				used.add(model);
				// First pool callsign the YAML did not already use (a YAML "anvil" must not
				// be duplicated by a pool "anvil"); ids stay unique too.
				const name = BUILDER_NAMES.find((candidate) => !takenNames.has(candidate)) ?? `builder-${index + 1}`;
				takenNames.add(name);
				let id = `builder-${index + 1}`;
				while (takenIds.has(id)) id = `${id}x`;
				takenIds.add(id);
				builders.push({
					id,
					name,
					model,
					thinking: "high",
					color: BUILDER_COLORS[index % BUILDER_COLORS.length],
					architect: false,
					primary: false,
					systemPrompt: stack.primaryBuilder.systemPrompt,
					appendSystemPrompts: [...stack.primaryBuilder.appendSystemPrompts],
				});
				index++;
			}
		}
		return { ...stack, slots: [stack.architect, ...builders], builders };
	};
	const modelStack = (): ModelStack => applyShape(baseStack());
	const shapeName = (): string => configuredStack?.codename ?? "legacy";
	const auditorState = new Map<string, string>();
	const auditorFor = (builder: ModelSlot): ModelSlot => {
		const s = readStackSettings();
		const stack = modelStack();
		const index = Math.max(0, stack.builders.findIndex((slot) => slot.id === builder.id));
		let model = s.auditorModel;
		if (model === "auto") {
			const builderFamily = modelFamily(builder.model);
			const architectFamily = modelFamily(stack.architect.model);
			model =
				AUDITOR_POOL.find((candidate) => modelFamily(candidate) !== builderFamily && modelFamily(candidate) !== architectFamily && modelUsable(candidate)) ??
				AUDITOR_POOL.find((candidate) => modelFamily(candidate) !== builderFamily && modelUsable(candidate)) ??
				stack.architect.model;
		}
		return { id: `${builder.id}-audit`, name: AUDITOR_NAMES[index] ?? `auditor-${index + 1}`, model, thinking: s.auditorThinking as Thinking, color: "#9CA3AF", architect: false, primary: false, appendSystemPrompts: [] };
	};
	const auditorsFor = (stack: ModelStack): ModelSlot[] => (readStackSettings().auditor ? stack.builders.map(auditorFor) : []);
	/** Codenames of every model-stack-*.yaml in ~/.pi/titan-harness, plus "legacy". */
	const listShapes = (): string[] => {
		let names: string[] = [];
		try {
			names = fs
				.readdirSync(STACK_DIR)
				.filter((file) => /^model-stack-.+\.ya?ml$/.test(file))
				.map((file) => file.replace(/^model-stack-/, "").replace(/\.ya?ml$/, ""))
				.sort();
		} catch {
			/* no stack dir */
		}
		return ["legacy", ...names.filter((name) => name !== "legacy")];
	};
	let lastFallbackNotes: string[] = []; // substitutions the last shape load made (shown once by announce)
	const stackProblems = (stack: ModelStack): string[] =>
		stack.slots.map((slot) => (modelUsable(slot.model) ? "" : `${slot.name}: ${slot.model} is not usable (not in catalog or not authed)`)).filter(Boolean);
	/** Switch the live shape (session-only) and persist the codename. */
	const loadShape = async (codename: string, ctx: any, switchHost = true): Promise<string[]> => {
		noteHost(ctx);
		if (codename === "legacy") {
			configuredStack = undefined;
			leaveLevel("legacy");
			return [];
		}
		let stack: ModelStack;
		try {
			stack = cloneStack(loadModelStack(path.join(STACK_DIR, `model-stack-${codename}.yaml`)));
		} catch (error) {
			return [error instanceof Error ? error.message : String(error)];
		}
		lastFallbackNotes = resolveFallbacks(stack);
		const problems = stackProblems(stack);
		if (problems.length) return problems;
		configuredStack = stack;
		// A level shape carries its own fan-out pools, review policy and watchdog default;
		// any other shape ends the active level (the LEVEL row then reads "shape <name>").
		if (stack.version === 2 && typeof stack.level === "number") {
			try {
				applyLevel(stack.level, stack);
			} catch {
				writeStackSettings({ shape: codename }); /* settings write is best effort; the shape is live regardless */
			}
		} else {
			leaveLevel(codename);
		}
		if (!switchHost) return [];
		const primary = stack.primaryBuilder;
		try {
			const slash = primary.model.indexOf("/");
			const model = ctx.modelRegistry.find(primary.model.slice(0, slash), primary.model.slice(slash + 1));
			if (model && !(ctx.model && `${ctx.model.provider}/${ctx.model.id}` === primary.model)) {
				if (await pi.setModel(model)) {
					hostModel = primary.model;
					pi.setThinkingLevel(primary.thinking);
				}
			}
		} catch {
			/* host model switch is best effort */
		}
		return [];
	};

	let childVisibleModelsPromise: Promise<Set<string>> | undefined;
	const childVisibleModels = async (): Promise<Set<string>> => {
		childVisibleModelsPromise ??= (async () => {
			const invocation = piInvocation(["--list-models"]);
			const result = await pi.exec(invocation.command, invocation.args, { timeout: 30_000 });
			if (result.code !== 0) throw new Error(`child model catalogue failed: ${result.stderr || result.stdout}`);
			const models = new Set<string>();
			for (const line of result.stdout.split("\n").slice(1)) {
				const [provider, model] = line.trim().split(/\s+/);
				if (provider && model) models.add(`${provider}/${model}`);
			}
			return models;
		})();
		return childVisibleModelsPromise;
	};

	// A configured stack is a declaration that every slot is runnable. Resolve/auth-check
	// both the parent registry and the clean-room child catalogue, then make Main the host.
	pi.on("session_start", async (_ev: any, ctx: any) => {
		ensureConfigLoaded();
		if (!configuredStack) return;
		const errors: string[] = [];
		const resolved = new Map<string, any>();
		let childCatalogue = new Set<string>();
		try {
			childCatalogue = await childVisibleModels();
		} catch (error) {
			errors.push(error instanceof Error ? error.message : String(error));
		}
		for (const slot of orderedSlots(configuredStack)) {
			const slash = slot.model.indexOf("/");
			const model = slash > 0 ? ctx.modelRegistry.find(slot.model.slice(0, slash), slot.model.slice(slash + 1)) : undefined;
			if (!model) errors.push(`${slot.name}: model is not registered: ${slot.model}`);
			else if (!ctx.modelRegistry.hasConfiguredAuth(model)) errors.push(`${slot.name}: no configured authentication for ${slot.model}`);
			else if (!childCatalogue.has(slot.model)) errors.push(`${slot.name}: ${slot.model} is not visible to child pi processes (pi --list-models)`);
			else resolved.set(slot.id, model);
		}
		if (!errors.length) {
			const current = ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : "";
			if (current !== configuredStack.primaryBuilder.model) {
				const selected = await pi.setModel(resolved.get(configuredStack.primaryBuilder.id));
				if (!selected) errors.push(`Main builder could not become host model: ${configuredStack.primaryBuilder.model}`);
			}
		}
		if (!errors.length) pi.setThinkingLevel(configuredStack.primaryBuilder.thinking);
		if (errors.length) {
			process.exitCode = 1;
			stackReadyError = `titan-harness: configured model stack is not runnable:\n${errors.map((error) => `- ${error}`).join("\n")}`;
			try {
				ctx.ui.notify(stackReadyError, "error");
			} catch {}
			ctx.shutdown?.();
			throw new Error(stackReadyError);
		}
		noteHost(ctx);
	});

	// ── 2.3 Shared live state (widget + footer read this) ──────
	// Left cell = ARCHITECT-family (ARCHITECT/FUSION/VALIDATOR), right cell = BUILDER.
	let liveRuns: AgentRun[] = []; // whatever the current command is running (empty when idle)
	const sideOf = (r: AgentRun): "left" | "right" => (r.role === "BUILDER" ? "right" : "left");
	// Last finished run per side — keeps the footer's context bar alive between commands.
	const sideLast: { left?: AgentRun; right?: AgentRun } = {};
	const slotLast = new Map<string, AgentRun>();

	// Per-slot session PERF — speed, cost, and volume together, one bucket per row:
	// Σ output tokens / Σ provider-response seconds / Σ cost across every absorbed child
	// run, plus the HOST's own raw-chat turns (credited to the primary/Main slot below).
	// Session tps per slot = tokens/seconds (throughput-weighted, like the tps
	// extension's atps — never a mean of per-run readings).
	const slotPerf = new Map<string, { outputTokens: number; seconds: number; costUsd: number }>();
	// A run object is cumulative across its command's rounds, so it must fold into
	// slotPerf exactly ONCE — at widget stop — even if a stop path ever ran twice.
	const absorbedRuns = new WeakSet<AgentRun>();
	const bumpSlotPerf = (slotId: string, outputTokens: number, seconds: number, costUsd: number) => {
		const perf = slotPerf.get(slotId) ?? { outputTokens: 0, seconds: 0, costUsd: 0 };
		perf.outputTokens += outputTokens;
		perf.seconds += seconds;
		perf.costUsd += costUsd;
		slotPerf.set(slotId, perf);
	};

	const absorbTotals = (runs: AgentRun[]) => {
		for (const r of runs) {
			if (r.slot && !absorbedRuns.has(r)) {
				absorbedRuns.add(r);
				bumpSlotPerf(r.slot.id, r.tokensOut, r.tpsSeconds, r.costUsd);
				recordRun(r);
			}
			// FUSION is a FRESH throwaway session by design and runs LAST in /titan-fusion — letting
			// it become sideLast would pin the left cell to a session that no longer exists and
			// overwrite the persistent ARCHITECT brain's real context with the merge's ~2%.
			// ARCHITECT/VALIDATOR/TRIAGE all share the one persistent architect session, so
			// only they may speak for the left cell.
			if (r.role === "FUSION") continue;
			if (r.ctxTokens || r.status !== "pending") {
				sideLast[sideOf(r)] = r;
				if (r.slot) slotLast.set(r.slot.id, r);
			}
		}
	};

	// The HOST's raw-chat turns are the Main slot working too — measure them with the
	// tps extension's boundary (monotonic before_provider_request → assistant
	// message_end; turn_start is the fallback) and credit tokens/seconds/cost to the
	// primary slot's perf bucket. Pi's message_start is NOT a safe first-token clock:
	// providers can buffer output before opening it, producing absurd 10k+ TPS readings.
	let hostRequestStart: number | undefined;
	let hostTurnStart: number | undefined;
	pi.on("turn_start", async () => {
		hostTurnStart = performance.now();
		hostRequestStart = undefined;
	});
	pi.on("before_provider_request", async () => {
		hostRequestStart = performance.now();
	});
	pi.on("message_end", async (event: any) => {
		if (event.message?.role !== "assistant") return;
		const endedAt = performance.now();
		const startedAt = hostRequestStart ?? hostTurnStart;
		hostRequestStart = undefined;
		hostTurnStart = undefined;
		const output = event.message.usage?.output || 0;
		if (startedAt === undefined || output <= 0) return;
		try {
			const primary = modelStack().primaryBuilder;
			const seconds = Math.max(0, endedAt - startedAt) / 1000;
			const usage = event.message.usage ?? {};
			bumpSlotPerf(primary.id, output, seconds, usage.cost?.total || 0);
			const model = hostModel ?? primary.model;
			const level = String(pi.getThinkingLevel?.() ?? primary.thinking);
			ledger({
				agentId: "host",
				callsign: primary.name,
				role: "host",
				model,
				provider: model.split("/")[0] ?? "?",
				thinking: { requested: level, effective: level },
				tokens: { input: (usage.input || 0) + (usage.cacheRead || 0) + (usage.cacheWrite || 0), output, cacheRead: usage.cacheRead || 0, cacheWrite: usage.cacheWrite || 0 },
				costUsd: usage.cost?.total || 0,
				source: "observed",
				origin: "host",
				tpsSeconds: seconds,
			});
		} catch {
			/* stack not resolvable yet — skip this turn's sample */
		}
	});

	// ── 2.4 Per-app-run slot sessions ──────────────────────────
	// A slot keeps ONE session across every command within a single pi launch — and
	// quitting the app discards every slot brain. Restarting must never resume
	// yesterday's transcripts (user direction 2026-08-18: v1 persisted ids on disk
	// across restarts, and freshly-launched agents greeted prompts with "already read
	// earlier this session"). Ids are minted in-memory per process; session files land
	// under a per-process run dir that is removed at shutdown. Cross-model keying is
	// unchanged: a /titan-model swap mid-run still mints a separate brain per slot+model.
	// (FUSION stays fresh per command — the merge judges answers without contamination.)

	// Per-run artifacts land under /tmp/titan-harness-* (the spec'd, inspectable location —
	// note os.tmpdir() on macOS is /var/folders/…, so we pin /tmp explicitly).
	const ARTIFACT_ROOT = fs.existsSync("/tmp") ? "/tmp" : os.tmpdir();

	const projectSlug = (cwd: string): string => {
		let canonical = path.resolve(cwd);
		try { canonical = fs.realpathSync.native(canonical); } catch {}
		const readable = canonical.replace(/[^a-zA-Z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(-40) || "root";
		const hash = createHash("sha256").update(canonical).digest("hex").slice(0, 12);
		return `${readable}-${hash}`;
	};
	const sessionsRootFor = (cwd: string): string => path.join(ARTIFACT_ROOT, "titan-harness-sessions", projectSlug(cwd));
	// One run dir per PROCESS: concurrent harness launches on the same project can never
	// share (or clobber) each other's session files, and a restart starts from nothing.
	const runSessionDirs = new Set<string>();
	const runSessionsRoot = (cwd: string): string => path.join(sessionsRootFor(cwd), `run-${process.pid}`);
	// Keyed per slot AND model: a transcript built under one model must never be replayed
	// as another model's own history. Observed live: a sonnet-5-built architect session
	// (full of "You are the ARCHITECT agent (anthropic/claude-sonnet-5)" turns) replayed
	// into claude-fable-5 tripped Anthropic's usage-policy classifier — every request
	// BLOCKED at the API, even "/titan-opinion hello" — while the identical prompt on a fresh
	// fable session passed. Swapping models mid-run mints a separate brain for that model.
	const slotSessions: Record<string, { id: string; dir: string }> = {};
	const slotKey = (slot: ModelSlot): string => `${slot.id}:${modelTag(slot.model)}:${createHash("sha256").update(slot.model).digest("hex").slice(0, 12)}`;
	const slotSession = (slot: ModelSlot, cwd: string): { id: string; dir: string } => {
		const key = slotKey(slot);
		const cached = slotSessions[key];
		if (cached) return cached;
		// Fresh id EVERY process — never read from disk, so a restart cannot resume.
		const dir = path.join(runSessionsRoot(cwd), slot.id);
		fs.mkdirSync(dir, { recursive: true });
		runSessionDirs.add(runSessionsRoot(cwd));
		slotSessions[key] = { id: randomUUID(), dir };
		return slotSessions[key];
	};
	// Best-effort cleanup: quitting the app deletes this run's session files outright.
	pi.on("session_shutdown", async () => {
		for (const dir of runSessionDirs) {
			await fs.promises.rm(dir, { recursive: true, force: true }).catch(() => {});
		}
		runSessionDirs.clear();
	});
	const roleSlot = (side: "architect" | "builder"): ModelSlot => (side === "architect" ? modelStack().architect : modelStack().primaryBuilder);
	const roleSession = (side: "architect" | "builder", cwd: string): { id: string; dir: string } => slotSession(roleSlot(side), cwd);
	/** Session id for summaries — cache-only, never mints a session. */
	const cachedSlotId = (slot: ModelSlot): string | undefined => slotSessions[slotKey(slot)]?.id;
	const cachedRoleId = (side: "architect" | "builder"): string | undefined => cachedSlotId(roleSlot(side));

	/** Wipe THIS run's slot sessions (disk + in-memory, all models) — shared by /titan-reset and /new. */
	const resetRoleSessions = async (cwd: string): Promise<string> => {
		const root = runSessionsRoot(cwd);
		await fs.promises.rm(root, { recursive: true, force: true }).catch(() => {});
		// Opportunistic sweep: run dirs left behind by dead processes (crashes never get
		// their shutdown cleanup). Only dead pids — a concurrent live harness keeps its brains.
		try {
			for (const entry of await fs.promises.readdir(sessionsRootFor(cwd))) {
				const pid = Number(entry.replace(/^run-/, ""));
				if (!entry.startsWith("run-") || !Number.isInteger(pid) || pid === process.pid) continue;
				try {
					process.kill(pid, 0);
				} catch {
					await fs.promises.rm(path.join(sessionsRootFor(cwd), entry), { recursive: true, force: true }).catch(() => {});
				}
			}
		} catch {
			/* nothing to sweep */
		}
		for (const key of Object.keys(slotSessions)) delete slotSessions[key];
		sideLast.left = undefined;
		sideLast.right = undefined;
		slotLast.clear();
		slotPerf.clear(); // fresh memories, fresh speed/cost stats
		return root;
	};

	// ── /new resets the role brains too ─────────────────────────
	// Pi's built-in /new gives the HOST a fresh session, but the ARCHITECT (and the
	// headless-fallback BUILDER) children resume their persistent per-project sessions —
	// without this hook they'd drag the old context straight into the "new" conversation.
	// So a /new also does the /titan-reset work. `reason` distinguishes the user's /new from
	// startup/reload/resume/fork, where persisting across restarts is the whole design.
	pi.on("session_start", async (ev: any, ctx: any) => {
		if (ev?.reason !== "new") return;
		// Silent by design (user preference): a fresh session resetting the role brains is
		// the expected behavior, not news. /titan-reset keeps its notify — it's an explicit ask.
		await resetRoleSessions(ctx.cwd);
	});

	/**
	 * The BUILDER is the HOST's agent: launch recipes set the host --model to the builder
	 * model, so raw (non-slash) input IS the builder, natively. Builder children therefore
	 * FORK the host session — inheriting every raw chat turn and every panel — instead of
	 * keeping a separate brain.
	 *
	 * The builder must ALWAYS land in a brain that persists across commands. Pi only
	 * flushes the host session file on the host's first ASSISTANT message (session-manager
	 * `_persist`) — appended panels don't trigger it — so a session driven purely by slash
	 * commands has a session PATH but no file to fork. In that window the only way to give
	 * the builder a memory is the manifest-pinned persistent session; handing it a fresh
	 * throwaway instead makes it amnesiac on every command (a visible ~1k cold-start prompt
	 * each time, while the ARCHITECT accumulates in its own persistent session).
	 */
	const builderSpawn = (ctx: any, artifactsDir: string): SpawnIdentity => {
		let hostFile: string | undefined;
		try {
			hostFile = ctx.sessionManager.getSessionFile?.();
		} catch {
			/* treat as sessionless */
		}
		// Host session on disk → fork it: that IS the shared brain (raw chat + every panel).
		if (hostFile) {
			let flushed = false;
			try {
				flushed = fs.existsSync(hostFile) && fs.statSync(hostFile).size > 0;
			} catch {
				/* not flushed yet */
			}
			if (flushed) return { fork: hostFile, sessionDir: path.join(artifactsDir, "builder") };
		}
		// No host file yet (slash-commands-only session) or no host session at all
		// (--no-session / headless): fall back to the persistent builder session so the
		// builder still remembers across commands. Once the host does flush, builder
		// children move to forking it — a promotion to the intended shared brain, whose
		// transcript already carries the panels from these earlier commands; only the
		// child's own verbose turns (throwaway by design) are left behind.
		const s = roleSession("builder", ctx.cwd);
		return { sessionDir: s.dir, sessionId: s.id };
	};

	const newSlotRun = (slot: ModelSlot): AgentRun => newRun(slot.architect ? "ARCHITECT" : "BUILDER", slot.model, slot);
	const slotInitialSpawn = (slot: ModelSlot, ctx: any, artifactsDir: string): SpawnIdentity => {
		if (slot.primary) return builderSpawn(ctx, artifactsDir);
		const session = slotSession(slot, ctx.cwd);
		return { sessionDir: session.dir, sessionId: session.id };
	};
	const slotNextSpawn = (slot: ModelSlot, run: AgentRun, initial: SpawnIdentity, ctx: any): SpawnIdentity => {
		if (run.sessionRef) return { sessionDir: initial.sessionDir, resume: run.sessionRef };
		if (slot.primary) return initial;
		const session = slotSession(slot, ctx.cwd);
		return { sessionDir: session.dir, sessionId: session.id };
	};

	// ── 2.4b Level snapshot + session totals (the LEVEL and Σ TOTALS rows) ──
	const shiftTabBound = shiftTabFree().free; // decided at load: Pi drops an extension shift+tab binding unless the user rebound app.thinking.cycle
	const terraformPackMissing = (cwd: string): boolean => {
		try {
			return !fs.existsSync(path.join(cwd, ".titan", "terraform", "entity.md"));
		} catch {
			return true;
		}
	};
	const levelSnapshot = (ctx: any) => {
		const s = readStackSettings();
		let stack: ModelStack | undefined;
		try {
			stack = modelStack();
		} catch {
			stack = undefined;
		}
		const v2 = stack?.version === 2 ? stack : undefined;
		const level = v2?.level ?? s.harnessLevel ?? null;
		const fanout = v2 ? fanoutForStack(v2) : { builders: stack?.builders.length ?? 0, workers: 0, watchdogs: 0, verifiers: 0, exa: s.childExa ? s.exaFanOut : 0 };
		return {
			level,
			label: v2?.label ?? shapeName(),
			fanout,
			planCommand: v2?.plan_command,
			terraformMissing: level === 3 && (v2?.requires ?? []).includes("terraform") && terraformPackMissing(ctx?.cwd ?? process.cwd()),
			shiftTab: shiftTabBound,
		};
	};
	// ── 2.4c The run store + session ledger (hash-chained JSONL under settings.store.root) ──
	// Every command's children and the host's own turns land as ledger rows in ONE
	// session run; the Σ TOTALS row and /workflow-monitor read the same rows. Writes are
	// best effort: a store problem must never break a command.
	let store: RunStore | undefined;
	const runStore = (): RunStore => (store ??= new RunStore(readStackSettings().store?.root));
	let sessionRun: { runId: string; dir: string } | undefined;
	const ledgerRows: LedgerRow[] = [];
	const currentCwd = (): string => footerCtx?.cwd ?? hostCtx?.cwd ?? process.cwd();
	const sessionRunFor = (cwd: string): { runId: string; dir: string } | undefined => {
		if (sessionRun) return sessionRun;
		try {
			const s = readStackSettings();
			sessionRun = runStore().open({ projectSlug: RunStore.projectSlug(cwd), cwd, command: "session", shape: shapeName(), level: s.harnessLevel ?? undefined, status: "running" });
			return sessionRun;
		} catch {
			return undefined;
		}
	};
	const ledger = (row: Omit<LedgerRow, "ts" | "runId">): void => {
		try {
			const run = sessionRunFor(currentCwd());
			if (!run) return;
			const full = { ...row, runId: run.runId } as Omit<LedgerRow, "ts">;
			appendLedger(run.dir, full);
			ledgerRows.push({ ...full, ts: new Date().toISOString() } as LedgerRow);
		} catch {
			/* ledger is observational; never break the session over it */
		}
	};
	const recordEvent = (type: string, data: Record<string, unknown>, agentId?: string): void => {
		try {
			const run = sessionRunFor(currentCwd());
			if (run) runStore().appendEvent(run.dir, type, data, agentId);
		} catch {}
	};
	const originFor = (role: Role): LedgerOrigin => (role === "AUDITOR" ? "auditor" : role === "FUSION" ? "fusion" : role === "VALIDATOR" ? "verifier" : "run");
	// Agent states use the monitor vocabulary; verification (P4) promotes done-unverified to done-verified.
	const agentStateOf = (r: AgentRun): string => (r.status === "done" ? "done-unverified" : r.status === "failed" || r.status === "timeout" ? "failed" : r.status === "aborted" ? "cancelled" : r.status === "working" ? "dispatched-working" : "queued");
	const recordRun = (r: AgentRun): void => {
		try {
			const run = sessionRunFor(currentCwd());
			if (!run) return;
			const effective = r.thinking ?? r.slot?.thinking;
			ledger(rowFromAgentRun(r, run.runId, originFor(r.role), effective));
			runStore().upsertAgent(run.dir, {
				agentId: r.slot?.id ?? r.role.toLowerCase(),
				callsign: r.slot?.name ?? r.role,
				role: r.role.toLowerCase(),
				model: r.model,
				thinking: { requested: r.slot?.requestedThinking ?? effective ?? "medium", effective: effective ?? "medium" },
				state: agentStateOf(r),
				usage: { input: r.tokensIn, output: r.tokensOut, cacheRead: 0, cacheWrite: 0, cost: r.costUsd },
				tps: { outputTokens: r.tokensOut, seconds: r.tpsSeconds },
			});
		} catch {
			/* observational */
		}
	};
	let totalsCache: { at: number; text: string } = { at: 0, text: "" };
	const sessionTotalsText = (): string => {
		if (!ledgerRows.length) return "";
		if (Date.now() - totalsCache.at < 2_000) return totalsCache.text;
		let text = "";
		try {
			const agents = sessionRun ? runStore().listAgents(sessionRun.dir) : undefined;
			text = formatTotals(totalsFor(ledgerRows, agents));
		} catch {
			text = "";
		}
		totalsCache = { at: Date.now(), text };
		return text;
	};
	pi.on("session_shutdown", async () => {
		try {
			if (sessionRun) runStore().updateRun(sessionRun.dir, { status: "completed", endedAt: new Date().toISOString() });
		} catch {}
	});

	// ── 2.5 The MODEL BAR (/titan): one aligned cell per model — `◆ ROLE | model (med) | [██--------] 12%` ──
	//
	// The harness CLEARS pi's default footer at TUI session start (user direction
	// 2026-08-17: "get rid of the default footer") — these recipes launch pi with only
	// this extension, so there is no other footer owner to fight. The model bar itself
	// stays a separate `belowEditor` widget, OFF by default and toggled with /titan —
	// auxiliary telemetry, not something worth spending permanent screen rows on.
	const FOOTER_WIDGET = `${CUSTOM_TYPE}-modelbar`;
	let footerVisible = readStackSettings().modelBar; // persisted through /stack and /titan on|off
	let footerCtx: any; // the session ctx — the widget needs its ui + modelRegistry + live model
	let footerTicker: ReturnType<typeof setInterval> | undefined;
	// Assigned next to describeShape(); stub so session_start / SHAPE_HOOK can call it before that line.
	let paintShapeStatus: (ctx?: any) => void = () => {};

	const renderFooterWidget = () => {
		const ctx = footerCtx;
		if (!ctx || !footerVisible) return;
		const contextWindow = (model: string): number => {
			try {
				const slash = model.indexOf("/");
				const found = ctx.modelRegistry.find(model.slice(0, slash), model.slice(slash + 1));
				if (found?.contextWindow) return found.contextWindow;
			} catch {
				/* fall through */
			}
			return 1_000_000;
		};
		const bar = (used: number, window: number): string => {
			const pct = Math.max(0, Math.min(1, window > 0 ? used / window : 0));
			const filled = Math.round(pct * 10);
			return `[${"█".repeat(filled)}${"-".repeat(10 - filled)}] ${Math.round(pct * 100)}%`;
		};
		try {
			ctx.ui.setWidget(
				FOOTER_WIDGET,
				(_tui: any, theme: any) => ({
					invalidate() {},
					render(width: number): string[] {
						const rows = orderedSlots(modelStack()).map((slot) => {
							const live = liveRuns.filter((run) => run.slot?.id === slot.id && run.model === slot.model);
							const remembered = slotLast.get(slot.id)?.model === slot.model ? slotLast.get(slot.id) : undefined;
							const active = live.find((run) => run.status === "working") ?? live[live.length - 1] ?? remembered;
							const role: Role = slot.architect ? "ARCHITECT" : "BUILDER";
							let model = active?.model ?? slot.model;
							let used = active?.ctxTokens || remembered?.ctxTokens || 0;
							let window = contextWindow(model);
							if (slot.primary && !live.length) {
								model = ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : slot.model;
								const usage = ctx.getContextUsage?.();
								used = Math.max(usage?.tokens ?? 0, used);
								window = usage?.contextWindow ?? contextWindow(model);
							}
							// Speed + cost per row: the slot's session bucket plus the in-flight run
							// (not yet absorbed), so tps/cost move live while an agent streams.
							const perf = slotPerf.get(slot.id);
							const inFlight = live.find((run) => run.status === "working") ?? live[live.length - 1];
							const extra = inFlight && !absorbedRuns.has(inFlight) ? inFlight : undefined;
							const perfTokens = (perf?.outputTokens ?? 0) + (extra?.tokensOut ?? 0);
							const perfSeconds = (perf?.seconds ?? 0) + (extra?.tpsSeconds ?? 0);
							const perfCost = (perf?.costUsd ?? 0) + (extra?.costUsd ?? 0);
							const perfStr = `${perfTokens > 0 && perfSeconds > 0 ? `${Math.round(perfTokens / perfSeconds)} tps` : "— tps"} | $${perfCost.toFixed(4)}`;
							// Requested→effective thinking: a normalized slot shows `xhi↘hi`, never a fake xhigh.
							const requested = slot.requestedThinking;
							const thinkingLabel = requested && requested !== slot.thinking ? `${THINKING_SHORT[requested] ?? requested}↘${THINKING_SHORT[slot.thinking] ?? slot.thinking}` : (active?.thinking ?? slot.thinking);
							return truncateToWidth(cellStr(theme, role, model, thinkingLabel, bar(used, window), slot, perfStr), width);
						});
						// Σ TOTALS row: the session ledger (token burn, cost, avg tps/agent, completion rate).
						rows.unshift(truncateToWidth(totalsCellStr(theme, sessionTotalsText(), liveRuns.length > 0), width));
						// LEVEL row: which harness level (or plain shape) is live, its lane pools, the plan default.
						rows.push(truncateToWidth(levelCellStr(theme, levelSnapshot(ctx)), width));
						try {
							rows.push(truncateToWidth(monitorCellStr(theme, monitorBarText(ctx), !!currentWorkflowRun()), width));
						} catch {}
						if (readStackSettings().watchdog.enabled || watchdog) rows.push(truncateToWidth(watchdogCellStr(theme, watchdogCell()), width));
						// FAN-OUT row: how many children are running right now, out of how many this
						// command spawned, against the configured stack size.
						rows.push(truncateToWidth(fanOutCellStr(theme, fanOutSnapshot()), width));
						// SUBAGENT row: the model pi-subagents will use for delegated workers, and
						// whether its provider is authed. EXA row: is web search live in this session.
						rows.push(truncateToWidth(subagentCellStr(theme, subagentSnapshot(ctx)), width));
						rows.push(truncateToWidth(exaCellStr(theme, exaSnapshot()), width));
						// SHAPE row + one AUDITOR row per builder (when auditors are on).
						const s = readStackSettings();
						const stack = modelStack();
						rows.push(truncateToWidth(shapeCellStr(theme, { shape: shapeName(), builders: stack.builders.length, subagentCap: s.subagentFanOut, auditor: s.auditor, anonymize: s.anonymize }), width));
						for (const auditor of auditorsFor(stack)) {
							const forName = stack.builders.find((slot) => `${slot.id}-audit` === auditor.id)?.name ?? "?";
							rows.push(truncateToWidth(auditorCellStr(theme, { name: auditor.name, forName, model: auditor.model, thinking: auditor.thinking, authed: modelUsable(auditor.model), state: auditorState.get(auditor.id) ?? "idle", color: auditor.color }), width));
						}
						return rows;
					},
				}),
				{ placement: "belowEditor" },
			);
		} catch {
			/* the model bar is progressive enhancement — never break the session over it */
		}
	};

	/** Show/hide the model bar, owning its refresh ticker (context bars move while agents run). */
	const setFooterVisible = (visible: boolean) => {
		footerVisible = visible;
		if (footerTicker) {
			clearInterval(footerTicker);
			footerTicker = undefined;
		}
		if (visible) {
			renderFooterWidget();
			footerTicker = setInterval(renderFooterWidget, WIDGET_TICK_MS);
			footerTicker.unref?.(); // never hold the process open for a status readout
			return;
		}
		try {
			footerCtx?.ui.setWidget(FOOTER_WIDGET, undefined);
		} catch {
			/* already gone */
		}
	};

	// /stack toggles the bar through this hook (and persists the choice itself).
	(globalThis as any)[STACK_MODEL_BAR_HOOK] = (visible: boolean) => setFooterVisible(visible);
	/** In-process subscribers to shape/level changes (the authoring status line refreshes through this). */
	const shapeListeners = new Set<() => void>();
	const notifyShapeListeners = () => {
		for (const cb of shapeListeners) {
			try {
				cb();
			} catch {}
		}
	};
	(globalThis as any)[STACK_SHAPE_HOOK] = () => {
		renderFooterWidget();
		paintShapeStatus();
		notifyShapeListeners();
	};

	// Boot: without --titan-config, load the persisted shape (settings.shape) as the session stack.
	pi.on("session_start", async (_ev: any, ctx: any) => {
		try {
			noteHost(ctx);
		} catch {
			return; // --titan-config validation already reported
		}
		if (configuredStack) return;
		const wanted = readStackSettings().shape;
		if (wanted === "legacy") return;
		// Boot never switches the host model (an explicit --model or the saved default wins);
		// cycling with /titan-shape or Ctrl+Tab does.
		const problems = await loadShape(wanted, ctx, false);
		if (problems.length) {
			try {
				ctx.ui.notify(`titan: shape "${wanted}" is not runnable — ${problems.join("; ")}. Using the legacy two-slot stack. /titan-shape to pick another.`, "warning");
			} catch {}
		}
	});

	pi.on("session_start", async (_ev: any, ctx: any) => {
		noteHost(ctx);
		if (ctx.mode !== "tui") return;
		footerCtx = ctx;
		// Pi's default footer stays. A /new or a session switch hands us a fresh ctx —
		// re-attach the model bar if it is on.
		if (footerVisible) setFooterVisible(true);
		paintShapeStatus(ctx);
	});

	// ── 2.6 No transcript renderer: panels are plain markdown custom messages ──

	// ── 2.7 Shared command machinery ───────────────────────────

	/** One markdown header line (+ optional stats line) so a plain custom message still says what it is. */
	const panelHeader = (details: FhDetails): string => {
		const title = details.title ? ` — ${details.title}` : "";
		const head = `**TITAN HARNESS · /${details.command ?? "?"}${title}**${details.ok === false && details.kind !== "prompt" ? " ✗" : ""}`;
		const bits = [
			details.totalMs ? `run ${fmtSecs(details.totalMs)}` : "",
			details.totalCostUsd ? `~$${details.totalCostUsd.toFixed(4)}` : "",
			details.artifactsDir ? `artifacts: ${details.artifactsDir}` : "",
		].filter(Boolean);
		return bits.length ? `${head}\n_${bits.join(" · ")}_` : head;
	};
	const panel = (details: FhDetails, content: string) => {
		const body = details.kind === "prompt" ? content : `${panelHeader(details)}\n\n${content}`;
		pi.sendMessage<FhDetails>({
			customType: CUSTOM_TYPE,
			content: truncateBytes(body, ANSWER_MAX_BYTES),
			display: true,
			details,
		});
	};

	/**
	 * The panel for an escape-stopped run. Renders as an `error` panel (no renderer change)
	 * but says plainly that the user stopped it — an aborted child is !runOk, so without
	 * this a stop would surface as "the agents failed", blaming the models for the user.
	 */
	const stoppedPanel = (command: string, runs: AgentRun[], artifactsDir: string, startedAt: number, what: string) => {
		panel(
			{
				kind: "stopped",
				command,
				ok: false,
				sources: runs.map(toStat),
				artifactsDir,
				totalMs: Date.now() - startedAt,
				totalCostUsd: runs.reduce((s, r) => s + r.costUsd, 0),
			},
			`⊘ STOPPED — escape pressed. ${what}\nEverything produced up to this point is in ${artifactsDir}.`,
		);
	};

	// ── 2.7a Live activity: ONE status line while children run — no panels ──
	// The former two-column / N-agent / solo widgets are gone. Finished markdown lands
	// in the transcript; the model bar's per-slot tps and FAN-OUT row move live.
	let currentCommand: string | undefined;
	let currentStartedAt = 0;
	const LIVE_STATUS = `${CUSTOM_TYPE}-live`;
	const fanOutSnapshot = () => ({
		running: liveRuns.filter((run) => run.status === "working").length,
		total: liveRuns.length,
		stackSize: (() => {
			try {
				return orderedSlots(modelStack()).length;
			} catch {
				return 0;
			}
		})(),
		command: currentCommand,
		elapsedMs: currentCommand ? Date.now() - currentStartedAt : 0,
	});
	const subagentSnapshot = (ctx: any) => {
		const s = readStackSettings();
		const slash = s.subagentModel.indexOf("/");
		let registered = false;
		let authed: boolean | undefined;
		try {
			const model = slash > 0 ? ctx.modelRegistry.find(s.subagentModel.slice(0, slash), s.subagentModel.slice(slash + 1)) : undefined;
			registered = !!model;
			if (model) authed = ctx.modelRegistry.hasConfiguredAuth(model);
		} catch {
			/* registry not bound yet */
		}
		return { model: s.subagentModel, thinking: s.subagentThinking, registered, authed, childMode: s.childSubagents };
	};
	const exaSnapshot = () => {
		const s = readStackSettings();
		let all: string[] = [];
		let active: string[] = [];
		try {
			// getAllTools() returns definitions; getActiveTools() returns NAMES (pi-exa relies on that too).
			const toolName = (tool: any) => (typeof tool === "string" ? tool : String(tool?.name ?? ""));
			all = ((pi as any).getAllTools?.() ?? []).map(toolName);
			active = ((pi as any).getActiveTools?.() ?? []).map(toolName);
		} catch {
			/* runtime not bound yet */
		}
		const total = EXA_TOOL_NAMES.filter((name) => all.includes(name)).length;
		return { installed: total > 0, total, active: EXA_TOOL_NAMES.filter((name) => active.includes(name)).length, children: s.childExa };
	};
	const activitySummary = (command: string, runs: AgentRun[], startedAt: number): string => {
		const working = runs.filter((run) => run.status === "working");
		const done = runs.filter((run) => run.status === "done").length;
		const cost = runs.reduce((sum, run) => sum + run.costUsd, 0);
		const who = working
			.map((run) => {
				const tps = runTps(run);
				return `${run.slot?.name ?? run.role}${tps ? ` ${Math.round(tps)}tps` : ""}`;
			})
			.join(", ");
		return `/${command} · ${working.length} running${done ? ` · ${done} done` : ""} of ${runs.length} · ${fmtSecs(Date.now() - startedAt)} · ~$${cost.toFixed(4)}${who ? ` · ${who}` : ""}`;
	};
	const startActivity = (ctx: any, command: string, runs: AgentRun[], startedAt: number): (() => void) => {
		liveRuns = [...runs];
		currentCommand = command;
		currentStartedAt = startedAt;
		recordEvent("command.start", { command, agents: runs.map((run) => run.slot?.name ?? run.role) });
		const render = () => {
			try {
				ctx.ui.setStatus(LIVE_STATUS, activitySummary(command, liveRuns, startedAt));
			} catch {
				/* headless */
			}
			renderFooterWidget();
		};
		render();
		const ticker = setInterval(render, WIDGET_TICK_MS);
		return () => {
			clearInterval(ticker);
			absorbTotals(liveRuns);
			recordEvent("command.end", { command, ms: Date.now() - startedAt, agents: liveRuns.map((run) => ({ name: run.slot?.name ?? run.role, status: run.status })) });
			liveRuns = [];
			currentCommand = undefined;
			try {
				ctx.ui.setStatus(LIVE_STATUS, undefined);
			} catch {
				/* ignore */
			}
			renderFooterWidget();
		};
	};
	// Same seams the orchestration commands call (HarnessDeps), status-line backed.
	const startWidget = (ctx: any, command: string, cols: [AgentRun, AgentRun], span: AgentRun | undefined, startedAt: number) =>
		startActivity(ctx, command, span ? [...cols, span] : [...cols], startedAt);
	const startGridWidget = (ctx: any, command: string, runs: AgentRun[], span: AgentRun | undefined, startedAt: number) =>
		startActivity(ctx, command, span ? [...runs, span] : [...runs], startedAt);
	const startSoloWidget = (ctx: any, command: string, run: AgentRun, startedAt: number) => startActivity(ctx, command, [run], startedAt);

	/**
	 * ESCAPE = stop. Pi's own escape only aborts ITS agent loop; a slash command's children
	 * are our subprocesses, so nothing cancels them unless we listen ourselves. While
	 * children run we tap raw terminal input and abort the run's controller on Escape.
	 *
	 * A bare "\x1b" IS the Escape key; "\x1b[A"/"\x1bO…" are arrow/function-key SEQUENCES
	 * that merely start with the same byte — matching a prefix would swallow those keys.
	 * Only Escape is consumed; every other key (incl. ctrl-c, which pi handles) passes through.
	 * Returns an unsubscribe — always call it, or the tap outlives the command.
	 */
	const onEscape = (ctx: any, stop: () => void): (() => void) => {
		try {
			return (
				ctx.ui.onTerminalInput?.((data: string) => {
					if (data === "\x1b" || data === "escape" || data === "esc" || matchesKey(data, "escape")) {
						stop();
						return { consume: true };
					}
					return undefined;
				}) ?? (() => {})
			);
		} catch {
			return () => {}; // headless / no TUI — nothing to tap
		}
	};

	const activeCommandControllers = new Set<AbortController>();
	/** One abort controller per command run + the Escape tap that trips it. */
	const startStoppable = (ctx: any, command: string): { signal: AbortSignal; stopped: () => boolean; release: () => void } => {
		const ctl = new AbortController();
		activeCommandControllers.add(ctl);
		const unsubscribe = onEscape(ctx, () => {
			if (ctl.signal.aborted) return;
			ctl.abort();
			try {
				ctx.ui.setStatus(CUSTOM_TYPE, `${command}: stopping…`);
				ctx.ui.notify(`titan-harness: stopping /${command} — escape pressed`, "warning");
			} catch {
				/* best effort */
			}
		});
		const release = () => {
			unsubscribe();
			activeCommandControllers.delete(ctl);
		};
		return { signal: ctl.signal, stopped: () => ctl.signal.aborted, release };
	};

	pi.on("session_shutdown", async () => {
		for (const controller of activeCommandControllers) controller.abort();
		activeCommandControllers.clear();
	});

	const mkArtifacts = async (): Promise<string> => fs.promises.mkdtemp(path.join(ARTIFACT_ROOT, "titan-harness-"));
	const save = (dir: string, name: string, body: string) => fs.promises.writeFile(path.join(dir, name), body, "utf-8");
	const ensureSummary = async (dir: string, payload: Record<string, unknown>) => {
		const summaryPath = path.join(dir, "summary.json");
		try {
			await fs.promises.access(summaryPath);
			return;
		} catch {}
		try {
			await fs.promises.writeFile(summaryPath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
		} catch (error) {
			process.stderr.write(`titan-harness: FAILED to write required summary ${summaryPath}: ${String(error)}\n`);
		}
	};
	const totals = (runs: AgentRun[], startedAt: number) => ({
		totalMs: Date.now() - startedAt,
		totalCostUsd: runs.reduce((s, r) => s + r.costUsd, 0),
	});

	// ── 2.8 (no boot banner — titan-harness keeps the transcript plain) ──

	// ── 2.9 /titan-reset — wipe the persistent slot sessions for this project ──
	// (/new triggers the same reset via the session_start hook above, on top of pi's own fresh session.)
	pi.registerCommand("titan-reset", {
		description: "Full reset: fresh host session AND fresh slot memories — every agent starts from nothing",
		handler: async (_args, ctx) => {
			noteHost(ctx); // an unset --builder follows the host session's live model
			await resetRoleSessions(ctx.cwd);
			// Main IS the host: without a fresh host session, the Main row keeps its raw-chat
			// context (user report 2026-08-18: "/titan-reset didn't reset the builder"). The old
			// ctx is STALE after replacement — all post-swap work runs in withSession on the
			// ctx pi hands over (per pi's own staleness guard).
			try {
				await ctx.newSession?.({
					withSession: async (newCtx: any) => {
						footerCtx = newCtx;
						// The session swap drops extension widgets; if the model bar was
						// showing, put it straight back on the fresh session.
						if (footerVisible) setFooterVisible(true);
						try {
							newCtx.ui?.notify?.("titan-harness: full reset — fresh host session, fresh slot memories", "info");
						} catch {}
					},
				});
			} catch {
				// headless / no session manager — the slot reset alone still applied
				try {
					ctx.ui.notify("titan-harness: slot memories reset (no host session to replace)", "info");
				} catch {}
			}
		},
	});

	// ── 2.10 /titan — the harness's front door: the command index + the model bar toggle ──
	// One thing to remember (`/titan`) instead of ten. Bare invocation prints every command and
	// flips the multi-row model bar; `on`/`off` pin the bar. The bar stays OFF by default —
	// the session runs footerless (pi's default footer is cleared at startup) until you ask.
	// Descriptions stay 3-8 words so index lines NEVER wrap in a normal terminal.
	const COMMAND_INDEX: Array<[string, string]> = [
		["/titan-opinion <prompt>", "every agent answers read-only"],
		['/titan-fusion "<prompt>" "<fusion>"', "parallel research, one writer, all ACK"],
		["/titan-debate [--rounds N] <prompt>", "all-to-all debate, no judge"],
		["/titan-collaborate <prompt>", "agents plan, architect delegates, parallel build"],
		["/titan-only [slot] [prompt]", "route one prompt to one agent"],
		["/titan-model", "pick slot, model, thinking"],
		["/ctx", "272k / 828k / OpenRouter 1M context"],
		["/stack", "subagent tools, fan-out, model bar, workflows"],
		["/titan-auto-validate [--max-validations N] <prompt>", "gate written first, build until green"],
		["/titan-system-prompt", "every slot's effective system prompt"],
		["/titan-reset", "full reset, host and slots"],
		["/titan-shape [next|name]", "cycle stack YAML (Ctrl+Tab · Alt+H)"],
		["/titan-n [1-4]", "builder fan-out (Ctrl+Shift+N · Alt+N)"],
		["/titan-s [0-16]", "subagent cap per child (Ctrl+Shift+S · Alt+S)"],
		["/titan-audit [on|off]", "auditors per builder (Ctrl+Shift+A · Alt+A)"],
		["/titan-level [0-3|next|status]", "harness level 0-3 (Shift+Tab after rebind · Alt+L)"],
		["/titan-doctor [--json]", "models, credentials, tools, pins, decisions"],
		["/workflow run|validate|list|status|stop|graph <name>", "YAML DAG workflows (.titan/workflows/<name>/<name>.yaml)"],
		["/workflow-monitor [runId|list|--split|close]", "store-driven run monitor: overlay, runs table, side pane"],
		["/titan-watchdog [status|on|off|model|thinking|compaction|resume]", "titan-native watchdog: compaction state block, child pre-emption, stalemate"],
		["/plan [brief]", "read-only plan mode; routes to /ultraplan when the shape says so"],
		["/ultraplan <brief> | answer | fuse | done | abort", "grilling round, anonymous fusion seats, judge, fused plan with ACKs"],
		["/cloud-simulated-users [probe|setup|run|advice]", "cloud sim-user lanes: probe matrix, setup agent, recorded runs"],
		["/create-workflow <goal> [--from-plan|--from-findings|--elevate]", "clean-context workflow architect authors .titan/workflows/<name>; host persists"],
		["/terraform [--refresh] [--section s] [--dry-run]", "entity, ontology, roadmap, automations, connectors docs under .titan/terraform"],
		["/local-dev-verify [--url u] [--start cmd] [--flows f] [--workers n]", "sim users against the local app: Kane or headless Chromium (CDP), hashed evidence"],
		["/titan [on|off|toggle]", "this list; model bar on/off (alias /fh)"],
	];
	const COMMAND_PAD = Math.max(...COMMAND_INDEX.map(([cmd]) => cmd.length));

	const frontDoor = {
		description: "TITAN HARNESS — list every /titan-* command and toggle the multi-row model bar. /titan [on|off] (alias: /fh)",
		handler: async (args: string, ctx: any) => {
			noteHost(ctx); // an unset --builder follows the host session's live model
			footerCtx ??= ctx; // first use before any tui session_start (e.g. after a reload)
			const arg = args.trim().toLowerCase();
			if (arg && !["on", "off", "show", "hide", "toggle"].includes(arg)) {
				ctx.ui.notify(`titan-harness: /titan takes on|off|toggle (or nothing to print the index). Got "${arg}".`, "error");
				return;
			}
			// Bare /titan only prints the index; the bar changes only on an explicit on|off|toggle.
			if (arg) {
				const next = arg === "on" || arg === "show" ? true : arg === "off" || arg === "hide" ? false : !footerVisible;
				setFooterVisible(next);
				writeStackSettings({ modelBar: next });
			}
			// Just the name and the tabbed index — the model bar appearing/disappearing is
			// its own feedback, and short descriptions keep every line unwrapped.
			ctx.ui.notify(
				["TITAN HARNESS", ...COMMAND_INDEX.map(([cmd, what]) => `  ${cmd.padEnd(COMMAND_PAD)}  ${what}`)].join("\n"),
				"info",
			);
		},
	};
	pi.registerCommand("titan", frontDoor);
	pi.registerCommand("fh", { ...frontDoor, description: "Alias for /titan (legacy fusion-harness name)" });

	// ── 2.11 /titan-model — choose slot → model → thinking, session-only ──
	pi.registerCommand("titan-model", {
		description: "Choose a configured slot, model, and thinking level. Session-only; never rewrites YAML.",
		handler: async (_args, ctx) => {
			noteHost(ctx);
			const stack = modelStack();
			const choices = orderedSlots(stack).map((slot) => `${slot.architect ? "◆ ARCHITECT" : "▲ BUILDER"} | ${slot.name} | ${slot.model} (${THINKING_SHORT[slot.thinking]})`);
			const picked = await ctx.ui.select("Titan Harness — choose slot", choices);
			if (!picked) return;
			const slotIndex = choices.indexOf(picked);
			const selectedSlot = orderedSlots(stack)[slotIndex];
			if (!selectedSlot) return;

			const availableModels = ctx.modelRegistry.getAvailable();
			const configuredModels = [...new Set([selectedSlot.model, ...orderedSlots(stack).map((slot) => slot.model)])];
			const browse = "Browse another provider…";
			const modelChoice = await ctx.ui.select(`Model for ${selectedSlot.name}`, [...configuredModels, browse]);
			if (!modelChoice) return;
			let selectedModel = modelChoice;
			if (modelChoice === browse) {
				const providers = [...new Set(availableModels.map((model: any) => model.provider as string))].sort();
				const provider = await ctx.ui.select("Choose model provider", providers);
				if (!provider) return;
				const providerModels = availableModels.filter((model: any) => model.provider === provider).map((model: any) => `${model.provider}/${model.id}`).sort();
				const providerModel = await ctx.ui.select(`Model from ${provider}`, providerModels);
				if (!providerModel) return;
				selectedModel = providerModel;
			}
			const selectedThinkingRaw = await ctx.ui.select(`Thinking for ${selectedSlot.name}`, THINKING_LEVELS);
			if (!selectedThinkingRaw) return;
			const selectedThinking = resolveStackThinking(selectedThinkingRaw);
			if (!selectedThinking) return;

			const next = cloneStack(stack);
			const target = next.slots.find((slot) => slot.id === selectedSlot.id)!;
			target.model = selectedModel;
			target.thinking = selectedThinking;
			if (target.primary) {
				const slash = selectedModel.indexOf("/");
				const model = ctx.modelRegistry.find(selectedModel.slice(0, slash), selectedModel.slice(slash + 1));
				if (!model || !ctx.modelRegistry.hasConfiguredAuth(model) || !(await pi.setModel(model))) {
					ctx.ui.notify(`titan-harness: could not switch Main host model to ${selectedModel}`, "error");
					return;
				}
				hostModel = selectedModel;
				pi.setThinkingLevel(selectedThinking);
				target.thinking = pi.getThinkingLevel() as Thinking;
			}
			next.architect = next.slots.find((slot) => slot.architect)!;
			next.primaryBuilder = next.slots.find((slot) => slot.primary)!;
			next.builders = next.slots.filter((slot) => !slot.architect);
			configuredStack = next;
			renderFooterWidget();
			ctx.ui.notify(`titan-harness: ${target.name} → ${target.model} (${target.thinking}); session-only, YAML unchanged`, "info");
		},
	});

	// ── 2.12 /titan-system-prompt — every configured slot, responsive grid ──
	pi.registerCommand("titan-system-prompt", {
		description: "Show the system prompt every configured slot runs with.",
		handler: async (_args, ctx) => {
			noteHost(ctx);
			const childDefaultPrompt = async (): Promise<string> => {
				const build = await loadBuildSystemPrompt();
				const hostOpts = ctx.getSystemPromptOptions?.();
				if (build && hostOpts) {
					return build({ ...hostOpts, customPrompt: undefined, appendSystemPrompt: undefined, contextFiles: [], skills: [], selectedTools: FULL_TOOLS.split(","), cwd: ctx.cwd });
				}
				return ctx.getSystemPrompt?.() ?? "(pi default — could not be resolved from this pi installation)";
			};
			const stack = modelStack();
			const needsDefault = orderedSlots(stack).some((slot) => !slot.systemPrompt);
			const dflt = needsDefault ? await childDefaultPrompt() : "";
			const answers: NonNullable<FhDetails["answers"]> = orderedSlots(stack).map((slot) => ({
				role: slot.architect ? "ARCHITECT" : "BUILDER",
				model: slot.model,
				// The EFFECTIVE prompt: base (override or pi default) plus every configured
				// append, in order — exactly what the child receives.
				text: [(slot.systemPrompt ?? dflt).trim(), ...slot.appendSystemPrompts.map((append) => append.trim())].filter(Boolean).join("\n\n"),
				slotId: slot.id,
				slotName: slot.name,
				color: slot.color,
				primary: slot.primary,
			}));
			panel({ kind: "system-prompt", command: "titan-system-prompt", ok: true, answers }, answers.map((answer) => `## ${answer.slotName} · ${answer.model}\n${answer.text}`).join("\n\n"));
		},
	});

	// ── 2.13 /titan-only — direct one-slot execution + armed one-send routing ──
	const ONE_SHOT_WIDGET = `${CUSTOM_TYPE}-one-shot`;
	let oneShotTargetSlotId: string | undefined;
	let oneShotCtx: any;
	const renderOneShot = () => {
		try {
			if (!oneShotTargetSlotId || !oneShotCtx) {
				oneShotCtx?.ui.setStatus(ONE_SHOT_WIDGET, undefined);
				return;
			}
			const slot = modelStack().slots.find((candidate) => candidate.id === oneShotTargetSlotId);
			if (!slot) return;
			oneShotCtx.ui.setStatus(ONE_SHOT_WIDGET, `▶ one-shot → ${slot.name} | ${slot.model} (${THINKING_SHORT[slot.thinking]}) · next plain prompt routes only there · /titan-only same slot to disarm`);
		} catch {}
	};
	const disarmOneShot = () => {
		oneShotTargetSlotId = undefined;
		renderOneShot();
	};

	const executeOnly = async (slot: ModelSlot, prompt: string, ctx: any, source: "command" | "one-shot") => {
		const startedAt = Date.now();
		const artifactsDir = await mkArtifacts();
		await save(artifactsDir, "prompt.md", prompt);
		await save(artifactsDir, "stack.json", JSON.stringify(modelStack(), null, 2));
		panel({ kind: "prompt", command: "titan-only", ok: true }, `${source === "command" ? "/titan-only " : ""}${prompt}`);
		const run = newSlotRun(slot);
		const stopper = startStoppable(ctx, "titan-only");
		const stopWidget = startSoloWidget(ctx, "titan-only", run, startedAt);
		let writerLease: WriterLease | undefined;
		ctx.ui.setStatus(CUSTOM_TYPE, `titan-only: ${slot.name} working…`);
		try {
			try {
				writerLease = acquireWriterLease(ctx.cwd, `/titan-only ${slot.id} ${path.basename(artifactsDir)}`);
			} catch (error) {
				panel({ kind: "error", command: "titan-only", ok: false, agent: toStat(run), artifactsDir }, error instanceof Error ? error.message : String(error));
				return;
			}
			const spawn = slotInitialSpawn(slot, ctx, path.join(artifactsDir, slot.id));
			await runChild({ run, prompt, systemPrompt: slot.systemPrompt, appendSystemPrompts: slot.appendSystemPrompts, tools: FULL_TOOLS, thinking: slot.thinking, ...spawn, cwd: ctx.cwd, timeoutMs: childTimeoutMs(), signal: stopper.signal });
			if (stopper.stopped()) {
				stoppedPanel("titan-only", [run], artifactsDir, startedAt, `${slot.name} was stopped mid-answer.`);
				return;
			}
			// Builders are audited before their report is shown (write-capable run); the
			// architect's own answers are not.
			let report = runOk(run) ? run.text : `FAILED: ${runError(run)}`;
			let blocked = false;
			// A chat-only answer (no working-tree change) is not a write task: no audit.
			if (!slot.architect && runOk(run) && hasWorkingTreeChanges(ctx.cwd)) {
				ctx.ui.setStatus(CUSTOM_TYPE, `titan-only: auditing ${slot.name}…`);
				const outcome = await auditGate(ctx, { builder: slot, run, task: { id: "only", description: prompt, outputs: [] }, report, artifactsDir, prompt, tools: FULL_TOOLS, spawn, signal: stopper.signal });
				report = outcome.report;
				blocked = outcome.failClosed;
				if (stopper.stopped()) {
					stoppedPanel("titan-only", [run], artifactsDir, startedAt, `${slot.name} was stopped during audit.`);
					return;
				}
			}
			await save(artifactsDir, `${slot.id}.md`, report);
			const t = totals([run], startedAt);
			if (runOk(run) && !blocked) panel({ kind: "solo", command: "titan-only", ok: true, agent: toStat(run), artifactsDir, ...t }, report);
			else if (runOk(run)) panel({ kind: "error", command: "titan-only", ok: false, agent: toStat(run), artifactsDir, ...t }, `${slot.name}'s work was blocked by the auditor (fail-closed).\n\n${report}`);
			else panel({ kind: "error", command: "titan-only", ok: false, agent: toStat(run), artifactsDir, ...t }, `${slot.name} produced no usable answer: ${runError(run)}`);
			await save(artifactsDir, "summary.json", JSON.stringify({ command: "titan-only", source, ok: runOk(run), targetSlot: slot.id, writerLeasePath: writerLease?.path, agents: [toStat(run)], sessions: { [slot.id]: run.sessionRef ?? cachedSlotId(slot) }, ...t }, null, 2));
		} finally {
			await ensureSummary(artifactsDir, { command: "titan-only", source, ok: false, stopped: stopper.stopped(), targetSlot: slot.id, writerLeasePath: writerLease?.path, agents: [toStat(run)], sessions: { [slot.id]: run.sessionRef ?? cachedSlotId(slot) }, ...totals([run], startedAt) });
			writerLease?.release();
			stopper.release();
			stopWidget();
			ctx.ui.setStatus(CUSTOM_TYPE, undefined);
		}
	};

	pi.registerCommand("titan-only", {
		description: "Choose one configured agent. With a prompt, run immediately; without one, arm the next plain prompt as a one-send route.",
		handler: async (raw, ctx) => {
			noteHost(ctx);
			oneShotCtx = ctx;
			const stack = modelStack();
			const input = (raw ?? "").trim();
			const firstSpace = input.search(/\s/);
			const targetToken = firstSpace === -1 ? input : input.slice(0, firstSpace);
			const rest = firstSpace === -1 ? "" : input.slice(firstSpace).trim();
			let selected = targetToken ? stack.slots.find((slot) => slot.id.toLowerCase() === targetToken.toLowerCase() || slot.name.toLowerCase() === targetToken.toLowerCase()) : undefined;
			if (targetToken && !selected) {
				ctx.ui.notify(`titan-harness: unknown slot ${targetToken}. Valid: ${orderedSlots(stack).map((slot) => slot.id).join(", ")}`, "error");
				return;
			}
			if (!selected) {
				const choices = orderedSlots(stack).map((slot) => `${slot.architect ? "◆ ARCHITECT" : "▲ BUILDER"} | ${slot.name} | ${slot.model}`);
				const picked = await ctx.ui.select("Titan Harness — one-send target", choices);
				if (!picked) return;
				selected = orderedSlots(stack)[choices.indexOf(picked)];
			}
			if (rest) {
				disarmOneShot();
				await executeOnly(selected, rest, ctx, "command");
				return;
			}
			if (oneShotTargetSlotId === selected.id) {
				disarmOneShot();
				ctx.ui.notify(`titan-harness: one-shot ${selected.name} disarmed`, "info");
				return;
			}
			oneShotTargetSlotId = selected.id;
			renderOneShot();
			ctx.ui.notify(`titan-harness: next plain prompt routes only to ${selected.name}`, "info");
		},
	});

	pi.on("input", async (event: any, ctx: any) => {
		if (!oneShotTargetSlotId || event.source !== "interactive" || event.text.startsWith("/")) return { action: "continue" as const };
		if (event.images?.length) {
			ctx.ui.notify("titan-harness: /titan-only one-shot image routing is not supported yet; target remains armed", "warning");
			return { action: "continue" as const };
		}
		const slot = modelStack().slots.find((candidate) => candidate.id === oneShotTargetSlotId);
		if (!slot) {
			disarmOneShot();
			return { action: "continue" as const };
		}
		disarmOneShot();
		await executeOnly(slot, event.text, ctx, "one-shot");
		return { action: "handled" as const };
	});

	// ── 2.13b The audit gate wiring (modules/audit.ts) ──
	const auditGate = (ctx: any, request: AuditRequest) =>
		runAuditGate(
			{
				auditorFor,
				childTimeoutMs,
				noteAuditor: (auditorId, state) => {
					auditorState.set(auditorId, state);
					renderFooterWidget();
				},
				save,
				mkdir: async (dir) => {
					await fs.promises.mkdir(dir, { recursive: true });
				},
			},
			ctx.cwd,
			request,
		);

	// ── 2.13c Shape controls: /titan-shape, /titan-n, /titan-s, /titan-audit + hotkeys ──
	const describeShape = (): string => {
		const s = readStackSettings();
		const stack = modelStack();
		return `shape ${shapeName()} · builders ${stack.builders.length} (${stack.builders.map((slot) => slot.name).join(", ")}) · subagents ${s.subagentFanOut > 0 ? `≤${s.subagentFanOut}` : "off"} · auditor ${s.auditor ? "on" : "off"} · ${s.anonymize ? "callsigns only" : "models visible"}`;
	};
	/** Idle footer status: current shape (ultraplan H2). Live command activity uses LIVE_STATUS. */
	const SHAPE_STATUS = "titan";
	const shapeStatusText = (): string => {
		try {
			const stack = modelStack();
			if (stack.version === 2) return describeLevel(stack, readStackSettings());
		} catch {
			/* v1 / not loaded yet */
		}
		try {
			return describeShape();
		} catch {
			return `shape ${readStackSettings().shape}`;
		}
	};
	paintShapeStatus = (ctx?: any) => {
		const ui = ctx?.ui ?? footerCtx?.ui;
		if (!ui?.setStatus) return;
		try {
			const theme = ui.theme;
			const text = shapeStatusText();
			ui.setStatus(SHAPE_STATUS, theme?.fg ? theme.fg("accent", "⬡ ") + theme.fg("dim", text) : `⬡ ${text}`);
		} catch {
			/* headless / session teardown */
		}
	};
	const announce = (ctx: any, text: string, level: "info" | "warning" | "error" = "info") => {
		try {
			ctx.ui.notify(text, level);
		} catch {}
		renderFooterWidget();
		paintShapeStatus(ctx);
		notifyShapeListeners();
	};
	const cycleShape = async (ctx: any, wanted?: string) => {
		const shapes = listShapes();
		let target = wanted;
		if (!target || target === "next") {
			const current = shapeName();
			let index = shapes.indexOf(current);
			// Skip shapes that are not runnable on this machine (unauthed slots).
			for (let step = 0; step < shapes.length; step++) {
				index = (index + 1) % shapes.length;
				const candidate = shapes[index];
				const problems = await loadShape(candidate, ctx);
				if (!problems.length) {
					announce(ctx, `titan: ${describeShape()}`);
					return;
				}
			}
			announce(ctx, "titan: no other runnable shape in ~/.pi/titan-harness (every candidate has an unauthed slot).", "warning");
			return;
		}
		if (!shapes.includes(target)) {
			announce(ctx, `titan: unknown shape "${target}". Available: ${shapes.join(", ")}`, "warning");
			return;
		}
		const problems = await loadShape(target, ctx);
		announce(ctx, problems.length ? `titan: shape "${target}" not runnable — ${problems.join("; ")}` : `titan: ${describeShape()}`, problems.length ? "warning" : "info");
	};
	const setBuilders = (ctx: any, n: number) => {
		writeStackSettings({ builderFanOut: n });
		announce(ctx, `titan: builders → ${n} · applies to the next command · ${describeShape()}`);
	};
	const setSubagents = (ctx: any, cap: number) => {
		writeStackSettings({ subagentFanOut: cap, childSubagents: cap > 0 ? readStackSettings().childSubagents === "off" ? "all" : readStackSettings().childSubagents : readStackSettings().childSubagents });
		announce(ctx, `titan: subagent fan-out → ${cap > 0 ? `≤${cap} per child` : "off"} · applies to children spawned from now on`);
	};
	const setAuditor = (ctx: any, on: boolean) => {
		writeStackSettings({ auditor: on });
		announce(ctx, `titan: auditor ${on ? "ON — every builder's write task is reviewed before it reaches the architect" : "OFF — reports go straight to the architect"}`);
	};
	pi.registerCommand("titan-shape", {
		description: "Cycle or pick the harness shape (model-stack-*.yaml in ~/.pi/titan-harness): /titan-shape [next|list|<codename>]",
		handler: async (args, ctx) => {
			const arg = args.trim().toLowerCase();
			if (arg === "list") return announce(ctx, `titan shapes: ${listShapes().map((name) => (name === shapeName() ? `● ${name}` : `○ ${name}`)).join("  ")}`);
			await cycleShape(ctx, arg || "next");
		},
	});
	pi.registerCommand("titan-n", {
		description: "Builder fan-out (tier 2): /titan-n [1-4|next]",
		handler: async (args, ctx) => {
			const arg = args.trim().toLowerCase();
			const current = readStackSettings().builderFanOut;
			const n = !arg || arg === "next" ? nextInCycle(BUILDER_FANOUT_CYCLE, current) : Number.parseInt(arg, 10);
			if (!BUILDER_FANOUT_CYCLE.includes(n)) return announce(ctx, "Usage: /titan-n [1-4|next]", "warning");
			setBuilders(ctx, n);
		},
	});
	pi.registerCommand("titan-s", {
		description: "Subagent fan-out cap per child (tier 3): /titan-s [0-16|next]",
		handler: async (args, ctx) => {
			const arg = args.trim().toLowerCase();
			const current = readStackSettings().subagentFanOut;
			const cap = !arg || arg === "next" ? nextInCycle(SUBAGENT_FANOUT_CYCLE, SUBAGENT_FANOUT_CYCLE.includes(current) ? current : 0) : Number.parseInt(arg, 10);
			if (!Number.isFinite(cap) || cap < 0 || cap > 16) return announce(ctx, "Usage: /titan-s [0-16|next]", "warning");
			setSubagents(ctx, cap);
		},
	});
	pi.registerCommand("titan-audit", {
		description: "Auditors per builder: /titan-audit [on|off|toggle]",
		handler: async (args, ctx) => {
			const arg = args.trim().toLowerCase();
			const current = readStackSettings().auditor;
			const on = arg === "on" ? true : arg === "off" ? false : !current;
			setAuditor(ctx, on);
		},
	});
	// Hotkeys. Ctrl+Tab / Ctrl+Shift+<key> need a terminal that speaks the Kitty keyboard
	// protocol (Kitty, Ghostty, WezTerm, foot, recent VTE); the Alt+<key> twins work everywhere.
	const bindKey = (keys: string[], description: string, handler: (ctx: any) => Promise<void> | void) => {
		for (const key of keys) {
			try {
				(pi as any).registerShortcut?.(key, { description, handler });
			} catch {
				/* older pi without shortcuts */
			}
		}
	};
	bindKey(["ctrl+tab", "alt+h"], "titan: cycle harness shape", async (ctx) => cycleShape(ctx, "next"));
	bindKey(["ctrl+shift+n", "alt+n"], "titan: cycle builder fan-out (1-4)", async (ctx) => setBuilders(ctx, nextInCycle(BUILDER_FANOUT_CYCLE, readStackSettings().builderFanOut)));
	bindKey(["ctrl+shift+s", "alt+s"], "titan: cycle subagent fan-out cap", async (ctx) => {
		const current = readStackSettings().subagentFanOut;
		setSubagents(ctx, nextInCycle(SUBAGENT_FANOUT_CYCLE, SUBAGENT_FANOUT_CYCLE.includes(current) ? current : 0));
	});
	bindKey(["ctrl+shift+a", "alt+a"], "titan: toggle auditors", async (ctx) => setAuditor(ctx, !readStackSettings().auditor));

	// ── 2.13d Harness levels: /titan-level + Alt+L / Ctrl+Shift+L, and Shift+Tab once the user has freed it ──
	const cycleLevel = async (ctx: any, wanted?: number | "next") => {
		const available = listLevels();
		if (!available.length) {
			announce(ctx, `titan: no level shapes in ${STACK_DIR} — copy model-stack-level-*.yaml from the package's .pi/titan-harness (see INSTALL.md).`, "warning");
			return;
		}
		const current = readStackSettings().harnessLevel;
		let target: number;
		if (wanted === undefined || wanted === "next") target = nextLevel(current, available);
		else {
			target = wanted;
			if (!available.includes(target)) return announce(ctx, `titan: level ${target} has no shape file. Available: ${available.join(", ")}`, "warning");
		}
		const problems = await loadShape(levelCodename(target), ctx);
		if (problems.length) return announce(ctx, `titan: level ${target} not runnable — ${problems.join("; ")}`, "warning");
		const stack = configuredStack!;
		let defaultsNote = "";
		if (target === 2) {
			// Level 2 (triggered ops) runs on the project's own terraform defaults when /terraform has written them.
			try {
				const defaults = readHarnessDefaults(ctx.cwd);
				if (defaults) {
					const patch: Record<string, unknown> = {};
					if (typeof defaults.exa === "boolean") patch.childExa = defaults.exa;
					if (defaults.budget_usd === null || typeof defaults.budget_usd === "number") patch.budgetUsd = defaults.budget_usd;
					if (defaults.review === "required") patch.auditor = true;
					if (Object.keys(patch).length) writeStackSettings(patch as any);
					defaultsNote = ` · harness_defaults from .titan/terraform/entity.md (${[defaults.tier ? `tier ${defaults.tier}` : "", typeof defaults.exa === "boolean" ? `exa ${defaults.exa ? "on" : "off"}` : "", defaults.budget_usd !== undefined ? `budget ${defaults.budget_usd === null ? "off" : `$${defaults.budget_usd}`}` : ""].filter(Boolean).join(", ")})`;
				}
			} catch {
				/* a malformed block never blocks the level */
			}
		}
		const notes = (lastFallbackNotes.length ? ` · ${lastFallbackNotes.join("; ")}` : "") + defaultsNote;
		const terraform = target === 3 && (stack.requires ?? []).includes("terraform") && terraformPackMissing(ctx.cwd) ? " · run /terraform for best results (no .titan/terraform/entity.md)" : "";
		announce(ctx, `titan: ${describeLevel(stack, readStackSettings())}${notes}${terraform}`, terraform ? "warning" : "info");
	};
	pi.registerCommand("titan-level", {
		description: "Harness level 0-3 (ultrafast · brain+workers · triggered ops · engineering): /titan-level [0-3|next|status|--claim-shift-tab]",
		handler: async (args, ctx) => {
			const arg = args.trim().toLowerCase();
			if (arg === "status") {
				let text = "titan level: shape-driven (no level active)";
				try {
					const stack = modelStack();
					if (stack.version === 2) text = `titan: ${describeLevel(stack, readStackSettings())}`;
				} catch {}
				const free = shiftTabFree();
				return announce(ctx, `${text} · shift+tab ${free.free ? "bound to level cycling" : `reserved by Pi (${free.detail}) — alt+l and /titan-level work; /titan-level --claim-shift-tab to rebind`}`);
			}
			if (arg === "--claim-shift-tab" || arg === "claim-shift-tab") {
				const free = shiftTabFree();
				if (free.free) return announce(ctx, `titan: shift+tab is already free (${free.detail}). ${shiftTabBound ? "It cycles levels." : "Run /reload so titan binds it."}`);
				let ok = false;
				try {
					ok = await ctx.ui.confirm("Free shift+tab for titan level cycling?", "This rebinds Pi's thinking-level cycle (app.thinking.cycle) to alt+t in ~/.pi/agent/keybindings.json (backup kept). You will need to /reload.");
				} catch {
					ok = false;
				}
				if (!ok) return announce(ctx, "titan: keybindings unchanged. alt+l and /titan-level keep working.");
				const result = claimShiftTab();
				return announce(ctx, `titan: ${result.message}`, result.changed ? "info" : "warning");
			}
			if (!arg || arg === "next") return cycleLevel(ctx, "next");
			const level = Number.parseInt(arg, 10);
			if (!LEVEL_CYCLE.includes(level)) return announce(ctx, "Usage: /titan-level [0-3|next|status|--claim-shift-tab]", "warning");
			await cycleLevel(ctx, level);
		},
	});
	bindKey(["ctrl+shift+l", "alt+l"], "titan: cycle harness level (0-3)", async (ctx) => cycleLevel(ctx, "next"));
	if (shiftTabBound) bindKey(["shift+tab"], "titan: cycle harness level (0-3)", async (ctx) => cycleLevel(ctx, "next"));

	// ── 2.13e /titan-doctor — the operator gate: models, credentials, tools, pins, decisions ──
	pi.registerCommand("titan-doctor", {
		description: "Report what the harness can run on this machine: models + auth, credentials (names only), tools on PATH, shift+tab, package pins, decisions. /titan-doctor [--json|--import-infranodus-key]",
		handler: async (args, ctx) => {
			noteHost(ctx);
			const arg = args.trim().toLowerCase();
			if (arg === "--import-infranodus-key" || arg === "import-infranodus-key") {
				let ok = false;
				try {
					ok = await ctx.ui.confirm("Import the InfraNodus key?", "Copies an existing INFRANODUS_API_KEY (environment, mcp-server-infranodus/.env or ~/.claude.json) into ~/.config/mcp/mcp.json so pi-mcp-adapter can start the server. The value is never shown.");
				} catch {
					ok = false;
				}
				if (!ok) return announce(ctx, "titan: nothing imported.");
				const result = importInfranodusKey();
				return announce(ctx, `titan: ${result.message}`, result.ok ? "info" : "warning");
			}
			const report = runDoctor({ ctx, pins: () => checkPins(), dwPatchApplied: () => dwPatchApplied() });
			if (arg === "--json" || arg === "json") {
				const dir = await mkArtifacts();
				await save(dir, "doctor.json", `${JSON.stringify(report, null, 2)}\n`);
				return announce(ctx, `titan doctor: ready ${report.summary.ready} · vacant ${report.summary.vacant} · warn ${report.summary.warn} · unknown ${report.summary.unknown} → ${path.join(dir, "doctor.json")}`);
			}
			panel({ kind: "banner", command: "titan-doctor", ok: report.summary.unknown === 0 }, `\`\`\`\n${formatDoctor(report)}\n\`\`\``);
		},
	});

	// Boot pin check: a drifted companion package or a wiped dynamic-workflows patch is
	// the kind of thing that silently changes behaviour, so say it once per session.
	let pinsChecked = false;
	pi.on("session_start", async (ev: any, ctx: any) => {
		if (pinsChecked || ev?.reason !== "startup") return;
		pinsChecked = true;
		try {
			const drift = checkPins().filter((pin) => !pin.ok);
			const patched = dwPatchApplied();
			if (!drift.length && patched) return;
			const parts = [...drift.map((pin) => `${pin.name} expected ${pin.expected}, found ${pin.found ?? "missing"}`), ...(patched ? [] : ["dynamic-workflows /workflows menu patch not applied (node scripts/apply-dw-patch.mjs)"])];
			ctx.ui.notify(`titan pins: ${parts.join(" · ")}`, "warning");
		} catch {
			/* pins are advisory */
		}
	});

	// ── 2.14 The orchestration commands — modules/cmd-*.ts through the HarnessDeps seam ──
	const deps: HarnessDeps = {
		auditBuilderRun: auditGate,
		panel,
		stoppedPanel,
		absorbRuns: absorbTotals,
		startStoppable,
		startWidget,
		startGridWidget,
		noteHost,
		modelStack,
		architectModel,
		builderModel,
		newSlotRun,
		slotInitialSpawn,
		slotNextSpawn,
		builderSpawn,
		roleSession,
		roleThinking,
		roleSystemPrompt,
		cachedRoleId,
		cachedSlotId,
		childTimeoutMs,
		buildTimeoutMs,
		flagStr,
		mkArtifacts,
		save,
		ensureSummary,
		totals,
	};
	registerReadonlyCommands(pi, deps); // /titan-opinion + /titan-debate
	registerFusionCommand(pi, deps); // /titan-fusion
	registerCollaborateCommand(pi, deps); // /titan-collaborate
	registerAutoValidateCommand(pi, deps); // /titan-auto-validate

	// ── 2.14 /workflow — the YAML DAG engine (plan §3, P3). The engine is pure; this is its runtime. ──
	/** A workflow role → the live shape's seat for it (model, thinking, callsign, prompts, tool contract). */
	const resolveWorkflowRole = (role: SlotRole, _node: NodeDoc): ResolvedRole => {
		const stack = modelStack();
		const s = readStackSettings();
		const lanes = stack.lanes;
		const primary = stack.primaryBuilder;
		const from = (slot: ModelSlot, tools: string): ResolvedRole => ({
			model: slot.model,
			thinking: slot.thinking,
			callsign: slot.name,
			systemPrompt: slot.systemPrompt,
			appendSystemPrompts: [...(slot.appendSystemPrompts ?? [])],
			tools,
		});
		switch (role) {
			case "architect":
				return from(stack.architect, READONLY_TOOLS);
			case "builder":
				return from(primary, FULL_TOOLS);
			case "worker":
				return from(lanes.workers[0] ?? primary, FULL_TOOLS);
			case "verifier":
				return from(lanes.verifiers[0] ?? lanes.workers[0] ?? primary, READONLY_TOOLS);
			case "auditor":
				return from(lanes.auditors[0] ?? auditorFor(primary), READONLY_TOOLS);
			case "watchdog":
				return { model: s.watchdog.model, thinking: s.watchdog.thinking, callsign: lanes.watchdogs[0]?.name ?? "hound", appendSystemPrompts: [], tools: READONLY_TOOLS };
			case "fusion":
				return from(lanes.fusion[0] ?? primary, READONLY_TOOLS);
			case "judge":
				return from(lanes.judge ?? stack.architect, READONLY_TOOLS);
			case "fuser":
				return from(lanes.fuser ?? primary, FULL_TOOLS);
			default:
				return from(primary, FULL_TOOLS);
		}
	};
	/** The stack slot a request's callsign or model names — for the model bar's per-slot tps/cost. */
	const workflowSlotFor = (req: { callsign?: string; model?: string }): ModelSlot | undefined => {
		try {
			const stack = modelStack();
			return stack.slots.find((slot) => slot.name === req.callsign) ?? stack.slots.find((slot) => slot.model === req.model);
		} catch {
			return undefined;
		}
	};
	const workflowUi = (ctx: any) =>
		ctx?.hasUI
			? {
					confirm: (title: string, body: string) => ctx.ui.confirm(title, body),
					input: (title: string, placeholder?: string) => ctx.ui.input(title, placeholder),
					notify: (text: string, level?: "info" | "warning" | "error") => ctx.ui.notify(text, level ?? "info"),
				}
			: undefined;
	const workflowValidateContext = (ctx: any): Partial<ValidateContext> => ({
		modelStatus: (model: string) => {
			try {
				const slash = model.indexOf("/");
				const found = slash > 0 ? (ctx?.modelRegistry ?? hostCtx?.modelRegistry)?.find?.(model.slice(0, slash), model.slice(slash + 1)) : undefined;
				if (!found) return "unknown";
				return (ctx?.modelRegistry ?? hostCtx?.modelRegistry).hasConfiguredAuth(found) ? "ok" : "unauthed";
			} catch {
				return "unknown";
			}
		},
		thinkingCeiling: (model: string, requested: string) => normalizeThinking(model, requested as Thinking).effective,
	});
	const makeWorkflowRuntime = (ctx: any, loaded: ReturnType<typeof loadWorkflow>, runId: string, runDir: string, parentRunId?: string) =>
		createWorkflowRuntime({
			cwd: ctx.cwd,
			runId,
			runDir,
			loaded,
			store: runStore(),
			settings: readStackSettings(),
			runChild: watchdogRunChild,
			mcpTool: (server: string, tool: string, args: Record<string, unknown>) => mcpBridge().mcpTool(server, tool, args),
			resolveRole: resolveWorkflowRole,
			// Ladder step 2: the strongest usable model of the same family (never a cross-family jump).
			familyMax: (model: string) => {
				const family = modelFamily(model);
				const pool = [...BUILDER_POOL, ...AUDITOR_POOL].filter((candidate) => modelFamily(candidate) === family && modelUsable(candidate));
				return pool[0] && pool[0] !== model ? pool[0] : undefined;
			},
			ui: workflowUi(ctx),
			slotFor: workflowSlotFor,
			onRun: (run) => {
				// The workflow run holds the canonical rows; the session run aggregates every child this session spent.
				if (run.slot) bumpSlotPerf(run.slot.id, run.tokensOut, run.tpsSeconds, run.costUsd);
				recordRun(run);
				renderFooterWidget();
			},
			runWorkflow: async (name: string, inputs: Record<string, unknown>): Promise<WorkflowRunResult> => {
				const child = loadWorkflow(name, ctx.cwd, workflowValidateContext(ctx));
				const opened = runStore().open({
					projectSlug: RunStore.projectSlug(ctx.cwd),
					cwd: ctx.cwd,
					command: "workflow",
					workflow: { name: child.name, sha256: child.sha256 },
					parentRunId: parentRunId ?? runId,
					status: "running",
				});
				const result = await executeWorkflow(child, makeWorkflowRuntime(ctx, child, opened.runId, opened.dir, runId), { inputs });
				try {
					runStore().updateRun(opened.dir, { status: result.status === "completed" ? "completed" : result.status === "cancelled" ? "aborted" : "failed", endedAt: new Date().toISOString() });
				} catch {}
				return result;
			},
		});
	registerWorkflowCommands(pi, {
		cwd: (ctx: any) => ctx.cwd,
		runtime: (ctx: any, loaded, runId, runDir) => {
			noteHost(ctx);
			return makeWorkflowRuntime(ctx, loaded, runId, runDir);
		},
		store: () => runStore(),
		notify: (ctx: any, text: string, level?: string) => announce(ctx, text, (level as "info" | "warning" | "error") ?? "info"),
		panel: (_ctx: any, title: string, markdown: string) => panel({ kind: "banner", command: "workflow", ok: !/FAILED|CANCELLED/.test(title), title: title.replace(/^◆ WORKFLOW\s*/, "") }, markdown),
		validateContext: (_cwd: string, ctx: any) => workflowValidateContext(ctx) as ValidateContext,
	});

	// ── 2.15 Watchdog + compaction (plan §5.5, D3; P5). The machine is pure (modules/watchdog); this is its host. ──
	const recentRuns = new Map<string, AgentRun>(); // agentId → the last child run (transcript tails for inspections)
	let watchdog: Watchdog | undefined;
	let lastCompaction: Awaited<ReturnType<Watchdog["beforeCompact"]>> | undefined;
	const watchdogRunDir = (): string | undefined => currentWorkflowRun()?.dir ?? sessionRun?.dir;
	const contextWindowOf = (model: string): number => {
		try {
			const slash = model.indexOf("/");
			const found = hostCtx?.modelRegistry?.find?.(model.slice(0, slash), model.slice(slash + 1));
			return Number(found?.contextWindow) || 0;
		} catch {
			return 0;
		}
	};
	/** Inspectors are read-only children on the watchdog model (compaction) or the architect's model (pre-emption), priority lease, fresh session. */
	const inspectorSpawn: WatchdogDeps["inspect"] = async (prompt, opts) => {
		const run = newRun("AUDITOR", opts.model);
		const dir = path.join(watchdogRunDir() ?? os.tmpdir(), "sessions", "watchdog");
		try {
			fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
			await runChild({ run, prompt, systemPrompt: opts.systemPrompt, tools: READONLY_TOOLS, thinking: normalizeThinking(opts.model, opts.thinking as Thinking).effective, sessionDir: dir, sessionId: randomUUID(), cwd: currentCwd(), timeoutMs: opts.timeoutMs, signal: opts.signal, priority: true });
		} catch (error) {
			run.status = "failed";
			run.errorMessage = error instanceof Error ? error.message : String(error);
		}
		const ok = run.status === "done" && runOk(run);
		return { ok, text: run.text, usage: { tokensIn: run.tokensIn, tokensOut: run.tokensOut, costUsd: run.costUsd, tpsSeconds: run.tpsSeconds }, error: ok ? undefined : runError(run) };
	};
	/** The entries Pi is about to summarize, as bounded text for the inspector. */
	const entriesText = (entries: unknown[] | undefined): string => {
		if (!Array.isArray(entries)) return "";
		const lines: string[] = [];
		for (const entry of entries as any[]) {
			const message = entry?.message ?? entry;
			const role = message?.role ?? entry?.type ?? "entry";
			const content = message?.content;
			let text = "";
			if (typeof content === "string") text = content;
			else if (Array.isArray(content)) text = content.map((part: any) => (part?.type === "text" ? String(part.text ?? "") : part?.type === "toolCall" ? `[tool ${part.name ?? "?"}]` : part?.type === "toolResult" ? "[tool result]" : "")).filter(Boolean).join(" ");
			if (text.trim()) lines.push(`${role}: ${text.trim().slice(0, 2000)}`);
		}
		return lines.join("\n").slice(-24_000);
	};
	const watchdogLedger = (row: LedgerNote): void => {
		try {
			const run = sessionRunFor(currentCwd());
			if (!run) return;
			const r = newRun("AUDITOR", row.model);
			r.tokensIn = row.tokensIn;
			r.tokensOut = row.tokensOut;
			r.costUsd = row.costUsd;
			r.tpsSeconds = row.tpsSeconds ?? 0;
			r.status = row.ok ? "done" : "failed";
			r.text = row.ok ? "inspection" : "";
			r.exitCode = row.ok ? 0 : 1;
			ledger(rowFromAgentRun(r, run.runId, row.origin, readStackSettings().watchdog.thinking as Thinking, row.agentId ?? row.origin));
		} catch {
			/* observational */
		}
	};
	const getWatchdog = (): Watchdog => {
		if (watchdog) return watchdog;
		const s = readStackSettings();
		let architect: { model: string; thinking: string } | undefined;
		try {
			const stack = modelStack();
			architect = { model: stack.architect.model, thinking: stack.architect.thinking };
		} catch {}
		watchdog = createWatchdog({
			settings: s.watchdog,
			store: runStore(),
			runDir: watchdogRunDir(),
			ledger: watchdogLedger,
			entriesText,
			transcriptTail: (agentId, maxChars) => {
				const r = recentRuns.get(agentId);
				if (!r) return "";
				const tail = r.flow
					.slice(-40)
					.map((item: any) => (item.type === "tool" ? `[tool] ${item.label}` : item.type === "text" ? String(item.text) : `[thinking] ${item.text}`))
					.join("\n");
				return tail.slice(-maxChars);
			},
			architectModel: architect?.model ?? s.watchdog.model,
			architectThinking: architect?.thinking ?? "high",
			inspect: inspectorSpawn,
		});
		return watchdog;
	};
	const resetWatchdog = () => {
		watchdog = undefined;
	};
	const watchdogCell = (): WatchdogCell => {
		const s = readStackSettings().watchdog;
		if (!s.enabled) return { enabled: false, state: "off", model: s.model, inspections: 0, spendUsd: 0, findings: 0, stalemate: `0/${s.stalemateRepeats}`, onCompaction: s.onCompaction };
		const st = getWatchdog().status();
		return { enabled: true, state: st.state, model: st.model, inspections: st.inspections, spendUsd: st.spendUsd, findings: st.findings, stalemate: `${st.lastIdentityRun}/${st.stalemateRepeats}`, onCompaction: st.onCompaction };
	};
	const sessionSpendUsd = (): number => ledgerRows.reduce((sum, row) => sum + (Number(row.costUsd) || 0), 0);
	/**
	 * runChild for workflow children: refuses spawns past `budgetUsd` (held-spend), watches
	 * context usage for the watchdog and, when a child is pre-empted, inspects it and either
	 * logically clears it (same model, fresh checkpoint session) or resumes it fresh on the
	 * architect's model with the resume prompt. One pre-emption per request; never a replay.
	 */
	const watchdogRunChild: typeof runChild = async (opts) => {
		const s = readStackSettings();
		if (s.budgetUsd !== null && sessionSpendUsd() > s.budgetUsd) {
			opts.run.status = "failed";
			opts.run.errorMessage = `held-spend: this session's ledger ($${sessionSpendUsd().toFixed(2)}) is over budgetUsd ($${s.budgetUsd}); raise it with /stack budget`;
			opts.run.startedAt = Date.now();
			opts.run.endedAt = opts.run.startedAt;
			opts.run.exitCode = 1;
			try {
				if (s.watchdog.enabled) getWatchdog().spend(sessionSpendUsd(), s.budgetUsd);
			} catch {}
			return opts.run;
		}
		const wd = s.watchdog.enabled ? getWatchdog() : undefined;
		const agentId = opts.run.slot?.id ?? opts.run.role.toLowerCase();
		const window = contextWindowOf(opts.run.model);
		const first = await runChild({
			...opts,
			onUsage: wd && window > 0 ? (run) => wd.childUsage({ agentId, ctxTokens: run.ctxTokens, contextWindow: window, compactionSeen: run.compactionSeen }) : undefined,
		});
		recentRuns.set(agentId, first);
		if (!first.preempted || !wd) return first;
		const decision = await wd.preempted(agentId, { signal: opts.signal });
		recordEvent("watchdog.preempt", { agentId, model: first.model, ctxTokens: first.ctxTokens, contextWindow: window, action: decision.action, note: decision.note }, agentId);
		if (decision.action === "failed") {
			first.errorMessage = `pre-empted at ${window ? Math.round((100 * first.ctxTokens) / window) : "?"} % of context; ${decision.note}`;
			return first;
		}
		const resumeFresh = decision.action === "resume-fresh";
		const retry = newRun(first.role, resumeFresh ? decision.model : first.model, first.slot);
		const prompt = resumeFresh ? decision.resumePrompt : `${opts.prompt}\n\n[titan watchdog] Your previous session was logically cleared at ${window ? Math.round((100 * first.ctxTokens) / window) : "?"} % of the context window. Carry-over from the inspector: ${decision.carry}`;
		const second = await runChild({
			...opts,
			run: retry,
			prompt,
			fork: undefined,
			resume: undefined,
			sessionId: resumeFresh ? randomUUID() : decision.checkpointSessionId,
			thinking: resumeFresh ? normalizeThinking(decision.model, decision.thinking as Thinking).effective : opts.thinking,
			onUsage: undefined,
		});
		recentRuns.set(agentId, second);
		// The caller holds `opts.run`: settle it with the second attempt plus the pre-empted turn's spend.
		Object.assign(opts.run, second, { tokensIn: first.tokensIn + second.tokensIn, tokensOut: first.tokensOut + second.tokensOut, costUsd: first.costUsd + second.costUsd, tpsSeconds: first.tpsSeconds + second.tpsSeconds, preempted: undefined });
		return opts.run;
	};
	pi.on("session_before_compact", async (event: any, ctx: any) => {
		try {
			if (!readStackSettings().watchdog.enabled) return undefined;
			const wd = getWatchdog();
			const dir = watchdogRunDir();
			if (dir) wd.arm(dir);
			const outcome = await wd.beforeCompact({ reason: event.reason, willRetry: event.willRetry, signal: event.signal, preparation: event.preparation, branchEntries: event.branchEntries, customInstructions: event.customInstructions });
			lastCompaction = outcome;
			if (outcome.badge) announce(ctx, `titan watchdog: ${outcome.note} (${outcome.badge})`, "warning");
			renderFooterWidget();
			if (outcome.mode === "default" || !outcome.summary) return undefined;
			return { compaction: { summary: outcome.summary, firstKeptEntryId: outcome.firstKeptEntryId ?? event.preparation?.firstKeptEntryId, tokensBefore: outcome.tokensBefore ?? event.preparation?.tokensBefore } };
		} catch {
			return undefined; // the watchdog never blocks a compaction
		}
	});
	pi.on("session_compact", async (event: any) => {
		try {
			if (!watchdog) return;
			const outcome = watchdog.afterCompact({ reason: event.reason, fromExtension: event.fromExtension, willRetry: event.willRetry, compactionEntry: event.compactionEntry });
			// A Pi-authored narrative still gets the run's state block into context (custom messages participate in the LLM context).
			if (lastCompaction && lastCompaction.mode === "default" && lastCompaction.stateBlock) {
				pi.sendMessage({ customType: `${CUSTOM_TYPE}-state-block`, content: stateBlockMessage(lastCompaction.stateBlock, lastCompaction.badge), display: false });
			}
			lastCompaction = undefined;
			recordEvent("compaction.done", { summaryHash: outcome.summaryHash ?? null, fromExtension: !!event.fromExtension, reason: event.reason });
			renderFooterWidget();
		} catch {}
	});
	pi.on("session_compact_failed", async (event: any) => {
		try {
			lastCompaction = undefined;
			if (watchdog) watchdog.compactFailed({ reason: event.reason, errorMessage: event.errorMessage, aborted: event.aborted, willRetry: event.willRetry, fromExtension: event.fromExtension });
		} catch {}
	});
	pi.on("input", async () => {
		try {
			if (watchdog) watchdog.userInput(); // cancels an in-flight inspection (pi-subagents semantics)
		} catch {}
		return { action: "continue" as const };
	});
	pi.registerCommand("titan-watchdog", {
		description: "Titan-native watchdog: /titan-watchdog [status|on|off|model <provider/id>|thinking <level>|compaction halt-inspect|summary-only|off|resume]",
		getArgumentCompletions: (prefix: string) => {
			const verbs = ["status", "on", "off", "model", "thinking", "compaction", "resume"];
			const items = verbs.filter((verb) => verb.startsWith(prefix.trim().toLowerCase())).map((verb) => ({ value: verb, label: verb }));
			return items.length ? items : null;
		},
		handler: async (args: string, ctx: any) => {
			noteHost(ctx);
			const [verb = "status", ...rest] = args.trim().split(/\s+/).filter(Boolean);
			const value = rest.join(" ").trim();
			switch (verb.toLowerCase()) {
				case "on":
				case "off": {
					writeStackSettings({ watchdog: { enabled: verb === "on" } });
					resetWatchdog();
					return announce(ctx, `titan watchdog: ${verb} (${verb === "on" ? "compaction state block + inspector, child pre-emption at " + Math.round(readStackSettings().watchdog.preemptAtContextFraction * 100) + " %, stalemate detection" : "Pi's default compaction; children run unwatched"})`);
				}
				case "model": {
					if (!value.includes("/")) return announce(ctx, "usage: /titan-watchdog model <provider/id>", "warning");
					if (!modelUsable(value)) return announce(ctx, `titan watchdog: ${value} is not usable (not in catalog or not authed)`, "warning");
					writeStackSettings({ watchdog: { model: value } });
					resetWatchdog();
					return announce(ctx, `titan watchdog: model ${value}`);
				}
				case "thinking": {
					if (!THINKING_LEVELS.includes(value as Thinking)) return announce(ctx, `usage: /titan-watchdog thinking <${THINKING_LEVELS.join("|")}>`, "warning");
					writeStackSettings({ watchdog: { thinking: value } });
					resetWatchdog();
					return announce(ctx, `titan watchdog: thinking ${value} (${normalizeThinking(readStackSettings().watchdog.model, value as Thinking).effective} effective)`);
				}
				case "compaction": {
					if (!(WATCHDOG_ON_COMPACTION_MODES as string[]).includes(value)) return announce(ctx, `usage: /titan-watchdog compaction <${WATCHDOG_ON_COMPACTION_MODES.join("|")}>`, "warning");
					writeStackSettings({ watchdog: { onCompaction: value as (typeof WATCHDOG_ON_COMPACTION_MODES)[number] } });
					resetWatchdog();
					return announce(ctx, `titan watchdog: on compaction → ${value}`);
				}
				case "resume": {
					getWatchdog().resumeAfterStalemate();
					return announce(ctx, "titan watchdog: re-armed after the stalemate gate");
				}
				default: {
					const s = readStackSettings();
					if (!s.watchdog.enabled) return announce(ctx, `titan watchdog: off · model ${s.watchdog.model} (${s.watchdog.thinking}) · compaction ${s.watchdog.onCompaction} · pre-empt at ${Math.round(s.watchdog.preemptAtContextFraction * 100)} % — /titan-watchdog on`);
					const st = getWatchdog().status();
					return announce(ctx, `titan watchdog: ${st.state}${st.armedRun ? ` · run ${path.basename(st.armedRun)}` : ""} · ${st.model} (${st.thinking}) · compaction ${st.onCompaction} · pre-empt at ${Math.round(st.preemptAt * 100)} % · ${st.inspections} inspections · $${st.spendUsd.toFixed(4)} · findings ${st.findings} · stalemate ${st.lastIdentityRun}/${st.stalemateRepeats} · ${st.lastTransition}`);
				}
			}
		},
	});

	// ── 2.16 /workflow-monitor (plan D4, §5.4; P6): overlay + the ◫ MONITOR bar row + the --split pane ──
	let monitorBarCache: { at: number; text: string } = { at: 0, text: "" };
	const monitorBarText = (ctx: any): string => {
		if (Date.now() - monitorBarCache.at < 1_000) return monitorBarCache.text;
		let text = renderBarRow(undefined);
		try {
			const store = runStore();
			const live = currentWorkflowRun();
			const view: RunView | undefined = live ? buildRunView(store, live.dir) : latestRuns(store, RunStore.projectSlug(ctx?.cwd ?? currentCwd()), 1)[0];
			text = renderBarRow(view);
		} catch {}
		monitorBarCache = { at: Date.now(), text };
		return text;
	};
	registerMonitorCommand(pi, {
		store: () => runStore(),
		cwd: (ctx: any) => ctx.cwd,
		notify: (ctx: any, text: string, level?: "info" | "warning" | "error") => announce(ctx, text, level ?? "info"),
		panel: (_ctx: any, title: string, markdown: string) => panel({ kind: "banner", command: "workflow-monitor", ok: true, title: title.replace(/^◆\s*/, "") }, markdown),
		currentRunDir: () => currentWorkflowRun()?.dir,
		color: (hex: string, text: string) => fgHex(hex as HexColor, text),
		openOverlay: (ctx: any, render, onClose) => {
			if (!ctx?.hasUI || typeof ctx.ui?.custom !== "function") return undefined;
			let tick = 0;
			let tuiRef: any;
			let doneRef: ((value: unknown) => void) | undefined;
			let closed = false;
			const height = () => Math.max(8, Math.floor(Number(tuiRef?.terminal?.rows ?? process.stdout.rows ?? 40) * 0.85));
			const promise: Promise<unknown> = ctx.ui.custom(
				(tui: any, _theme: any, _keybindings: any, done: (value: unknown) => void) => {
					tuiRef = tui;
					doneRef = done;
					return {
						render: (width: number) => render(tick, { width, height: height() }).map((line) => truncateToWidth(line, width)),
						handleInput: (data: string) => {
							if (matchesKey(data, "escape") || data === "q") done(undefined);
						},
						invalidate: () => {},
					};
				},
				{
					overlay: true,
					overlayOptions: { anchor: "right-center", width: "50%", minWidth: 44, maxHeight: "90%", margin: { right: 1 } },
					onHandle: (handle: any) => {
						try {
							handle.unfocus(); // the editor keeps input; the overlay is a live view
						} catch {}
					},
				},
			);
			promise.then(
				() => {
					closed = true;
					onClose();
				},
				() => {
					closed = true;
					onClose();
				},
			);
			return {
				close: () => {
					if (!closed) doneRef?.(undefined);
				},
				refresh: () => {
					tick += 1;
					try {
						tuiRef?.requestRender?.();
					} catch {}
				},
			};
		},
		spawnSplit: async (_ctx: any, argv: string[]) => {
			const cmd = argv.map((arg) => (/[\s"'$`\\]/.test(arg) ? `'${arg.replace(/'/g, "'\\''")}'` : arg)).join(" ");
			const orca = findBinary("orca", [path.join(os.homedir(), "Dev Tools", "bin")]);
			if (orca) {
				const result = await runProcess(orca, ["terminal", "split", "--direction", "horizontal", "--command", cmd], { cwd: currentCwd(), timeoutMs: 15_000 });
				if (result.code === 0) return { ok: true, how: "orca" as const, detail: result.stdout.trim().slice(0, 200) || "pane opened" };
			}
			if (process.env.TMUX) {
				const result = await runProcess("tmux", ["split-window", "-h", cmd], { cwd: currentCwd(), timeoutMs: 15_000 });
				if (result.code === 0) return { ok: true, how: "tmux" as const, detail: "tmux pane opened" };
			}
			return { ok: false, how: "none" as const, detail: `no Orca terminal or tmux here — run by hand: ${cmd}` };
		},
	});

	// ── 2.17 Plan mode, /plan, /ultraplan and the MCP bridge (plan H6, A13, D14; P7) ──
	const PLAN_ENTRY = "titan-plan-mode";
	const planMode = createPlanMode({
		getActiveTools: () => pi.getActiveTools(),
		setActiveTools: (names) => pi.setActiveTools(names),
		notify: (text, level) => {
			try {
				hostCtx?.ui?.notify?.(text, level ?? "info");
			} catch {}
		},
		setStatus: (key, text) => {
			try {
				hostCtx?.ui?.setStatus?.(key, text);
			} catch {}
		},
		setWidget: (key, lines) => {
			try {
				hostCtx?.ui?.setWidget?.(key, lines);
			} catch {}
		},
		persist: (state: PlanModeState) => {
			try {
				pi.appendEntry(PLAN_ENTRY, state);
			} catch {}
		},
		planCommand: () => {
			try {
				const stack = modelStack();
				return stack.version === 2 ? stack.plan_command : undefined;
			} catch {
				return undefined;
			}
		},
		runUltraplan: async (args, ctx) => {
			await ultraplan.run(args, ctx);
		},
	});
	pi.registerCommand("plan", {
		description: "Read-only plan mode (edit/write off, bash allowlisted, Plan: steps tracked); at a shape with plan_command /ultraplan, bare /plan <brief> routes there. /plan [brief|on|off|toggle]",
		handler: async (args: string, ctx: any) => {
			noteHost(ctx);
			await planMode.handlePlanCommand(args ?? "", ctx);
		},
	});
	pi.registerCommand("todos", {
		description: "Show the current plan's steps and their completion",
		handler: async (_args: string, ctx: any) => {
			const text = planMode.todosText();
			ctx.ui.notify(text || "No plan steps yet. /plan, then ask for a numbered plan under a `Plan:` header.", "info");
		},
	});
	pi.on("tool_call", async (event: any) => planMode.onToolCall({ toolName: event.toolName, input: event.input ?? {} }));
	pi.on("before_agent_start", async () => planMode.onBeforeAgentStart());
	pi.on("context", async (event: any) => ({ messages: planMode.onContext(event.messages ?? []) }));
	pi.on("message_end", async (event: any) => {
		try {
			const message = event.message;
			if (message?.role !== "assistant") return;
			const text = Array.isArray(message.content) ? message.content.filter((part: any) => part?.type === "text").map((part: any) => String(part.text ?? "")).join("\n") : "";
			if (text.trim()) planMode.onAssistantMessage(text);
		} catch {}
	});
	pi.on("session_start", async (_ev: any, ctx: any) => {
		try {
			let last: Partial<PlanModeState> | undefined;
			for (const entry of ctx.sessionManager?.getEntries?.() ?? []) {
				if (entry?.type === "custom" && entry.customType === PLAN_ENTRY && entry.data) last = entry.data as Partial<PlanModeState>;
			}
			if (last) planMode.restore(last, ctx);
		} catch {}
	});
	/** The ultraplan roster with today's fallbacks: vacant seats are flagged, never silently dropped. */
	const resolveUltraplanStack = (): ResolvedUltraplanStack => {
		const base = cloneStack(loadModelStack(path.join(STACK_DIR, "model-stack-ultraplan.yaml")));
		const vacant = base.slots.filter((slot) => !modelUsable(slot.model) && !(slot.fallback && modelUsable(slot.fallback))).map((slot) => slot.name);
		const notes = resolveFallbacks(base);
		for (const slot of base.slots) if (!modelUsable(slot.model)) (slot as any).vacant = true;
		return { stack: base, notes, vacant };
	};
	const ultraplan = registerUltraplanCommand(pi, {
		resolveStack: () => {
			noteHost(hostCtx);
			return resolveUltraplanStack();
		},
		runChild: watchdogRunChild,
		store: () => runStore(),
		cwd: (ctx: any) => ctx.cwd,
		notify: (ctx: any, text: string, level?: "info" | "warning" | "error") => announce(ctx, text, level ?? "info"),
		panel: (_ctx: any, title: string, markdown: string) => panel({ kind: "banner", command: "ultraplan", ok: !/ABORT|FAILED/.test(title), title: title.replace(/^◆\s*/, "") }, markdown),
		planMode,
		childTimeoutMs,
		recordRun: (run: AgentRun) => {
			if (run.slot) bumpSlotPerf(run.slot.id, run.tokensOut, run.tpsSeconds, run.costUsd);
			recordRun(run);
			renderFooterWidget();
		},
		opinionFallback: async (prompt: string, ctx: any) => {
			announce(ctx, `ultraplan: fewer than three live fusion seats — run the read-only fan-out instead: /titan-opinion ${prompt}`, "warning");
		},
	});
	let mcpBridgeInstance: McpToolBridge | undefined;
	/** One stdio MCP client per catalog server, started lazily for workflow `mcp_tool` nodes and the InfraNodus stage. */
	const mcpBridge = (): McpToolBridge => (mcpBridgeInstance ??= createMcpToolBridge({ cwd: currentCwd() }));
	const mcpServerEnabled = (server: string): boolean => {
		try {
			const cfg = mcpBridge()
				.catalog()
				.find((entry) => entry.name === server);
			return !!cfg && !cfg.disabled;
		} catch {
			return false;
		}
	};

	// ── 2.19 /create-workflow (plan H2, Appendix B.5; P7): a read-only workflow-architect child emits; the host persists ──
	registerCreateWorkflowCommand(pi, {
		runChild: watchdogRunChild,
		store: () => runStore(),
		cwd: (ctx: any) => ctx.cwd,
		notify: (ctx: any, text: string, level?: "info" | "warning" | "error") => announce(ctx, text, level ?? "info"),
		panel: (_ctx: any, title: string, markdown: string) => panel({ kind: "banner", command: "create-workflow", ok: !/FAILED/.test(title), title: title.replace(/^◆\s*/, "") }, markdown),
		architectSeat: (ctx: any) => {
			noteHost(ctx);
			const seat = modelStack().architect;
			return { model: seat.model, thinking: seat.thinking, callsign: seat.name, systemPrompt: seat.systemPrompt, appendSystemPrompts: [...(seat.appendSystemPrompts ?? [])], substitutedFrom: (seat as any).substitutedFrom };
		},
		levelInfo: (ctx: any) => {
			const snapshot = levelSnapshot(ctx);
			let tier: string | undefined;
			try {
				tier = modelStack().verification?.default_tier;
			} catch {}
			return { level: snapshot.level, shape: shapeName(), tier };
		},
		setStatus: (ctx: any, text: string | undefined) => {
			try {
				ctx.ui.setStatus("titan", text);
			} catch {}
		},
		childTimeoutMs,
		onShapeChanged: (cb) => {
			shapeListeners.add(cb);
			return () => shapeListeners.delete(cb);
		},
		validateContext: (_cwd: string, ctx: any) => workflowValidateContext(ctx),
	});

	// ── 2.20 /terraform (plan H7, §5.7; P8): entity docs from the fusion seats, InfraNodus ontology when keyed, connectors + automations ──
	registerTerraformCommand(pi, {
		cwd: (ctx: any) => ctx.cwd,
		store: () => runStore(),
		notify: (ctx: any, text: string, level?: "info" | "warning" | "error") => announce(ctx, text, level ?? "info"),
		panel: (_ctx: any, title: string, markdown: string) => panel({ kind: "banner", command: "terraform", ok: !/FAILED/.test(title), title: title.replace(/^◆\s*/, "") }, markdown),
		runWorkflow: async (ctx: any, loaded, inputs) => {
			noteHost(ctx);
			const opened = runStore().open({ projectSlug: RunStore.projectSlug(ctx.cwd), cwd: ctx.cwd, command: "terraform", workflow: { name: loaded.name, sha256: loaded.sha256 }, status: "running" });
			const result = await executeWorkflow(loaded, makeWorkflowRuntime(ctx, loaded, opened.runId, opened.dir), { inputs });
			try {
				runStore().updateRun(opened.dir, { status: result.status === "completed" ? "completed" : result.status === "cancelled" ? "aborted" : "failed", endedAt: new Date().toISOString() });
			} catch {}
			return result;
		},
		ontology: (text: string) => ontologyStage(mcpBridge(), text, { purpose: "terraform: the entity ontology of this project for its harness docs" }),
	});

	// ── 2.21 /local-dev-verify (plan H8; P8): start or probe the app, sim-user flows, Kane or the CDP headless driver, hashed evidence ──
	registerLocalDevVerifyCommand(pi, {
		cwd: (ctx: any) => ctx.cwd,
		store: () => runStore(),
		notify: (ctx: any, text: string, level?: "info" | "warning" | "error") => announce(ctx, text, level ?? "info"),
		panel: (_ctx: any, title: string, markdown: string) => panel({ kind: "banner", command: "local-dev-verify", ok: !/FAILED|UNAVAILABLE/.test(title), title: title.replace(/^◆\s*/, "") }, markdown),
		runtime: (ctx: any, loaded, runId, runDir) => {
			noteHost(ctx);
			return makeWorkflowRuntime(ctx, loaded, runId, runDir);
		},
		settings: () => readStackSettings(),
		which: (binary: string) => findBinary(binary, [path.join(os.homedir(), ".local", "bin"), path.join(os.homedir(), ".bun", "bin"), path.join(os.homedir(), "Dev Tools", "bin")]),
		setStatus: (ctx: any, text: string | undefined) => {
			try {
				ctx.ui.setStatus("titan-local-dev-verify", text);
			} catch {}
		},
	});

	// ── 2.18 /cloud-simulated-users (plan H9; P8): provider probe matrix, setup agent, recorded runs ──
	registerCloudSimCommand(pi, {
		cwd: (ctx: any) => ctx.cwd,
		store: () => runStore(),
		notify: (ctx: any, text: string, level?: "info" | "warning" | "error") => announce(ctx, text, level ?? "info"),
		panel: (_ctx: any, title: string, markdown: string) => panel({ kind: "banner", command: "cloud-simulated-users", ok: !/FAILED|VACANT/.test(title), title: title.replace(/^◆\s*/, "") }, markdown),
		runtime: (ctx: any, loaded, runId, runDir) => {
			noteHost(ctx);
			return makeWorkflowRuntime(ctx, loaded, runId, runDir);
		},
		confirm: async (ctx: any, title: string, body: string) => {
			try {
				return ctx?.hasUI ? !!(await ctx.ui.confirm(title, body)) : false;
			} catch {
				return false;
			}
		},
		which: (binary: string) => findBinary(binary, [path.join(os.homedir(), ".local", "bin"), path.join(os.homedir(), ".bun", "bin"), path.join(os.homedir(), "Dev Tools", "bin")]),
		env: (name: string) => typeof process.env[name] === "string" && process.env[name]!.length > 0,
		mcpEnabled: mcpServerEnabled,
		runChild: watchdogRunChild,
		workerSeat: () => resolveWorkflowRole("worker", { id: "cloud-sim-setup", prompt: "" } as NodeDoc),
		childTimeoutMs,
	});
	pi.on("session_shutdown", async () => {
		try {
			await mcpBridgeInstance?.close();
		} catch {}
		mcpBridgeInstance = undefined;
	});
}
