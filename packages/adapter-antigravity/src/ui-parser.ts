import type { TranscriptEntry } from "./types.js";

function asObject(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return {};
  }
  return value as Record<string, unknown>;
}

function asString(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function asNumber(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

/**
 * Stateless single-line parser for Antigravity CLI (`agy --output-format stream-json`).
 * Runs inside the KyoubeAI UI Web Worker sandbox (must have zero runtime imports).
 */
export function parseStdoutLine(line: string, ts: string): TranscriptEntry[] {
  const trimmed = line.trim();
  if (!trimmed) return [];

  if (trimmed.startsWith("[antigravity]") || trimmed.startsWith("[kyoubeai]")) {
    return [
      {
        kind: "system",
        ts,
        text: trimmed.replace(/^\[(antigravity|kyoubeai)\]\s*/, ""),
      },
    ];
  }

  if (!trimmed.startsWith("{") || !trimmed.endsWith("}")) {
    return [{ kind: "stdout", ts, text: line }];
  }

  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(trimmed) as Record<string, unknown>;
  } catch {
    return [{ kind: "stdout", ts, text: line }];
  }

  const eventType = asString(parsed.event);

  if (eventType === "init") {
    const initObj = asObject(parsed.init);
    const sessionId =
      asString(parsed.conversation_id).trim() ||
      asString(initObj.conversation_id).trim();
    const model = asString(initObj.model).trim() || "antigravity";
    return [{ kind: "init", ts, model, sessionId }];
  }

  if (eventType === "step_update") {
    const su = asObject(parsed.step_update);
    const stepType = asString(su.step_type);
    const state = asString(su.state);
    const stepIndex = asNumber(su.step_index);

    if (stepType === "user_input") {
      return [];
    }

    if (stepType === "agent_response") {
      const entries: TranscriptEntry[] = [];
      const thinkingDelta = asString(su.thinking_delta);
      const textDelta = asString(su.text_delta);
      if (thinkingDelta) {
        entries.push({ kind: "thinking", ts, text: thinkingDelta, delta: true });
      }
      if (textDelta) {
        entries.push({ kind: "assistant", ts, text: textDelta, delta: true });
      }
      return entries;
    }

    if (stepType === "tool") {
      const toolInfo = asObject(su.tool_info);
      const toolName =
        asString(toolInfo.name).trim() ||
        asString(su.tool_name).trim() ||
        "tool";
      // Step indexes restart in each conversation, and a stale-session retry puts two in one log.
      const toolUseId = `agy-tool-${asString(su.conversation_id) || "run"}-${stepIndex}`;

      if (state === "ACTIVE") {
        return [
          {
            kind: "tool_call",
            ts,
            name: toolName,
            toolUseId,
            input: toolInfo.parameters ?? {},
          },
        ];
      }

      if (state === "DONE" || state === "ERROR" || state === "FAILED") {
        const output =
          asString(toolInfo.output) ||
          asString(su.error) ||
          (state === "DONE" ? "completed" : state);
        return [
          {
            kind: "tool_result",
            ts,
            toolUseId,
            content: output,
            isError: state === "ERROR" || state === "FAILED",
          },
        ];
      }

      return [];
    }

    return [];
  }

  if (eventType === "result") {
    const res = asObject(parsed.result);
    const usage = asObject(res.usage);
    const status = asString(res.status).trim() || "SUCCESS";
    const isError = status !== "SUCCESS" && status !== "DONE";
    const inputTokens = asNumber(usage.input_tokens);
    const outputTokens =
      asNumber(usage.output_tokens) + asNumber(usage.thinking_tokens);
    const cachedTokens = asNumber(usage.cache_read_tokens);
    const costUsd = asNumber(res.cost_usd);
    const text = asString(res.response);
    const errText = asString(res.error).trim() || (isError ? status : "");

    return [
      {
        kind: "result",
        ts,
        text,
        inputTokens,
        outputTokens,
        cachedTokens,
        costUsd,
        subtype: status.toLowerCase(),
        isError,
        errors: errText ? [errText] : [],
      },
    ];
  }

  return [{ kind: "stdout", ts, text: line }];
}

/**
 * Stateful parser factory for multi-line/stateful tracking across a run's stdout stream.
 */
export function createStdoutParser() {
  const seenToolCalls = new Set<string>();
  return {
    parseLine(line: string, ts: string): TranscriptEntry[] {
      const entries = parseStdoutLine(line, ts);
      const out: TranscriptEntry[] = [];
      for (const entry of entries) {
        if (entry.kind === "tool_call") {
          if (seenToolCalls.has(entry.toolUseId)) continue;
          seenToolCalls.add(entry.toolUseId);
          out.push(entry);
        } else if (entry.kind === "tool_result") {
          if (!seenToolCalls.has(entry.toolUseId)) {
            seenToolCalls.add(entry.toolUseId);
            out.push({
              kind: "tool_call",
              ts,
              name: "tool",
              toolUseId: entry.toolUseId,
              input: {},
            });
          }
          out.push(entry);
        } else {
          out.push(entry);
        }
      }
      return out;
    },
    reset() {
      seenToolCalls.clear();
    },
  };
}
