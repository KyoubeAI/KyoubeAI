import { describe, expect, it, vi } from "vitest";
import { applyAskLevel, ASK_LEVEL_KEY, askLevelOf, decideAskLevel, isBuiltInAgent, lineOf, MESSAGES, QUESTION_LIMIT } from "../ask-level.mjs";

const agent = (id, name, reportsTo = null, status = "idle", metadata = null) => ({ id, name, reportsTo, status, metadata });
// top <- m <- r <- r2 ; m <- s (r's peer) ; p alone
const ORG = [
  agent("top", "Top"),
  agent("m", "Manager", "top"),
  agent("r", "Report", "m"),
  agent("r2", "Report's report", "r"),
  agent("s", "Sibling", "m"),
  agent("p", "Peer"),
];
const withLevel = (agents, id, level) => agents.map((row) => (row.id === id ? { ...row, metadata: { [ASK_LEVEL_KEY]: level } } : row));
const decide = (overrides = {}) => decideAskLevel({ askerId: "r", addresseeId: "m", agents: ORG, questions: [], idempotencyKey: null, ...overrides });

describe("askLevelOf", () => {
  it("reads none and any, and treats everything else as line", () => {
    expect(askLevelOf({ [ASK_LEVEL_KEY]: "none" })).toBe("none");
    expect(askLevelOf({ [ASK_LEVEL_KEY]: "any" })).toBe("any");
    expect(askLevelOf({ [ASK_LEVEL_KEY]: "line" })).toBe("line");
    expect(askLevelOf({ [ASK_LEVEL_KEY]: "everyone" })).toBe("line");
    expect(askLevelOf({ [ASK_LEVEL_KEY]: "NONE" })).toBe("line");
    expect(askLevelOf({})).toBe("line");
    expect(askLevelOf(null)).toBe("line");
    expect(askLevelOf(undefined)).toBe("line");
    expect(askLevelOf(["none"])).toBe("line");
  });
});

describe("isBuiltInAgent", () => {
  it("reads the core's marker the way ask-levels.ts does: a plain object with a string key", () => {
    expect(isBuiltInAgent({ paperclipBuiltInAgent: { key: "reflection-coach", featureKeys: [] } })).toBe(true);
    expect(isBuiltInAgent({ paperclipBuiltInAgent: { key: "reflection-coach" } })).toBe(true);
    expect(isBuiltInAgent({ paperclipBuiltInAgent: { key: 1 } })).toBe(false);
    expect(isBuiltInAgent({ paperclipBuiltInAgent: ["x"] })).toBe(false);
    expect(isBuiltInAgent({ paperclipBuiltInAgent: null })).toBe(false);
    expect(isBuiltInAgent({})).toBe(false);
    expect(isBuiltInAgent(null)).toBe(false);
    expect(isBuiltInAgent(undefined)).toBe(false);
  });
});

describe("lineOf", () => {
  it("is every manager above plus every agent below, never the asker", () => {
    expect([...lineOf(ORG, "r")].sort()).toEqual(["m", "r2", "top"]);
    expect([...lineOf(ORG, "m")].sort()).toEqual(["r", "r2", "s", "top"]);
    expect([...lineOf(ORG, "top")].sort()).toEqual(["m", "r", "r2", "s"]);
    expect([...lineOf(ORG, "p")]).toEqual([]);
  });

  it("stops at a cycle", () => {
    const cycle = [agent("a", "A", "b"), agent("b", "B", "c"), agent("c", "C", "a")];
    expect([...lineOf(cycle, "a")].sort()).toEqual(["b", "c"]);
  });

  it("leaves out terminated agents and stops at a terminated manager", () => {
    const org = [agent("top", "Top"), agent("m", "Manager", "top", "terminated"), agent("r", "Report", "m"), agent("x", "Gone report", "r", "terminated")];
    expect([...lineOf(org, "r")]).toEqual([]);
  });

  it("stops at a manager it does not know (another company's id)", () => {
    expect([...lineOf([agent("r", "Report", "elsewhere")], "r")]).toEqual([]);
  });
});

