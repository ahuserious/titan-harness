import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync, readFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { formatDoctor, importInfranodusKey, infranodusConfigured, runDoctor, shiftTabFree } from "../modules/doctor.ts";

const dirs: string[] = [];
const tmp = () => {
	const dir = mkdtempSync(join(tmpdir(), "titan-doctor-"));
	dirs.push(dir);
	return dir;
};
afterEach(() => {
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const registryWith = (authed: string[], catalog: string[]) => ({
	find: (provider: string, id: string) => (catalog.includes(`${provider}/${id}`) ? { provider, id } : undefined),
	hasConfiguredAuth: (model: { provider: string; id: string }) => authed.includes(`${model.provider}/${model.id}`),
});

describe("doctor", () => {
	test("shift+tab is reserved without a rebind and free after one", () => {
		const dir = tmp();
		const file = join(dir, "keybindings.json");
		expect(shiftTabFree(file).free).toBe(false);
		writeFileSync(file, JSON.stringify({ "app.thinking.cycle": "alt+t" }));
		expect(shiftTabFree(file).free).toBe(true);
		writeFileSync(file, JSON.stringify({ "app.thinking.cycle": [] }));
		expect(shiftTabFree(file).free).toBe(true);
		writeFileSync(file, JSON.stringify({ "app.thinking.cycle": ["shift+tab", "alt+t"] }));
		expect(shiftTabFree(file).free).toBe(false);
	});

	test("infranodus user-config detection ignores placeholders and disabled entries", () => {
		const dir = tmp();
		const file = join(dir, "mcp.json");
		expect(infranodusConfigured(file).configured).toBe(false);
		writeFileSync(file, JSON.stringify({ mcpServers: { infranodus: { command: "npx", env: { INFRANODUS_API_KEY: "${INFRANODUS_API_KEY}" } } } }));
		expect(infranodusConfigured(file).configured).toBe(false);
		writeFileSync(file, JSON.stringify({ mcpServers: { infranodus: { command: "npx", env: { INFRANODUS_API_KEY: "k" }, disabled: true } } }));
		expect(infranodusConfigured(file).configured).toBe(false);
		writeFileSync(file, JSON.stringify({ mcpServers: { infranodus: { command: "npx", env: { INFRANODUS_API_KEY: "k" } } } }));
		expect(infranodusConfigured(file).configured).toBe(true);
	});

	test("importInfranodusKey copies from the environment into the user config without printing the value", () => {
		const dir = tmp();
		const file = join(dir, "mcp.json");
		mkdirSync(dir, { recursive: true });
		writeFileSync(file, JSON.stringify({ mcpServers: { figma: { url: "https://mcp.figma.com/mcp" } } }));
		const previous = process.env.INFRANODUS_API_KEY;
		process.env.INFRANODUS_API_KEY = "secret-value-123";
		try {
			const result = importInfranodusKey(file);
			expect(result.ok).toBe(true);
			expect(result.message).not.toContain("secret-value-123");
			const written = JSON.parse(readFileSync(file, "utf8"));
			expect(written.mcpServers.figma.url).toBe("https://mcp.figma.com/mcp");
			expect(written.mcpServers.infranodus.env.INFRANODUS_API_KEY).toBe("secret-value-123");
			expect(written.mcpServers.infranodus.disabled).toBe(false);
			expect(written.mcpServers.infranodus.args).toEqual(["-y", "infranodus-mcp-server"]);
		} finally {
			if (previous === undefined) delete process.env.INFRANODUS_API_KEY;
			else process.env.INFRANODUS_API_KEY = previous;
		}
	});

	test("runDoctor classifies models by catalog and auth and formats a grouped report", () => {
		const dir = tmp();
		const ctx = { modelRegistry: registryWith(["xai/grok-4.6", "cerebras/qwen-3.8-27b"], ["xai/grok-4.6", "cerebras/qwen-3.8-27b", "openai-codex/gpt-6-astra"]) };
		const report = runDoctor({
			ctx,
			env: {},
			keybindingsPath: join(dir, "keybindings.json"),
			userMcpConfig: join(dir, "mcp.json"),
			pins: () => [{ name: "@quintinshaw/pi-dynamic-workflows", expected: "3.10.1", found: "3.10.1", ok: true }],
			dwPatchApplied: () => true,
		});
		const byKey = Object.fromEntries(report.items.map((item) => [item.key, item]));
		expect(byKey["xai/grok-4.6"].status).toBe("ready");
		expect(byKey["openai-codex/gpt-6-astra"].status).toBe("vacant");
		expect(byKey["openai-codex/gpt-6-astra"].action).toBe("/login openai-codex");
		expect(byKey["anthropic/claude-fable-5-1"].status).toBe("vacant");
		expect(byKey["shift-tab"].status).toBe("warn");
		expect(byKey["@quintinshaw/pi-dynamic-workflows"].status).toBe("ready");
		expect(byKey["dw-patch"].status).toBe("ready");
		expect(byKey["INFRANODUS_API_KEY"].status).toBe("vacant");
		expect(report.summary.ready + report.summary.vacant + report.summary.warn + report.summary.unknown).toBe(report.items.length);
		const text = formatDoctor(report);
		expect(text).toContain("MODELS");
		expect(text).toContain("DECISIONS");
		expect(text).toContain("/login openai-codex");
	});
});
