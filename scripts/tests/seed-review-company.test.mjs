// scripts/tests/seed-review-company.test.mjs
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { COMPANY, SEED, TASK_LIST_LIMIT, appShape, chunk, extras, fileLayout, findOne, inviteDecision, openTasks, parseArgs, taskListFull } from "../demo/seed-review-company.mjs";

test("findOne finds by exact name and refuses duplicates", () => {
  assert.equal(findOne([{ name: "A", id: 1 }, { name: "B", id: 2 }], "B").id, 2);
  assert.equal(findOne([], "B"), null);
  assert.throws(() => findOne([{ name: "B" }, { name: "B" }], "B"), /more than one "B"/);
});

test("extras lists what reviewers added", () =>
  assert.deepEqual(extras(["leads", "scratch", "orders", "tickets"], ["leads", "orders", "tickets"]), ["scratch"]));

test("openTasks keeps only tasks that can still be cancelled", () =>
  assert.deepEqual(openTasks([{ id: "a", status: "working" }, { id: "b", status: "done" }, { id: "c", status: "needs_review" }, { id: "d", status: "cancelled" }]).map((t) => t.id), ["a", "c"]));

test("chunk splits ids for the 500-row limit", () =>
  assert.deepEqual(chunk(Array.from({ length: 1001 }, (_, i) => String(i))).map((c) => c.length), [500, 500, 1]));

test("the seed matches the spec", () => {
  assert.equal(COMPANY, "KyoubeAI Review");
  assert.equal(SEED.agent.budgetMonthlyCents, 500);
  assert.deepEqual(SEED.tables.map((t) => [t.name, t.rows.length]), [["leads", 20], ["orders", 20], ["tickets", 20]]);
  assert.ok(SEED.tables.find((t) => t.name === "tickets").fields.some((f) => f.options?.decision));
  assert.equal(SEED.app.manifest.tasks.summarise.agent, SEED.agent.name);
  assert.equal(SEED.project.files.length, 3);
});

test("parseArgs needs the base URL and the key, and the provider settings with --decisions", () => {
  const env = { KYOUBE_SEED_API_KEY: "pcp_board_x" };
  assert.deepEqual(parseArgs(["--base-url", "http://localhost:3300/"], env), { baseUrl: "http://localhost:3300", key: "pcp_board_x", decisions: false, newInvite: false, decisionsConfig: null });
  assert.equal(parseArgs(["--base-url", "http://h", "--new-invite"], env).newInvite, true);
  assert.throws(() => parseArgs([], env), /--base-url is missing/);
  assert.throws(() => parseArgs(["--base-url", "http://localhost:3300"], {}), /KYOUBE_SEED_API_KEY is not set/);
  assert.throws(() => parseArgs(["--base-url", "http://localhost:3300", "--decisions"], env), /KYOUBE_SEED_DECISIONS_API_KEY, KYOUBE_SEED_DECISIONS_PROVIDER, KYOUBE_SEED_DECISIONS_MODEL/);
  const decisionsEnv = { ...env, KYOUBE_SEED_DECISIONS_API_KEY: "k", KYOUBE_SEED_DECISIONS_PROVIDER: "openrouter", KYOUBE_SEED_DECISIONS_MODEL: "typesafe/jev-1.13" };
  assert.equal(parseArgs(["--base-url", "http://h", "--decisions"], decisionsEnv).decisionsConfig.provider, "openrouter");
});

test("the CLI exits 1 with a message when the key is missing", () => {
  const script = fileURLToPath(new URL("../demo/seed-review-company.mjs", import.meta.url));
  const run = spawnSync(process.execPath, [script, "--base-url", "http://127.0.0.1:9"], { env: { PATH: process.env.PATH }, encoding: "utf8" });
  assert.equal(run.status, 1);
  assert.match(run.stderr, /KYOUBE_SEED_API_KEY is not set/);
});

test("inviteDecision keeps an open operator invite unless a new one is asked for", () => {
  const operator = { id: "op", allowedJoinTypes: "human", humanRole: "operator" };
  const other = [{ id: "admin", allowedJoinTypes: "human", humanRole: "admin" }, { id: "agent", allowedJoinTypes: "agent", humanRole: null }];
  assert.deepEqual(inviteDecision([operator, ...other], false), { keep: [operator], revoke: [], create: false });
  assert.deepEqual(inviteDecision([operator, ...other], true), { keep: [], revoke: [operator], create: true });
  assert.deepEqual(inviteDecision(other, false), { keep: [], revoke: [], create: true });
  assert.deepEqual(inviteDecision([], true), { keep: [], revoke: [], create: true });
});

test("taskListFull flags a page that may hide older tasks", () => {
  assert.equal(TASK_LIST_LIMIT, 50);
  assert.equal(taskListFull(Array.from({ length: 49 }, (_, i) => ({ id: String(i) }))), false);
  assert.equal(taskListFull(Array.from({ length: 50 }, (_, i) => ({ id: String(i) }))), true);
});

test("fileLayout names the top-level entries and the files in each seeded folder", () =>
  assert.deepEqual(fileLayout(SEED.project.files), { top: ["README.md", "data", "notes"], dirs: { notes: ["meeting-2026-11-10.md"], data: ["prices.csv"] } }));

test("appShape ignores what the core adds to a stored manifest", () => {
  const stored = { ...SEED.app.manifest, description: null, icon: null, connections: [], tasks: { summarise: { ...SEED.app.manifest.tasks.summarise, inputs: {} } } };
  assert.equal(appShape(stored, SEED.app.source), appShape(SEED.app.manifest, SEED.app.source));
  assert.notEqual(appShape(SEED.app.manifest, `${SEED.app.source} `), appShape(SEED.app.manifest, SEED.app.source));
});
