import { CoreApiError, type CompanySummary } from "../core-api.js";
import type { AgentRef, RulesApi } from "./api.js";
import { applyRules, removeRules, type RulesEdit } from "./block.js";
import { askLevelOf, hasAskLevel, isBuiltInAgent, withAskLevel, type AskLevel } from "./ask-levels.js";
import { planGovernance, revertGovernance } from "./governance.js";
import type { CompanyReport, Failure, PassReport } from "./report.js";
import type { AgentRulesState } from "./state.js";

export interface PassDeps {
  api: RulesApi;
  now: () => Date;
}

/**
 * A failure as `kyoube doctor` should show it. A 404, 405 or 422 on a route
 * this feature depends on is the sign that a core update moved something,
 * so the message names that route. A 403 "does not have access to this company" is the core refusing a board key whose user is not a member. Any other 403 from a KyoubeAI plugin route means the plugin did not
 * accept the CLI's rules token (ruling R18), so the message names the company and the file.
 */
export function describeError(error: unknown, company?: string): string {
  if (error instanceof CoreApiError && error.route) {
    if (isCompanyAccessRefusal(error)) {
      return `the core refused the board key in ${company ? `"${company}"` : "this company"} (${error.route} → 403): ${error.message}; add the board key's user to ${company ? `"${company}"` : "the company"} as a member (any role)`;
    }
    if (isRulesTokenRefusal(error)) {
      return `the plugin refused the kyoube CLI in ${company ? `"${company}"` : "this company"} (${error.route} → 403): ${error.message}; check that the rules token file (kyoube/rules-token on the home volume) exists and the node user can read it`;
    }
    if (error.status === 404 && error.route.includes("/api/plugins/kyoube.agent-rules/")) {
      return `the kyoube.agent-rules plugin is not installed or not ready (${error.route} → 404): ${error.message}`;
    }
    if ([404, 405, 422].includes(error.status)) return `the core no longer accepts ${error.route} (${error.status}): ${error.message}`;
    return `${error.route} failed (${error.status}): ${error.message}`;
  }
  return error instanceof Error ? error.message : String(error);
}

/** The core's own refusal of a key whose user is not a member of the company; it comes before any plugin runs. */
function isCompanyAccessRefusal(error: unknown): boolean {
  return error instanceof CoreApiError && error.status === 403 && /does not have access to this company/i.test(error.message);
}

/** The guard, group and ask-level routes of the plugins refuse 403 without the rules token or an owner or admin caller. */
function isRulesTokenRefusal(error: unknown): boolean {
  return error instanceof CoreApiError && error.status === 403 && /\/api\/plugins\/kyoube\.(agent-rules|apps|studio)\//.test(error.route);
}

function companyReport(company: CompanySummary): CompanyReport {
  return { companyId: company.id, name: company.name || company.id, governance: "already", guard: null, groups: null, rulesUpdated: [], askLevelsUpdated: [], skipped: [], failures: [], writes: 0 };
}

async function listCompanies(deps: PassDeps, report: PassReport): Promise<CompanySummary[] | null> {
  try {
    return await deps.api.listCompanies();
  } catch (error) {
    report.failures.push({ step: "list", error: describeError(error) });
    return null;
  }
}

/** Edits one agent's entry file with `edit`, only when the core says KyoubeAI may. */
async function editAgent(api: RulesApi, agent: AgentRef, entry: CompanyReport, edit: (content: string) => RulesEdit): Promise<void> {
  try {
    const bundle = await api.getInstructionsBundle(agent.id);
    if (bundle.mode !== "managed" || !bundle.editable) {
      entry.skipped.push({ agent: agent.name, reason: `its instructions are not a managed bundle KyoubeAI can edit (mode ${bundle.mode ?? "none"})` });
      return;
    }
    if (bundle.legacyPromptTemplateActive) {
      entry.skipped.push({ agent: agent.name, reason: "it still uses the legacy prompt template" });
      return;
    }
    if (!bundle.hasEntryFile) {
      entry.skipped.push({ agent: agent.name, reason: `its instructions bundle has no ${bundle.entryFile}` });
      return;
    }
    const file = await api.readInstructionsFile(agent.id, bundle.entryFile);
    const result = edit(file.content);
    if (result.kind === "corrupt") {
      entry.skipped.push({ agent: agent.name, reason: `${bundle.entryFile}: ${result.reason}` });
      return;
    }
    if (result.kind === "changed") {
      // Written on the revision just read: if someone saved the file in between, the core
      // refuses (409) and this agent is retried on the next pass, so their edit is never lost.
      await api.writeInstructionsFile(agent.id, bundle.entryFile, result.content, file.revisionId);
      entry.rulesUpdated.push(agent.name);
      entry.writes += 1;
    }
  } catch (error) {
    entry.failures.push({ step: "rules", agent: agent.name, error: describeError(error) });
  }
}

