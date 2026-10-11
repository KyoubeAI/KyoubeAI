// tests/integration/app-decisions.spec.ts
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { AppService, OUTCOME_WINDOW_MS } from "../../src/apps/service.js";
import { DataError } from "../../src/data/errors.js";
import { DataService } from "../../src/data/service.js";
import { resetCompanyCache } from "../../src/db/company-scope.js";
import { recordDecisions } from "../../src/decisions/store.js";
import { migrationsDirFrom, runMetaMigrations } from "../../src/db/migrate.js";
import { createTestDatabase } from "./setup.js";

export const C = "66666666-6666-4666-8666-666666666666";
export const OWNER = { kind: "user" as const, id: "owner-1", runId: null };
export const VIEWER = { kind: "user" as const, id: "viewer-1", runId: null };
export const STRANGER = { kind: "user" as const, id: "stranger-1", runId: null };
export const AGENT = { kind: "agent" as const, id: "agent-1", runId: "run-1" };
const ROLES: Record<string, string> = { "owner-1": "owner", "viewer-1": "viewer" };
export const SOURCE = "<!doctype html><html><body><script>kyoube.ready()</script></body></html>";
export const URGENT = { type: "check", statement: "The ticket needs a reply today." };
export const TRIAGE_SET = { table: "tickets", fields: ["subject", "body"], questions: { urgent: URGENT } };

export function manifest(slug: string, decisions?: Record<string, unknown>, tables: string[] = ["tickets"]) {
  return { name: `App ${slug}`, slug, tables: tables.map((name) => ({ name })), ...(decisions ? { decisions } : {}) };
}

let db: Awaited<ReturnType<typeof createTestDatabase>>;
let data: DataService;
let apps: AppService;

beforeAll(async () => {
  db = await createTestDatabase();
  resetCompanyCache();
  await runMetaMigrations(db.pool, migrationsDirFrom(import.meta.url.replace("tests/integration/app-decisions.spec.ts", "src/db/migrate.ts")));
  data = new DataService({ pool: db.pool, resolveUserRole: async (_companyId, userId) => ROLES[userId] ?? null });
  apps = new AppService({ pool: db.pool, data });
  await data.createTable(C, OWNER, { name: "tickets", fields: [
    { name: "subject", kind: "text", required: true }, { name: "body", kind: "long_text" }, { name: "priority", kind: "integer" },
  ] });
  await data.setAgentGrant(C, OWNER, "agent-1", "schema");
});
afterAll(async () => { await db.close(); });

describe("decision set fields", () => {
  it("refuses to save a set naming a field its table does not have", async () => {
    await expect(apps.create(C, OWNER, manifest("fields-bad", { triage: { ...TRIAGE_SET, fields: ["subject", "nope"] } }), SOURCE))
      .rejects.toThrow('decision set "triage" names field(s) nope that table "tickets" does not have');
  });

  it("saves a set whose table does not exist yet, and refuses to publish it", async () => {
    const later = { table: "later", fields: ["x"], questions: { urgent: URGENT } };
    await apps.create(C, OWNER, manifest("fields-later", { triage: later }, ["later"]), SOURCE);
    await expect(apps.publish(C, OWNER, "fields-later", undefined, { decisionsConfirmed: true })).rejects.toMatchObject({ code: "not_found" });
  });

  it("checks the fields again at publish", async () => {
    await data.createTable(C, OWNER, { name: "leads", fields: [{ name: "name", kind: "text" }, { name: "notes", kind: "long_text" }] });
    await apps.create(C, OWNER, manifest("fields-gone", { triage: { table: "leads", fields: ["name", "notes"], questions: { urgent: URGENT } } }, ["leads"]), SOURCE);
    await data.removeField(C, OWNER, "leads", "notes");
    await expect(apps.publish(C, OWNER, "fields-gone", undefined, { decisionsConfirmed: true })).rejects.toThrow("notes");
  });
});

function stubDecisions(opts: { available?: boolean; fail?: DataError } = {}) {
  const calls: unknown[][] = [];
  const decisions = {
    decide: async (...args: unknown[]) => {
      calls.push(args);
      if (opts.fail) throw opts.fail;
      return { decisionId: "d-1", model: "jev-1.13.0", answers: { urgent: { type: "check", value: true, confidence: 0.97, status: "auto" } } };
    },
    status: async () => ({ available: opts.available ?? true, enabled: true, configured: true, provider: "openrouter", model: "typesafe/jev-1.13", budget: { cap: 10, used: 0, remaining: 10 } }),
  };
  return { decisions: decisions as never, calls };
}

