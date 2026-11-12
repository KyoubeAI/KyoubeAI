import type { PluginApiRequestInput } from "@paperclipai/plugin-sdk";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { AppService } from "../../src/apps/service.js";
import { DataService } from "../../src/data/service.js";
import { resetCompanyCache } from "../../src/db/company-scope.js";
import { migrationsDirFrom, runMetaMigrations } from "../../src/db/migrate.js";
import { handleMcpApiRequest } from "../../src/mcp/api-routes.js";
import { createTestDatabase } from "./setup.js";

const C = "77777777-7777-4777-8777-777777777777";
const OWNER = { kind: "user" as const, id: "owner-1" };
let db: Awaited<ReturnType<typeof createTestDatabase>>;
let service: DataService;

beforeAll(async () => {
  db = await createTestDatabase();
  resetCompanyCache();
  await runMetaMigrations(db.pool, migrationsDirFrom(import.meta.url.replace("tests/integration/mcp-call.spec.ts", "src/db/migrate.ts")));
  const roles: Record<string, string> = { "owner-1": "owner", "member-1": "member", "viewer-1": "viewer" };
  service = new DataService({ pool: db.pool, resolveUserRole: async (_companyId, userId) => roles[userId] ?? null });
  await service.createTable(C, OWNER, { name: "deals", fields: [{ name: "name", kind: "text", required: true }] });
});
afterAll(async () => { await db.close(); });

function call(userId: string, tool: string, args: Record<string, unknown>) {
  const input = {
    routeKey: "mcp.call", method: "POST", path: "/mcp/call", params: {}, query: {},
    body: { companyId: C, tool, arguments: args },
    actor: { actorType: "user", actorId: userId, userId }, companyId: C, headers: {},
  } as PluginApiRequestInput;
  return handleMcpApiRequest({ data: service, apps: {} as AppService }, input);
}

describe("MCP calls against the real data service", () => {
  it("lets a member insert and query rows as themselves", async () => {
    const inserted = await call("member-1", "kyoubeai_data_insert", { table: "deals", rows: [{ name: "Acme" }], requestId: "req-1" });
    expect(inserted!.status).toBe(200);
    expect(inserted!.body).toMatchObject({ outcome: "completed", data: [{ name: "Acme", created_by_kind: "user", created_by_id: "member-1" }] });
    const queried = await call("member-1", "kyoubeai_data_query", { table: "deals" });
    expect(queried!.body).toMatchObject({ outcome: "completed", data: { rows: [{ name: "Acme" }] } });
  });

  it("rejects a member dropping a table, with the member's own level deciding", async () => {
    const dropped = await call("member-1", "kyoubeai_data_drop_table", { table: "deals", requestId: "req-2" });
    expect(dropped!.status).toBe(200);
    expect(dropped!.body).toMatchObject({ outcome: "rejected", status: 403, code: "forbidden" });
    expect((await service.query(C, OWNER, "deals", {})).rows).toHaveLength(1);
  });

  it("rejects a viewer inserting rows", async () => {
    const inserted = await call("viewer-1", "kyoubeai_data_insert", { table: "deals", rows: [{ name: "Nope" }], requestId: "req-3" });
    expect(inserted!.status).toBe(200);
    expect(inserted!.body).toMatchObject({ outcome: "rejected", status: 403, code: "forbidden" });
    expect((await service.query(C, OWNER, "deals", {})).rows).toHaveLength(1);
  });
});
