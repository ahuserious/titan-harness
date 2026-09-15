import { describe, expect, test } from "bun:test";
import { describeTier, elevationTarget, evidenceRequirement, isTierName, requiredKinds, TIER_NAMES, TIERS, tierFor } from "../modules/workflow/tiers.ts";
import type { NodeDoc, WorkflowDoc } from "../modules/workflow/schema.ts";

describe("tiers: the §5.2 table as data", () => {
	test("every tier names its required kinds, verifiers and review policy exactly", () => {
		expect(TIER_NAMES).toEqual(["web-general", "research-planning", "prototype-analytics", "production-swe", "platform-update", "content"]);
		expect(TIERS["web-general"]).toMatchObject({ required: ["http-status", "payload-hash", "screenshot", "db-op-log"], verifiers: ["bash", "orca-browser"], review: "optional", simUser: false, humanApprovals: 0, mechanicalMax: 3 });
		expect(TIERS["research-planning"]).toMatchObject({ required: ["plan-digest", "source-digests", "alignment-table"], verifiers: ["verifier"], review: "required" });
		expect(TIERS["prototype-analytics"]).toMatchObject({ required: ["test-result", "log", "screenshot", "script", "result-card", "design-match"], verifiers: ["cursor-cloud", "kane"], review: "required" });
		expect(TIERS["production-swe"]).toMatchObject({ required: ["test-result", "log", "screenshot", "script", "result-card", "design-match", "console-log", "network-log", "schedule-id"], anyOf: [["video", "screenshot"]], verifiers: ["kane", "momentic", "orca-browser"], review: "required", simUser: true });
		expect(TIERS["platform-update"]).toMatchObject({ required: ["diff", "migration-log", "coverage-report", "probe", "rollback-note"], review: "required", coverageMin: 100, simUser: true });
		expect(TIERS["platform-update"].verifiers).toContain("approval");
		expect(TIERS.content).toMatchObject({ required: ["payload-hash", "source-digests", "screenshot", "approval-receipt"], verifiers: ["approval", "judge"], humanApprovals: 3 });
		for (const name of TIER_NAMES) expect(TIERS[name].name).toBe(name);
	});

	test("elevationTarget is min(level + 1, 3); no level → 1", () => {
		expect(elevationTarget(undefined)).toBe(1);
		expect(elevationTarget(0)).toBe(1);
		expect(elevationTarget(2)).toBe(3);
		expect(elevationTarget(3)).toBe(3);
		expect(TIERS.content.elevationTarget(1)).toBe(2);
	});

	test("tierFor prefers the node's tier over titan.tier and ignores unknown names", () => {
		const doc = { apiVersion: "titan.harness/v1", name: "t", nodes: [], titan: { tier: "web-general" } } as unknown as WorkflowDoc;
		expect(tierFor(doc)?.name).toBe("web-general");
		expect(tierFor(doc, { id: "v", tier: "content" } as NodeDoc)?.name).toBe("content");
		expect(tierFor(doc, { id: "v", tier: "made-up" } as NodeDoc)).toBeUndefined();
		expect(tierFor({ ...doc, titan: {} } as WorkflowDoc)).toBeUndefined();
		expect(isTierName("production-swe")).toBe(true);
		expect(isTierName("swe")).toBe(false);
	});

	test("requiredKinds merges the tier with the node's evidence.require; evidenceRequirement carries anyOf + simUser", () => {
		const node = { id: "v", evidence: { require: ["screenshot", "probe"] } } as NodeDoc;
		expect(requiredKinds(TIERS["web-general"], node)).toEqual(["http-status", "payload-hash", "screenshot", "db-op-log", "probe"]);
		expect(requiredKinds(undefined, node)).toEqual(["screenshot", "probe"]);
		expect(evidenceRequirement(TIERS["production-swe"], node)).toEqual({ required: [...TIERS["production-swe"].required, "probe"], anyOf: [["video", "screenshot"]], simUser: true });
		expect(evidenceRequirement(TIERS["web-general"])).toEqual({ required: [...TIERS["web-general"].required] });
	});

	test("describeTier renders one line", () => {
		expect(describeTier(TIERS["production-swe"])).toBe("production-swe · review required · sim-user · 9 kinds + video|screenshot");
		expect(describeTier(TIERS.content)).toBe("content · review required · no sim-user · 4 kinds · 3 human approvals");
		expect(describeTier(TIERS["platform-update"])).toContain("coverage ≥ 100 %");
	});
});
