/**
 * Who an agent may ask (docs/agent-rules.md, "Agent questions").
 *
 * The core lets an agent address an ask_user_questions card to any agent in its
 * company, and the agent working rules cap every such card at human_only. A
 * standing core patch (patches.mjs, `agent-questions-ask-level`) calls
 * applyAskLevel at the one point where the core creates a card, for one case
 * only: an agent creating an ask_user_questions card addressed to another agent.
 * The patch passes in everything the module uses, so the tests run it with fakes.
 * The image ships this file as /opt/kyoube/core-patches/ask-level.mjs.
 *
 * The level is in the asker's agent metadata, which `kyoube agent-rules`
 * copies there from Studio every minute: "none", "any", or anything else
 * (missing included) as "line", meaning the managers above the agent and the
 * agents below it. docker/bootstrap/src/agent-rules/ask-levels.ts reads the same
 * key the same way. A built-in agent (the core's own bundled agents) is always at
 * "line": the loop leaves its level at the default, and an agent can edit its own
 * metadata, so a level found there is never trusted.
 */

export const ASK_LEVEL_KEY = "kyoubeAskLevel";
/** Questions to agents one task may carry in all, whatever became of them. */
export const QUESTION_LIMIT = 3;
/** How many agents a refusal names before "and N more". */
const NAMES_SHOWN = 20;

export const MESSAGES = {
  none: "Your ask level does not let you ask other agents. Finish the task yourself, or hand it back to the person who started it (rule 4).",
  open: "This task already has an open question to an agent. End your run; its answer wakes you.",
  limit: `This task has used its ${QUESTION_LIMIT} questions to agents. Hand it back to the person who started it (rule 4).`,
  checkFailed: "Your question could not be checked. Hand the task back to the person who started it (rule 4).",
};

/** The level stored in an agent's metadata; anything but "none" or "any" is "line". */
export function askLevelOf(metadata) {
  const value = metadata && typeof metadata === "object" && !Array.isArray(metadata) ? metadata[ASK_LEVEL_KEY] : undefined;
  return value === "none" || value === "any" ? value : "line";
}

function plain(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : null;
}

/**
 * Whether the core's metadata marks an agent as one of its bundled agents, by
 * the core's own rule (readBuiltInAgentMarker): a non-blank key and a
 * featureKeys list of non-blank strings. The core refuses to add or change a
 * marker it would read, so an agent cannot give itself one; a looser check would
 * let it. The loop, Studio and the agent rules plugin each keep a copy of this rule.
 */
export function isBuiltInAgent(metadata) {
  const marker = plain(plain(metadata)?.paperclipBuiltInAgent);
  if (marker === null || typeof marker.key !== "string" || marker.key.trim() === "") return false;
  const { featureKeys } = marker;
  return Array.isArray(featureKeys) && featureKeys.filter((key) => typeof key === "string" && key.trim() !== "").length === featureKeys.length;
}

/**
 * The agents in the asker's line: each manager above it in turn, then every
 * agent whose reportsTo chain reaches it. Terminated agents are never in it,
 * and the walk up stops at the top, at a terminated or unknown manager, or at a
 * cycle.
 */
export function lineOf(agents, askerId) {
  const live = new Map(agents.filter((row) => row.status !== "terminated").map((row) => [row.id, row]));
  const line = new Set();
  const seen = new Set([askerId]);
  let next = live.get(askerId)?.reportsTo ?? null;
  while (next && !seen.has(next) && live.has(next)) {
    seen.add(next);
    line.add(next);
    next = live.get(next).reportsTo ?? null;
  }
  const reports = new Map();
  for (const row of live.values()) {
    if (!row.reportsTo) continue;
    if (!reports.has(row.reportsTo)) reports.set(row.reportsTo, []);
    reports.get(row.reportsTo).push(row.id);
  }
  const below = new Set();
  const queue = [...(reports.get(askerId) ?? [])];
  while (queue.length > 0) {
    const id = queue.shift();
    if (id === askerId || below.has(id)) continue;
    below.add(id);
    queue.push(...(reports.get(id) ?? []));
  }
  for (const id of below) line.add(id);
  line.delete(askerId);
  return line;
}

