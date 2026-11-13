import { z } from "zod";
import { FilesError } from "../errors.js";
import type { FileEntry, WorkspaceFiles } from "../fs-service.js";
import { normalizeRelativePath } from "../paths.js";
import type { FilesSettings } from "../settings.js";

/**
 * Project files as MCP tools, for a person's assistant connected at
 * `/mcp/kyoubeai`. The core's bridge reads this catalogue through
 * `GET /mcp/tools` and calls a tool through `POST /mcp/call` (api-routes.ts).
 * The tools are the same file operations the Files tab runs, so the same
 * containment and size limits apply.
 */
export type McpTier = "read" | "write";

export interface McpToolEntry {
  name: string;
  title: string;
  description: string;
  inputSchema: Record<string, unknown>;
  tier: McpTier;
  annotations: { readOnlyHint: boolean; destructiveHint: boolean; idempotentHint: boolean; openWorldHint: false };
}

export interface FilesMcpContext {
  files: WorkspaceFiles;
  settings: FilesSettings;
  projectId: string;
  folder: { id: string; name: string };
  /** The Files tab of this project, for a file the assistant cannot be shown. */
  link: string;
  audit(operation: string, target: string, extra?: Record<string, unknown>): Promise<void>;
}

export interface FilesMcpTool {
  entry: McpToolEntry;
  schema: z.ZodObject;
  /** `false` for the folder list, which runs before a folder is chosen. */
  folderScoped: boolean;
  run(ctx: FilesMcpContext, args: any): Promise<unknown>;
}

/** The most entries one `kyoubeai_files_list` returns; the result says when more exist. */
const LIST_MAX_ENTRIES = 500;
/**
 * The characters a list page (pretty-printed, as the route sends it) or a read
 * page's content may take. The route cuts any result at 20,000; staying under
 * this keeps the paging fields and line numbers whole.
 */
const PAGE_BUDGET_CHARS = 18_000;
const NOT_SHOWN = "Not shown here: open the link in KyoubeAI to download it.";

// The core's own contract (public-mcp/contracts.js): its receipts store the id as a uuid.
const requestId = z.uuid().describe("A new UUID for this intended action. Reuse this UUID and identical arguments on retries; never invent a second ID after an uncertain result.");

const projectId = z.uuid().describe("The project's id, from the project list.");
const folderId = z.string().min(1).optional().describe("Which of the project's folders; leave out for the main one. kyoubeai_files_folders lists them.");
const expectedModifiedAt = z.string().optional().describe("The modifiedAt you last saw for this file. The change is refused if the file was changed since.");

function modifiedAt(mtimeMs: number): string {
  return new Date(Math.floor(mtimeMs)).toISOString();
}

function entryOf(entry: FileEntry) {
  return { name: entry.name, path: entry.path, kind: entry.kind, size: entry.size, modifiedAt: modifiedAt(entry.mtimeMs) };
}

// `Date.parse` alone would take "2026" or "Jan 1 2026"; only the ISO form a result carries is accepted.
const ISO_DATE_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/;

function baseMtime(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const parsed = ISO_DATE_TIME.test(value) ? Date.parse(value) : Number.NaN;
  if (Number.isNaN(parsed)) throw new FilesError("invalid", "expectedModifiedAt must be an ISO date");
  return parsed;
}

type ListedEntry = ReturnType<typeof entryOf>;

/**
 * One page of a listing: from `offset`, at most `LIST_MAX_ENTRIES` entries and
 * no more than fit `PAGE_BUDGET_CHARS` pretty-printed. `available` holds the
 * entries from `offset` on, one past a full page when more exist.
 */
function listPage(path: string, exists: boolean, offset: number, available: ListedEntry[], more: boolean) {
  const page = (count: number, cut: boolean) => ({
    path,
    exists,
    cut,
    ...(cut
      ? {
          nextOffset: offset + count,
          note: `More entries than shown: call again with offset ${offset + count}, list a subfolder, or use a smaller depth.`,
        }
      : {}),
    entries: available.slice(0, count),
  });
  const fits = (result: object) => JSON.stringify(result, null, 2).length <= PAGE_BUDGET_CHARS;
  const whole = Math.min(available.length, LIST_MAX_ENTRIES);
  const cut = more || available.length > LIST_MAX_ENTRIES;
  if (!cut && fits(page(whole, false))) return page(whole, false);
  if (fits(page(whole, true))) return page(whole, true);
  // The largest count that fits; at least one entry, so paging always moves on.
  let low = 1;
  let high = whole - 1;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (fits(page(middle, true))) low = middle;
    else high = middle - 1;
  }
  return page(Math.max(1, low), true);
}

