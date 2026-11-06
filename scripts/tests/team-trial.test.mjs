// scripts/tests/team-trial.test.mjs
import assert from "node:assert/strict";
import { test } from "node:test";
import { teamTrial } from "../lib/team-trial.mjs";

const agent = (id, name, reportsTo = null) => ({ id, name, reportsTo });

test("teamTrial on a flat company picks the first three by name and moves only the two members", () => {
  const trial = teamTrial([agent("c", "Cleo"), agent("a", "Ada"), agent("d", "Dov"), agent("b", "Bea")]);
  assert.equal(trial.lead.id, "a");
  assert.deepEqual(trial.members.map((m) => m.id), ["b", "c"]);
  assert.deepEqual(trial.patches, [{ id: "b", reportsTo: "a" }, { id: "c", reportsTo: "a" }]);
});

test("teamTrial in a deep org uses agents nobody reports to and makes the lead top-level", () => {
  // Ana Aide 1 sorts first but sits three levels down; as the lead of a team it must stand alone.
  const org = [
    agent("m", "Morgan"),
    agent("p", "Director Pat", "m"),
    agent("ana", "Lead Ana", "p"),
    agent("a1", "Ana Aide 1", "ana"),
    agent("a2", "Ana Aide 2", "ana"),
    agent("k", "Analytics Kim", "m"),
    agent("k1", "Analyst 1", "k"),
  ];
  const trial = teamTrial(org);
  assert.equal(trial.lead.id, "a1");
  assert.deepEqual(trial.members.map((m) => m.id), ["a2", "k1"]);
  assert.deepEqual(trial.patches, [{ id: "a1", reportsTo: null }, { id: "a2", reportsTo: "a1" }, { id: "k1", reportsTo: "a1" }]);
});

test("teamTrial needs three agents with no reports", () => {
  assert.equal(teamTrial([agent("m", "Morgan"), agent("a", "Ada", "m"), agent("b", "Bea", "m")]), null);
});
