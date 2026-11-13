import { mkdtemp, mkdir, readFile, rm, stat, symlink, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { WorkspaceFiles } from "../src/fs-service.js";

let base: string;
let root: string;
let outside: string;
let files: WorkspaceFiles;

beforeEach(async () => {
  base = await mkdtemp(path.join(tmpdir(), "kyoube-files-"));
  root = path.join(base, "project", "_default");
  outside = path.join(base, "outside");
  await mkdir(root, { recursive: true });
  await mkdir(outside, { recursive: true });
  await writeFile(path.join(outside, "secret.txt"), "top secret");
  files = new WorkspaceFiles(root, { maxReadBytes: 1024 * 1024, maxWriteBytes: 64 * 1024 });
});

afterEach(async () => {
  await rm(base, { recursive: true, force: true });
});

describe("WorkspaceFiles listing and reading", () => {
  it("lists folders first, then files, case-insensitively, with kinds and sizes", async () => {
    await writeFile(path.join(root, "b.txt"), "bb");
    await writeFile(path.join(root, "A.txt"), "a");
    await mkdir(path.join(root, "src"));
    await symlink(path.join(outside, "secret.txt"), path.join(root, "link"));
    const listing = await files.list("");
    expect(listing.exists).toBe(true);
    expect(listing.entries.map((entry) => [entry.name, entry.kind, entry.size])).toEqual([
      ["src", "dir", 0],
      ["A.txt", "file", 1],
      ["b.txt", "file", 2],
      ["link", "symlink", 0],
    ]);
    expect(listing.entries.map((entry) => entry.path)).toEqual(["src", "A.txt", "b.txt", "link"]);
  });

  it("reports a folder that does not exist yet instead of failing", async () => {
    const missing = new WorkspaceFiles(path.join(base, "never"), { maxReadBytes: 1024, maxWriteBytes: 1024 });
    expect(await missing.list("")).toEqual({ path: "", exists: false, entries: [], cut: false });
    await expect(missing.read("a.txt")).rejects.toThrow("not_found");
  });

  it("reads text as utf8, flags binary, and refuses to truncate a large file", async () => {
    await writeFile(path.join(root, "notes.md"), "# hi\n");
    await writeFile(path.join(root, "img.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 1, 2]));
    const text = await files.read("notes.md");
    expect(text).toMatchObject({ name: "notes.md", encoding: "utf8", content: "# hi\n", binary: false, tooLarge: false, size: 5 });
    const binary = await files.read("img.png");
    expect(binary).toMatchObject({ encoding: "none", content: null, binary: true });
    const raw = await files.read("img.png", { encoding: "base64" });
    expect(raw).toMatchObject({ encoding: "base64", content: Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 1, 2]).toString("base64") });
    const large = await files.read("notes.md", { maxBytes: 2 });
    expect(large).toMatchObject({ encoding: "none", content: null, tooLarge: true, size: 5 });
  });

  it("refuses to read a folder, a symlink, or the root", async () => {
    await mkdir(path.join(root, "dir"));
    await symlink(path.join(outside, "secret.txt"), path.join(root, "link"));
    await expect(files.read("dir")).rejects.toThrow("invalid");
    await expect(files.read("link")).rejects.toThrow("symbolic link");
    await expect(files.read("")).rejects.toThrow("invalid");
    await expect(files.read("nope")).rejects.toThrow("not_found");
  });

  it("never follows a symlinked folder out of the root", async () => {
    await symlink(outside, path.join(root, "escape"));
    await expect(files.list("escape")).rejects.toThrow("symbolic link");
    await expect(files.read("escape/secret.txt")).rejects.toThrow("outside the project folder");
    await expect(files.write("escape/new.txt", "x")).rejects.toThrow("outside the project folder");
    await expect(files.mkdir("escape/dir")).rejects.toThrow("outside the project folder");
    expect(await readFile(path.join(outside, "secret.txt"), "utf8")).toBe("top secret");
  });

  it("refuses paths that try to leave the root before touching the disk", async () => {
    await expect(files.list("../outside")).rejects.toThrow("invalid");
    await expect(files.read("/etc/passwd")).rejects.toThrow("invalid");
    await expect(files.write("../outside/x.txt", "x")).rejects.toThrow("invalid");
  });
});

describe("WorkspaceFiles writing", () => {
  it("creates, saves, and enforces the size limit", async () => {
    const created = await files.write("a/../new.txt", "hello");
    expect(created).toMatchObject({ path: "new.txt", kind: "file", size: 5 });
    expect(await readFile(path.join(root, "new.txt"), "utf8")).toBe("hello");
    await expect(files.write("big.txt", "x".repeat(64 * 1024 + 1))).rejects.toThrow("limit");
    await expect(files.write("", "x")).rejects.toThrow("invalid");
  });

  it("creates the project folder itself on the first write", async () => {
    const fresh = new WorkspaceFiles(path.join(base, "later", "_default"), { maxReadBytes: 1024, maxWriteBytes: 1024 });
    await fresh.mkdir("docs");
    expect((await fresh.list("")).entries.map((entry) => entry.name)).toEqual(["docs"]);
  });

  it("detects a concurrent change through the base mtime", async () => {
    await files.write("shared.txt", "v1");
    const seen = await files.read("shared.txt");
    // An agent writes to the same file; force a visibly different mtime.
    await writeFile(path.join(root, "shared.txt"), "agent");
    const { utimes } = await import("node:fs/promises");
    await utimes(path.join(root, "shared.txt"), new Date(seen.mtimeMs + 5_000), new Date(seen.mtimeMs + 5_000));
    await expect(files.write("shared.txt", "mine", { baseMtimeMs: seen.mtimeMs })).rejects.toThrow("conflict");
    expect(await readFile(path.join(root, "shared.txt"), "utf8")).toBe("agent");
    // Without a base mtime (an explicit overwrite) the save goes through.
    await files.write("shared.txt", "mine");
    expect(await readFile(path.join(root, "shared.txt"), "utf8")).toBe("mine");
  });

  it("honours mustCreate and mustExist", async () => {
    await files.write("x.txt", "1");
    await expect(files.write("x.txt", "2", { mustCreate: true })).rejects.toThrow("exists");
    await expect(files.write("y.txt", "2", { mustExist: true })).rejects.toThrow("not_found");
  });

  it("does not write through a symlink or onto a folder", async () => {
    await symlink(path.join(outside, "secret.txt"), path.join(root, "link"));
    await mkdir(path.join(root, "dir"));
    await expect(files.write("link", "pwned")).rejects.toThrow("symbolic link");
    await expect(files.write("dir", "x")).rejects.toThrow("invalid");
    expect(await readFile(path.join(outside, "secret.txt"), "utf8")).toBe("top secret");
  });

  it("writes base64 content and rejects malformed base64", async () => {
    await files.write("bin", Buffer.from([1, 2, 3]).toString("base64"), { encoding: "base64" });
    expect([...(await readFile(path.join(root, "bin")))]).toEqual([1, 2, 3]);
    await expect(files.write("bin2", "not base64!", { encoding: "base64" })).rejects.toThrow("invalid");
  });

  it("makes folders, renames, and deletes with the folder guard", async () => {
    await files.mkdir("docs");
    await expect(files.mkdir("docs")).rejects.toThrow("exists");
    await expect(files.mkdir("missing/child")).rejects.toThrow("not_found");
    await files.write("docs/a.txt", "a");
    const renamed = await files.rename("docs/a.txt", "docs/b.txt");
    expect(renamed).toMatchObject({ path: "docs/b.txt", kind: "file" });
    await files.write("c.txt", "c");
    await expect(files.rename("c.txt", "docs/b.txt")).rejects.toThrow("exists");
    await expect(files.rename("docs", "docs/inner")).rejects.toThrow("into itself");
    await expect(files.rename("docs", "docs")).rejects.toThrow("invalid");
    await expect(files.remove("docs")).rejects.toThrow("confirm deleting");
    expect(await files.remove("docs", { recursive: true })).toEqual({ path: "docs", kind: "dir" });
    expect(await files.remove("c.txt")).toEqual({ path: "c.txt", kind: "file" });
    await expect(files.remove("")).rejects.toThrow("invalid");
    expect((await files.list("")).entries).toEqual([]);
  });

  it("deletes a symlink itself, never its target", async () => {
    await symlink(path.join(outside, "secret.txt"), path.join(root, "link"));
    await symlink(outside, path.join(root, "dirlink"));
    expect(await files.remove("link")).toEqual({ path: "link", kind: "symlink" });
    expect(await files.remove("dirlink", { recursive: true })).toEqual({ path: "dirlink", kind: "symlink" });
    expect(await readFile(path.join(outside, "secret.txt"), "utf8")).toBe("top secret");
  });
});

async function codeOf(promise: Promise<unknown>): Promise<{ code: string; message: string }> {
  try {
    await promise;
  } catch (error) {
    return { code: (error as { code: string }).code, message: (error as Error).message };
  }
  throw new Error("expected a rejection");
}

describe("WorkspaceFiles readLines", () => {
  it("pages a file", async () => {
    await writeFile(path.join(root, "a.txt"), "a\nb\nc\n");
    expect(await files.readLines("a.txt", { offset: 2, limit: 1, maxBytes: 1000 })).toMatchObject({
      kind: "text",
      content: "b\n",
      startLine: 2,
      endLine: 2,
      totalLines: 3,
    });
  });

  it("keeps CRLF and a missing final newline", async () => {
    await writeFile(path.join(root, "c.txt"), "x\r\ny");
    const first = await files.readLines("c.txt", { limit: 1, maxBytes: 1000 });
    const second = await files.readLines("c.txt", { offset: 2, maxBytes: 1000 });
    expect(first).toMatchObject({ totalLines: 2, content: "x\r\n" });
    expect(second).toMatchObject({ content: "y", startLine: 2, endLine: 2 });
  });

  it("handles multi-byte text", async () => {
    await writeFile(path.join(root, "m.txt"), "é😀\n漢字\n");
    expect(await files.readLines("m.txt", { offset: 2, maxBytes: 1000 })).toMatchObject({ totalLines: 2, content: "漢字\n" });
  });

  it("handles an empty file and an offset past the end", async () => {
    await writeFile(path.join(root, "e.txt"), "");
    expect(await files.readLines("e.txt", { maxBytes: 1000 })).toMatchObject({ totalLines: 0, content: "", startLine: 1, endLine: 0 });
    await writeFile(path.join(root, "a.txt"), "a\nb\nc\n");
    expect(await files.readLines("a.txt", { offset: 9, maxBytes: 1000 })).toMatchObject({ content: "", startLine: 9, endLine: 8, totalLines: 3 });
  });

  it("refuses bad paging, flags binary and too large", async () => {
    await writeFile(path.join(root, "a.txt"), "a\nb\nc\n");
    expect((await codeOf(files.readLines("a.txt", { offset: 0, maxBytes: 1000 }))).code).toBe("invalid");
    expect((await codeOf(files.readLines("a.txt", { limit: 2001, maxBytes: 1000 }))).code).toBe("invalid");
    await writeFile(path.join(root, "img.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 1, 2]));
    expect(await files.readLines("img.png", { maxBytes: 1000 })).toMatchObject({ kind: "binary" });
    expect(await files.readLines("a.txt", { maxBytes: 3 })).toMatchObject({ kind: "too_large", size: 6 });
  });
});

describe("WorkspaceFiles edit", () => {
  it("replaces one exact passage", async () => {
    await writeFile(path.join(root, "f.txt"), "one\r\ntwo\r\nthree");
    const result = await files.edit("f.txt", { oldText: "two", newText: "2", maxBytes: 1000 });
    expect(result.replacements).toBe(1);
    expect(await readFile(path.join(root, "f.txt"), "utf8")).toBe("one\r\n2\r\nthree");
  });

  it("counts matches", async () => {
    await writeFile(path.join(root, "f.txt"), "a a");
    const failure = await codeOf(files.edit("f.txt", { oldText: "a", newText: "b", maxBytes: 1000 }));
    expect(failure.code).toBe("invalid");
    expect(failure.message).toContain("the passage matches 2 times: add surrounding text or set replaceAll");
    const result = await files.edit("f.txt", { oldText: "a", newText: "b", replaceAll: true, maxBytes: 1000 });
    expect(result.replacements).toBe(2);
    expect(await readFile(path.join(root, "f.txt"), "utf8")).toBe("b b");
  });

  it("refuses what it cannot do exactly", async () => {
    await writeFile(path.join(root, "f.txt"), "hello");
    expect((await codeOf(files.edit("f.txt", { oldText: "", newText: "x", maxBytes: 1000 }))).code).toBe("invalid");
    const missing = await codeOf(files.edit("f.txt", { oldText: "zzz", newText: "x", maxBytes: 1000 }));
    expect(missing.code).toBe("invalid");
    expect(missing.message).toContain("the passage was not found");
    await writeFile(path.join(root, "img.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 1, 2]));
    expect((await codeOf(files.edit("img.png", { oldText: "a", newText: "b", maxBytes: 1000 }))).code).toBe("invalid");
    const seen = (await stat(path.join(root, "f.txt"))).mtimeMs;
    expect((await codeOf(files.edit("f.txt", { oldText: "hello", newText: "x", baseMtimeMs: seen - 1000, maxBytes: 1000 }))).code).toBe("conflict");
    expect((await codeOf(files.edit("f.txt", { oldText: "hello", newText: "x".repeat(50), maxBytes: 20 }))).code).toBe("limit");
    expect(await readFile(path.join(root, "f.txt"), "utf8")).toBe("hello");
  });

  it("refuses a file larger than maxBytes", async () => {
    await writeFile(path.join(root, "big.txt"), "x".repeat(50));
    expect((await codeOf(files.edit("big.txt", { oldText: "x", newText: "y", replaceAll: true, maxBytes: 20 }))).code).toBe("limit");
  });
});

describe("WorkspaceFiles write mtime and parents", () => {
  it("accepts a millisecond-rounded baseMtimeMs", async () => {
    const target = path.join(root, "t.txt");
    await writeFile(target, "v1");
    await utimes(target, new Date(1_700_000_000_123.456), new Date(1_700_000_000_123.456));
    const mtime = (await stat(target)).mtimeMs;
    await files.write("t.txt", "v2", { baseMtimeMs: Math.floor(mtime) });
    await utimes(target, new Date(1_700_000_000_123.456), new Date(1_700_000_000_123.456));
    const again = (await stat(target)).mtimeMs;
    expect((await codeOf(files.write("t.txt", "v3", { baseMtimeMs: Math.floor(again) - 1 }))).code).toBe("conflict");
  });

  it("does not create a missing parent folder", async () => {
    expect((await codeOf(files.write("nope/x.txt", "x"))).code).toBe("not_found");
    await expect(stat(path.join(root, "nope"))).rejects.toThrow();
  });
});

describe("WorkspaceFiles deep listing", () => {
  it("descends to the depth, breadth first, and refuses a bad depth", async () => {
    await mkdir(path.join(root, "a", "b", "c"), { recursive: true });
    await writeFile(path.join(root, "a", "b", "c", "d.txt"), "d");
    const listing = await files.list("", { depth: 3 });
    expect(listing.entries.map((entry) => entry.path)).toEqual(["a", "a/b", "a/b/c"]);
    expect(listing.cut).toBe(false);
    expect((await codeOf(files.list("", { depth: 4 }))).code).toBe("invalid");
    expect((await codeOf(files.list("", { depth: 0 }))).code).toBe("invalid");
  });

  it("lists a symlink and does not follow it", async () => {
    await mkdir(path.join(root, "a"));
    await symlink("..", path.join(root, "a", "loop"));
    const listing = await files.list("", { depth: 3 });
    expect(listing.entries.map((entry) => [entry.path, entry.kind])).toEqual([
      ["a", "dir"],
      ["a/loop", "symlink"],
    ]);
  });

  it("cuts at maxEntries", async () => {
    for (let i = 0; i < 600; i++) await writeFile(path.join(root, `f${i}.txt`), "");
    const listing = await files.list("");
    expect(listing.entries).toHaveLength(500);
    expect(listing.cut).toBe(true);
  });
});
