import { describe, expect, it } from "vitest";
import { stripLiveEvent } from "../src/index.js";

describe("stripLiveEvent", () => {
  it("keeps the identifying fields of an activity and empties its details", () => {
    const event = { type: "activity.logged", companyId: "c", createdAt: "t", payload: { actorType: "user", actorId: "u", action: "issue.created", entityType: "issue", entityId: "i", agentId: null, runId: null, responsibleUserId: "u", details: { title: "Secret plan", description: "x" } } };
    expect(stripLiveEvent(event)).toEqual({ type: "activity.logged", companyId: "c", createdAt: "t", payload: { actorType: "user", actorId: "u", action: "issue.created", entityType: "issue", entityId: "i", agentId: null, runId: null, responsibleUserId: "u", details: {} } });
    expect(JSON.stringify(stripLiveEvent(event))).not.toContain("Secret");
  });
  it("strips a run log to ids", () => {
    const event = { type: "heartbeat.run.log", companyId: "c", payload: { runId: "r", issueId: "i", agentId: "a", status: "running", line: "cat /etc/passwd", entries: [{ text: "secret" }] } };
    expect(stripLiveEvent(event).payload).toEqual({ runId: "r", issueId: "i", agentId: "a", status: "running" });
    expect(stripLiveEvent({ type: "heartbeat.run.progress", companyId: "c", payload: { issueId: "i", summary: "secret" } }).payload).toEqual({ issueId: "i" });
    expect(stripLiveEvent({ type: "agent.status", companyId: "c", payload: { agentId: "a", status: "idle", errorReason: "secret" } }).payload).toEqual({ agentId: "a", status: "idle" });
  });
  it("strips an unknown event type to its type and company", () => {
    expect(stripLiveEvent({ type: "something.new", companyId: "c", createdAt: "t", payload: { title: "secret" } })).toEqual({ type: "something.new", companyId: "c", createdAt: "t", payload: {} });
  });
  it("does not change its input", () => {
    const event = { type: "activity.logged", companyId: "c", payload: { details: { title: "x" } } };
    stripLiveEvent(event);
    expect(event.payload.details).toEqual({ title: "x" });
  });
});
