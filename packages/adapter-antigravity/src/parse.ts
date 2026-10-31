import type { UsageSummary } from "./types.js";

export interface ParsedAntigravityOutput {
  sessionId: string | null;
  summary: string | null;
  usage?: UsageSummary;
  costUsd?: number;
  errorMessage?: string | null;
  status?: string | null;
  resultEvent?: Record<string, unknown> | null;
}

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
 * Parse `agy --print --output-format stream-json` NDJSON output.
 *
 * Event types emitted by `agy`:
 * - `{"event":"init","conversation_id":"<uuid>","init":{...}}`
 * - `{"event":"step_update","step_update":{"conversation_id":"<uuid>","step_index":1,"state":"ACTIVE"|"DONE","step_type":"agent_response"|"tool"|"user_input",...}}`
 * - `{"event":"result","result":{"conversation_id":"<uuid>","status":"SUCCESS"|"ERROR"|"FAILED","response":"...","usage":{"input_tokens":...,"output_tokens":...,"thinking_tokens":...,"cache_read_tokens":...}}}`
 */
export function parseAntigravityJsonl(stdout: string, stderr = ""): ParsedAntigravityOutput {
  let sessionId: string | null = null;
  let resultResponse: string | null = null;
  let resultStatus: string | null = null;
  let resultUsage: UsageSummary | undefined;
  let resultCostUsd: number | undefined;
  let resultError: string | null = null;
  let resultEvent: Record<string, unknown> | null = null;

  const stepTextChunks = new Map<number, string>();
  const stepUsageByIndex = new Map<number, UsageSummary>();
  const plainLines: string[] = [];

  for (const rawLine of stdout.split(/\r?\n/)) {
    const trimmed = rawLine.trim();
    if (!trimmed) continue;
    if (trimmed.startsWith("[antigravity]") || trimmed.startsWith("[kyoubeai]")) {
      continue;
    }

    let parsed: Record<string, unknown> | null = null;
    if (trimmed.startsWith("{") && trimmed.endsWith("}")) {
      try {
        parsed = JSON.parse(trimmed) as Record<string, unknown>;
      } catch {
        parsed = null;
      }
    }

    if (!parsed) {
      plainLines.push(rawLine);
      continue;
    }

    const eventType = asString(parsed.event);
    const topConvId = asString(parsed.conversation_id).trim();
    if (topConvId) sessionId = topConvId;

    if (eventType === "init") {
      const initObj = asObject(parsed.init);
      const initConvId = asString(initObj.conversation_id).trim();
      if (initConvId) sessionId = initConvId;
      continue;
    }

    if (eventType === "step_update") {
      const su = asObject(parsed.step_update);
      const suConvId = asString(su.conversation_id).trim();
      if (suConvId) sessionId = suConvId;
      const stepIndex = asNumber(su.step_index);
      const stepType = asString(su.step_type);

      if (stepType === "agent_response") {
        const delta = asString(su.text_delta);
        if (delta) {
          stepTextChunks.set(stepIndex, (stepTextChunks.get(stepIndex) ?? "") + delta);
        }
        const usageObj = asObject(su.usage);
        if (Object.keys(usageObj).length > 0) {
          const inputTokens = asNumber(usageObj.input_tokens);
          const outputTokens = asNumber(usageObj.output_tokens) + asNumber(usageObj.thinking_tokens);
          const cachedInputTokens = asNumber(usageObj.cache_read_tokens);
          if (inputTokens > 0 || outputTokens > 0 || cachedInputTokens > 0) {
            stepUsageByIndex.set(stepIndex, {
              inputTokens,
              outputTokens,
              ...(cachedInputTokens > 0 ? { cachedInputTokens } : {}),
            });
          }
        }
      }
      continue;
    }

    if (eventType === "result") {
      const res = asObject(parsed.result);
      resultEvent = res;
      const resConvId = asString(res.conversation_id).trim();
      if (resConvId) sessionId = resConvId;
      const status = asString(res.status).trim();
      if (status) resultStatus = status;
      const response = asString(res.response).trim();
      if (response) resultResponse = response;
      const errText = asString(res.error).trim() || asString(res.error_message).trim();
      if (errText) resultError = errText;

      const usageObj = asObject(res.usage);
      if (Object.keys(usageObj).length > 0) {
        const inputTokens = asNumber(usageObj.input_tokens);
        const outputTokens = asNumber(usageObj.output_tokens) + asNumber(usageObj.thinking_tokens);
        const cachedInputTokens = asNumber(usageObj.cache_read_tokens);
        resultUsage = {
          inputTokens,
          outputTokens,
          ...(cachedInputTokens > 0 ? { cachedInputTokens } : {}),
        };
      }

      if (typeof res.cost_usd === "number" && Number.isFinite(res.cost_usd)) {
        resultCostUsd = res.cost_usd;
      }
      continue;
    }
  }

  const aggregatedStepText = [...stepTextChunks.entries()]
    .sort(([a], [b]) => a - b)
    .map(([, text]) => text.trim())
    .filter(Boolean)
    .join("\n\n");

  const summary =
    resultResponse ||
    aggregatedStepText ||
    (plainLines.length > 0 ? plainLines.join("\n").trim() : null);

  let usage = resultUsage;
  if (!usage && stepUsageByIndex.size > 0) {
    let inputTokens = 0;
    let outputTokens = 0;
    let cachedInputTokens = 0;
    for (const stepUsage of stepUsageByIndex.values()) {
      inputTokens += stepUsage.inputTokens;
      outputTokens += stepUsage.outputTokens;
      cachedInputTokens += stepUsage.cachedInputTokens ?? 0;
    }
    usage = {
      inputTokens,
      outputTokens,
      ...(cachedInputTokens > 0 ? { cachedInputTokens } : {}),
    };
  }

  let errorMessage = resultError;
  if (!errorMessage && resultStatus && resultStatus !== "SUCCESS" && resultStatus !== "DONE") {
    errorMessage = `Antigravity run finished with status ${resultStatus}`;
  }
  if (!errorMessage && stderr.trim().length > 0) {
    const errLines = stderr
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line.length > 0 && /error|failed|fatal|unauthorized|unauthenticated/i.test(line))
      .filter((line) => !/\b(INFO|DEBUG|WARN|WARNING)\b/.test(line));
    if (errLines.length > 0) {
      errorMessage = errLines.slice(0, 5).join("\n");
    }
  }

  return {
    sessionId,
    summary: summary ? summary.slice(0, 4000) : null,
    usage,
    costUsd: resultCostUsd,
    errorMessage,
    status: resultStatus,
    resultEvent,
  };
}

export function isAntigravitySessionUnrecoverableError(stdout: string, stderr: string): boolean {
  const combined = `${stdout}\n${stderr}`;
  return /conversation.*not found|unknown conversation|failed to (load|resume) conversation|invalid conversation|no such conversation/i.test(
    combined,
  );
}

export function detectAntigravityAuthRequired(stdout: string, stderr: string): boolean {
  const combined = `${stdout}\n${stderr}`;
  return /not logged in|authentication required|run [`'"]?agy login|oauth token.*expired|unauthenticated|invalid credentials/i.test(
    combined,
  );
}