function outsideLineMessage(agents, addresseeId, line) {
  const names = new Map(agents.map((row) => [row.id, row.name]));
  const who = names.get(addresseeId) ?? addresseeId;
  if (line.size === 0) {
    return `${who} is outside your line, and you have no managers or reports to ask. Finish the task yourself, or hand it back to the person who started it (rule 4).`;
  }
  const allowed = [...line]
    .map((id) => ({ id, name: names.get(id) ?? id }))
    .sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
  const shown = allowed.slice(0, NAMES_SHOWN).map((row) => `${row.name} (${row.id})`).join(", ");
  const more = allowed.length > NAMES_SHOWN ? `, and ${allowed.length - NAMES_SHOWN} more` : "";
  return `${who} is outside your line. You may ask: ${shown}${more}.`;
}

/**
 * The decision, from what the core holds: the company's agents and this task's
 * ask_user_questions cards that an agent created and addressed to an agent.
 * An idempotent replay is let through, so the core returns the card it already
 * created; then the level; then the limits.
 */
export function decideAskLevel({ askerId, addresseeId, agents, questions, idempotencyKey }) {
  if (idempotencyKey && questions.some((question) => question.idempotencyKey === idempotencyKey)) return { allow: true };
  const askerMetadata = agents.find((row) => row.id === askerId)?.metadata;
  const level = isBuiltInAgent(askerMetadata) ? "line" : askLevelOf(askerMetadata);
  if (level === "none") return { allow: false, code: "kyoube_ask_level_none", message: MESSAGES.none };
  if (level === "line") {
    const line = lineOf(agents, askerId);
    if (!line.has(addresseeId)) return { allow: false, code: "kyoube_ask_outside_line", message: outsideLineMessage(agents, addresseeId, line) };
  }
  // The limits are read just before the core creates the card, not under a lock, so
  // questions sent at the same moment can each pass and go past them. The core still
  // replaces the asker's older open question with the newer one (SECURITY.md, Groups).
  if (questions.some((question) => question.status === "pending")) return { allow: false, code: "kyoube_ask_open_question", message: MESSAGES.open };
  if (questions.length >= QUESTION_LIMIT) return { allow: false, code: "kyoube_ask_limit", message: MESSAGES.limit };
  return { allow: true };
}

/**
 * Called by the core patch with the core's own db, tables, drizzle operators,
 * issue row, actor, parsed card input, the policy it just computed (the company
 * cap applied) and its `unprocessable`. Refuses with a 422 carrying a code;
 * allows by making the card answerable by anyone but its creator, which
 * together with the addressee check means the addressed agent or a person. The
 * core stores these policy fields on the card and checks every answer against
 * them. Any unexpected error refuses the question (fail closed).
 */
export async function applyAskLevel({ db, tables, ops, issue, actor, data, policy, unprocessable }) {
  let decision;
  try {
    const { agents: agentsTable, issueThreadInteractions: cards } = tables;
    const agents = await db
      .select({ id: agentsTable.id, name: agentsTable.name, reportsTo: agentsTable.reportsTo, status: agentsTable.status, metadata: agentsTable.metadata })
      .from(agentsTable)
      .where(ops.eq(agentsTable.companyId, issue.companyId));
    const questions = await db
      .select({ status: cards.status, idempotencyKey: cards.idempotencyKey })
      .from(cards)
      .where(ops.and(ops.eq(cards.issueId, issue.id), ops.eq(cards.kind, "ask_user_questions"), ops.isNotNull(cards.createdByAgentId), ops.isNotNull(cards.addresseeAgentId)));
    decision = decideAskLevel({ askerId: actor.agentId, addresseeId: data.addresseeAgentId, agents, questions, idempotencyKey: data.idempotencyKey ?? null });
  } catch (error) {
    console.error("[kyoube] ask-level check failed", error);
    throw unprocessable(MESSAGES.checkFailed, { code: "kyoube_ask_check_failed" });
  }
  if (!decision.allow) throw unprocessable(decision.message, { code: decision.code });
  policy.requestedResolverPolicy = "not_creator";
  policy.effectiveResolverPolicy = "not_creator";
  policy.effectiveResolverPolicySource = "requested";
}
