import { afterEach, describe, expect, it } from "vitest";
import { _resetBoardData, loadBoardSnapshot, loadIssueComments } from "../src/ui/board-data.js";

const COMPANY = "c1";
/** The signed-in person and the company: what every board read is kept under. */
const AS_U1 = { userId: "u1", companyId: COMPANY };
const AS_U2 = { userId: "u2", companyId: COMPANY };
const ISSUES = `/api/companies/${COMPANY}/issues?limit=500`;
const APPROVALS = `/api/companies/${COMPANY}/approvals?status=pending`;

const ISSUE = { id: "i1", identifier: "BAP-1", title: "Three posts", status: "in_progress", assigneeAgentId: "a1", hiddenAt: null, updatedAt: "2026-10-22T09:00:00.000Z" };
const APPROVAL = { id: "ap1", type: "request_board_approval", status: "pending", requestedByAgentId: "a1", payload: { title: "New pricing page" }, createdAt: "2026-10-22T08:00:00.000Z" };

type Answers = Record<string, { status?: number; body: unknown }>;

/** A fake `fetch` answering the core's board routes from `answers` (changeable between calls), recording every call. */
function fakeFetch(answers: Answers) {
  const calls: Array<{ url: string; init: RequestInit | undefined }> = [];
  const impl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, init });
    const answer = answers[url] ?? { status: 404, body: { error: "Not found" } };
    return new Response(JSON.stringify(answer.body), { status: answer.status ?? 200, headers: { "Content-Type": "application/json" } });
  }) as typeof fetch;
  return { impl, calls, urls: () => calls.map((call) => call.url) };
}

afterEach(() => _resetBoardData());

describe("board data", () => {
  it("loads issues and pending approvals with the session and caches for eight seconds", async () => {
    const board = fakeFetch({ [ISSUES]: { body: [ISSUE] }, [APPROVALS]: { body: [APPROVAL] } });
    const clock = { now: 1_000 };
    const load = () => loadBoardSnapshot(AS_U1, { fetchImpl: board.impl, now: () => clock.now });
    expect(await load()).toEqual({ issues: [ISSUE], approvals: [APPROVAL], approvalsHidden: false });
    expect(board.urls()).toEqual([ISSUES, APPROVALS]);
    expect(board.calls.every((call) => call.init?.credentials === "include" && (call.init?.method ?? "GET") === "GET")).toBe(true);
    clock.now += 7_999;
    expect(await load()).toEqual({ issues: [ISSUE], approvals: [APPROVAL], approvalsHidden: false });
    expect(board.calls).toHaveLength(2);
    clock.now += 1;
    await load();
    expect(board.urls()).toEqual([ISSUES, APPROVALS, ISSUES, APPROVALS]);
  });

  it("treats a 403 from approvals as hidden, not as an error", async () => {
    const board = fakeFetch({ [ISSUES]: { body: [ISSUE] }, [APPROVALS]: { status: 403, body: { error: "Forbidden" } } });
    expect(await loadBoardSnapshot(AS_U1, { fetchImpl: board.impl })).toEqual({ issues: [ISSUE], approvals: [], approvalsHidden: true });
  });

  it("does not cache a failed load", async () => {
    const answers: Answers = { [ISSUES]: { status: 500, body: { error: "Database unavailable" } }, [APPROVALS]: { body: [] } };
    const board = fakeFetch(answers);
    await expect(loadBoardSnapshot(AS_U1, { fetchImpl: board.impl })).rejects.toMatchObject({ status: 500, message: "Database unavailable" });
    answers[ISSUES] = { body: [ISSUE] };
    expect(await loadBoardSnapshot(AS_U1, { fetchImpl: board.impl })).toEqual({ issues: [ISSUE], approvals: [], approvalsHidden: false });
    expect(board.urls()).toEqual([ISSUES, APPROVALS, ISSUES, APPROVALS]);
  });

  it("fresh bypasses the cache", async () => {
    const answers: Answers = { [ISSUES]: { body: [] }, [APPROVALS]: { body: [] } };
    const board = fakeFetch(answers);
    await loadBoardSnapshot(AS_U1, { fetchImpl: board.impl });
    answers[ISSUES] = { body: [ISSUE] };
    expect((await loadBoardSnapshot(AS_U1, { fetchImpl: board.impl })).issues).toEqual([]);
    expect((await loadBoardSnapshot(AS_U1, { fetchImpl: board.impl, fresh: true })).issues).toEqual([ISSUE]);
    expect(board.calls).toHaveLength(4);
  });

  it("a load for another person drops the first person's entries", async () => {
    const board = fakeFetch({ [ISSUES]: { body: [ISSUE] }, [APPROVALS]: { body: [APPROVAL] } });
    const clock = { now: 1_000 };
    const load = (who: typeof AS_U1) => loadBoardSnapshot(who, { fetchImpl: board.impl, now: () => clock.now });
    await load(AS_U1);
    // The next person on the tab gets a read of their own, never the first person's cached one.
    clock.now += 1_000;
    await load(AS_U2);
    expect(board.calls).toHaveLength(4);
    // And the first person's read is gone from memory: well inside eight seconds, it is read again.
    clock.now += 1_000;
    await load(AS_U1);
    expect(board.calls).toHaveLength(6);
  });

  it("loads a task's comments", async () => {
    const comments = [{ body: "Drafted post 1 of 3", authorAgentId: "a1", createdAt: "2026-10-22T09:01:00.000Z" }];
    const board = fakeFetch({ "/api/issues/i%2F1/comments": { body: comments } });
    expect(await loadIssueComments({ userId: "u1", issueId: "i/1" }, board.impl)).toEqual(comments);
    expect(board.calls).toEqual([{ url: "/api/issues/i%2F1/comments", init: expect.objectContaining({ credentials: "include" }) }]);
  });
});