async function editAgents(api: RulesApi, companyId: string, entry: CompanyReport, editFor: (agent: AgentRef) => (content: string) => RulesEdit): Promise<void> {
  let agents: AgentRef[];
  try {
    agents = await api.listAgents(companyId);
  } catch (error) {
    entry.failures.push({ step: "rules", error: describeError(error) });
    return;
  }
  for (const agent of agents) {
    // The core freezes the config of an agent waiting for approval, and an instructions write
    // updates its adapterConfig. No skipped entry: the plugin's report lists it as waiting.
    if (agent.status === "terminated" || agent.status === "pending_approval") continue;
    await editAgent(api, agent, entry, editFor(agent));
  }
}

/** kyoube.apps's sync-report route refuses an `error` longer than this. */
export const SYNC_ERROR_MAX = 2000;

/** The error as the sync report can carry it: cut to fit the route's cap, marked with an ellipsis. */
export function syncReportError(error: string | null): string | null {
  return error !== null && error.length > SYNC_ERROR_MAX ? `${error.slice(0, SYNC_ERROR_MAX - 10)}…` : error;
}

/**
 * Whether the core answered for a KyoubeAI plugin the way it does before that plugin is installed (404
 * `Plugin not found`) or while its worker starts (503), as `pluginReady` in api.ts reads them.
 */
function pluginNotStarted(error: unknown): boolean {
  return error instanceof CoreApiError && (error.status === 503 || (error.status === 404 && error.message === "Plugin not found"));
}

/**
 * Groups (docs/groups.md): read who may assign which agent from kyoube.apps, have kyoube.agent-rules
 * apply it, and tell kyoube.apps how it went. A failed read skips the step: an unreadable list must
 * never be applied as "no groups", which would lift every restriction. While kyoube.apps is not
 * installed or not started, the step is skipped quietly: there are no groups to read yet.
 */
async function groupsStep(deps: PassDeps, companyId: string, entry: CompanyReport): Promise<void> {
  const syncedAt = deps.now().toISOString();
  let error: string | null = null;
  try {
    let access: Awaited<ReturnType<PassDeps["api"]["getAgentAccess"]>>;
    try {
      access = await deps.api.getAgentAccess(companyId);
    } catch (caught) {
      // kyoube.apps not installed yet, or its worker not started: no groups to read, so nothing to
      // apply, nothing to report and no failure. The next pass reads them.
      if (pluginNotStarted(caught)) return;
      throw caught;
    }
    const groups = await deps.api.applyGroups(companyId, access);
    entry.groups = groups;
    entry.writes += groups.protected.length + groups.unprotected.length + groups.people.length;
    for (const skipped of groups.skipped) entry.skipped.push({ agent: skipped.id, reason: skipped.reason });
    for (const failure of groups.failures) entry.failures.push({ step: "groups", agent: failure.id, error: `${failure.step}: ${failure.error}` });
    if (groups.failures.length > 0) error = `${groups.failures.length} failure(s); see kyoube doctor`;
  } catch (caught) {
    error = describeError(caught, entry.name);
    entry.failures.push({ step: "groups", error });
    // Refused: the sync report would be refused the same way.
    if (isRulesTokenRefusal(caught)) return;
  }
  try {
    await deps.api.reportGroupSync(companyId, { syncedAt, error: syncReportError(error) });
  } catch (caught) {
    entry.failures.push({ step: "groups", error: `could not report the sync: ${describeError(caught, entry.name)}` });
  }
}

