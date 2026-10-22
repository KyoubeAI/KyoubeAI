// What a restricted person's live-events socket may carry: enough for the screen to know what
// to refresh, never a title, a detail or a log line. No dependencies on purpose: this file is
// bundled into the core's dependency-free decision module.

/** The fields of an `activity.logged` payload that are kept; `details` becomes `{}`. */
export const ACTIVITY_PAYLOAD_KEYS = ["actorType", "actorId", "action", "entityType", "entityId", "agentId", "runId", "responsibleUserId"] as const;

/** The fields of a `heartbeat.run.*` or `agent.status` payload that are kept. */
export const RUN_PAYLOAD_KEYS = ["id", "runId", "issueId", "agentId", "status"] as const;

/** Only plain values survive, so an id field cannot smuggle an object with a title in it. */
function pick(payload: unknown, keys: readonly string[]): Record<string, unknown> {
  const kept: Record<string, unknown> = {};
  if (typeof payload !== "object" || payload === null) return kept;
  for (const key of keys) {
    if (!Object.hasOwn(payload, key)) continue;
    const value = (payload as Record<string, unknown>)[key];
    if (value === null || typeof value === "string" || typeof value === "number" || typeof value === "boolean") kept[key] = value;
  }
  return kept;
}

function strippedPayload(type: unknown, payload: unknown): Record<string, unknown> {
  if (type === "activity.logged") return { ...pick(payload, ACTIVITY_PAYLOAD_KEYS), details: {} };
  if (typeof type === "string" && (type.startsWith("heartbeat.run.") || type === "agent.status")) return pick(payload, RUN_PAYLOAD_KEYS);
  return {};
}

/** A copy of the event with its payload cut down; every other top-level field is kept. */
export function stripLiveEvent<T extends { type: string; companyId: string; createdAt?: string; payload?: unknown }>(event: T): T {
  return { ...event, payload: strippedPayload(event.type, event.payload) };
}
