/**
 * The pure half of the guardrail (docs/agent-rules.md, G2): who is a manager,
 * and what an agent's assignment policy and grants should be. Nothing here
 * calls the host.
 */

/** What the guardrail reads of an agent. */
export interface AgentRow {
  id: string;
  name: string;
  status: string;
  reportsTo: string | null;
  /** One of core's bundled agents (the Reflection Coach, …), which core never treats as the company's top agent. */
  builtIn?: boolean;
}

/** One principal permission grant, reduced to what the guardrail compares. */
export interface Grant {
  permissionKey: string;
  scope: Record<string, unknown> | null;
}

export type Policy = Record<string, unknown> | null;

/** The scope key of the one grant a manager gets: itself and everyone below it (core resolves the subtree when it decides). */
export const SUBTREE_SCOPE_KEY = "subtreeRootAgentId";

/**
 * The top-level policy keys core can evaluate for an assignment
 * (`evaluateAuthorizationPolicyForAssignment`, server/src/services/authorization.ts
 * in core 2026.1012.0, which added its own trust sections: a low-trust agent's
 * policy carries `trustPreset`). Any other key makes core treat the whole policy
 * as "unknown", so adding protection to such a policy changes nothing and would
 * hide the real problem: that agent is reported instead.
 */
const ASSIGNMENT_POLICY_KEYS = new Set([
  "agentVisibility", "assignmentPolicy", "protectedAgent", "managedBy", "trustPreset", "trustBoundary", "reviewPreset",
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Ids of agents with at least one direct report; terminated agents count neither as managers nor as reports. */
/**
 * What core gives its root CEO so it can change the company's agents: its own
 * and other agents' instructions, skills and settings, and new skills
 * (ROOT_AGENT_DEFAULT_CHANGE_GRANTS, server/src/services/built-in-agents.ts).
 * Since core 2026.1012.0 every new standard agent gets both as well
 * (NEW_STANDARD_AGENT_DEFAULT_GRANT_KEYS, server/src/services/agent-permissions.ts);
 * an agent that already holds them is recorded as given nothing.
 */
export const CHANGE_KEYS = ["agents:configure", "skills:create"] as const;

/**
 * The company's top agent: the one live agent that reports to nobody, or null
 * when there are none or several. Core picks the same agent, but only when its
 * role is "ceo", and KyoubeAI's onboarding hires it as "general".
 */
export function topAgentId(agents: AgentRow[]): string | null {
  const tops = agents.filter((agent) => !agent.reportsTo && !agent.builtIn && agent.status !== "terminated" && agent.status !== "pending_approval");
  return tops.length === 1 ? tops[0]!.id : null;
}

export function managerIds(agents: AgentRow[]): Set<string> {
  const live = agents.filter((agent) => agent.status !== "terminated");
  const liveIds = new Set(live.map((agent) => agent.id));
  const managers = new Set<string>();
  for (const agent of live) {
    if (agent.reportsTo && liveIds.has(agent.reportsTo)) managers.add(agent.reportsTo);
  }
  return managers;
}

export function canExtendPolicy(policy: Policy): boolean {
  return policy === null || Object.keys(policy).every((key) => ASSIGNMENT_POLICY_KEYS.has(key));
}

export function isProtected(policy: Policy): boolean {
  const assignment = policy?.assignmentPolicy;
  return isRecord(assignment) && assignment.mode === "protected";
}

/** The policy with `assignmentPolicy.mode` set to protected; every other key kept. */
export function withProtection(policy: Policy): Record<string, unknown> {
  const base = policy ?? {};
  const assignment = isRecord(base.assignmentPolicy) ? base.assignmentPolicy : {};
  return { ...base, assignmentPolicy: { ...assignment, mode: "protected" } };
}

/** The policy without the protection `withProtection` added; `null` when nothing else is left. */
export function withoutProtection(policy: Policy): Policy {
  if (!policy) return null;
  const { assignmentPolicy, ...rest } = policy;
  const next: Record<string, unknown> = { ...rest };
  if (isRecord(assignmentPolicy)) {
    const { mode: _mode, ...assignmentRest } = assignmentPolicy;
    if (Object.keys(assignmentRest).length > 0) next.assignmentPolicy = assignmentRest;
  }
  return Object.keys(next).length > 0 ? next : null;
}

/** The broad grant core gives every new agent: assign to anyone, a protected agent included. */
export function isBroadAssign(grant: Grant): boolean {
  return grant.permissionKey === "tasks:assign" && (grant.scope === null || Object.keys(grant.scope).length === 0);
}

/** The one scoped grant the guardrail gives a manager. */
export function ownTeamGrant(agentId: string): Grant {
  return { permissionKey: "tasks:assign_scope", scope: { [SUBTREE_SCOPE_KEY]: agentId } };
}

export function isOwnTeamGrant(grant: Grant, agentId: string): boolean {
  return grant.permissionKey === "tasks:assign_scope"
    && grant.scope !== null
    && Object.keys(grant.scope).length === 1
    && grant.scope[SUBTREE_SCOPE_KEY] === agentId;
}

/**
 * An agent's grants as the guardrail wants them: no broad assign grant, and its
 * own-team grant only while it is a manager. Every other grant stays as it is.
 */
export function desiredGrants(current: Grant[], agentId: string, isManager: boolean): Grant[] {
  const kept = current.filter((grant) => !isBroadAssign(grant) && !isOwnTeamGrant(grant, agentId));
  return isManager ? [...kept, ownTeamGrant(agentId)] : kept;
}

function grantKey(grant: Grant): string {
  const scope = grant.scope ? Object.fromEntries(Object.entries(grant.scope).sort(([a], [b]) => a.localeCompare(b))) : null;
  return JSON.stringify([grant.permissionKey, scope]);
}

export function sameGrants(a: Grant[], b: Grant[]): boolean {
  const left = a.map(grantKey).sort();
  const right = b.map(grantKey).sort();
  return left.length === right.length && left.every((key, index) => key === right[index]);
}
