import { Buffer } from "node:buffer";
import { promises as fs } from "node:fs";
import path from "node:path";
import { FilesError } from "./errors.js";
import { baseName, isWithin, joinRelative, looksLikeText, normalizeRelativePath, parentOf, validateEntryName } from "./paths.js";

export type EntryKind = "file" | "dir" | "symlink" | "other";

export interface FileEntry {
  name: string;
  /** Canonical path relative to the workspace root. */
  path: string;
  kind: EntryKind;
  size: number;
  mtimeMs: number;
}

export interface Listing {
  path: string;
  /** `false` when the folder does not exist yet (a project no agent has run in). */
  exists: boolean;
  entries: FileEntry[];
}

export interface ReadResult {
  path: string;
  name: string;
  size: number;
  mtimeMs: number;
  /** `utf8` carries `content` as text; `base64` carries the raw bytes; `none` carries no content. */
  encoding: "utf8" | "base64" | "none";
  content: string | null;
  /** The file is not text and was asked for as text. */
  binary: boolean;
  /** The file is larger than the limit the caller passed. */
  tooLarge: boolean;
}

export type LinesResult =
  | { kind: "text"; path: string; size: number; mtimeMs: number; content: string; startLine: number; endLine: number; totalLines: number }
  | { kind: "binary" | "too_large"; path: string; size: number; mtimeMs: number };

export interface ListOptions {
  /** How many folder levels to show, 1 to 3 (default 1). */
  depth?: number;
  /** Most entries returned; more than that sets `cut`. Omitted means no cap (`cut` is always false). */
  maxEntries?: number;
}

export interface EditOptions {
  oldText: string;
  newText: string;
  replaceAll?: boolean;
  /** The mtime the caller last saw; a different one on disk means the file changed since. */
  baseMtimeMs?: number | null;
  /** Upper bound on the file read and on the file written. */
  maxBytes: number;
}

export interface WriteOptions {
  encoding?: "utf8" | "base64";
  /** The mtime the caller last saw; a different one on disk means someone (an agent) changed the file since. */
  baseMtimeMs?: number | null;
  /** Fail if the file already exists. */
  mustCreate?: boolean;
  /** Fail if the file does not exist yet (a save of an open file whose target vanished). */
  mustExist?: boolean;
  /** When the write creates the file, hold its name to the rules for a new name (`validateEntryName`). */
  checkNewName?: boolean;
}

export interface WorkspaceFilesOptions {
  /** Upper bound on `read`; a caller may ask for less, never more. */
  maxReadBytes: number;
  /** Upper bound on `write`. */
  maxWriteBytes: number;
}

/** The errno code of a failed call, never its message: Node's text carries the absolute path. */
function codeOf(error: unknown): string {
  const code = typeof error === "object" && error !== null ? (error as { code?: unknown }).code : undefined;
  return typeof code === "string" ? code : "unknown error";
}

function isErrno(error: unknown, code: string): boolean {
  return typeof error === "object" && error !== null && (error as { code?: unknown }).code === code;
}

/**
 * Every filesystem operation the plugin performs, bound to one workspace root.
 *
 * Two invariants hold for every method:
 *
 * 1. **Nothing outside the root is ever touched.** Paths are normalised by
 *    `normalizeRelativePath` (no absolute paths, no `..`), and then the
 *    *resolved* location is checked against the root's own resolved location,
 *    so a symlink an agent (or a cloned repository) left inside the folder
 *    cannot lead a read or a write out of it. The root is resolved once per
 *    call, not cached, because it may be created between calls.
 * 2. **Symlinks are never followed.** They are listed as `symlink`, can be
 *    renamed or deleted (which acts on the link itself), and are refused for
 *    read and write. Following one would let a link to, say,
 *    `/kyoubeai/.claude/.credentials.json` be read by anyone who can browse
 *    the project.
 */
export class WorkspaceFiles {
  constructor(readonly root: string, private readonly opts: WorkspaceFilesOptions) {
    if (!path.isAbsolute(root)) throw new FilesError("invalid", "workspace root must be an absolute path");
  }

