import { mkdir, mkdtemp, readFile, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { PluginApiRequestInput } from "@paperclipai/plugin-sdk";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FilesError } from "../src/errors.js";
import { WorkspaceFiles } from "../src/fs-service.js";
import { FILES_MCP_ROUTES, handleFilesMcpRequest, type FilesMcpDeps } from "../src/mcp/api-routes.js";
import { buildFilesCatalogue, type FilesMcpContext } from "../src/mcp/catalogue.js";
import { DEFAULT_SETTINGS } from "../src/settings.js";

const PROJECT = "3f1d9a64-7f43-4b9c-a3a4-0d2f2c5a1e11";
const COMPANY = "company-1";
const REQUEST = "0b9a7d1e-2c3f-4d5e-8f60-123456789abc";
const PERSON = { companyId: COMPANY, userId: "u1" };

let dir: string;
let context: FilesMcpContext;
let audit: ReturnType<typeof vi.fn<FilesMcpContext["audit"]>>;
let deps: FilesMcpDeps;
let contextFor: ReturnType<typeof vi.fn<FilesMcpDeps["contextFor"]>>;
let log: ReturnType<typeof vi.fn<(message: string, meta?: Record<string, unknown>) => void>>;

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "files-mcp-"));
  audit = vi.fn<FilesMcpContext["audit"]>(async () => undefined);
  context = {
    files: new WorkspaceFiles(dir, { maxReadBytes: 1024 * 1024, maxWriteBytes: 1024 * 1024 }),
    settings: DEFAULT_SETTINGS,
    projectId: PROJECT,
    folder: { id: "f1", name: "Main" },
    link: "/KYO/projects/p?tab=files",
    audit,
  };
  contextFor = vi.fn<FilesMcpDeps["contextFor"]>(async () => context);
  deps = { version: "9.9.9", contextFor, describeFolders: vi.fn(async () => ({ folders: [{ id: "f1", name: "Main" }] })) };
  log = vi.fn<(message: string, meta?: Record<string, unknown>) => void>();
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

function request(routeKey: string, body: unknown, actor: Partial<PluginApiRequestInput["actor"]> = {}): PluginApiRequestInput {
  return {
    routeKey,
    method: routeKey === "mcp.tools" ? "GET" : "POST",
    path: "/",
    params: {},
    query: {},
    body,
    actor: { actorType: "user", actorId: "u1", userId: "u1", ...actor },
    companyId: COMPANY,
    headers: {},
  };
}

function call(tool: string, args: Record<string, unknown>, write = false) {
  const withIds = { projectId: PROJECT, ...(write ? { requestId: REQUEST } : {}), ...args };
  return handleFilesMcpRequest(deps, request("mcp.call", { companyId: COMPANY, tool, arguments: withIds }), log);
}