describe("decideAskLevel", () => {
  it("allows its manager, its manager's manager and its own reports at its line", () => {
    for (const addresseeId of ["m", "top", "r2"]) expect(decide({ addresseeId })).toEqual({ allow: true });
  });

  it("refuses a sibling or an outsider at its line and names who it may ask, sorted by name", () => {
    const refused = decide({ addresseeId: "p" });
    expect(refused).toEqual({ allow: false, code: "kyoube_ask_outside_line", message: "Peer is outside your line. You may ask: Manager (m), Report's report (r2), Top (top)." });
    expect(decide({ addresseeId: "s" })).toMatchObject({ allow: false, code: "kyoube_ask_outside_line" });
  });

  it("names an unknown addressee by its id", () => {
    expect(decide({ addresseeId: "who" }).message).toMatch(/^who is outside your line\./);
  });

  it("says when there is nobody in its line", () => {
    expect(decide({ askerId: "p", addresseeId: "m" })).toEqual({
      allow: false,
      code: "kyoube_ask_outside_line",
      message: "Manager is outside your line, and you have no managers or reports to ask. Finish the task yourself, or hand it back to the person who started it (rule 4).",
    });
  });

  it("names at most 20 agents, then how many more", () => {
    const many = [agent("boss", "Boss"), ...Array.from({ length: 25 }, (_, i) => agent(`a${String(i).padStart(2, "0")}`, `Agent ${String(i).padStart(2, "0")}`, "boss")), agent("out", "Outsider")];
    const message = decideAskLevel({ askerId: "boss", addresseeId: "out", agents: many, questions: [], idempotencyKey: null }).message;
    expect(message).toContain("Agent 19 (a19)");
    expect(message).not.toContain("Agent 20 (a20)");
    expect(message.endsWith(", and 5 more.")).toBe(true);
  });

  it("refuses everyone at no agents", () => {
    expect(decide({ agents: withLevel(ORG, "r", "none") })).toEqual({ allow: false, code: "kyoube_ask_level_none", message: MESSAGES.none });
  });

  it("allows anyone at any agent, the core still checks the company", () => {
    expect(decide({ agents: withLevel(ORG, "r", "any"), addresseeId: "p" })).toEqual({ allow: true });
    expect(decide({ agents: withLevel(ORG, "r", "any"), addresseeId: "someone-elsewhere" })).toEqual({ allow: true });
  });

  it("holds a built-in agent at its line whatever level its metadata says", () => {
    const builtIn = (level) => ORG.map((row) => (row.id === "r" ? { ...row, metadata: { paperclipBuiltInAgent: { key: "reflection-coach" }, [ASK_LEVEL_KEY]: level } } : row));
    expect(decide({ agents: builtIn("any"), addresseeId: "p" })).toMatchObject({ allow: false, code: "kyoube_ask_outside_line" });
    expect(decide({ agents: builtIn("none"), addresseeId: "m" })).toEqual({ allow: true });
  });

  it("refuses a second question while one is open", () => {
    expect(decide({ questions: [{ status: "pending", idempotencyKey: "k1" }] })).toEqual({ allow: false, code: "kyoube_ask_open_question", message: MESSAGES.open });
  });

  it("refuses a fourth question in all, whatever became of the first three", () => {
    const three = ["answered", "expired", "cancelled"].map((status, i) => ({ status, idempotencyKey: `k${i}` }));
    expect(decide({ questions: three.slice(0, 2) })).toEqual({ allow: true });
    expect(decide({ questions: three })).toEqual({ allow: false, code: "kyoube_ask_limit", message: MESSAGES.limit });
    expect(QUESTION_LIMIT).toBe(3);
  });

  it("checks the level before the limits", () => {
    expect(decide({ addresseeId: "p", questions: [{ status: "pending", idempotencyKey: null }] }).code).toBe("kyoube_ask_outside_line");
  });

  it("lets an idempotent replay through, even at the limit or while it is the open one", () => {
    const questions = [{ status: "answered", idempotencyKey: "a" }, { status: "answered", idempotencyKey: "b" }, { status: "pending", idempotencyKey: "c" }];
    expect(decide({ questions, idempotencyKey: "c" })).toEqual({ allow: true });
    expect(decide({ questions, idempotencyKey: "d" }).allow).toBe(false);
  });

  it("has the messages the spec fixes", () => {
    expect(MESSAGES).toEqual({
      none: "Your ask level does not let you ask other agents. Finish the task yourself, or hand it back to the person who started it (rule 4).",
      open: "This task already has an open question to an agent. Wait for its answer.",
      limit: "This task has used its 3 questions to agents. Hand it back to the person who started it (rule 4).",
      checkFailed: "Your question could not be checked. Hand the task back to the person who started it (rule 4).",
    });
  });
});

