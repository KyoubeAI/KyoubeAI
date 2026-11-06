import { characterFor } from "../characters.js";
import type { OrgAgent, OrgHead, OrgNode, OrgPanel, OrgState, OrgTally, OrgTree } from "./org-types.js";

// Same order as STATE_RANK in ../model.ts, copied because src/org may not import the model.
const STATE_RANK: Record<OrgState, number> = { working: 0, attention: 1, waiting: 2, paused: 3, idle: 4 };

const byName = (a: OrgAgent, b: OrgAgent) => a.name.localeCompare(b.name);
const byStateThenName = (a: OrgAgent, b: OrgAgent) => STATE_RANK[a.state] - STATE_RANK[b.state] || byName(a, b);

export function panelName(owner: string, kind: "team" | "office"): string {
  if (!/[\s,]/.test(owner)) return `${owner}'s ${kind}`;
  return `${kind === "team" ? "Team" : "Office"} · ${owner}`;
}

export function tallyText(t: OrgTally): string {
  const parts = [`${t.agents} ${t.agents === 1 ? "agent" : "agents"}`];
  if (t.working > 0) parts.push(`${t.working} working`);
  if (t.waiting > 0) parts.push(`${t.waiting} waiting`);
  if (t.attention > 0) parts.push(`${t.attention} stuck`);
  if (t.paused > 0) parts.push(`${t.paused} paused`);
  return parts.join(" · ");
}

function tallyOf(agents: OrgAgent[]): OrgTally {
  const count = (state: OrgState) => agents.filter((a) => a.state === state).length;
  return { agents: agents.length, working: count("working"), waiting: count("waiting"), attention: count("attention"), paused: count("paused") };
}

function flatten(nodes: OrgNode[]): OrgAgent[] {
  return nodes.flatMap((n) => [n.agent, ...flatten(n.children)]);
}

export function buildOrgTree(agents: OrgAgent[]): OrgTree {
  const byId = new Map(agents.map((a) => [a.id, a]));
  const managerOf = new Map<string, string | null>();
  for (const a of agents) managerOf.set(a.id, a.reportsTo && a.reportsTo !== a.id && byId.has(a.reportsTo) ? a.reportsTo : null);

  // Break loops: in each cycle the member with the smallest id becomes top-level. Not the list's order,
  // which follows state and heartbeat, so the chart does not jump between polls.
  for (const a of agents) {
    const path: string[] = [];
    const seen = new Set<string>();
    let cur: string | null = a.id;
    while (cur && !seen.has(cur)) {
      seen.add(cur);
      path.push(cur);
      cur = managerOf.get(cur) ?? null;
    }
    if (cur) {
      const cycle = path.slice(path.indexOf(cur));
      const first = cycle.reduce((best, id) => (id < best ? id : best));
      managerOf.set(first, null);
    }
  }

  const kids = new Map<string, OrgAgent[]>();
  for (const a of agents) {
    const m = managerOf.get(a.id);
    if (m) kids.set(m, [...(kids.get(m) ?? []), a]);
  }
  for (const list of kids.values()) list.sort(byStateThenName);
  const reportsOf = new Map<string, string[]>(agents.map((a) => [a.id, (kids.get(a.id) ?? []).map((k) => k.id)]));
  const hasReports = (a: OrgAgent) => (kids.get(a.id)?.length ?? 0) > 0;

  const node = (a: OrgAgent): OrgNode => ({ agent: a, children: (kids.get(a.id) ?? []).map(node) });
  const panel = (id: string, kind: "team" | "office", owner: OrgAgent, members: OrgNode[], counted: OrgAgent[]): OrgPanel => {
    const tally = tallyOf(counted);
    return { id, kind, owner, name: panelName(owner.name, kind), tint: characterFor(owner.icon, owner.name).tint, members, tally, attention: tally.attention > 0 };
  };
  const teamPanel = (lead: OrgAgent): OrgPanel => {
    const members = (kids.get(lead.id) ?? []).map(node);
    return panel(`team:${lead.id}`, "team", lead, members, [lead, ...flatten(members)]);
  };

  const top = agents.filter((a) => managerOf.get(a.id) === null).sort(byName);
  const heads: OrgHead[] = [];
  const teams: OrgPanel[] = [];
  const shelf: OrgAgent[] = [];
  for (const a of top) {
    const direct = kids.get(a.id) ?? [];
    if (direct.length === 0) shelf.push(a);
    else if (!direct.some(hasReports)) teams.push(teamPanel(a));
    else {
      const panels: OrgPanel[] = [];
      const flat = direct.filter((d) => !hasReports(d)).map(node);
      if (flat.length > 0) panels.push(panel(`office:${a.id}`, "office", a, flat, flat.map((n) => n.agent)));
      panels.push(...direct.filter(hasReports).sort(byName).map(teamPanel));
      heads.push({ agent: a, panels });
    }
  }
  return { heads, teams, shelf, managerOf, reportsOf, byId };
}

/** The agent, every manager up the chain, and the agent's direct reports. */
export function focusIds(tree: OrgTree, id: string): Set<string> {
  const out = new Set<string>();
  if (!tree.byId.has(id)) return out;
  for (let cur: string | null | undefined = id; cur && !out.has(cur); cur = tree.managerOf.get(cur)) out.add(cur);
  for (const r of tree.reportsOf.get(id) ?? []) out.add(r);
  return out;
}

/** The id of the panel that holds the agent, or null (heads and the shelf sit outside panels). */
export function panelOf(tree: OrgTree, agentId: string): string | null {
  const panels = [...tree.heads.flatMap((h) => h.panels), ...tree.teams];
  for (const p of panels) {
    if (p.kind === "team" && p.owner.id === agentId) return p.id;
    if (flatten(p.members).some((a) => a.id === agentId)) return p.id;
  }
  return null;
}
