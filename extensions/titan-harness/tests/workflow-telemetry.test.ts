import { describe, expect, test } from "bun:test";
import { summarizeThroughput } from "../modules/monitor/workflow-telemetry.ts";
import { throughputFromLedger, type LedgerRow } from "../modules/ledger.ts";

describe("human throughput telemetry", () => {
	test("weights generation durations instead of averaging rates", () => {
		const result = summarizeThroughput([
			{ outputTokens: 100, generationSeconds: 1, measurement: "measured" },
			{ outputTokens: 100, generationSeconds: 9, measurement: "measured" },
			{ outputTokens: 900, generationSeconds: 1, measurement: "estimated" },
		]);
		expect(result.measured).toEqual({ sampleCount: 2, outputTokens: 200, generationSeconds: 10, tokensPerSecond: 20 });
		expect(result.estimated.tokensPerSecond).toBe(900);
		expect(result.coverage).toEqual({ totalSamples: 3, measuredSamples: 2, estimatedSamples: 1, excludedSamples: 0, measuredFraction: 2 / 3 });
	});

	test("missing or invalid pairs and unknown provenance are excluded, with explicit coverage", () => {
		const result = summarizeThroughput([
			{ outputTokens: undefined, generationSeconds: 1, measurement: "measured" },
			{ outputTokens: 1, measurement: "measured" },
			...[0, -1, NaN, Infinity].map((generationSeconds) => ({ outputTokens: 1, generationSeconds, measurement: "measured" as const })),
			...[-1, NaN, Infinity].map((outputTokens) => ({ outputTokens, generationSeconds: 1, measurement: "measured" as const })),
			{ outputTokens: 1, generationSeconds: 1, measurement: "unknown" },
		]);
		expect(result.measured.tokensPerSecond).toBeUndefined();
		expect(result.coverage).toMatchObject({ totalSamples: 10, excludedSamples: 10, measuredFraction: 0 });
		expect(summarizeThroughput([]).coverage.measuredFraction).toBeUndefined();
		expect(summarizeThroughput([{ outputTokens: 0, generationSeconds: 2, measurement: "measured" }]).measured.tokensPerSecond).toBe(0);
	});

	test("ledger legacy provider-response duration is estimated, explicit measured pairs stand alone", () => {
		const legacy = { source: "observed", tokens: { output: 200 }, tpsSeconds: 10 } as LedgerRow;
		expect(throughputFromLedger([legacy]).measured.tokensPerSecond).toBeUndefined();
		expect(throughputFromLedger([legacy]).estimated.tokensPerSecond).toBe(20);
		const result = throughputFromLedger([legacy, { ...legacy, generationMeasurement: { outputTokens: 50, generationSeconds: 1, measurement: "measured" } }, { ...legacy, source: "unmetered" }]);
		expect(result.measured.tokensPerSecond).toBe(50);
		expect(result.coverage).toMatchObject({ measuredSamples: 1, estimatedSamples: 1, excludedSamples: 1 });
	});
});