describe("applyAskLevel", () => {
  const tables = {
    agents: { name: "agents", id: "agents.id", name_: "agents.name", reportsTo: "agents.reportsTo", status: "agents.status", metadata: "agents.metadata", companyId: "agents.companyId" },
    issueThreadInteractions: { name: "cards", issueId: "cards.issueId", kind: "cards.kind", status: "cards.status", idempotencyKey: "cards.idempotencyKey", createdByAgentId: "cards.createdByAgentId", addresseeAgentId: "cards.addresseeAgentId" },
  };
  const ops = { and: (...parts) => ({ and: parts }), eq: (column, value) => ({ eq: [column, value] }), isNotNull: (column) => ({ isNotNull: column }) };
  const unprocessable = (message, details) => Object.assign(new Error(message), { status: 422, details });
  function fakeDb({ agents = ORG, questions = [], fail = false } = {}) {
    const wheres = [];
    const db = {
      select: () => ({
        from: (table) => ({
          where: async (condition) => {
            wheres.push({ table: table.name, condition });
            if (fail) throw new Error("db down");
            return table === tables.agents ? agents : questions;
          },
        }),
      }),
    };
    return { db, wheres };
  }
  const policy = () => ({ requestedResolverPolicy: "human_only", effectiveResolverPolicy: "human_only", resolverPolicyProvenance: "inherited", effectiveResolverPolicySource: "company_cap" });
  const call = (db, overrides = {}) => applyAskLevel({ db, tables, ops, issue: { id: "i1", companyId: "c1" }, actor: { agentId: "r" }, data: { kind: "ask_user_questions", addresseeAgentId: "m" }, policy: policy(), unprocessable, ...overrides });

  it("makes an allowed card answerable by the addressed agent", async () => {
    const { db } = fakeDb();
    const p = policy();
    await call(db, { policy: p });
    expect(p).toEqual({ requestedResolverPolicy: "not_creator", effectiveResolverPolicy: "not_creator", resolverPolicyProvenance: "inherited", effectiveResolverPolicySource: "requested" });
  });

  it("reads the company's agents and this task's agent-to-agent questions only", async () => {
    const { db, wheres } = fakeDb();
    await call(db);
    expect(wheres).toEqual([
      { table: "agents", condition: { eq: ["agents.companyId", "c1"] } },
      { table: "cards", condition: { and: [{ eq: ["cards.issueId", "i1"] }, { eq: ["cards.kind", "ask_user_questions"] }, { isNotNull: "cards.createdByAgentId" }, { isNotNull: "cards.addresseeAgentId" }] } },
    ]);
  });

  it("refuses with a 422 carrying the code, and leaves the policy alone", async () => {
    const { db } = fakeDb();
    const p = policy();
    await expect(call(db, { policy: p, data: { kind: "ask_user_questions", addresseeAgentId: "p" } })).rejects.toMatchObject({ status: 422, details: { code: "kyoube_ask_outside_line" } });
    expect(p.effectiveResolverPolicy).toBe("human_only");
  });

  it("fails closed when the database fails", async () => {
    const { db } = fakeDb({ fail: true });
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    await expect(call(db)).rejects.toMatchObject({ message: MESSAGES.checkFailed, status: 422, details: { code: "kyoube_ask_check_failed" } });
    error.mockRestore();
  });

  it("passes the idempotency key through", async () => {
    const { db } = fakeDb({ questions: [{ status: "pending", idempotencyKey: "same" }] });
    await expect(call(db, { data: { kind: "ask_user_questions", addresseeAgentId: "m", idempotencyKey: "same" } })).resolves.toBeUndefined();
    await expect(call(db, { data: { kind: "ask_user_questions", addresseeAgentId: "m", idempotencyKey: "other" } })).rejects.toMatchObject({ details: { code: "kyoube_ask_open_question" } });
  });
});