  async list(relative: unknown, options: ListOptions = {}): Promise<Listing & { cut: boolean }> {
    const rel = normalizeRelativePath(relative);
    const depth = options.depth ?? 1;
    const maxEntries = options.maxEntries ?? Number.POSITIVE_INFINITY;
    if (!Number.isInteger(depth) || depth < 1 || depth > 3) throw new FilesError("invalid", "depth must be 1, 2 or 3");
    if (options.maxEntries !== undefined && (!Number.isInteger(maxEntries) || maxEntries < 1)) throw new FilesError("invalid", "maxEntries must be a positive whole number");
    const abs = await this.resolveExisting(rel, { allowMissingRoot: true });
    if (abs === null) return { path: rel, exists: false, entries: [], cut: false };
    if (rel !== "" && (await fs.lstat(abs)).isSymbolicLink()) throw new FilesError("invalid", `${rel} is a symbolic link; links are not followed`);
    const entries: FileEntry[] = [];
    let cut = false;
    // Breadth first: every folder of one level is listed before any of the next.
    let level: { abs: string; rel: string }[] = [{ abs, rel }];
    for (let current = 1; current <= depth && level.length > 0 && !cut; current++) {
      const next: { abs: string; rel: string }[] = [];
      for (const folder of level) {
        const children = await this.readFolder(folder.abs, folder.rel);
        for (const child of children) {
          if (entries.length >= maxEntries) {
            cut = true;
            break;
          }
          entries.push(child);
          if (child.kind === "dir") next.push({ abs: path.join(folder.abs, child.name), rel: child.path });
        }
        if (cut) break;
      }
      level = next;
    }
    return { path: rel, exists: true, entries, cut };
  }

  /** The sorted entries of one folder: folders first, then names case-insensitively. */
  private async readFolder(abs: string, rel: string): Promise<FileEntry[]> {
    let dirents;
    try {
      dirents = await fs.readdir(abs, { withFileTypes: true });
    } catch (error) {
      if (isErrno(error, "ENOENT")) throw new FilesError("not_found", `no folder ${rel || "/"}`);
      if (isErrno(error, "ENOTDIR")) throw new FilesError("invalid", `${rel} is not a folder`);
      throw error;
    }
    const entries: FileEntry[] = [];
    for (const dirent of dirents) {
      const entryPath = joinRelative(rel, dirent.name);
      let stat;
      try {
        stat = await fs.lstat(path.join(abs, dirent.name));
      } catch {
        continue; // vanished between readdir and lstat: an agent is at work
      }
      entries.push({
        name: dirent.name,
        path: entryPath,
        kind: stat.isSymbolicLink() ? "symlink" : stat.isDirectory() ? "dir" : stat.isFile() ? "file" : "other",
        size: stat.isFile() ? stat.size : 0,
        mtimeMs: stat.mtimeMs,
      });
    }
    entries.sort((a, b) => {
      const aDir = a.kind === "dir" ? 0 : 1;
      const bDir = b.kind === "dir" ? 0 : 1;
      return aDir - bDir || a.name.localeCompare(b.name, undefined, { sensitivity: "base" }) || a.name.localeCompare(b.name);
    });
    return entries;
  }

  async stat(relative: unknown): Promise<FileEntry> {
    const rel = normalizeRelativePath(relative);
    const abs = await this.resolveExisting(rel);
    const stat = await fs.lstat(abs);
    return {
      name: baseName(rel),
      path: rel,
      kind: stat.isSymbolicLink() ? "symlink" : stat.isDirectory() ? "dir" : stat.isFile() ? "file" : "other",
      size: stat.isFile() ? stat.size : 0,
      mtimeMs: stat.mtimeMs,
    };
  }

  /**
   * Reads a file. As `utf8`, a binary file comes back with `binary: true` and
   * no content; as `base64`, the bytes come back whatever they are. A file
   * larger than `maxBytes` (capped by the service's own limit) comes back with
   * `tooLarge: true` and no content, never truncated: a truncated file that
   * was then saved would be a destroyed file.
   */
  async read(relative: unknown, options: { encoding?: "utf8" | "base64"; maxBytes?: number } = {}): Promise<ReadResult> {
    const rel = normalizeRelativePath(relative);
    if (rel === "") throw new FilesError("invalid", "the project folder itself is not a file");
    const encoding = options.encoding ?? "utf8";
    const maxBytes = Math.min(this.opts.maxReadBytes, options.maxBytes ?? this.opts.maxReadBytes);
    const abs = await this.resolveExisting(rel);
    const stat = await fs.lstat(abs);
    if (stat.isSymbolicLink()) throw new FilesError("invalid", `${rel} is a symbolic link; links are not followed`);
    if (stat.isDirectory()) throw new FilesError("invalid", `${rel} is a folder`);
    if (!stat.isFile()) throw new FilesError("invalid", `${rel} is not a regular file`);
    const base = { path: rel, name: baseName(rel), size: stat.size, mtimeMs: stat.mtimeMs };
    if (stat.size > maxBytes) return { ...base, encoding: "none", content: null, binary: false, tooLarge: true };
    const bytes = await fs.readFile(abs);
    if (encoding === "base64") return { ...base, encoding: "base64", content: bytes.toString("base64"), binary: false, tooLarge: false };
    if (!looksLikeText(bytes)) return { ...base, encoding: "none", content: null, binary: true, tooLarge: false };
    return { ...base, encoding: "utf8", content: bytes.toString("utf8"), binary: false, tooLarge: false };
  }

