import { describe, expect, test } from "vitest";
import {
  parseClaudeStatus,
  parseClaudeTranscript,
  parseCodexRateLimits,
  parseCodexTokenUsage,
} from "./telemetry";

describe("parseClaudeStatus", () => {
  test("keeps context and subscription windows provider-specific", () => {
    expect(
      parseClaudeStatus("session-1", {
        observedAt: "2026-09-15T08:00:00.000Z",
        model: { display_name: "Claude Sonnet" },
        context_window: {
          total_input_tokens: 50_000,
          total_output_tokens: 6_200,
          context_window_size: 200_000,
          used_percentage: 28.1,
        },
        rate_limits: {
          five_hour: { used_percentage: 14 },
          seven_day: { used_percentage: 33 },
        },
      }),
    ).toEqual({
      session: {
        sessionId: "session-1",
        model: "Claude Sonnet",
        context: {
          usedTokens: 56_200,
          totalTokens: 200_000,
          usedPercent: 28.1,
        },
        observedAt: "2026-09-15T08:00:00.000Z",
      },
      usage: {
        provider: "claude",
        windows: [
          { label: "5h", usedPercent: 14 },
          { label: "7d", usedPercent: 33 },
        ],
        observedAt: "2026-09-15T08:00:00.000Z",
      },
    });
  });

  test("omits rate limits when an account does not report them", () => {
    expect(
      parseClaudeStatus("session-1", {
        context_window: {
          total_input_tokens: 10,
          total_output_tokens: 2,
          context_window_size: 100,
        },
      }).usage,
    ).toBeUndefined();
  });
});

describe("parseCodexTokenUsage", () => {
  test("uses the latest request context instead of cumulative tokens", () => {
    const text = [
      JSON.stringify({
        type: "turn_context",
        payload: { model: "gpt-5.6-codex" },
      }),
      JSON.stringify({
        payload: {
          type: "token_count",
          info: {
            last_token_usage: { total_tokens: 56_200 },
            total_token_usage: { total_tokens: 90_000 },
            model_context_window: 200_000,
          },
        },
      }),
    ].join("\n");
    expect(
      parseCodexTokenUsage("session-1", text, "2026-09-15T08:00:00.000Z"),
    ).toMatchObject({
      model: "gpt-5.6-codex",
      context: {
        usedTokens: 56_200,
        totalTokens: 200_000,
        usedPercent: 28.1,
      },
    });
  });
});

describe("parseClaudeTranscript", () => {
  test("recovers existing-session context from Claude usage events", () => {
    const text = JSON.stringify({
      type: "assistant",
      timestamp: "2026-09-15T08:00:00.000Z",
      message: {
        model: "claude-fable-5-1",
        usage: {
          input_tokens: 100,
          cache_creation_input_tokens: 2_000,
          cache_read_input_tokens: 537_000,
          output_tokens: 900,
        },
      },
    });
    expect(
      parseClaudeTranscript("session-1", text, "claude-fable-5-1[1m]"),
    ).toEqual({
      sessionId: "session-1",
      model: "claude-fable-5-1[1m]",
      context: {
        usedTokens: 540_000,
        totalTokens: 1_000_000,
        usedPercent: 54,
      },
      observedAt: "2026-09-15T08:00:00.000Z",
    });
  });
});

describe("parseCodexRateLimits", () => {
  test("derives honest labels from the provider window durations", () => {
    expect(
      parseCodexRateLimits(
        {
          rateLimits: {
            primary: { usedPercent: 28, windowDurationMins: 300 },
            secondary: { usedPercent: 61, windowDurationMins: 10_080 },
          },
        },
        "2026-09-15T08:00:00.000Z",
      ),
    ).toEqual({
      provider: "codex",
      windows: [
        { label: "5h", usedPercent: 28 },
        { label: "7d", usedPercent: 61 },
      ],
      observedAt: "2026-09-15T08:00:00.000Z",
    });
  });

  test("shows a plan allowance when rolling windows are not provided", () => {
    expect(
      parseCodexRateLimits(
        {
          rateLimits: {
            primary: null,
            secondary: null,
            individualLimit: { remainingPercent: 95, resetsAt: 1_790_812_800 },
          },
        },
        "2026-09-15T08:00:00.000Z",
      ),
    ).toMatchObject({
      provider: "codex",
      windows: [{ label: "allowance", usedPercent: 5 }],
    });
  });
});
