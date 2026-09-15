import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RunStore } from "../modules/run-store.ts";
import { sha256 } from "../modules/hash-chain.ts";
import {
	buildEvidence,
	checkCitations,
	declaredArtifact,
	EVIDENCE_KINDS,
	type EvidenceArtifact,
	evidenceStatus,
	hashArtifact,
	observedKinds,
	readEvidencePackage,
	simUserKinds,
	writeEvidencePackage,
} from "../modules/workflow/evidence.ts";

const dirs: string[] = [];
afterEach(() => {
	while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});
const scratch = (): string => {
	const dir = mkdtempSync(join(tmpdir(), "titan-evidence-"));
	dirs.push(dir);
	return dir;
};
const FIXTURES = join(import.meta.dir, "fixtures");
const observed = (kind: EvidenceArtifact["kind"], source: EvidenceArtifact["source"] = "bash", extra: Partial<EvidenceArtifact> = {}): EvidenceArtifact => ({ path: `/x/${kind}`, sha256: sha256(kind), bytes: 3, kind, capturedBy: "observed", source, ts: "2026-09-15T00:00:00.000Z", ...extra });

describe("evidence: artifacts", () => {
	test("hashArtifact hashes a real file; a missing file keeps the row with degraded missing and no sha256", async () => {
		const dir = scratch();
		const file = join(dir, "screenshot-1.png");
		writeFileSync(file, "png-bytes");
		const row = await hashArtifact(file, "screenshot", "orca", { device: "desktop" });
		expect(row).toMatchObject({ path: file, kind: "screenshot", source: "orca", capturedBy: "observed", sha256: sha256("png-bytes"), bytes: 9, device: "desktop" });
		expect(row.degraded).toBeUndefined();
		const gone = await hashArtifact(join(dir, "nope.log"), "log", "kane");
		expect(gone.sha256).toBeUndefined();
		expect(gone.degraded).toEqual(["missing"]);
		expect(observedKinds({ artifacts: [row, gone] })).toEqual(new Set(["screenshot"]));
	});

	test("declared rows never count as hard evidence; sim-user kinds come only from kane/momentic/orca", () => {
		const artifacts = [declaredArtifact("test-result", "the model says tests passed"), observed("screenshot", "bash"), observed("video", "kane"), { ...observed("log", "tool"), sha256: "short" }];
		expect(observedKinds({ artifacts })).toEqual(new Set(["screenshot", "video"]));
		expect(simUserKinds({ artifacts })).toEqual(new Set(["video"]));
		expect(EVIDENCE_KINDS).toContain("db-op-log");
	});
});

describe("evidence: status derivation (fail closed)", () => {
	test.each([
		["all required observed → matched", [observed("http-status"), observed("payload-hash")], ["http-status", "payload-hash"], "matched", []],
		["some missing → current-unverified", [observed("http-status")], ["http-status", "payload-hash"], "current-unverified", ["payload-hash"]],
		["nothing usable → unavailable", [declaredArtifact("http-status", "claimed")], ["http-status"], "unavailable", ["http-status"]],
		["no artifacts at all → unavailable", [], ["screenshot"], "unavailable", ["screenshot"]],
		["declared rows do not satisfy a requirement", [observed("log"), declaredArtifact("screenshot", "claimed")], ["log", "screenshot"], "current-unverified", ["screenshot"]],
	] as const)("%s", (_label, artifacts, required, status, missing) => {
		expect(evidenceStatus({ artifacts: [...artifacts] }, [...required])).toEqual({ status, missing: [...missing] });
	});

	test("anyOf groups: one of the kinds suffices; simUser demands a simulated-user source (H3d)", () => {
		const base = { required: ["log"] as const, anyOf: [["video", "screenshot"]] as Array<Array<"video" | "screenshot">> };
		expect(evidenceStatus({ artifacts: [observed("log"), observed("screenshot", "bash")] }, { required: [...base.required], anyOf: base.anyOf })).toEqual({ status: "matched", missing: [] });
		expect(evidenceStatus({ artifacts: [observed("log"), observed("screenshot", "bash")] }, { required: [...base.required], anyOf: base.anyOf, simUser: true })).toEqual({ status: "current-unverified", missing: ["video|screenshot (sim-user source)"] });
		expect(evidenceStatus({ artifacts: [observed("log"), observed("screenshot", "kane")] }, { required: [...base.required], anyOf: base.anyOf, simUser: true })).toEqual({ status: "matched", missing: [] });
	});

	test("buildEvidence carries status, missingInformation and the optional fields", () => {
		const pkg = buildEvidence({ runId: "r1", nodeId: "verify-1", agent: "assay", tier: "web-general", modes: ["bash"], artifacts: [observed("screenshot")], checks: { exitCode: 0 }, summary: "ok", missingInformation: ["device b never reported"] }, ["screenshot", "db-op-log"]);
		expect(pkg).toMatchObject({ schemaVersion: 1, runId: "r1", nodeId: "verify-1", agent: "assay", tier: "web-general", modes: ["bash"], status: "current-unverified", checks: { exitCode: 0 }, provenanceSeq: [], summary: "ok" });
		expect(pkg.missingInformation).toEqual(["missing evidence: db-op-log", "device b never reported"]);
	});
});

