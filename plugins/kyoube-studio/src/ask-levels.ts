/**
 * The ask level on the agent profile (docs/agent-rules.md, "Agent questions"):
 * which agents an agent may send a question card to when it is stuck. Studio
 * keeps each company's levels in plugin state; `kyoube agent-rules` reads them
 * through the `ask-levels` route and copies them into each agent's metadata,
 * where the core patch reads them. "line" (the managers above the agent and the
 * agents below it) is the default and is never stored.
 */

export type AskLevel = "none" | "line" | "any";
export type AskLevels = Record<string, "none" | "any">;

/** Plugin state key (company scope) of the company's levels. */
export const ASK_LEVELS_STATE_KEY = "ask-levels";

export function parseAskLevel(value: unknown): AskLevel | null {
  return value === "none" || value === "line" || value === "any" ? value : null;
}

/** The stored map, tolerating a missing or hand-edited value: only "none" and "any" entries survive. */
export function parseAskLevels(value: unknown): AskLevels {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return {};
  const out: AskLevels = {};
  for (const [agentId, level] of Object.entries(value as Record<string, unknown>)) {
    if (level === "none" || level === "any") out[agentId] = level;
  }
  return out;
}

export function withAskLevel(levels: AskLevels, agentId: string, level: AskLevel): AskLevels {
  const { [agentId]: _previous, ...rest } = levels;
  return level === "line" ? rest : { ...rest, [agentId]: level };
}

export function levelOf(levels: AskLevels, agentId: string): AskLevel {
  return levels[agentId] ?? "line";
}

export function pruneAskLevels(levels: AskLevels, live: ReadonlySet<string>): AskLevels {
  return Object.fromEntries(Object.entries(levels).filter(([agentId]) => live.has(agentId)));
}

function plain(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
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
