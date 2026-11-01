// src/ui/apps/PublishDisclosure.tsx
import { Fragment, useState } from "react";
import { usePluginAction, usePluginToast } from "@paperclipai/plugin-sdk/ui";
import { errorText } from "../format.js";
import { button } from "../forms.js";

/** What `apps.publish_preview` returns (`PublishPreview` in src/apps/service.ts). */
export interface PublishPreviewData {
  version: number;
  changed: boolean;
  provider: string | null;
  available: boolean;
  /** Absent from an older worker; treated as no connections. */
  connections?: { changed: boolean; list: PublishConnection[] };
  /** Absent from an older worker; treated as no task templates. */
  tasks?: { changed: boolean; list: PublishTask[] };
  sets: Array<{ key: string; table: string; fields: string[]; advisory: boolean; questions: Array<{ key: string; type: string; text: string }> }>;
}

export type PublishTaskInput = { type: "choice"; options: string[] } | { type: "number"; min: number | null; max: number | null } | { type: "text"; maxLength: number };

export interface PublishTask {
  key: string;
  /** The agent the template will actually reach (as written when not found). */
  agent: string;
  agentFound: boolean;
  /** Null unless the template writes. */
  agentCanWrite: boolean | null;
  title: string;
  instructions: string;
  table: string | null;
  fields: string[];
  inputs: Record<string, PublishTaskInput>;
  writes: string[];
  added: boolean;
  changed: boolean;
}

export const tasksOf = (preview: PublishPreviewData): PublishTask[] => preview.tasks?.list ?? [];
export const tasksChanged = (preview: PublishPreviewData): boolean => tasksOf(preview).length > 0 && preview.tasks?.changed === true;

/** One input as the person reads it: `tone: friendly | formal`, `count: number 1–10`, `note: text ≤ 200`. */
export function describeTaskInput(name: string, input: PublishTaskInput): string {
  if (input.type === "choice") return `${name}: ${input.options.join(" | ")}`;
  if (input.type === "text") return `${name}: text ≤ ${input.maxLength}`;
  const range = input.min !== null && input.max !== null ? ` ${input.min}–${input.max}` : input.min !== null ? ` ≥ ${input.min}` : input.max !== null ? ` ≤ ${input.max}` : "";
  return `${name}: number${range}`;
}

export interface PublishConnection {
  name: string;
  access: "read" | "read-write";
  baseUrl: string | null;
  auth: string | null;
  methods: string | null;
  available: boolean;
  missing: boolean;
  /** The published version lacks this connection (absent from an older worker: not marked). */
  added?: boolean;
  /** The published version declares it `read` and this one `read-write`. */
  widened?: boolean;
}

export const connectionsOf = (preview: PublishPreviewData): PublishConnection[] => preview.connections?.list ?? [];
export const connectionsChanged = (preview: PublishPreviewData): boolean => connectionsOf(preview).length > 0 && preview.connections?.changed === true;

const AUTH_LABELS: Record<string, string> = { bearer: "bearer token", header: "API key header", basic: "basic auth", authorization: "Authorization header" };
const METHOD_LABELS: Record<string, string> = { read: "GET only", "read-write": "GET, POST, PUT, PATCH, DELETE" };