describe("kyoube.files MCP routes", () => {
  it("declares the two board routes", () => {
    expect(FILES_MCP_ROUTES.map((route) => [route.routeKey, route.method, route.path, route.auth])).toEqual([
      ["mcp.tools", "GET", "/mcp/tools", "board"],
      ["mcp.call", "POST", "/mcp/call", "board"],
    ]);
  });

  it("ignores routes that are not mcp.*", async () => {
    expect(await handleFilesMcpRequest(deps, request("files.list", {}))).toBeNull();
  });

  it("lists the eight tools", async () => {
    const response = await handleFilesMcpRequest(deps, request("mcp.tools", undefined));
    expect(response?.status).toBe(200);
    expect((response?.body as { tools: unknown[] }).tools).toHaveLength(8);
    expect((response?.body as { version: string }).version).toBe("9.9.9");
  });

  it("refuses an agent and an unauthenticated user", async () => {
    expect((await handleFilesMcpRequest(deps, request("mcp.tools", undefined, { actorType: "agent" })))?.status).toBe(403);
    const response = await handleFilesMcpRequest(deps, request("mcp.tools", undefined, { actorId: "", userId: null }));
    expect(response?.status).toBe(403);
    expect(JSON.stringify(response?.body)).toContain("unauthenticated");
  });

  it("answers 400 for a malformed body and 404 for an unknown tool", async () => {
    expect((await handleFilesMcpRequest(deps, request("mcp.call", { nope: 1 })))?.status).toBe(400);
    expect((await call("kyoubeai_files_nope", {}))?.status).toBe(404);
  });

  it("rejects arguments that fail the schema", async () => {
    const response = await call("kyoubeai_files_read", {});
    expect(response?.body).toMatchObject({ outcome: "rejected", status: 400, code: "invalid" });
    expect((response?.body as { message: string }).message).toContain("path");
  });

  it("reads a window of lines with an ISO modifiedAt", async () => {
    await writeFile(path.join(dir, "a.txt"), "one\ntwo\nthree\n");
    const response = await call("kyoubeai_files_read", { path: "a.txt" });
    expect(response?.status).toBe(200);
    const body = response?.body as { outcome: string; data: Record<string, unknown> };
    expect(body.outcome).toBe("completed");
    expect(body.data).toMatchObject({ content: "one\ntwo\nthree\n", startLine: 1, endLine: 3, totalLines: 3 });
    expect(new Date(body.data.modifiedAt as string).toISOString()).toBe(body.data.modifiedAt);
    expect(body.data).not.toHaveProperty("mtimeMs");
  });

  it("answers a binary file with a link and no content", async () => {
    await writeFile(path.join(dir, "b.bin"), Buffer.from([0, 1, 2, 0, 255]));
    const response = await call("kyoubeai_files_read", { path: "b.bin" });
    const data = (response?.body as { data: Record<string, unknown> }).data;
    expect(data.kind).toBe("binary");
    expect(data.link).toBe("/KYO/projects/p?tab=files");
    expect(data.note).toContain("download");
    expect(data).not.toHaveProperty("content");
  });

  it("truncates a single line too long to fit, with the line numbers ahead of the cut", async () => {
    await writeFile(path.join(dir, "big.txt"), "x".repeat(30_000));
    const response = await call("kyoubeai_files_read", { path: "big.txt" });
    const body = response?.body as { outcome: string; truncated?: boolean; content: string };
    expect(body.outcome).toBe("completed");
    expect(body.truncated).toBe(true);
    expect(body.content.length).toBeLessThanOrEqual(20_000 + 200);
    expect(body.content).toContain("[Result truncated at 20000 characters.");
    expect(body.content).toContain('"totalLines": 1');
    expect(body.content).not.toContain("Page shortened");
  });

  it("answers an over-long first line alone, and says where the next line starts", async () => {
    await writeFile(path.join(dir, "wide.txt"), `${"x".repeat(30_000)}\nsecond\n`);
    const response = await call("kyoubeai_files_read", { path: "wide.txt" });
    const body = response?.body as { truncated?: boolean; content: string };
    expect(body.truncated).toBe(true);
    expect(body.content).toContain('"endLine": 1');
    expect(body.content).toContain("Page shortened to fit: continue with offset 2.");
    expect(body.content).not.toContain("second");
  });

  describe("a read too long for one answer", () => {
    const line = (n: number) => `${String(n).padStart(4, "0")}${"x".repeat(76)}\n`;

    beforeEach(async () => {
      let text = "";
      for (let n = 1; n <= 2000; n++) text += line(n);
      await writeFile(path.join(dir, "long.txt"), text);
    });

    it("is shortened to whole lines, says where to continue, and is not truncated", async () => {
      const response = await call("kyoubeai_files_read", { path: "long.txt" });
      const body = response?.body as { outcome: string; truncated?: boolean; data: { content: string; startLine: number; endLine: number; totalLines: number; note?: string } };
      expect(body.outcome).toBe("completed");
      expect(body.truncated).toBeUndefined();
      const { data } = body;
      expect(data.startLine).toBe(1);
      expect(data.endLine).toBeLessThan(2000);
      expect(data.totalLines).toBe(2000);
      expect(data.note).toBe(`Page shortened to fit: continue with offset ${data.endLine + 1}.`);
      expect(data.content.split("\n").slice(0, -1)).toHaveLength(data.endLine);
      expect(data.content.endsWith(line(data.endLine))).toBe(true);
      expect(Object.keys(data)).toEqual(["kind", "path", "size", "modifiedAt", "startLine", "endLine", "totalLines", "note", "content"]);
      expect(JSON.stringify(data, null, 2).length).toBeLessThanOrEqual(20_000);
    });

    it("continues from the offset the note gives", async () => {
      const first = ((await call("kyoubeai_files_read", { path: "long.txt" }))?.body as { data: { endLine: number } }).data;
      const response = await call("kyoubeai_files_read", { path: "long.txt", offset: first.endLine + 1 });
      const data = (response?.body as { data: { content: string; startLine: number; endLine: number } }).data;
      expect(data.startLine).toBe(first.endLine + 1);
      expect(data.content.startsWith(line(first.endLine + 1))).toBe(true);
    });

    it("leaves a page that fits as it is, with no note", async () => {
      const response = await call("kyoubeai_files_read", { path: "long.txt", offset: 1990 });
      const data = (response?.body as { data: Record<string, unknown> }).data;
      expect(data).toMatchObject({ startLine: 1990, endLine: 2000 });
      expect(data).not.toHaveProperty("note");
    });
  });

  describe("listing a folder too large for one answer", () => {
    type Page = { outcome: string; truncated?: boolean; content?: string; data: { path: string; cut: boolean; nextOffset?: number; note?: string; entries: { path: string }[] } };
    const listPage = async (offset?: number) => (await call("kyoubeai_files_list", offset === undefined ? {} : { offset }))?.body as Page;

    it("pages through 600 files with offset, each once", async () => {
      for (let i = 0; i < 600; i++) await writeFile(path.join(dir, `f${String(i).padStart(3, "0")}.txt`), "");
      const seen: string[] = [];
      let offset: number | undefined;
      for (let pages = 0; pages < 50; pages++) {
        const page = await listPage(offset);
        expect(page.outcome).toBe("completed");
        expect(page.truncated).toBeUndefined();
        expect(JSON.stringify(page.data, null, 2).length).toBeLessThanOrEqual(20_000);
        seen.push(...page.data.entries.map((entry) => entry.path));
        if (!page.data.cut) {
          expect(page.data).not.toHaveProperty("nextOffset");
          break;
        }
        expect(page.data.nextOffset).toBe(seen.length);
        expect(page.data.note).toBe(`More entries than shown: call again with offset ${page.data.nextOffset}, list a subfolder, or use a smaller depth.`);
        offset = page.data.nextOffset;
      }
      expect(seen).toHaveLength(600);
      expect(new Set(seen).size).toBe(600);
    });

    it("keeps pages of long names under the cut, with the paging fields first", async () => {
      for (let i = 0; i < 300; i++) await writeFile(path.join(dir, `${String(i).padStart(3, "0")}-${"n".repeat(56)}`), "");
      const page = await listPage();
      expect(page.outcome).toBe("completed");
      expect(page.truncated).toBeUndefined();
      expect(page.data.cut).toBe(true);
      expect(page.data.nextOffset).toBe(page.data.entries.length);
      expect(page.data.entries.length).toBeGreaterThan(0);
      expect(JSON.stringify(page.data, null, 2).length).toBeLessThanOrEqual(20_000);
      expect(Object.keys(page.data)).toEqual(["path", "exists", "cut", "nextOffset", "note", "entries"]);
    });

    it("asks the folder for one more entry than the page can hold", async () => {
      const list = vi.spyOn(context.files, "list");
      await call("kyoubeai_files_list", { offset: 40, depth: 2 });
      expect(list).toHaveBeenCalledWith("", { depth: 2, maxEntries: 541 });
    });

    it("answers an offset past the end with no entries", async () => {
      await writeFile(path.join(dir, "a.txt"), "");
      const page = await listPage(5);
      expect(page.data).toMatchObject({ cut: false, entries: [] });
    });
  });

  it("lists a subfolder with depth", async () => {
    await mkdir(path.join(dir, "sub"));
    await writeFile(path.join(dir, "sub", "x.txt"), "x");
    const response = await call("kyoubeai_files_list", { depth: 2 });
    const data = (response?.body as { data: { entries: { path: string; modifiedAt: string }[]; cut: boolean } }).data;
    expect(data.entries.map((entry) => entry.path)).toEqual(["sub", "sub/x.txt"]);
    expect(data.entries[0]?.modifiedAt).toMatch(/Z$/);
    expect(data.cut).toBe(false);
    expect(data).not.toHaveProperty("note");
  });

  it("never puts the server path in a refusal when the root cannot be read", async () => {
    // A file where a folder is expected: realpath fails with ENOTDIR, whose Node message holds the path.
    await writeFile(path.join(dir, "plain"), "x");
    context.files = new WorkspaceFiles(path.join(dir, "plain", "sub"), { maxReadBytes: 1024, maxWriteBytes: 1024 });
    const response = await call("kyoubeai_files_list", {});
    const body = response?.body as { outcome: string; message: string };
    expect(body.outcome).toBe("rejected");
    expect(body.message).toContain("ENOTDIR");
    expect(body.message).not.toContain(dir);
  });

  it("runs the folder list outside a folder context", async () => {
    const response = await call("kyoubeai_files_folders", {});
    expect(response?.body).toMatchObject({ outcome: "completed", data: { folders: [{ id: "f1" }] } });
    expect(contextFor).not.toHaveBeenCalled();
    expect(deps.describeFolders).toHaveBeenCalledWith(PERSON, PROJECT);
  });

  it("asks for read access for read tools and write access for write tools", async () => {
    await call("kyoubeai_files_list", { folderId: "f1" });
    expect(contextFor).toHaveBeenLastCalledWith(PERSON, { projectId: PROJECT, folderId: "f1" }, "read");
    await call("kyoubeai_files_create_folder", { path: "d" }, true);
    expect(contextFor).toHaveBeenLastCalledWith(PERSON, { projectId: PROJECT }, "write");
  });

  it("answers a stale expectedModifiedAt as a 409 conflict", async () => {
    await writeFile(path.join(dir, "a.txt"), "one");
    const response = await call("kyoubeai_files_write", { path: "a.txt", content: "two", expectedModifiedAt: "2025-01-01T00:00:00.000Z" }, true);
    expect(response?.status).toBe(200);
    expect(response?.body).toMatchObject({ outcome: "rejected", status: 409, code: "conflict" });
  });

  it("writes when expectedModifiedAt matches, and refuses createOnly over an existing file", async () => {
    await writeFile(path.join(dir, "a.txt"), "one");
    const when = new Date("2026-01-01T00:00:00.500Z");
    await utimes(path.join(dir, "a.txt"), when, when);
    const ok = await call("kyoubeai_files_write", { path: "a.txt", content: "two", expectedModifiedAt: when.toISOString() }, true);
    expect(ok?.body).toMatchObject({ outcome: "completed", data: { path: "a.txt", size: 3 } });
    const exists = await call("kyoubeai_files_write", { path: "a.txt", content: "three", createOnly: true }, true);
    expect(exists?.body).toMatchObject({ outcome: "rejected", status: 409, code: "exists" });
  });

  it("rejects an expectedModifiedAt that is not an ISO date", async () => {
    await writeFile(path.join(dir, "a.txt"), "one");
    for (const expectedModifiedAt of ["yesterday", "2026", "2026-01-01", "Jan 1 2026 00:00:00 GMT"]) {
      const response = await call("kyoubeai_files_write", { path: "a.txt", content: "two", expectedModifiedAt }, true);
      expect(response?.body).toMatchObject({ outcome: "rejected", status: 400, code: "invalid" });
      expect((response?.body as { message: string }).message).toContain("expectedModifiedAt must be an ISO date");
    }
    expect(await readFile(path.join(dir, "a.txt"), "utf8")).toBe("one");
  });

  it("accepts an ISO date with an offset", async () => {
    await writeFile(path.join(dir, "a.txt"), "one");
    const when = new Date("2026-01-01T00:00:00.000Z");
    await utimes(path.join(dir, "a.txt"), when, when);
    const response = await call("kyoubeai_files_write", { path: "a.txt", content: "two", expectedModifiedAt: "2026-01-01T01:00:00+01:00" }, true);
    expect(response?.body).toMatchObject({ outcome: "completed" });
  });

  it("does not recreate a file moved or deleted since it was read", async () => {
    const response = await call("kyoubeai_files_write", { path: "gone.txt", content: "two", expectedModifiedAt: "2026-01-01T00:00:00.000Z" }, true);
    expect(response?.body).toMatchObject({ outcome: "rejected", status: 404, code: "not_found" });
    expect((response?.body as { message: string }).message).toContain("gone.txt no longer exists");
    await expect(readFile(path.join(dir, "gone.txt"), "utf8")).rejects.toThrow("ENOENT");
    expect(audit).not.toHaveBeenCalled();
  });

  it("refuses a new file or folder whose name the Files tab would refuse", async () => {
    for (const [tool, args] of [
      ["kyoubeai_files_write", { path: "notes.txt\n", content: "x" }],
      ["kyoubeai_files_write", { path: " lead.txt", content: "x", createOnly: true }],
      ["kyoubeai_files_create_folder", { path: "drafts\n" }],
    ] as const) {
      const response = await call(tool, args, true);
      expect(response?.body).toMatchObject({ outcome: "rejected", status: 400, code: "invalid" });
      expect((response?.body as { message: string }).message).toContain("name must not start or end with whitespace");
    }
    expect(audit).not.toHaveBeenCalled();
  });

  it("still replaces an existing file whose name the Files tab would refuse", async () => {
    await writeFile(path.join(dir, "odd "), "one");
    const response = await call("kyoubeai_files_write", { path: "odd ", content: "two" }, true);
    expect(response?.body).toMatchObject({ outcome: "completed" });
    expect(await readFile(path.join(dir, "odd "), "utf8")).toBe("two");
  });

  it("audits a move under its normalized path", async () => {
    await writeFile(path.join(dir, "b.txt"), "b");
    const response = await call("kyoubeai_files_move", { path: "./b.txt", newPath: "c.txt" }, true);
    expect(response?.body).toMatchObject({ outcome: "completed", data: { path: "c.txt" } });
    expect(audit).toHaveBeenCalledWith("renamed", "b.txt", { to: "c.txt" });
  });

  it("maps a FilesError from the context to its status and message", async () => {
    contextFor.mockRejectedValueOnce(new FilesError("forbidden", "this project is outside what you can see"));
    const response = await call("kyoubeai_files_list", {});
    expect(response?.status).toBe(200);
    expect(response?.body).toMatchObject({ outcome: "rejected", status: 403, code: "forbidden" });
    expect((response?.body as { message: string }).message).toContain("this project is outside what you can see");
  });

  it("answers 500 and logs for an unexpected error", async () => {
    contextFor.mockRejectedValueOnce(new Error("disk on fire"));
    const response = await call("kyoubeai_files_list", {});
    expect(response?.status).toBe(500);
    expect(JSON.stringify(response?.body)).not.toContain("disk on fire");
    expect(log).toHaveBeenCalledWith("mcp call failed", expect.objectContaining({ tool: "kyoubeai_files_list" }));
  });

  it("never passes requestId or companyId on to the tool", async () => {
    const tool = buildFilesCatalogue().find((candidate) => candidate.entry.name === "kyoubeai_files_create_folder")!;
    const run = vi.spyOn(tool, "run");
    await handleFilesMcpRequest(
      deps,
      request("mcp.call", { companyId: COMPANY, tool: tool.entry.name, arguments: { projectId: PROJECT, requestId: REQUEST, companyId: "other", path: "d" } }),
      log,
    );
    expect(run).toHaveBeenCalledTimes(1);
    expect(run.mock.calls[0]?.[1]).toEqual({ projectId: PROJECT, path: "d" });
    run.mockRestore();
  });

  it("audits each write tool exactly once, with the UI's operation words", async () => {
    await writeFile(path.join(dir, "a.txt"), "hello world");
    const edit = await call("kyoubeai_files_edit", { path: "a.txt", oldText: "world", newText: "there" }, true);
    expect(edit?.body).toMatchObject({ outcome: "completed", data: { path: "a.txt", replacements: 1 } });
    expect(audit).toHaveBeenCalledTimes(1);
    expect(audit).toHaveBeenLastCalledWith("edited", "a.txt", { replacements: 1 });

    audit.mockClear();
    await call("kyoubeai_files_write", { path: "b.txt", content: "b" }, true);
    expect(audit).toHaveBeenCalledTimes(1);
    expect(audit).toHaveBeenLastCalledWith("saved", "b.txt", expect.anything());

    audit.mockClear();
    await call("kyoubeai_files_create_folder", { path: "d" }, true);
    expect(audit).toHaveBeenCalledTimes(1);
    expect(audit).toHaveBeenLastCalledWith("created folder", "d");

    audit.mockClear();
    const moved = await call("kyoubeai_files_move", { path: "b.txt", newPath: "d/b.txt" }, true);
    expect(moved?.body).toMatchObject({ outcome: "completed", data: { path: "d/b.txt" } });
    expect(audit).toHaveBeenCalledTimes(1);
    expect(audit).toHaveBeenLastCalledWith("renamed", "b.txt", { to: "d/b.txt" });

    audit.mockClear();
    await call("kyoubeai_files_delete", { path: "d/b.txt" }, true);
    expect(audit).toHaveBeenCalledTimes(1);
    expect(audit).toHaveBeenLastCalledWith("deleted", "d/b.txt");

    audit.mockClear();
    const folder = await call("kyoubeai_files_delete", { path: "d", recursive: true }, true);
    expect(folder?.body).toMatchObject({ outcome: "completed" });
    expect(audit).toHaveBeenCalledTimes(1);
    expect(audit).toHaveBeenLastCalledWith("deleted folder", "d");
  });
});
