import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "bun:test";
import { DEFAULT_CONNECTORS } from "../modules/connectors.ts";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const catalogPath = join(root, "mcp", "mcp.json");
const fiberSkill = join(root, "skills", "fiber-b2b-data", "SKILL.md");
const outboundSkill = join(root, "skills", "outbound-scratch", "SKILL.md");

describe("mcp catalog: outbound scratch", () => {
	test("ships Fiber OAuth and never a Salesforce sandbox host", () => {
		const text = readFileSync(catalogPath, "utf8");
		const catalog = JSON.parse(text) as { mcpServers: Record<string, { url?: string; auth?: string }> };
		expect(catalog.mcpServers.fiber, "fiber server missing from mcp/mcp.json").toMatchObject({
			url: "https://mcp.fiber.ai/mcp/v3",
			auth: "oauth",
		});
		expect(catalog.mcpServers.salesforce, "Salesforce must not be in the package catalog").toBeUndefined();
		expect(text).not.toContain("test.salesforce.com");
		expect(text).not.toContain("/sandbox/platform/");
		expect(text).not.toContain("login.salesforce.com");
	});

	test("DEFAULT_CONNECTORS names Fiber as MCP and not Salesforce", () => {
		const names = DEFAULT_CONNECTORS.map((c) => c.name);
		expect(names).toContain("fiber");
		expect(names).not.toContain("salesforce");
		expect(DEFAULT_CONNECTORS.find((c) => c.name === "fiber")).toMatchObject({ kind: "mcp", server: "fiber" });
	});

	test("skill pack tells hosts scratch CRM is Macro, not Salesforce sandbox", () => {
		expect(existsSync(fiberSkill)).toBe(true);
		expect(existsSync(outboundSkill)).toBe(true);
		const outbound = readFileSync(outboundSkill, "utf8");
		expect(outbound).toContain("test.salesforce.com");
		expect(outbound).toContain("Outbound scratch");
		expect(outbound).toContain("Never treat a Developer Edition");
		expect(outbound).not.toMatch(/https:\/\/test\.salesforce\.com\/services/);
	});
});
