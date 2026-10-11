import { z } from "zod";
import { DataError } from "../data/errors.js";
import { assertIdentifier } from "../data/identifiers.js";
import { CONNECTION_NAME_RE } from "../connections/config.js";
import { canonical, questionKeySchema, questionsSchema, type Question } from "../decisions/contract.js";

export const APP_SLUG_RE = /^[a-z][a-z0-9-]{1,48}$/;
export const MAX_APP_SOURCE_BYTES = 2 * 1024 * 1024;
/** Version notes are a short human record of a change, not a place to park text; every entry point caps them here. */
export const MAX_APP_NOTES = 2000;

/** How many decision sets one app may declare, and how many fields one set may send. */
export const MAX_DECISION_SETS = 10;
export const MAX_DECISION_FIELDS = 20;
/** How many external API connections one app may declare. */
export const MAX_APP_CONNECTIONS = 10;
/** Task templates an app may hand to agents (docs/app-tasks.md): how many, how large, and how a key or input name is spelled. */
export const MAX_TASK_TEMPLATES = 10;
export const MAX_TASK_FIELDS = 20;
export const MAX_TASK_INPUTS = 5;
export const MAX_TASK_INSTRUCTIONS = 4000;
export const MAX_TASK_TITLE = 200;
export const TASK_KEY_RE = /^[a-z][a-z0-9_]{0,39}$/;

/**
 * One named set of typed questions an app may ask (docs/decisions.md). It is tied to one table the
 * manifest declares and the fields it may send: the worker builds the state from those fields and
 * nothing else, so an app can never send free text of its own or rewrite its questions at run time.
 */
export interface AppDecisionSet {
  table: string;
  fields: string[];
  /** Every answer is `review`: the set can only ever suggest. */
  advisory: boolean;
  questions: Record<string, Question>;
}

export type TaskInput =
  | { type: "choice"; options: string[] }
  | { type: "number"; min: number | null; max: number | null }
  | { type: "text"; maxLength: number };

/**
 * One named task an app may hand to an agent (docs/app-tasks.md). The agent, the wording and the
 * data it may see are all fixed here, so a person confirms them at publish and the app can only
 * fill the declared placeholders at run time.
 */
export interface AppTaskTemplate {
  /** The agent's name as written. */
  agent: string;
  /** Unfilled: may hold `{{row.<field>}}` and `{{input.<name>}}`. */
  title: string;
  /** Unfilled, like the title. */
  instructions: string;
  table: string | null;
  /** The row fields the task may see; [] when `table` is null. */
  fields: string[];
  inputs: Record<string, TaskInput>;
  /** Fields the agent is asked to change; a subset of `fields`. */
  writes: string[];
}

export interface AppManifest {
  name: string;
  slug: string;
  description: string | null;
  icon: string | null;
  tables: Array<{ name: string; access: "read" | "readwrite" }>;
  surfaces: Array<"page">;
  /** Present only when the manifest declares at least one decision set. */
  decisions?: Record<string, AppDecisionSet>;
  /** Present only when the manifest declares at least one connection (docs/connections.md). */
  connections?: Array<{ name: string; access: "read" | "read-write" }>;
  /** Present only when the manifest declares at least one task template. */
  tasks?: Record<string, AppTaskTemplate>;
}

const taskInputSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("choice"), options: z.array(z.string().min(1).max(100)).min(1).max(20) }).strict(),
  z.object({ type: z.literal("number"), min: z.number().finite().optional(), max: z.number().finite().optional() }).strict(),
  z.object({ type: z.literal("text"), maxLength: z.number().int().min(1).max(200).optional() }).strict(),
]);

/**
 * The one description of a manifest's shape. `validateAppManifest` below is
 * still the authority (it also normalises and rejects duplicate or non-
 * identifier table names), but the tools and the REST routes reuse this schema
 * so an agent's declared parameters and a request body are checked — and, for
 * a tool, *documented* as JSON Schema — against exactly what is accepted here.
 */