describe("evidence: persistence", () => {
	test("writeEvidencePackage goes through the store (canonical JSON + sha256 sidecar) and reads back", () => {
		const root = scratch();
		const store = new RunStore(root);
		const cwd = scratch();
		const { dir } = store.open({ projectSlug: RunStore.projectSlug(cwd), cwd, command: "workflow", status: "running" });
		const pkg = buildEvidence({ runId: "r1", nodeId: "verify/1", artifacts: [observed("log")] }, ["log"]);
		const written = writeEvidencePackage(store, dir, pkg);
		expect(written.path).toBe(join(dir, "evidence", "verify-1", "evidence.json"));
		expect(existsSync(`${written.path}.sha256`)).toBe(true);
		expect(readFileSync(`${written.path}.sha256`, "utf8")).toBe(`${written.sha256}  evidence.json\n`);
		expect(readEvidencePackage(dir, "verify/1")).toEqual(pkg);
		expect(readEvidencePackage(dir, "nope")).toBeUndefined();
	});
});

describe("evidence: checkCitations (H3b, deterministic)", () => {
	const docs = [
		{ name: "vision.md", text: readFileSync(join(FIXTURES, "vision.md"), "utf8") },
		{ name: "intent.md", text: readFileSync(join(FIXTURES, "intent.md"), "utf8") },
	];

	test("resolves anchors, bracket citations, breadcrumbs and section numbers that exist", () => {
		const text = "Per vision.md#goals we ship one page. [intent: Scope] limits release one. See vision.md > Non-goals and vision.md §2.1 plus § 2.3.";
		const result = checkCitations(text, docs);
		expect(result.missing).toEqual([]);
		expect(result.cited).toEqual(["vision.md#goals", "[intent: Scope]", "vision.md > Non-goals", "vision.md §2.1", "§ 2.3"]);
	});

	test("flags a cited section that does not exist and a doc that is not among the grounding docs", () => {
		const text = "As vision.md#pricing-tiers states, we bill per seat; [intent: Revenue model] agrees; vision.md §4.2 fixes the SLA; roadmap.md#q3 lists it.";
		const result = checkCitations(text, docs);
		expect([...result.missing].sort()).toEqual(["[intent: Revenue model]", "roadmap.md#q3", "vision.md §4.2", "vision.md#pricing-tiers"]);
	});

	test("brackets that name no known doc are not citations; duplicates are counted once", () => {
		const result = checkCitations("[note: remember this] and [vision: Goals] and again [vision: Goals]", docs);
		expect(result).toEqual({ cited: ["[vision: Goals]"], missing: [] });
	});
});
