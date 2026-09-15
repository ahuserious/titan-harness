/**
 * nodes/verify.ts — `verify: {runner, objective, devices, headless, …}` nodes (P4 stub).
 *
 * P3 ships the node type so workflows validate, layer and schedule; every run of it ends
 * "failed" with "not implemented until P4" and is never retried. P4 (plan §5.8, D9) fills
 * in the runner adapters — kane (kane-cli NDJSON run_end + .testmuai/evidence hashes),
 * testmu (HyperExecute triage tools), momentic (only when keyed and enabled), cursor-cloud
 * (preflight GET /v1/me, idempotent agentId, poll runs, download artifacts), orca-browser
 * (`orca tab …` driven by sim-user workers) and bash — each failing closed: status pass ∧
 * artifacts exist ∧ hashes recorded, else `unavailable`; and writes
 * evidence/<nodeId>/evidence.json (plan §5.1) through store.writeEvidence.
 */
import type { NodeHandler } from "../executor.ts";

export const NOT_IMPLEMENTED = "not implemented until P4";

export const runVerifyNode: NodeHandler = async (ctx) => ({ status: "failed", output: undefined, error: `verify ${(ctx.node as { verify?: { runner?: string } }).verify?.runner ?? ""}: ${NOT_IMPLEMENTED}`.replace(/ :/, ":"), retryable: false });
