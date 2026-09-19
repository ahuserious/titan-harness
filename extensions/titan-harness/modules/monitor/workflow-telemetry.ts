/** Human UI only. Do not serialize these samples into task capsules or model context. */
export interface ThroughputSample {
	outputTokens?: number;
	generationSeconds?: number;
	measurement: "measured" | "estimated" | "unknown";
}

export interface ThroughputAggregate {
	sampleCount: number;
	outputTokens: number;
	generationSeconds: number;
	/** Absent means unknown. Zero is valid only for a measured zero-token sample. */
	tokensPerSecond?: number;
}

export interface ThroughputSummary {
	measured: ThroughputAggregate;
	estimated: ThroughputAggregate;
	coverage: {
		totalSamples: number;
		measuredSamples: number;
		estimatedSamples: number;
		excludedSamples: number;
		/** Sample coverage, not a claim about token coverage or exporter completeness. */
		measuredFraction?: number;
	};
}

/**
 * Sum paired output counts / sum corresponding generation durations (seconds).
 * Caller must supply actual generation measurements, preferably monotonic, for
 * "measured". Provider-response/wall durations belong in "estimated". Output token
 * accounting is passed through; callers must disclose whether reasoning is included.
 * Missing, non-finite, negative counts and nonpositive durations are excluded.
 */
export function summarizeThroughput(samples: readonly ThroughputSample[]): ThroughputSummary {
	const empty = (): ThroughputAggregate => ({ sampleCount: 0, outputTokens: 0, generationSeconds: 0 });
	const measured = empty();
	const estimated = empty();
	for (const sample of samples) {
		const { outputTokens: tokens, generationSeconds: seconds } = sample;
		if (typeof tokens !== "number" || !Number.isFinite(tokens) || tokens < 0 || typeof seconds !== "number" || !Number.isFinite(seconds) || seconds <= 0) continue;
		const target = sample.measurement === "measured" ? measured : sample.measurement === "estimated" ? estimated : undefined;
		if (!target) continue;
		target.sampleCount++;
		target.outputTokens += tokens;
		target.generationSeconds += seconds;
	}
	for (const target of [measured, estimated]) {
		if (target.sampleCount && Number.isFinite(target.outputTokens) && Number.isFinite(target.generationSeconds)) {
			const rate = target.outputTokens / target.generationSeconds;
			if (Number.isFinite(rate)) target.tokensPerSecond = rate;
		}
	}
	return {
		measured, estimated,
		coverage: {
			totalSamples: samples.length,
			measuredSamples: measured.sampleCount,
			estimatedSamples: estimated.sampleCount,
			excludedSamples: samples.length - measured.sampleCount - estimated.sampleCount,
			measuredFraction: samples.length ? measured.sampleCount / samples.length : undefined,
		},
	};
}