async function published(service: AppService, slug: string, decisions?: Record<string, unknown>) {
  await service.create(C, OWNER, manifest(slug, decisions), SOURCE);
  await service.publish(C, OWNER, slug, undefined, { decisionsConfirmed: true });
}

async function firstTicket(): Promise<string> {
  const inserted = await data.insert(C, OWNER, "tickets", [{ subject: "Card charged twice", body: "Please refund", priority: 2 }]);
  return String(inserted[0]!.id);
}

describe("runtime context", () => {
  it("names the declared sets and whether decisions are available to apps", async () => {
    const { decisions } = stubDecisions({ available: false });
    const service = new AppService({ pool: db.pool, data, decisions });
    await published(service, "ctx-sets", { triage: TRIAGE_SET });
    expect((await service.runtime(C, VIEWER, "ctx-sets", "")).context.decisions).toEqual({ available: false, sets: ["triage"] });
    await published(service, "ctx-none");
    expect((await service.runtime(C, VIEWER, "ctx-none", "")).context.decisions).toEqual({ available: false, sets: [] });
    const on = new AppService({ pool: db.pool, data, decisions: stubDecisions({ available: true }).decisions });
    expect((await on.runtime(C, VIEWER, "ctx-sets", "")).context.decisions).toEqual({ available: true, sets: ["triage"] });
  });
});

describe("runtimeDecide", () => {
  it("decides on a stored row under the viewer, sending only the set's fields", async () => {
    const { decisions, calls } = stubDecisions();
    const service = new AppService({ pool: db.pool, data, decisions });
    await published(service, "decide-row", { triage: TRIAGE_SET });
    const rowId = await firstTicket();
    const result = await service.runtimeDecide(C, VIEWER, "decide-row", "triage", { rowId });
    expect(result.answers.urgent!.value).toBe(true);
    expect(calls).toEqual([[C, VIEWER, "apps", { state: { subject: "Card charged twice", body: "Please refund" }, questions: { urgent: URGENT } }, { via: "decide-row@1", advisory: false }]]);
  });

  it("decides on unsaved values, checking each against its field kind", async () => {
    const { decisions, calls } = stubDecisions();
    const service = new AppService({ pool: db.pool, data, decisions });
    await published(service, "decide-values", { triage: { table: "tickets", fields: ["subject", "priority"], advisory: true, questions: { urgent: URGENT } } });
    await service.runtimeDecide(C, VIEWER, "decide-values", "triage", { values: { subject: 42, priority: "3" } });
    expect(calls[0]![3]).toEqual({ state: { subject: "42", priority: 3 }, questions: { urgent: URGENT } });
    expect(calls[0]![4]).toEqual({ via: "decide-values@1", advisory: true });
    await expect(service.runtimeDecide(C, VIEWER, "decide-values", "triage", { values: { priority: "high" } })).rejects.toThrow("expects");
    await expect(service.runtimeDecide(C, VIEWER, "decide-values", "triage", { values: { body: "x" } })).rejects.toThrow('does not send field(s) body');
    expect(calls).toHaveLength(1);
  });

  it("checks the gates in order and asks nothing until all of them pass", async () => {
    const { decisions, calls } = stubDecisions();
    const service = new AppService({ pool: db.pool, data, decisions });
    await service.create(C, OWNER, manifest("decide-draft", { triage: TRIAGE_SET }), SOURCE);
    await expect(service.runtimeDecide(C, VIEWER, "decide-draft", "triage", { values: {} })).rejects.toMatchObject({ code: "not_found" });
    await published(service, "decide-gates", { triage: TRIAGE_SET });
    await expect(service.runtimeDecide(C, VIEWER, "decide-gates", "other", { values: {} })).rejects.toMatchObject({ code: "forbidden" });
    await expect(service.runtimeDecide(C, VIEWER, "decide-gates", "constructor", { values: {} })).rejects.toMatchObject({ code: "forbidden" });
    await expect(service.runtimeDecide(C, STRANGER, "decide-gates", "triage", { values: {} })).rejects.toMatchObject({ code: "forbidden" });
    await expect(service.runtimeDecide(C, VIEWER, "decide-gates", "triage", { rowId: randomUUID() })).rejects.toMatchObject({ code: "not_found" });
    expect(calls).toHaveLength(0);
  });

  it("passes on the decision service's own refusal, and says disabled without one", async () => {
    const off = new AppService({ pool: db.pool, data, decisions: stubDecisions({ fail: new DataError("disabled", "typed decisions for apps are switched off") }).decisions });
    await published(off, "decide-off", { triage: TRIAGE_SET });
    await expect(off.runtimeDecide(C, VIEWER, "decide-off", "triage", { values: { subject: "x" } })).rejects.toMatchObject({ code: "disabled" });
    await expect(apps.runtimeDecide(C, VIEWER, "decide-off", "triage", { values: { subject: "x" } })).rejects.toMatchObject({ code: "disabled" });
  });
});