/** Records one metadata write of the ask-level step, or its failure; true when it was written. */
async function writeAskLevel(deps: PassDeps, agent: AgentRef & { metadata: Record<string, unknown> | null }, level: AskLevel, entry: CompanyReport): Promise<boolean> {
  try {
    await deps.api.updateAgentMetadata(agent.id, withAskLevel(agent.metadata, level));
    entry.askLevelsUpdated = [...(entry.askLevelsUpdated ?? []), agent.name];
    entry.writes += 1;
    return true;
  } catch (error) {
    entry.failures.push({ step: "asklevels", agent: agent.name, error: describeError(error, entry.name) });
    return false;
  }
}

/**
 * Ask levels (docs/agent-rules.md, "Agent questions"): read each agent's level from kyoube.studio
 * and copy it into the agent's metadata, where the core patch reads it. Returns the level each
 * agent now has, for its rules block. A failed read skips the copy and is never applied as "no
 * levels": every agent keeps the level its metadata already holds. While Studio is not installed
 * or not started, the step is skipped quietly. Terminated agents and agents waiting for approval
 * are left alone. A built-in agent stays at its line whatever Studio says: a level in its metadata
 * (which it can edit itself) is removed, with the core's marker kept as it is, and the core patch
 * holds it at its line too. An agent listed without a metadata field is never written: writing
 * the level alone would wipe the metadata the list left out.
 */
async function askLevelsStep(deps: PassDeps, companyId: string, entry: CompanyReport): Promise<Map<string, AskLevel>> {
  const now = new Map<string, AskLevel>();
  let agents: AgentRef[];
  try {
    agents = await deps.api.listAgents(companyId);
  } catch (error) {
    entry.failures.push({ step: "asklevels", error: describeError(error, entry.name) });
    return now;
  }
  let levels: Record<string, "none" | "any"> | null = null;
  try {
    levels = await deps.api.getAskLevels(companyId);
  } catch (error) {
    if (!pluginNotStarted(error)) entry.failures.push({ step: "asklevels", error: describeError(error, entry.name) });
  }
  for (const agent of agents) {
    if (agent.status === "terminated" || agent.status === "pending_approval") continue;
    const metadata = agent.metadata;
    if (metadata === undefined) continue;
    if (isBuiltInAgent(metadata)) {
      now.set(agent.id, "line");
      if (hasAskLevel(metadata)) await writeAskLevel(deps, { ...agent, metadata }, "line", entry);
      continue;
    }
    const current = askLevelOf(metadata);
    now.set(agent.id, current);
    if (!levels) continue;
    const desired: AskLevel = levels[agent.id] ?? "line";
    if (desired === current) continue;
    if (await writeAskLevel(deps, { ...agent, metadata }, desired, entry)) now.set(agent.id, desired);
  }
  return now;
}

/**
 * `kyoube agent-rules off`: the ask-level key comes out of every agent's metadata that has it,
 * built-in agents included; every other key stays. An agent listed without a metadata field is
 * never written.
 */
async function clearAskLevels(api: RulesApi, companyId: string, entry: CompanyReport): Promise<void> {
  let agents: AgentRef[];
  try {
    agents = await api.listAgents(companyId);
  } catch (error) {
    entry.failures.push({ step: "asklevels", error: describeError(error, entry.name) });
    return;
  }
  for (const agent of agents) {
    if (agent.status === "terminated" || agent.status === "pending_approval" || agent.metadata === undefined || !hasAskLevel(agent.metadata)) continue;
    try {
      await api.updateAgentMetadata(agent.id, withAskLevel(agent.metadata, "line"));
      entry.writes += 1;
    } catch (error) {
      entry.failures.push({ step: "asklevels", agent: agent.name, error: describeError(error, entry.name) });
    }
  }
}

/**
 * A pass while KYOUBE_AGENT_RULES=off (ruling R15): the group step alone, in every company. Groups
 * are their own feature, so deleting a group still lifts its restrictions with the rules off. No
 * governance, guard or rules block; recorded as `lastGroupsPass`, leaving `lastPass` as it was.
 */
