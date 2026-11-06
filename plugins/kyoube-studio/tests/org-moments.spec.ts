import { describe, expect, it } from "vitest";
import { diffMoments, momentSnapshot } from "../src/org/org-moments.js";
import type { OrgAgent, OrgState, OrgTask } from "../src/org/org-types.js";

const task = (id: string): OrgTask => ({ id, identifier: id.toUpperCase(), title: `Task ${id}`, href: `/tasks/${id}` });

/** One agent with a given state and an optional open task. */
function agent(id: string, state: OrgState = "idle", taskId: string | null = null): OrgAgent {
  return {
    id,
    name: id,
    title: null,
    icon: null,
    state,
    detail: state,
    task: taskId ? task(taskId) : null,
    reportsTo: null,
  };
}

describe("momentSnapshot", () => {
  it("records each agent's state and task id, and the done set", () => {
    const snap = momentSnapshot([agent("ana", "working", "t1"), agent("bo")], ["t0"]);
    expect(snap.agents.get("ana")).toEqual({ state: "working", taskId: "t1" });
    expect(snap.agents.get("bo")).toEqual({ state: "idle", taskId: null });
    expect(snap.done.has("t0")).toBe(true);
  });
});

describe("diffMoments", () => {
  it("nothing on the first snapshot", () => {
    const next = momentSnapshot([agent("ana", "attention", "t1")], []);
    expect(diffMoments(null, next)).toEqual([]);
  });

  it("finished when the previous task is done", () => {
    const prev = momentSnapshot([agent("ana", "working", "t1")], []);
    const next = momentSnapshot([agent("ana", "idle", null)], ["t1"]);
    expect(diffMoments(prev, next)).toEqual([{ kind: "finished", agentId: "ana" }]);
  });

  it("handover when a new open task arrives", () => {
    const prev = momentSnapshot([agent("ana", "idle", null)], []);
    const next = momentSnapshot([agent("ana", "working", "t2")], []);
    expect(diffMoments(prev, next)).toEqual([{ kind: "handover", agentId: "ana" }]);
  });

  it("problem when the state turns to attention", () => {
    const prev = momentSnapshot([agent("ana", "working", "t1")], []);
    const next = momentSnapshot([agent("ana", "attention", "t1")], []);
    expect(diffMoments(prev, next)).toEqual([{ kind: "problem", agentId: "ana" }]);
  });

  it("two identical snapshots give no moments", () => {
    const agents = [agent("ana", "working", "t1"), agent("bo", "attention", "t2")];
    const prev = momentSnapshot(agents, ["t0"]);
    const next = momentSnapshot(agents, ["t0"]);
    expect(diffMoments(prev, next)).toEqual([]);
  });

  it("caps at three, finished first", () => {
    const prev = momentSnapshot(
      [
        agent("f1", "working", "d1"),
        agent("f2", "working", "d2"),
        agent("h1", "idle", null),
        agent("h2", "idle", null),
        agent("p1", "working", "x1"),
      ],
      [],
    );
    const next = momentSnapshot(
      [
        agent("f1", "idle", null),
        agent("f2", "idle", null),
        agent("h1", "working", "n1"),
        agent("h2", "working", "n2"),
        agent("p1", "attention", "x1"),
      ],
      ["d1", "d2"],
    );
    expect(diffMoments(prev, next).map((m) => m.kind)).toEqual(["finished", "finished", "handover"]);
  });

  it("an agent new to the snapshot gives no moment", () => {
    const prev = momentSnapshot([agent("ana", "idle", null)], []);
    const next = momentSnapshot([agent("ana", "idle", null), agent("newbie", "attention", "t9")], []);
    expect(diffMoments(prev, next)).toEqual([]);
  });
});