export const APP_MANIFEST_SCHEMA = z.object({
  name: z.string().trim().min(1).max(120),
  slug: z.string().regex(APP_SLUG_RE, "slug must match ^[a-z][a-z0-9-]{1,48}$"),
  description: z.string().max(2000).nullable().optional(),
  icon: z.string().max(16).nullable().optional(),
  // .strict() on both this object and the table-entry object below: an unknown
  // key (a typo, or a field from a future manifest version) must be rejected
  // rather than silently dropped.
  tables: z.array(z.object({ name: z.string(), access: z.enum(["read", "readwrite"]).optional() }).strict()).max(50),
  surfaces: z.array(z.enum(["page"])).optional(),
  decisions: z.record(questionKeySchema, z.object({
    table: z.string(),
    fields: z.array(z.string()).min(1).max(MAX_DECISION_FIELDS),
    advisory: z.boolean().optional(),
    questions: questionsSchema,
  }).strict())
    .refine((sets) => Object.keys(sets).length <= MAX_DECISION_SETS, `at most ${MAX_DECISION_SETS} decision sets`)
    .optional()
    .describe("named sets of typed questions (docs/decisions.md): each names one declared table, the fields it may send, and its questions"),
  connections: z.array(z.object({ name: z.string().regex(CONNECTION_NAME_RE), access: z.enum(["read", "read-write"]).optional() }).strict())
    .max(MAX_APP_CONNECTIONS).optional()
    .describe("external API connections the app calls (docs/connections.md); a person confirms them at publish"),
  tasks: z.record(z.string().regex(TASK_KEY_RE), z.object({
    agent: z.string().trim().min(1).max(120),
    title: z.string().trim().min(1).max(MAX_TASK_TITLE),
    instructions: z.string().trim().min(1).max(MAX_TASK_INSTRUCTIONS),
    table: z.string().optional(),
    fields: z.array(z.string()).min(1).max(MAX_TASK_FIELDS).optional(),
    inputs: z.record(z.string().regex(TASK_KEY_RE), taskInputSchema).optional(),
    writes: z.array(z.string()).optional(),
  }).strict())
    .refine((t) => Object.keys(t).length <= MAX_TASK_TEMPLATES, `at most ${MAX_TASK_TEMPLATES} task templates`)
    .optional()
    .describe("named task templates an app may hand to an agent (docs/app-tasks.md); a person confirms them at publish"),
}).strict();

export function validateAppManifest(raw: unknown): AppManifest {
  const parsed = APP_MANIFEST_SCHEMA.safeParse(raw);
  if (!parsed.success) throw new DataError("invalid", `invalid app manifest: ${parsed.error.issues.map((issue) => `${issue.path.join(".") || "manifest"} ${issue.message}`).join("; ")}`);
  const seen = new Set<string>();
  const tables = parsed.data.tables.map((table) => {
    const name = assertIdentifier(table.name, "app table");
    if (seen.has(name)) throw new DataError("invalid", `duplicate table "${name}" in app manifest`);
    seen.add(name);
    return { name, access: table.access ?? ("read" as const) };
  });
  const declared = new Set(tables.map((table) => table.name));
  const decisions = normaliseDecisionSets(parsed.data.decisions, declared);
  const tasks = normaliseTaskTemplates(parsed.data.tasks, declared);
  const connSeen = new Set<string>();
  const connections = (parsed.data.connections ?? []).map((entry) => {
    if (connSeen.has(entry.name)) throw new DataError("invalid", `duplicate connection "${entry.name}" in app manifest`);
    connSeen.add(entry.name);
    return { name: entry.name, access: entry.access ?? ("read" as const) };
  });
  return {
    name: parsed.data.name, slug: parsed.data.slug, description: parsed.data.description ?? null, icon: parsed.data.icon ?? null,
    tables, surfaces: parsed.data.surfaces?.length ? parsed.data.surfaces : ["page"],
    ...(decisions ? { decisions } : {}),
    ...(connections.length > 0 ? { connections } : {}),
    ...(tasks ? { tasks } : {}),
  };
}