describe("publishing decision sets", () => {
  it("needs a person and a confirmation for new or changed sets, and nothing more for anything else", async () => {
    await apps.create(C, OWNER, manifest("pub-rules", { triage: TRIAGE_SET }), SOURCE);
    await expect(apps.publish(C, AGENT, "pub-rules")).rejects.toThrow("decision sets need a person to publish");
    await expect(apps.publish(C, OWNER, "pub-rules")).rejects.toThrow("decisionsConfirmed");
    expect((await apps.publish(C, OWNER, "pub-rules", undefined, { decisionsConfirmed: true })).currentVersion).toBe(1);
    const audit = await db.pool.query("SELECT details FROM kyoube_meta.audit WHERE company_id = $1 AND operation = 'app_publish' AND details->>'app' = 'pub-rules'", [C]);
    expect(audit.rows[0]!.details).toMatchObject({ version: 1, decisionSets: ["triage"], decisionsConfirmed: true });
    // Same sets, new source: an agent may publish it, no confirmation needed.
    await apps.update(C, AGENT, "pub-rules", manifest("pub-rules", { triage: TRIAGE_SET }), SOURCE.replace("<body>", "<body><!--v2-->"));
    expect((await apps.publish(C, AGENT, "pub-rules")).currentVersion).toBe(2);
    // Removing every set only narrows what is sent.
    await apps.update(C, AGENT, "pub-rules", manifest("pub-rules"), SOURCE);
    expect((await apps.publish(C, AGENT, "pub-rules")).currentVersion).toBe(3);
    // Rolling back to a version with sets is a change again.
    await expect(apps.rollback(C, AGENT, "pub-rules", 2)).rejects.toMatchObject({ code: "forbidden" });
    expect((await apps.rollback(C, OWNER, "pub-rules", 2, { decisionsConfirmed: true })).currentVersion).toBe(2);
  });

  it("previews what a version would send", async () => {
    const service = new AppService({ pool: db.pool, data, decisions: stubDecisions().decisions });
    await service.create(C, OWNER, manifest("pub-preview", { triage: { ...TRIAGE_SET, advisory: true } }), SOURCE);
    expect(await service.publishPreview(C, OWNER, "pub-preview")).toEqual({
      version: 1, changed: true, provider: "openrouter", available: true, connections: { changed: false, list: [] }, tasks: { changed: false, list: [] },
      sets: [{ key: "triage", table: "tickets", fields: ["subject", "body"], advisory: true, questions: [{ key: "urgent", type: "check", text: URGENT.statement }] }],
    });
    await expect(service.publishPreview(C, VIEWER, "pub-preview")).rejects.toMatchObject({ code: "forbidden" });
  });
});