/** The characters `text` takes as a JSON string, quotes left out. */
function jsonChars(text: string): number {
  return JSON.stringify(text).length - 2;
}

/**
 * The whole lines of `content` that fit `PAGE_BUDGET_CHARS` once escaped as
 * JSON. A first line that alone is too long comes back on its own and the
 * route's truncation applies to it.
 */
function clipLines(content: string): { content: string; lines: number; clipped: boolean } {
  const lines = content.match(/[^\n]*\n|[^\n]+$/g) ?? [];
  let used = 0;
  let count = 0;
  for (const line of lines) {
    const size = jsonChars(line);
    if (used + size > PAGE_BUDGET_CHARS) break;
    used += size;
    count += 1;
  }
  if (count === lines.length) return { content, lines: count, clipped: false };
  const kept = Math.max(1, count);
  return { content: lines.slice(0, kept).join(""), lines: kept, clipped: kept < lines.length };
}

interface Definition {
  name: string;
  title: string;
  description: string;
  tier: McpTier;
  destructive?: true;
  folderScoped?: false;
  shape: z.ZodRawShape;
  run(ctx: FilesMcpContext, args: any): Promise<unknown>;
}

const DEFINITIONS: Definition[] = [
  {
    name: "folders",
    title: "Project folders",
    description: "List the folders a project works in, with the id of each. Use an id as folderId in the other file tools when the project has more than one.",
    tier: "read",
    folderScoped: false,
    shape: { projectId },
    run: async () => {
      throw new Error("kyoubeai_files_folders is answered by describeFolders");
    },
  },
  {
    name: "list",
    title: "List files",
    description: "List the files and folders in a project folder, with size and last-modified time. Set depth to 2 or 3 to include subfolders. When the result says cut, call again with offset set to its nextOffset for the rest.",
    tier: "read",
    shape: {
      projectId,
      folderId,
      path: z.string().optional().describe("The folder to list, relative to the project folder; leave out for the top."),
      depth: z.number().int().min(1).max(3).optional().describe("How many levels of folders to show (default 1)."),
      offset: z.number().int().min(0).optional().describe("How many entries to skip, for the next page of a long listing: the nextOffset of the previous result (default 0)."),
    },
    run: async (ctx, args: { path?: string; depth?: number; offset?: number }) => {
      const offset = args.offset ?? 0;
      // One past a full page, so the answer knows whether more exist.
      const listing = await ctx.files.list(args.path ?? "", { depth: args.depth, maxEntries: offset + LIST_MAX_ENTRIES + 1 });
      const available = listing.entries.slice(offset).map(entryOf);
      return listPage(listing.path, listing.exists, offset, available, listing.cut);
    },
  },
  {
    name: "read",
    title: "Read file",
    description: "Read a text file in pages of lines, from offset for limit lines, along with its total line count. A page too long for one answer is shortened to whole lines and says where to continue. A file that is not text, or is too large, comes back as a link instead.",
    tier: "read",
    shape: {
      projectId,
      folderId,
      path: z.string().describe("The file, relative to the project folder."),
      offset: z.number().int().min(1).optional().describe("The first line to read (default 1)."),
      limit: z.number().int().min(1).max(2000).optional().describe("How many lines to read (default 2000)."),
    },
    run: async (ctx, args: { path: string; offset?: number; limit?: number }) => {
      const result = await ctx.files.readLines(args.path, { offset: args.offset, limit: args.limit, maxBytes: ctx.settings.maxEditableKb * 1024 });
      const common = { kind: result.kind, path: result.path, size: result.size, modifiedAt: modifiedAt(result.mtimeMs) };
      if (result.kind !== "text") return { ...common, link: ctx.link, note: NOT_SHOWN };
      // The line numbers go ahead of the content, so a cut never loses them.
      const page = clipLines(result.content);
      if (!page.clipped) return { ...common, startLine: result.startLine, endLine: result.endLine, totalLines: result.totalLines, content: result.content };
      const endLine = result.startLine + page.lines - 1;
      return {
        ...common,
        startLine: result.startLine,
        endLine,
        totalLines: result.totalLines,
        note: `Page shortened to fit: continue with offset ${endLine + 1}.`,
        content: page.content,
      };
    },
  },
  {
    name: "write",
    title: "Write file",
    description: "Create a file, or replace one, with the given text. Set createOnly to refuse when the file exists, or expectedModifiedAt to refuse when it changed since you read it.",
    tier: "write",
    destructive: true,
    shape: {
      projectId,
      folderId,
      path: z.string().describe("The file, relative to the project folder. Its folder must already exist."),
      content: z.string().describe("The whole new text of the file."),
      expectedModifiedAt,
      createOnly: z.boolean().optional().describe("Refuse if the file already exists."),
    },
    run: async (ctx, args: { path: string; content: string; expectedModifiedAt?: string; createOnly?: boolean }) => {
      const baseMtimeMs = baseMtime(args.expectedModifiedAt);
      // A file read before must still be there: one moved or deleted since is not quietly recreated.
      const written = await ctx.files.write(args.path, args.content, {
        baseMtimeMs,
        mustCreate: args.createOnly,
        mustExist: baseMtimeMs !== undefined && args.createOnly !== true,
        checkNewName: true,
      });
      await ctx.audit("saved", written.path, { size: written.size });
      return entryOf(written);
    },
  },
  {
    name: "edit",
    title: "Edit file",
    description: "Replace a passage of a text file. The passage must match exactly once unless replaceAll is set, so read the file first and copy the passage as it is.",
    tier: "write",
    destructive: true,
    shape: {
      projectId,
      folderId,
      path: z.string().describe("The file, relative to the project folder."),
      oldText: z.string().min(1).describe("The exact text to replace."),
      newText: z.string().describe("The text to put in its place."),
      replaceAll: z.boolean().optional().describe("Replace every match instead of requiring exactly one."),
      expectedModifiedAt,
    },
    run: async (ctx, args: { path: string; oldText: string; newText: string; replaceAll?: boolean; expectedModifiedAt?: string }) => {
      const baseMtimeMs = baseMtime(args.expectedModifiedAt);
      const edited = await ctx.files.edit(args.path, {
        oldText: args.oldText,
        newText: args.newText,
        replaceAll: args.replaceAll,
        baseMtimeMs,
        maxBytes: ctx.settings.maxEditableKb * 1024,
      });
      await ctx.audit("edited", edited.path, { replacements: edited.replacements });
      return { ...entryOf(edited), replacements: edited.replacements };
    },
  },
  {
    name: "create_folder",
    title: "Create folder",
    description: "Create a folder. Its parent folder must already exist.",
    tier: "write",
    shape: { projectId, folderId, path: z.string().describe("The new folder, relative to the project folder.") },
    run: async (ctx, args: { path: string }) => {
      const created = await ctx.files.mkdir(args.path, { checkNewName: true });
      await ctx.audit("created folder", created.path);
      return entryOf(created);
    },
  },
  {
    name: "move",
    title: "Move or rename",
    description: "Move or rename a file or folder. The destination's folder must exist and nothing there is overwritten.",
    tier: "write",
    shape: {
      projectId,
      folderId,
      path: z.string().describe("The file or folder to move."),
      newPath: z.string().describe("Where it goes, relative to the project folder."),
    },
    run: async (ctx, args: { path: string; newPath: string }) => {
      const moved = await ctx.files.rename(args.path, args.newPath);
      await ctx.audit("renamed", normalizeRelativePath(args.path), { to: moved.path });
      return entryOf(moved);
    },
  },
  {
    name: "delete",
    title: "Delete file or folder",
    description: "Delete a file, or a folder and everything in it when recursive is set. This cannot be undone.",
    tier: "write",
    destructive: true,
    shape: {
      projectId,
      folderId,
      path: z.string().describe("The file or folder to delete."),
      recursive: z.boolean().optional().describe("Needed to delete a folder."),
    },
    run: async (ctx, args: { path: string; recursive?: boolean }) => {
      const removed = await ctx.files.remove(args.path, { recursive: args.recursive });
      await ctx.audit(removed.kind === "dir" ? "deleted folder" : "deleted", removed.path);
      return { path: removed.path, kind: removed.kind };
    },
  },
];

function jsonSchemaFor(schema: z.ZodType): Record<string, unknown> {
  const generated = z.toJSONSchema(schema, { target: "draft-7" }) as Record<string, unknown>;
  delete generated.$schema;
  return generated;
}

let catalogue: FilesMcpTool[] | undefined;

export function buildFilesCatalogue(): FilesMcpTool[] {
  catalogue ??= DEFINITIONS.map((definition): FilesMcpTool => {
    const schema = z.object(definition.shape);
    return {
      folderScoped: definition.folderScoped !== false,
      schema,
      run: definition.run,
      entry: {
        name: `kyoubeai_files_${definition.name}`,
        title: definition.title,
        description: definition.description,
        inputSchema: jsonSchemaFor(definition.tier === "read" ? schema : z.object({ ...definition.shape, requestId })),
        tier: definition.tier,
        annotations: {
          readOnlyHint: definition.tier === "read",
          destructiveHint: definition.destructive === true,
          idempotentHint: definition.tier === "read",
          openWorldHint: false,
        },
      },
    };
  });
  return catalogue;
}
