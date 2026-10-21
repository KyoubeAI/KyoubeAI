/**
 * The ask level (docs/agent-rules.md, "Agent questions"): which agents an agent
 * may send a question card to. People set it on the agent's Studio profile;
 * Studio keeps it, and each pass copies it into the agent's metadata, where the
 * core patch reads it (docker/core-patches/ask-level.mjs reads the same key the
 * same way). "line" is the default and is never written.
 */

export type AskLevel = "none" | "line" | "any";

export const ASK_LEVEL_KEY = "kyoubeAskLevel";

function plain(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

export function askLevelOf(metadata: unknown): AskLevel {
  const value = plain(metadata)?.[ASK_LEVEL_KEY];
  return value === "none" || value === "any" ? value : "line";
}

export function hasAskLevel(metadata: unknown): boolean {
  const record = plain(metadata);
  return record !== null && Object.hasOwn(record, ASK_LEVEL_KEY);
}

/** The metadata with the level set, every other key kept; "line" removes the key. Never mutates its input. */
export function withAskLevel(metadata: Record<string, unknown> | null | undefined, level: AskLevel): Record<string, unknown> {
  const { [ASK_LEVEL_KEY]: _previous, ...rest } = metadata ?? {};
  return level === "line" ? rest : { ...rest, [ASK_LEVEL_KEY]: level };
}

/**
 * Whether the core's metadata marks an agent as one of its bundled agents, by the
 * core's own rule (readBuiltInAgentMarker): a non-blank key and a featureKeys list
 * of non-blank strings. The core refuses to add or change a marker it would read,
 * so an agent cannot give itself one; a looser check would let it.
 */
export function isBuiltInAgent(metadata: unknown): boolean {
  const marker = plain(plain(metadata)?.paperclipBuiltInAgent);
  if (marker === null || typeof marker.key !== "string" || marker.key.trim() === "") return false;
  const { featureKeys } = marker;
  return Array.isArray(featureKeys) && featureKeys.filter((key) => typeof key === "string" && key.trim() !== "").length === featureKeys.length;
}
