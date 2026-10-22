import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { compileCompanyPolicy, compileIndex, createPolicyReader, writePolicyFiles, type PolicyReader } from "@kyoube/visibility";
import { projectVisibleFor } from "../src/visibility.js";

const COMPANY = "11111111-1111-4111-8111-111111111111";
const LISTED = "33333333-3333-4333-8333-333333333333";
const UNLISTED = "44444444-4444-4444-8444-444444444444";
const ON_LIST = { userId: "on-list", role: "operator" };
const OFF_LIST = { userId: "off-list", role: "operator" };
const SEES_ALL = { userId: "sees-all", role: "operator" };
const OWNER = { userId: "owner-1", role: "owner" };
const ADMIN = { userId: "admin-1", role: "admin" };
const WRITTEN_AT = "2026-10-23T00:00:00.000Z";

let dir: string;
let reader: PolicyReader;

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "kyoube-files-visibility-"));
  reader = createPolicyReader({ dir, checkMs: 0 });
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

async function writeNeedToKnow() {
  const policy = compileCompanyPolicy({
    companyId: COMPANY,
    mode: "need_to_know",
    writtenAt: WRITTEN_AT,
    groups: [
      { seesAll: false, members: [ON_LIST.userId], projects: [LISTED] },
      { seesAll: true, members: [SEES_ALL.userId], projects: [] },
    ],
  });
  if (!policy) throw new Error("expected a need-to-know policy");
  await writePolicyFiles({ dir, index: compileIndex([{ companyId: COMPANY, mode: "need_to_know" }], WRITTEN_AT), companies: [policy] });
}

describe("projectVisibleFor", () => {
  it("shows every project to anyone in an open company", async () => {
    await writePolicyFiles({ dir, index: compileIndex([{ companyId: COMPANY, mode: "open" }], WRITTEN_AT), companies: [] });
    expect(await projectVisibleFor(reader, COMPANY, OFF_LIST, UNLISTED)).toBe(true);
    expect(await projectVisibleFor(reader, COMPANY, { userId: "viewer-1", role: "viewer" }, LISTED)).toBe(true);
  });

  it("shows a restricted person only the projects their groups list", async () => {
    await writeNeedToKnow();
    expect(await projectVisibleFor(reader, COMPANY, ON_LIST, LISTED)).toBe(true);
    expect(await projectVisibleFor(reader, COMPANY, ON_LIST, UNLISTED)).toBe(false);
    expect(await projectVisibleFor(reader, COMPANY, OFF_LIST, LISTED)).toBe(false);
  });

  it("never restricts an owner or an admin", async () => {
    await writeNeedToKnow();
    expect(await projectVisibleFor(reader, COMPANY, OWNER, UNLISTED)).toBe(true);
    expect(await projectVisibleFor(reader, COMPANY, ADMIN, UNLISTED)).toBe(true);
  });

  it("shows every project to a person in a sees-all group", async () => {
    await writeNeedToKnow();
    expect(await projectVisibleFor(reader, COMPANY, SEES_ALL, UNLISTED)).toBe(true);
  });

  it("treats a person with no company role as restricted", async () => {
    await writeNeedToKnow();
    expect(await projectVisibleFor(reader, COMPANY, { userId: ON_LIST.userId, role: null }, LISTED)).toBe(true);
    expect(await projectVisibleFor(reader, COMPANY, { userId: OFF_LIST.userId, role: null }, LISTED)).toBe(false);
  });

  it("fails closed for a restricted person when the company file is gone, and still serves an admin", async () => {
    await writeNeedToKnow();
    await rm(path.join(dir, `${COMPANY}.json`));
    expect(await projectVisibleFor(reader, COMPANY, ON_LIST, LISTED)).toBe(false);
    expect(await projectVisibleFor(reader, COMPANY, ADMIN, LISTED)).toBe(true);
  });
});
