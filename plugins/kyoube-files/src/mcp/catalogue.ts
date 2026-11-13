import { z } from "zod";
import { FilesError } from "../errors.js";
import type { FileEntry, WorkspaceFiles } from "../fs-service.js";
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

function baseMtime(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const parsed = Date.parse(value);
  if (Number.isNaN(parsed)) throw new FilesError("invalid", "expectedModifiedAt must be an ISO date");
  return parsed;
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
    description: "List the files and folders in a project folder, with size and last-modified time. Set depth to 2 or 3 to include subfolders; the result says when it was cut short.",
    tier: "read",
    shape: {
      projectId,
      folderId,
      path: z.string().optional().describe("The folder to list, relative to the project folder; leave out for the top."),
      depth: z.number().int().min(1).max(3).optional().describe("How many levels of folders to show (default 1)."),
    },
    run: async (ctx, args: { path?: string; depth?: number }) => {
      const listing = await ctx.files.list(args.path ?? "", { depth: args.depth, maxEntries: LIST_MAX_ENTRIES });
      return {
        path: listing.path,
        exists: listing.exists,
        entries: listing.entries.map(entryOf),
        cut: listing.cut,
        ...(listing.cut ? { note: "More entries than shown: list a subfolder, or use a smaller depth." } : {}),
      };
    },
  },
  {
    name: "read",
    title: "Read file",
    description: "Read a text file in pages of lines, from offset for limit lines, along with its total line count. A file that is not text, or is too large, comes back as a link instead.",
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
      return { ...common, content: result.content, startLine: result.startLine, endLine: result.endLine, totalLines: result.totalLines };
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
      const written = await ctx.files.write(args.path, args.content, { baseMtimeMs, mustCreate: args.createOnly });
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
      const created = await ctx.files.mkdir(args.path);
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
      await ctx.audit("renamed", args.path, { to: moved.path });
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