  /**
   * Reads a window of lines from a text file. Lines split on `\n` (a final
   * `\n` does not start another); `content` is the exact text of the window,
   * line endings included, so what is read can be edited exactly.
   */
  async readLines(relative: unknown, options: { offset?: number; limit?: number; maxBytes: number }): Promise<LinesResult> {
    const rel = normalizeRelativePath(relative);
    if (rel === "") throw new FilesError("invalid", "the project folder itself is not a file");
    const offset = options.offset ?? 1;
    const limit = options.limit ?? 2000;
    if (!Number.isInteger(offset) || offset < 1) throw new FilesError("invalid", "offset must be a whole number of 1 or more");
    if (!Number.isInteger(limit) || limit < 1 || limit > 2000) throw new FilesError("invalid", "limit must be a whole number from 1 to 2000");
    const maxBytes = Math.min(this.opts.maxReadBytes, options.maxBytes);
    const { abs, stat } = await this.existingFile(rel);
    const base = { path: rel, size: stat.size, mtimeMs: stat.mtimeMs };
    if (stat.size > maxBytes) return { kind: "too_large", ...base };
    const bytes = await fs.readFile(abs);
    if (!looksLikeText(bytes)) return { kind: "binary", ...base };
    const text = bytes.toString("utf8");
    const starts: number[] = [];
    if (text.length > 0) starts.push(0);
    for (let at = text.indexOf("\n"); at !== -1 && at + 1 < text.length; at = text.indexOf("\n", at + 1)) starts.push(at + 1);
    const totalLines = starts.length;
    if (offset > totalLines) return { kind: "text", ...base, content: "", startLine: offset, endLine: offset - 1, totalLines };
    const endLine = Math.min(totalLines, offset + limit - 1);
    const from = starts[offset - 1] as number;
    const to = endLine < totalLines ? (starts[endLine] as number) : text.length;
    return { kind: "text", ...base, content: text.slice(from, to), startLine: offset, endLine, totalLines };
  }

  /**
   * Replaces an exact passage in a text file. The passage must match once
   * unless `replaceAll`; nothing is guessed. The write carries the mtime this
   * call read, so a change in between fails as `conflict`.
   */
  async edit(relative: unknown, options: EditOptions): Promise<FileEntry & { replacements: number }> {
    const rel = normalizeRelativePath(relative);
    if (rel === "") throw new FilesError("invalid", "the project folder itself is not a file");
    if (typeof options.oldText !== "string" || typeof options.newText !== "string") throw new FilesError("invalid", "oldText and newText must be strings");
    if (options.oldText === "") throw new FilesError("invalid", "oldText must not be empty");
    const { abs, stat } = await this.existingFile(rel);
    if (stat.size > options.maxBytes) throw new FilesError("limit", `${rel} is ${stat.size} bytes; the limit is ${options.maxBytes}`);
    if (options.baseMtimeMs !== undefined && options.baseMtimeMs !== null && Math.floor(stat.mtimeMs) !== Math.floor(options.baseMtimeMs)) {
      throw new FilesError("conflict", `${rel} changed on disk since it was read`);
    }
    const bytes = await fs.readFile(abs);
    if (!looksLikeText(bytes)) throw new FilesError("invalid", `${rel} is not a text file`);
    const text = bytes.toString("utf8");
    let count = 0;
    for (let at = text.indexOf(options.oldText); at !== -1; at = text.indexOf(options.oldText, at + options.oldText.length)) count++;
    if (count === 0) throw new FilesError("invalid", "the passage was not found");
    if (count > 1 && !options.replaceAll) {
      throw new FilesError("invalid", `the passage matches ${count} times: add surrounding text or set replaceAll`);
    }
    const next = text.split(options.oldText).join(options.newText);
    const nextBytes = Buffer.byteLength(next, "utf8");
    if (nextBytes > options.maxBytes) throw new FilesError("limit", `the result is ${nextBytes} bytes; the limit is ${options.maxBytes}`);
    const written = await this.write(rel, next, { baseMtimeMs: stat.mtimeMs, mustExist: true });
    return { ...written, replacements: count };
  }