export async function groupsPass(deps: PassDeps, state: AgentRulesState): Promise<{ report: PassReport; state: AgentRulesState }> {
  const report: PassReport = { at: deps.now().toISOString(), mode: "groups", companies: [], failures: [] };
  for (const company of (await listCompanies(deps, report)) ?? []) {
    const entry = companyReport(company);
    await groupsStep(deps, company.id, entry);
    report.companies.push(entry);
  }
  return { report, state: { ...state, lastGroupsPass: report } };
}

/** One pass: in every company, G1, then G2 through the plugin, then groups, ask levels and the rules block. Each step and each agent fails on its own. */
export async function applyPass(deps: PassDeps, state: AgentRulesState): Promise<{ report: PassReport; state: AgentRulesState }> {
  const report: PassReport = { at: deps.now().toISOString(), mode: "apply", companies: [], failures: [] };
  const governancePrevious = { ...state.governancePrevious };
  const companies = (await listCompanies(deps, report)) ?? [];

  for (const company of companies) {
    const entry = companyReport(company);
    try {
      const plan = planGovernance(await deps.api.getGovernance(company.id));
      // Record governance even when unchanged, to preserve pre-existing people-only settings.
      // The first recorded value wins: a later pass must not record KyoubeAI's own entry as
      // "what was there before".
      governancePrevious[company.id] = { ...plan.previous, ...(governancePrevious[company.id] ?? {}) };
      if (plan.changed) {
        await deps.api.setGovernance(company.id, plan.next);
        entry.governance = "set";
        entry.writes += 1;
      }
    } catch (error) {
      entry.governance = "failed";
      entry.failures.push({ step: "governance", error: describeError(error) });
    }

    try {
      const guard = await deps.api.reconcileGuard(company.id);
      entry.guard = guard;
      entry.writes += guard.updated.length;
      for (const skipped of guard.skipped) entry.skipped.push({ agent: skipped.name, reason: skipped.reason });
      for (const failure of guard.failures) entry.failures.push({ step: "guard", agent: failure.name, error: `${failure.step}: ${failure.error}` });
      if (guard.selfTest.status === "fail") entry.failures.push({ step: "guard", error: `self-test failed: ${guard.selfTest.detail}` });
    } catch (error) {
      entry.failures.push({ step: "guard", error: describeError(error, entry.name) });
    }

    await groupsStep(deps, company.id, entry);
    const levels = await askLevelsStep(deps, company.id, entry);
    await editAgents(deps.api, company.id, entry, (agent) => (content) => applyRules(content, levels.get(agent.id) ?? askLevelOf(agent.metadata)));
    report.companies.push(entry);
  }

  return { report, state: { ...state, governancePrevious, lastPass: report } };
}

/** `kyoube agent-rules off`: G1 back as it was, G2 undone by the plugin, the ask levels and the blocks removed. */
export async function revertPass(deps: PassDeps, state: AgentRulesState): Promise<{ report: PassReport; state: AgentRulesState }> {
  const report: PassReport = { at: deps.now().toISOString(), mode: "revert", companies: [], failures: [] };
  const governancePrevious = { ...state.governancePrevious };
  const companies = (await listCompanies(deps, report)) ?? [];

  for (const company of companies) {
    const entry = companyReport(company);
    try {
      const { next, changed } = revertGovernance(await deps.api.getGovernance(company.id), governancePrevious[company.id]);
      if (changed) {
        await deps.api.setGovernance(company.id, next);
        entry.governance = "restored";
        entry.writes += 1;
      }
      delete governancePrevious[company.id];
    } catch (error) {
      entry.governance = "failed";
      entry.failures.push({ step: "governance", error: describeError(error) });
    }

    try {
      const reverted = await deps.api.revertGuard(company.id);
      entry.writes += reverted.reverted.length;
      for (const failure of reverted.failures) entry.failures.push({ step: "guard", agent: failure.name, error: `${failure.step}: ${failure.error}` });
    } catch (error) {
      entry.failures.push({ step: "guard", error: describeError(error, entry.name) });
    }

    await clearAskLevels(deps.api, company.id, entry);
    await editAgents(deps.api, company.id, entry, () => removeRules);
    report.companies.push(entry);
  }

  return { report, state: { ...state, governancePrevious, lastPass: report } };
}
