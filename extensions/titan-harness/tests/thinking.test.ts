import { describe, expect, test } from "bun:test";
import type { Thinking } from "../modules/model-stack.ts";
import { normalizeThinking, STATIC_CEILINGS, staticCeiling, supportedThinkingLevels, THINKING_ORDER, thinkingLabel } from "../modules/thinking.ts";

describe("thinking normalization", () => {
  test("THINKING_ORDER is Pi's ladder", () => {
    expect(THINKING_ORDER).toEqual(["off", "minimal", "low", "medium", "high", "xhigh", "max"]);
  });

  // Plan §4.4, all seven models, static table only (no registry model).
  test.each<[string, Thinking, Thinking, string]>([
    ["xai/grok-4.6", "xhigh", "xhigh", "unknown_model"],
    ["openai-codex/gpt-6-astra", "xhigh", "xhigh", "unknown_model"],
    ["openai-codex/gpt-6-astra", "max", "max", "unknown_model"],
    ["anthropic/claude-fable-5-1", "xhigh", "xhigh", "unknown_model"],
    ["anthropic/claude-fable-5-1", "max", "max", "unknown_model"],
    ["openrouter/meta/muse-spark-1.3", "max", "max", "unknown_model"],
    ["antigravity/gemini-3.8-flash", "xhigh", "high", "provider_ceiling"],
    ["antigravity/gemini-3.8-flash", "high", "high", "identity"],
    ["cerebras/qwen-3.8-27b", "xhigh", "high", "provider_ceiling"],
    ["cerebras/qwen-3.8-27b", "max", "high", "provider_ceiling"],
    ["cerebras/qwen-3.8-27b", "medium", "medium", "identity"],
    ["antigravity/claude-opus-4-6", "high", "high", "unknown_model"],
  ])("static: %s requested %s → %s (%s)", (model, requested, effective, reason) => {
    expect(normalizeThinking(model, requested)).toEqual({ requested, effective, reason });
  });

  test("static table matches the full id, then the id after the provider, then the last segment", () => {
    expect(STATIC_CEILINGS["xai/grok-4.5"]).toBe("high");
    expect(staticCeiling("xai/grok-4.5")).toBe("high");
    expect(staticCeiling("openrouter/x-ai/grok-4.5")).toBe("high");
    expect(staticCeiling("someprovider/gemini-3.8-flash")).toBe("high");
    expect(staticCeiling("Antigravity/Gemini-3.8-Flash")).toBe("high");
    expect(staticCeiling("xai/grok-4.6")).toBeUndefined();
    expect(normalizeThinking("openrouter/x-ai/grok-4.5", "xhigh")).toEqual({ requested: "xhigh", effective: "high", reason: "provider_ceiling" });
  });

  test("registry map: Pi's shipped gemini-3.8-flash {off: null} caps xhigh at high", () => {
    const gemini = { thinkingLevelMap: { off: null } };
    expect(supportedThinkingLevels(gemini)).toEqual(["minimal", "low", "medium", "high"]);
    expect(normalizeThinking("google/gemini-3.8-flash", "xhigh", gemini)).toEqual({ requested: "xhigh", effective: "high", reason: "provider_ceiling" });
    expect(normalizeThinking("google/gemini-3.8-flash", "high", gemini)).toEqual({ requested: "high", effective: "high", reason: "identity" });
  });

  test("registry map: grok-4.6 passes xhigh through and caps max at xhigh", () => {
    const grok = { thinkingLevelMap: { off: null, minimal: null, low: "low", medium: "medium", high: "high", xhigh: "xhigh", max: null } };
    expect(normalizeThinking("xai/grok-4.6", "xhigh", grok)).toEqual({ requested: "xhigh", effective: "xhigh", reason: "identity" });
    expect(normalizeThinking("xai/grok-4.6", "max", grok)).toEqual({ requested: "max", effective: "xhigh", reason: "provider_ceiling" });
  });

  test("registry map: fable max is identity; opus-4-6 {max} caps xhigh at high", () => {
    const fable = { thinkingLevelMap: { off: null, xhigh: "xhigh", max: "max" } };
    expect(normalizeThinking("anthropic/claude-fable-5-1", "max", fable)).toEqual({ requested: "max", effective: "max", reason: "identity" });
    const opus = { thinkingLevelMap: { max: "max" } };
    expect(normalizeThinking("anthropic/claude-opus-4-6", "xhigh", opus)).toEqual({ requested: "xhigh", effective: "high", reason: "provider_ceiling" });
    expect(normalizeThinking("anthropic/claude-opus-4-6", "max", opus)).toEqual({ requested: "max", effective: "max", reason: "identity" });
  });

  test("a registry map wins over the static table", () => {
    expect(normalizeThinking("cerebras/qwen-3.8-27b", "xhigh", { thinkingLevelMap: { xhigh: "xhigh" } })).toEqual({ requested: "xhigh", effective: "xhigh", reason: "identity" });
  });

  test("a registry model without a map falls back to the static table", () => {
    expect(normalizeThinking("cerebras/qwen-3.8-27b", "xhigh", { reasoning: true })).toEqual({ requested: "xhigh", effective: "high", reason: "provider_ceiling" });
    expect(normalizeThinking("xai/grok-4.6", "xhigh", {})).toEqual({ requested: "xhigh", effective: "xhigh", reason: "unknown_model" });
  });

  test("reasoning: false collapses every request to off", () => {
    expect(normalizeThinking("openai/gpt-4.1", "high", { reasoning: false })).toEqual({ requested: "high", effective: "off", reason: "provider_ceiling" });
  });

  test("a provider that rejects off floors to its lowest supported level", () => {
    const noOff = { thinkingLevelMap: { off: null, minimal: null, low: "low", medium: "medium", high: "high" } };
    expect(normalizeThinking("x/y", "off", noOff)).toEqual({ requested: "off", effective: "low", reason: "provider_ceiling" });
  });

  test("thinkingLabel renders identity plainly and a ceiling as requested↘effective", () => {
    expect(thinkingLabel(normalizeThinking("xai/grok-4.6", "xhigh"))).toBe("xhigh");
    expect(thinkingLabel(normalizeThinking("antigravity/gemini-3.8-flash", "xhigh"))).toBe("xhigh↘high");
    expect(thinkingLabel(normalizeThinking("cerebras/qwen-3.8-27b", "medium"))).toBe("medium");
  });
});
