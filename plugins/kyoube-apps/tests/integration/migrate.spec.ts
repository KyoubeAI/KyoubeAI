import { createHash } from "node:crypto";
import { copyFile, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { migrationsDirFrom, runMetaMigrations } from "../../src/db/migrate.js";
import { createTestDatabase } from "./setup.js";

const migrationsDir = migrationsDirFrom(import.meta.url.replace("tests/integration/migrate.spec.ts", "src/db/migrate.ts"));

let db: Awaited<ReturnType<typeof createTestDatabase>>;
beforeAll(async () => {
  db = await createTestDatabase();
});
afterAll(async () => {
  await db.close();
});

describe("runMetaMigrations", () => {
  it("applies the metadata schema once and is idempotent", async () => {
    const first = await runMetaMigrations(db.pool, migrationsDir);
    expect(first).toEqual(["0001_meta.sql", "0002_apps.sql", "0003_decisions.sql", "0004_decision_cells.sql", "0005_guardrail_holds.sql", "0006_groups.sql", "0007_connection_grants.sql", "0008_app_tasks.sql"]);
    expect(await runMetaMigrations(db.pool, migrationsDir)).toEqual([]);
    const tables = await db.pool.query<{ table_name: string }>(
      `SELECT table_name FROM information_schema.tables WHERE table_schema = 'kyoube_meta' ORDER BY table_name COLLATE "C"`,
    );
    expect(tables.rows.map((row) => row.table_name)).toEqual([
      "agent_grants",
      "app_tasks",
      "app_versions",
      "apps",
      "audit",
      "companies",
      "company_settings",
      "connection_grants",
      "decision_cells",
      "decision_columns",
      "decision_usage",
      "decisions",
      "fields",
      "group_agents",
      "group_apps",
      "group_members",
      "group_sync",
      "groups",
      "guardrail_holds",
      "migrations",
      "tables",
    ]);
  });

  // M9: `status` is an enum in all but name, and AppStore writes it from three
  // call sites; the CHECK keeps a typo (or a status added in code and not here)
  // out of the table, where the "live app" unique index depends on its value.
  it("constrains an app's status to the three it can hold", async () => {
    await runMetaMigrations(db.pool, migrationsDir);
    await db.pool.query("INSERT INTO kyoube_meta.companies (company_id, schema_name, role_name) VALUES ('c-status', 'kyoube_c_status', 'kyoube_c_status') ON CONFLICT DO NOTHING");
    const insert = (status: string) => db.pool.query("INSERT INTO kyoube_meta.apps (company_id, slug, name, status) VALUES ('c-status', $1, 'X', $2)", [`app-${status}`, status]);
    for (const status of ["draft", "published", "archived"]) await insert(status);
    await expect(insert("publised")).rejects.toThrow(/violates check constraint/);
  });

  it("refuses to run when an already-applied migration file has changed", async () => {
    await runMetaMigrations(db.pool, migrationsDir);

    // A directory holding the same migration *name* with different bytes is
    // exactly what editing an already-applied migration looks like on disk.
    // Tampering a copy rather than the recorded checksum leaves the database
    // untouched, so the assertions below observe the guard, not our own cleanup.
    const tamperedDir = await mkdtemp(path.join(tmpdir(), "kyoube-migrations-"));
    try {
      const original = await readFile(path.join(migrationsDir, "0001_meta.sql"), "utf8");
      await writeFile(path.join(tamperedDir, "0001_meta.sql"), `${original}\n-- edited after the fact\n`, "utf8");
      await expect(runMetaMigrations(db.pool, tamperedDir)).rejects.toThrow(/0001_meta\.sql was modified after being applied/);
    } finally {
      await rm(tamperedDir, { recursive: true, force: true });
    }

    // The guard rejects before writing anything, so the recorded checksum still
    // matches the real file and a normal run is still a no-op. This also proves
    // the failed run released its advisory lock and its pooled client: a leaked
    // lock would block this call on a different backend until the test times out.
    expect(await runMetaMigrations(db.pool, migrationsDir)).toEqual([]);
  });

  // Ruling P4-R23: the release upgrades installations that already exist. Every
  // other test here starts from an empty database, which only ever exercises
  // the *fresh install* path — this one starts from the schema a 0.2.x
  // deployment is actually running (0001 applied, 0002 not) and upgrades it.
  it("upgrades a database that has only the first migration applied", async () => {
    const fresh = await createTestDatabase();
    const onlyFirst = await mkdtemp(path.join(tmpdir(), "kyoube-migrations-"));
    const tableNames = async () => (await fresh.pool.query<{ table_name: string }>(
      "SELECT table_name FROM information_schema.tables WHERE table_schema = 'kyoube_meta' ORDER BY table_name",
    )).rows.map((row) => row.table_name);
    try {
      // Byte-for-byte the shipped file, so the checksum it records is the one
      // the full runner will compare against below.
      await copyFile(path.join(migrationsDir, "0001_meta.sql"), path.join(onlyFirst, "0001_meta.sql"));
      expect(await runMetaMigrations(fresh.pool, onlyFirst)).toEqual(["0001_meta.sql"]);
      expect(await tableNames()).not.toContain("apps");

      // The upgrade: exactly the migration that was missing, and no attempt to
      // re-apply the one already recorded.
      expect(await runMetaMigrations(fresh.pool, migrationsDir)).toEqual(["0002_apps.sql", "0003_decisions.sql", "0004_decision_cells.sql", "0005_guardrail_holds.sql", "0006_groups.sql", "0007_connection_grants.sql", "0008_app_tasks.sql"]);
      expect(await tableNames()).toEqual(expect.arrayContaining(["apps", "app_versions"]));

      const recorded = await fresh.pool.query<{ name: string; checksum: string }>("SELECT name, checksum FROM kyoube_meta.migrations ORDER BY name");
      expect(recorded.rows.map((row) => row.name)).toEqual(["0001_meta.sql", "0002_apps.sql", "0003_decisions.sql", "0004_decision_cells.sql", "0005_guardrail_holds.sql", "0006_groups.sql", "0007_connection_grants.sql", "0008_app_tasks.sql"]);
      for (const row of recorded.rows) {
        const sql = await readFile(path.join(migrationsDir, row.name), "utf8");
        expect(row.checksum, row.name).toBe(createHash("sha256").update(sql).digest("hex"));
      }
      // Both checksums being the shipped files' is what makes the *next* run a
      // no-op rather than a "modified after being applied" refusal.
      expect(await runMetaMigrations(fresh.pool, migrationsDir)).toEqual([]);
    } finally {
      await rm(onlyFirst, { recursive: true, force: true });
      await fresh.close();
    }
  });
});