describe("decideOutcome", () => {
  let clock = Date.now();
  const logged = async (overrides: Record<string, unknown> = {}) => {
    const decisionId = randomUUID();
    await recordDecisions(db.pool, [{
      decisionId, questionKey: "urgent", companyId: C, surface: "apps", actorKind: "user", actorId: "viewer-1", runId: null,
      via: "outcomes@1", fingerprint: "f".repeat(64), questionType: "check", answer: "true", confidence: 0.8,
      reviewThreshold: 0.9, status: "review", model: "jev-1.13.0", latencyMs: 300, ...overrides,
    } as never]);
    return decisionId;
  };
  // Both tests below report outcomes for this app, so neither depends on the other having run.
  beforeAll(async () => { await published(apps, "outcomes", { triage: TRIAGE_SET }); });

  it("records what the viewer chose, once, for this app's own recent decisions", async () => {
    const service = new AppService({ pool: db.pool, data, decisions: stubDecisions().decisions, now: () => clock });
    const kept = await logged();
    expect(await service.decideOutcome(C, VIEWER, "outcomes", kept, "urgent", true)).toEqual({ outcome: "human_confirmed" });
    await expect(service.decideOutcome(C, VIEWER, "outcomes", kept, "urgent", true)).rejects.toMatchObject({ code: "conflict" });
    const changed = await logged();
    expect(await service.decideOutcome(C, VIEWER, "outcomes", changed, "urgent", false)).toEqual({ outcome: "human_changed" });
    const row = await db.pool.query("SELECT outcome_via, outcome_by FROM kyoube_meta.decisions WHERE decision_id = $1", [changed]);
    expect(row.rows[0]).toEqual({ outcome_via: "app", outcome_by: "viewer-1" });
  });

  /**
   * The database pool, except that each read of a logged decision waits until `parties` reads have
   * happened: simultaneous reports then all see "no outcome yet" before any of them writes, every
   * time, so only the write itself can settle which one counts.
   */
  function readBarrier(parties: number): typeof db.pool {
    let waiting: Array<() => void> = [];
    return new Proxy(db.pool, {
      get(target, prop) {
        if (prop !== "query") {
          const value = Reflect.get(target, prop);
          return typeof value === "function" ? value.bind(target) : value;
        }
        return async (...args: unknown[]) => {
          const result = await Reflect.apply(target.query, target, args);
          if (typeof args[0] === "string" && /^\s*SELECT[\s\S]*FROM kyoube_meta\.decisions WHERE/.test(args[0])) {
            await new Promise<void>((release) => {
              waiting.push(release);
              if (waiting.length === parties) { waiting.forEach((go) => go()); waiting = []; }
            });
          }
          return result;
        };
      },
    });
  }

  it("records one outcome when two reports for the same decision arrive at once", async () => {
    const service = new AppService({ pool: readBarrier(2), data, decisions: stubDecisions().decisions, now: () => clock });
    const id = await logged();
    const settled = await Promise.allSettled([
      service.decideOutcome(C, VIEWER, "outcomes", id, "urgent", true),
      service.decideOutcome(C, VIEWER, "outcomes", id, "urgent", false),
    ]);
    const kept = settled.filter((result) => result.status === "fulfilled");
    const refused = settled.filter((result): result is PromiseRejectedResult => result.status === "rejected");
    expect(kept).toHaveLength(1);
    expect(refused).toHaveLength(1);
    expect(refused[0]!.reason).toMatchObject({ code: "conflict" });
    const row = await db.pool.query("SELECT outcome FROM kyoube_meta.decisions WHERE decision_id = $1", [id]);
    expect(row.rows[0]!.outcome).toBe((kept[0] as PromiseFulfilledResult<{ outcome: string }>).value.outcome);
  });

  it("refuses another viewer's, another app's, a stale or a non-app decision alike", async () => {
    const service = new AppService({ pool: db.pool, data, decisions: stubDecisions().decisions, now: () => clock });
    for (const overrides of [{ actorId: "owner-1" }, { via: "other-app@1" }, { surface: "agents", actorKind: "agent" }]) {
      const id = await logged(overrides);
      await expect(service.decideOutcome(C, VIEWER, "outcomes", id, "urgent", true)).rejects.toMatchObject({ code: "not_found" });
    }
    const stale = await logged();
    // Past the window as the database dated the row, not as this file's clock started: the row was
    // written after `clock` was first read, so adding the window to `clock` would still land inside it.
    const written = await db.pool.query<{ created_at: Date }>("SELECT created_at FROM kyoube_meta.decisions WHERE decision_id = $1", [stale]);
    clock = written.rows[0]!.created_at.getTime() + OUTCOME_WINDOW_MS + 1;
    await expect(service.decideOutcome(C, VIEWER, "outcomes", stale, "urgent", true)).rejects.toMatchObject({ code: "not_found" });
    await expect(service.decideOutcome(C, VIEWER, "outcomes", "not-a-uuid", "urgent", true)).rejects.toMatchObject({ code: "invalid" });
    await expect(service.decideOutcome(C, VIEWER, "outcomes", stale, "urgent", 1)).rejects.toMatchObject({ code: "invalid" });
  });
});