  /** An existing regular file's absolute path and `lstat`; links, folders and the like are refused. */
  private async existingFile(rel: string) {
    const abs = await this.resolveExisting(rel);
    const stat = await fs.lstat(abs);
    if (stat.isSymbolicLink()) throw new FilesError("invalid", `${rel} is a symbolic link; links are not followed`);
    if (stat.isDirectory()) throw new FilesError("invalid", `${rel} is a folder`);
    if (!stat.isFile()) throw new FilesError("invalid", `${rel} is not a regular file`);
    return { abs, stat };
  }

  async write(relative: unknown, content: string, options: WriteOptions = {}): Promise<FileEntry> {
    const rel = normalizeRelativePath(relative);
    if (rel === "") throw new FilesError("invalid", "the project folder itself is not a file");
    if (typeof content !== "string") throw new FilesError("invalid", "content must be a string");
    const bytes = options.encoding === "base64" ? decodeBase64(content) : Buffer.from(content, "utf8");
    if (bytes.byteLength > this.opts.maxWriteBytes) {
      throw new FilesError("limit", `content is ${bytes.byteLength} bytes; the limit is ${this.opts.maxWriteBytes}`);
    }
    const abs = await this.resolveForWrite(rel);
    const existing = await lstatOrNull(abs);
    if (existing) {
      if (options.mustCreate) throw new FilesError("exists", `${rel} already exists`);
      if (existing.isSymbolicLink()) throw new FilesError("invalid", `${rel} is a symbolic link; links are not followed`);
      if (existing.isDirectory()) throw new FilesError("invalid", `${rel} is a folder`);
      if (!existing.isFile()) throw new FilesError("invalid", `${rel} is not a regular file`);
      if (options.baseMtimeMs !== undefined && options.baseMtimeMs !== null && Math.floor(existing.mtimeMs) !== Math.floor(options.baseMtimeMs)) {
        throw new FilesError("conflict", `${rel} changed on disk since it was opened`);
      }
    } else if (options.mustExist) {
      throw new FilesError("not_found", `${rel} no longer exists`);
    } else if (options.checkNewName) {
      validateEntryName(baseName(rel));
    }
    await fs.writeFile(abs, bytes);
    const stat = await fs.lstat(abs);
    return { name: baseName(rel), path: rel, kind: "file", size: stat.size, mtimeMs: stat.mtimeMs };
  }

  /** Creates a folder; `checkNewName` holds its name to the rules for a new name (`validateEntryName`). */
  async mkdir(relative: unknown, options: { checkNewName?: boolean } = {}): Promise<FileEntry> {
    const rel = normalizeRelativePath(relative);
    if (rel === "") throw new FilesError("invalid", "the project folder already exists");
    if (options.checkNewName) validateEntryName(baseName(rel));
    const abs = await this.resolveForWrite(rel);
    if (await lstatOrNull(abs)) throw new FilesError("exists", `${rel} already exists`);
    await fs.mkdir(abs);
    const stat = await fs.lstat(abs);
    return { name: baseName(rel), path: rel, kind: "dir", size: 0, mtimeMs: stat.mtimeMs };
  }

  /** Renames or moves. The target's parent must already exist; nothing is overwritten. */
  async rename(fromRelative: unknown, toRelative: unknown): Promise<FileEntry> {
    const from = normalizeRelativePath(fromRelative);
    const to = normalizeRelativePath(toRelative);
    if (from === "" || to === "") throw new FilesError("invalid", "the project folder itself cannot be moved");
    if (from === to) throw new FilesError("invalid", "the new name is the same as the old one");
    if (isWithin(from, to)) throw new FilesError("invalid", "a folder cannot be moved into itself");
    validateEntryName(baseName(to));
    const fromAbs = await this.resolveExisting(from);
    const toAbs = await this.resolveForWrite(to);
    if (await lstatOrNull(toAbs)) throw new FilesError("exists", `${to} already exists`);
    await fs.rename(fromAbs, toAbs);
    const stat = await fs.lstat(toAbs);
    return {
      name: baseName(to),
      path: to,
      kind: stat.isSymbolicLink() ? "symlink" : stat.isDirectory() ? "dir" : stat.isFile() ? "file" : "other",
      size: stat.isFile() ? stat.size : 0,
      mtimeMs: stat.mtimeMs,
    };
  }