function normaliseDecisionSets(
  raw: Record<string, { table: string; fields: string[]; advisory?: boolean; questions: Record<string, Question> }> | undefined,
  declared: ReadonlySet<string>,
): Record<string, AppDecisionSet> | null {
  if (!raw || Object.keys(raw).length === 0) return null;
  const sets: Record<string, AppDecisionSet> = {};
  for (const [key, set] of Object.entries(raw)) {
    const table = assertIdentifier(set.table, `decision set "${key}" table`);
    if (!declared.has(table)) throw new DataError("invalid", `decision set "${key}" uses table "${table}", which the manifest does not declare`);
    const seen = new Set<string>();
    const fields = set.fields.map((name) => {
      const field = assertIdentifier(name, `decision set "${key}" field`);
      if (seen.has(field)) throw new DataError("invalid", `decision set "${key}" names field "${field}" twice`);
      seen.add(field);
      return field;
    });
    sets[key] = { table, fields, advisory: set.advisory ?? false, questions: set.questions };
  }
  return sets;
}

/**
 * Whether publishing `target` over `current` adds or changes what an app sends. A version with no
 * decision sets never counts — removing sets only ever narrows what leaves the server.
 */
export function decisionSetsChanged(current: AppManifest | null, target: AppManifest): boolean {
  const next = target.decisions ?? {};
  if (Object.keys(next).length === 0) return false;
  return JSON.stringify(canonical(current?.decisions ?? {})) !== JSON.stringify(canonical(next));
}

type RawTaskInput = z.infer<typeof taskInputSchema>;
interface RawTaskTemplate {
  agent: string; title: string; instructions: string; table?: string; fields?: string[];
  inputs?: Record<string, RawTaskInput>; writes?: string[];
}

/** Every `{{…}}` in a string; the validator and the filler both read placeholders through this. */
export function placeholdersIn(text: string): Array<{ kind: "row" | "input" | "other"; name: string; raw: string }> {
  return [...text.matchAll(/\{\{\s*([^{}]*?)\s*\}\}/g)].map((match) => {
    const inner = match[1] ?? "";
    const row = /^row\.([a-z][a-z0-9_]*)$/.exec(inner);
    if (row) return { kind: "row" as const, name: row[1]!, raw: match[0] };
    const input = /^input\.([a-z][a-z0-9_]*)$/.exec(inner);
    if (input) return { kind: "input" as const, name: input[1]!, raw: match[0] };
    return { kind: "other" as const, name: inner, raw: match[0] };
  });
}

