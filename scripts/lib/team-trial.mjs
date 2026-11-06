/** The live check's trial team (scripts/studio-live-check.mjs), kept apart so it can be tested without running the check. */

/**
 * Three live agents to rewire into a standalone team, so the chart must draw `team:<lead>` and
 * the lead's two lines whatever the company's shape. All three are agents nobody reports to, by
 * name: the lead is made top-level (a lead deep in a team would only be indented there) and the
 * other two report to it. `patches` holds only the managers that change. Null with fewer than three.
 */
export function teamTrial(agents) {
  const managers = new Set(agents.map((a) => a.reportsTo).filter(Boolean));
  const [lead, ...members] = agents.filter((a) => !managers.has(a.id)).sort((a, b) => String(a.name).localeCompare(String(b.name))).slice(0, 3);
  if (members.length < 2) return null;
  const wanted = [[lead, null], ...members.map((m) => [m, lead.id])];
  return { lead, members, patches: wanted.filter(([a, to]) => (a.reportsTo ?? null) !== to).map(([a, to]) => ({ id: a.id, reportsTo: to })) };
}