  /** Deletes a file, a symlink (the link, never its target), or — only with `recursive` — a folder and everything in it. */
  async remove(relative: unknown, options: { recursive?: boolean } = {}): Promise<{ path: string; kind: EntryKind }> {
    const rel = normalizeRelativePath(relative);
    if (rel === "") throw new FilesError("invalid", "the project folder itself cannot be deleted");
    const abs = await this.resolveExisting(rel);
    const stat = await fs.lstat(abs);
    if (stat.isSymbolicLink()) {
      await fs.unlink(abs);
      return { path: rel, kind: "symlink" };
    }
    if (stat.isDirectory()) {
      if (!options.recursive) throw new FilesError("invalid", `${rel} is a folder; confirm deleting it and everything in it`);
      await fs.rm(abs, { recursive: true, force: false });
      return { path: rel, kind: "dir" };
    }
    await fs.unlink(abs);
    return { path: rel, kind: stat.isFile() ? "file" : "other" };
  }

  // ---- containment -------------------------------------------------------

  /** The root's resolved location, or `null` when it does not exist yet. */
  private async resolvedRoot(): Promise<string | null> {
    try {
      return await fs.realpath(this.root);
    } catch (error) {
      if (isErrno(error, "ENOENT")) return null;
      throw new FilesError("invalid", `project folder is unreadable (${codeOf(error)})`);
    }
  }

  private assertInside(rootReal: string, real: string, rel: string): void {
    if (real !== rootReal && !real.startsWith(rootReal + path.sep)) {
      throw new FilesError("invalid", `${rel} resolves outside the project folder`);
    }
  }

  /**
   * The absolute path of an existing entry, or `not_found`. The path *to* the
   * entry is resolved (so a symlinked folder along the way that leaves the
   * root is refused), while the entry itself is left as found — `lstat` by
   * every caller — so a symlink *as* the entry stays the caller's decision.
   */
  private async resolveExisting(rel: string, opts: { allowMissingRoot: true }): Promise<string | null>;
  private async resolveExisting(rel: string, opts?: { allowMissingRoot?: false }): Promise<string>;
  private async resolveExisting(rel: string, opts: { allowMissingRoot?: boolean } = {}): Promise<string | null> {
    const rootReal = await this.resolvedRoot();
    if (rootReal === null) {
      if (opts.allowMissingRoot) return null;
      throw new FilesError("not_found", rel ? `no ${rel}: the project folder does not exist yet` : "the project folder does not exist yet");
    }
    if (rel === "") return rootReal;
    const parentRel = parentOf(rel);
    const parentReal = await this.realpathOrNotFound(path.join(rootReal, parentRel), rel);
    this.assertInside(rootReal, parentReal, rel);
    const entryAbs = path.join(parentReal, baseName(rel));
    if (!(await lstatOrNull(entryAbs))) throw new FilesError("not_found", `no ${rel}`);
    return entryAbs;
  }

  /** The absolute path a new entry may be created at: its parent must exist, be a folder, and resolve inside the root. */
  private async resolveForWrite(rel: string): Promise<string> {
    let rootReal = await this.resolvedRoot();
    if (rootReal === null) {
      // First write into a project no agent has run in yet: the core creates
      // this folder lazily on the first run, and so does the plugin.
      await fs.mkdir(this.root, { recursive: true });
      rootReal = await fs.realpath(this.root);
    }
    const parentRel = parentOf(rel);
    const parentAbs = path.join(rootReal, parentRel);
    const parentReal = await this.realpathOrNotFound(parentAbs, parentRel || "/");
    this.assertInside(rootReal, parentReal, parentRel || "/");
    const parentStat = await fs.lstat(parentReal);
    if (!parentStat.isDirectory()) throw new FilesError("invalid", `${parentRel} is not a folder`);
    return path.join(parentReal, baseName(rel));
  }

  private async realpathOrNotFound(abs: string, rel: string): Promise<string> {
    try {
      return await fs.realpath(abs);
    } catch (error) {
      if (isErrno(error, "ENOENT") || isErrno(error, "ENOTDIR")) throw new FilesError("not_found", `no ${rel}`);
      throw error;
    }
  }
}

async function lstatOrNull(abs: string) {
  try {
    return await fs.lstat(abs);
  } catch (error) {
    if (isErrno(error, "ENOENT") || isErrno(error, "ENOTDIR")) return null;
    throw error;
  }
}

function decodeBase64(value: string): Buffer {
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(value) || value.length % 4 !== 0) throw new FilesError("invalid", "content is not valid base64");
  return Buffer.from(value, "base64");
}