/** Spec §2: what the person confirms, per connection; the change mark says what this version adds. */
export function connectionDetails(entry: PublishConnection): { host: string | null; auth: string | null; methods: string | null; change: string | null } {
  return {
    host: entry.baseUrl ? entry.baseUrl.replace(/^https?:\/\//, "") : null,
    auth: entry.auth ? AUTH_LABELS[entry.auth] ?? entry.auth : null,
    methods: entry.methods ? METHOD_LABELS[entry.methods] ?? entry.methods : null,
    change: entry.added ? "new in this version" : entry.widened ? "widened from read to read-write" : null,
  };
}

const PROVIDER_NAMES: Record<string, string> = {
  typesafe: "TypeSafe",
  openrouter: "OpenRouter",
  vercel: "Vercel AI Gateway",
  custom: "the company's custom decisions provider",
};

export function providerName(provider: string | null): string {
  return provider ? PROVIDER_NAMES[provider] ?? provider : "the company's decisions provider (none is set yet)";
}

export function sentFields(set: PublishPreviewData["sets"][number]): string[] {
  return set.fields.map((field) => `${set.table}.${field}`);
}

/**
 * Spec §5: the publish dialog says plainly what leaves the server, and a person confirms that no
 * set decides anything about people's lives unless it is advisory. Pure, so the unit suite can
 * render it without a host.
 */
export function PublishDisclosure(props: { preview: PublishPreviewData; appName: string; confirmed: boolean; onConfirmedChange: (next: boolean) => void; connectionsConfirmed?: boolean; onConnectionsConfirmedChange?: (next: boolean) => void; tasksConfirmed?: boolean; onTasksConfirmedChange?: (next: boolean) => void }) {
  const { preview, appName } = props;
  const tasks = tasksOf(preview);
  const connections = connectionsOf(preview);
  const provider = providerName(preview.provider);
  return (
    <div className="flex flex-col gap-2">
      {preview.sets.map((set) => (
        <section key={set.key} className="rounded border p-2">
          <div className="font-medium">Decision set <code>{set.key}</code>{set.advisory && <span className="text-foreground/60"> (advisory: every answer is only a suggestion)</span>}</div>
          <p>
            Sends {sentFields(set).map((field, index) => <Fragment key={field}>{index > 0 ? ", " : ""}<code>{field}</code></Fragment>)} to {provider} each time someone uses {appName}.
          </p>
          <ul className="list-disc pl-5 text-foreground/80">
            {set.questions.map((question) => <li key={question.key}><code>{question.key}</code> ({question.type}): {question.text}</li>)}
          </ul>
        </section>
      ))}
      {connections.length > 0 && (
        <section className="rounded border p-2" data-kyoube-connections="">
          <div className="font-medium">Connections</div>
          <ul className="list-disc pl-5">
            {connections.map((entry) => {
              const details = connectionDetails(entry);
              return (
                <li key={entry.name} data-kyoube-connection={entry.name} {...(details.change ? { "data-kyoube-changed": entry.added ? "added" : "widened", className: "font-medium" } : {})}>
                  <code>{entry.name}</code>{details.host && <> <span className="break-all" data-kyoube-break="">{details.host}</span></>}
                  {details.change && <span className="text-amber-700"> ({details.change})</span>}
                  <div className="font-normal text-foreground/80">
                    {details.auth && <>Auth: {details.auth} · </>}
                    {details.methods && <>Connection allows: {details.methods} · </>}
                    This app: {entry.access}
                  </div>
                  {entry.missing ? <div className="font-normal text-red-600">Not set up; ask a company admin.</div> : !entry.available ? <div className="font-normal text-red-600">Its secret doesn't resolve or can't be used right now.</div> : null}
                </li>
              );
            })}
          </ul>
          {preview.connections?.changed && (
            <>
              <p className="text-foreground/70">This version adds or widens connections, so it needs a person to publish it. Agents cannot.</p>
              <label className="flex items-start gap-2" data-kyoube-confirm="">
                <input type="checkbox" checked={props.connectionsConfirmed === true} onChange={(event) => props.onConnectionsConfirmedChange?.(event.target.checked)} />
                <span>This app may call these services with the company's credentials</span>
              </label>
            </>
          )}
        </section>
      )}
      {tasks.length > 0 && (
        <section className="rounded border p-2" data-kyoube-tasks="">
          <div className="font-medium">Tasks for agents</div>
          <ul className="flex flex-col gap-2">
            {tasks.map((task) => {
              const mark = task.added ? "added" : task.changed ? "changed" : null;
              return (
                <li key={task.key} data-kyoube-task={task.key} {...(mark ? { "data-kyoube-changed": mark, className: "font-medium" } : {})}>
                  <code>{task.key}</code> → {task.agentFound ? task.agent : <><span>{task.agent}</span> <span className="text-red-600">Agent not found</span></>}
                  {mark && <span className="text-amber-700"> ({mark === "added" ? "new in this version" : "changed in this version"})</span>}
                  <div className="font-normal text-foreground/80">
                    <div className="break-all" data-kyoube-break="">{task.title}</div>
                    <pre className="whitespace-pre-wrap break-words rounded bg-accent/30 p-1">{task.instructions}</pre>
                    {task.table && <div>Sees: <code>{task.table}</code> ({task.fields.join(", ")})</div>}
                    {Object.keys(task.inputs).length > 0 && <div>Inputs: {Object.entries(task.inputs).map(([name, input]) => describeTaskInput(name, input)).join("; ")}</div>}
                    {task.writes.length > 0 && <div>May change: {task.writes.join(", ")}</div>}
                    {task.agentCanWrite === false && <div className="text-amber-700">{task.agent} can't write Data yet. Ask an admin to give it write access, or its tasks will be refused.</div>}
                  </div>
                </li>
              );
            })}
          </ul>
          {preview.tasks?.changed && (
            <>
              <p className="text-foreground/70">This version adds or changes task templates, so it needs a person to publish it. Agents cannot.</p>
              <label className="flex items-start gap-2" data-kyoube-confirm="">
                <input type="checkbox" checked={props.tasksConfirmed === true} onChange={(event) => props.onTasksConfirmedChange?.(event.target.checked)} />
                <span>These agents may be sent this work by anyone who can open the app</span>
              </label>
            </>
          )}
        </section>
      )}
      {!preview.available && preview.sets.length > 0 && <p className="text-foreground/70">Typed decisions for apps are switched off for this company or no provider is set, so these sets will answer <code>disabled</code> until a company admin turns them on under Company Settings → Data access.</p>}
      {preview.changed && (
        <>
          <p className="text-foreground/70">This version adds or changes decision sets, so it needs a person to publish it. Agents cannot.</p>
          <label className="flex items-start gap-2" data-kyoube-confirm="">
            <input type="checkbox" checked={props.confirmed} onChange={(event) => props.onConfirmedChange(event.target.checked)} />
            <span>No decision set here decides anything about a person's employment, credit, housing, health, education or legal status. A set that does is marked advisory.</span>
          </label>
        </>
      )}
    </div>
  );
}

/**
 * The dialog around the disclosure: publishes or rolls back once the person has confirmed. It always
 * names the version the disclosure was built from, never "latest", so a draft saved while the dialog
 * is open cannot be published under this confirmation. The tick belongs to one mode and version: shown
 * anything else, the dialog asks again.
 */
export function PublishDialog(props: { slug: string; appName: string; mode: "publish" | "rollback"; preview: PublishPreviewData; onDone: () => void; onCancel: () => void }) {
  const toast = usePluginToast();
  const publish = usePluginAction("apps.publish");
  const rollback = usePluginAction("apps.rollback");
  const shown = `${props.mode}:${props.preview.version}`;
  const [confirmedFor, setConfirmedFor] = useState<string | null>(null);
  const confirmed = confirmedFor === shown;
  const [connectionsFor, setConnectionsFor] = useState<string | null>(null);
  const connectionsConfirmed = connectionsFor === shown;
  const needsConnections = connectionsChanged(props.preview);
  const [tasksFor, setTasksFor] = useState<string | null>(null);
  const tasksConfirmed = tasksFor === shown;
  const needsTasks = tasksChanged(props.preview);
  const [busy, setBusy] = useState(false);
  const ready = (!props.preview.changed || confirmed) && (!needsConnections || connectionsConfirmed) && (!needsTasks || tasksConfirmed);
  const go = () => {
    setBusy(true);
    const params = { slug: props.slug, version: props.preview.version, decisionsConfirmed: props.preview.changed && confirmed, ...(needsConnections && connectionsConfirmed ? { connectionsConfirmed: true } : {}), ...(needsTasks && tasksConfirmed ? { tasksConfirmed: true } : {}) };
    (props.mode === "publish" ? publish(params) : rollback(params))
      .then(() => { toast({ title: props.mode === "publish" ? `Published v${props.preview.version}` : "Rolled back", tone: "success" }); props.onDone(); })
      .catch((err: unknown) => { toast({ title: errorText(err), tone: "error" }); })
      .finally(() => setBusy(false));
  };
  return (
    <div className="flex flex-col gap-2 rounded border p-3 text-sm">
      <div className="font-medium">{props.mode === "publish" ? `Publish version ${props.preview.version}?` : `Roll back to version ${props.preview.version}?`}</div>
      <PublishDisclosure preview={props.preview} appName={props.appName} confirmed={confirmed} onConfirmedChange={(next) => setConfirmedFor(next ? shown : null)} connectionsConfirmed={connectionsConfirmed} onConnectionsConfirmedChange={(next) => setConnectionsFor(next ? shown : null)} tasksConfirmed={tasksConfirmed} onTasksConfirmedChange={(next) => setTasksFor(next ? shown : null)} />
      <div className="flex gap-2">
        <button type="button" className={button} disabled={!ready || busy} onClick={go}>{props.mode === "publish" ? "Publish" : "Roll back"}</button>
        <button type="button" className={button} onClick={props.onCancel}>Cancel</button>
      </div>
    </div>
  );
}