function normaliseTaskTemplates(raw: Record<string, RawTaskTemplate> | undefined, declared: ReadonlySet<string>): Record<string, AppTaskTemplate> | null {
  if (!raw || Object.keys(raw).length === 0) return null;
  const tasks: Record<string, AppTaskTemplate> = {};
  for (const [key, t] of Object.entries(raw)) {
    const label = `task "${key}"`;
    let table: string | null = null;
    if (t.table !== undefined) {
      table = assertIdentifier(t.table, `${label} table`);
      if (!declared.has(table)) throw new DataError("invalid", `${label} uses table "${table}", which the manifest does not declare`);
      if (!t.fields) throw new DataError("invalid", `${label} needs fields, since it names a table`);
    } else if (t.fields) {
      throw new DataError("invalid", `${label} names fields but no table`);
    }
    const fields: string[] = [];
    for (const name of t.fields ?? []) {
      const field = assertIdentifier(name, `${label} field`);
      if (fields.includes(field)) throw new DataError("invalid", `${label} names field "${field}" twice`);
      fields.push(field);
    }
    const inputs: Record<string, TaskInput> = {};
    const inputEntries = Object.entries(t.inputs ?? {});
    if (inputEntries.length > MAX_TASK_INPUTS) throw new DataError("invalid", `${label} takes at most ${MAX_TASK_INPUTS} inputs`);
    for (const [name, input] of inputEntries) {
      if (input.type === "choice") inputs[name] = { type: "choice", options: input.options };
      else if (input.type === "text") inputs[name] = { type: "text", maxLength: input.maxLength ?? 200 };
      else {
        const min = input.min ?? null;
        const max = input.max ?? null;
        if (min !== null && max !== null && min > max) throw new DataError("invalid", `${label} input "${name}" has min above max`);
        inputs[name] = { type: "number", min, max };
      }
    }
    const writes: string[] = [];
    if ((t.writes ?? []).length > 0 && table === null) throw new DataError("invalid", `${label} writes need a table`);
    for (const name of t.writes ?? []) {
      if (!fields.includes(name)) throw new DataError("invalid", `${label} writes "${name}", which is not one of its fields`);
      if (writes.includes(name)) throw new DataError("invalid", `${label} writes "${name}" twice`);
      writes.push(name);
    }
    for (const part of ["title", "instructions"] as const) {
      for (const ph of placeholdersIn(t[part])) {
        const known = ph.kind === "row" ? fields.includes(ph.name) : ph.kind === "input" ? Object.hasOwn(inputs, ph.name) : false;
        if (!known) throw new DataError("invalid", `unknown placeholder ${ph.raw} in ${label} ${part}`);
      }
    }
    tasks[key] = { agent: t.agent, title: t.title, instructions: t.instructions, table, fields, inputs, writes };
  }
  return tasks;
}

export interface TemplateChange { key: string; added: boolean; changed: boolean }

/** Per template `target` declares: `added` when the current published version lacks the key, `changed` when its canonical JSON differs. */
export function templateChanges(current: AppManifest | null, target: AppManifest): TemplateChange[] {
  const before = current?.tasks ?? {};
  return Object.entries(target.tasks ?? {}).map(([key, template]) => {
    const was = Object.hasOwn(before, key) ? before[key] : undefined;
    return { key, added: was === undefined, changed: was !== undefined && JSON.stringify(canonical(was)) !== JSON.stringify(canonical(template)) };
  });
}

/** Whether publishing `target` over `current` needs a person's confirmation for its task templates. Removal never counts. */
export function taskTemplatesChanged(current: AppManifest | null, target: AppManifest): boolean {
  return templateChanges(current, target).some((c) => c.added || c.changed);
}

export interface ConnectionChange { name: string; access: "read" | "read-write"; added: boolean; widened: boolean }

/**
 * Ruling R12, per connection `target` declares: `added` when the current published version lacks it,
 * `widened` when it goes from `read` to `read-write`. Removing or narrowing a connection never
 * counts, and neither does a reorder: those only shrink what the app can reach.
 */
export function connectionChanges(current: AppManifest | null, target: AppManifest): ConnectionChange[] {
  const before = new Map((current?.connections ?? []).map((c) => [c.name, c.access]));
  return (target.connections ?? []).map((c) => {
    const was = before.get(c.name);
    return { name: c.name, access: c.access, added: was === undefined, widened: was === "read" && c.access === "read-write" };
  });
}

/** Whether publishing `target` over `current` needs a person's confirmation for its connections. */
export function connectionsChanged(current: AppManifest | null, target: AppManifest): boolean {
  return connectionChanges(current, target).some((c) => c.added || c.widened);
}

export function assertAppSource(source: unknown): string {
  if (typeof source !== "string") throw new DataError("invalid", "app source must be a string");
  if (Buffer.byteLength(source, "utf8") > MAX_APP_SOURCE_BYTES) throw new DataError("limit", "app source must be at most 2 MiB");
  if (!/<(html|body|script)[\s>]/i.test(source)) throw new DataError("invalid", "app source must be an HTML document");
  return source;
}
