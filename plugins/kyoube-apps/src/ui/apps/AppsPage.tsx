import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { PluginPageProps, PluginToastTone } from "@paperclipai/plugin-sdk/ui";
import { useHostContext, useHostLocation, useHostNavigation, usePluginAction, usePluginData, usePluginToast } from "@paperclipai/plugin-sdk/ui";
import { appsPagePath } from "../../apps/page-route.js";
import { errorText } from "../format.js";
import { button, input } from "../forms.js";
import { AppRunner } from "./AppRunner.js";
import { PublishDialog, connectionsOf, type PublishPreviewData } from "./PublishDisclosure.js";
import { appNameOf, ensurePhoneStyles } from "../phone.js";
import { appErrorPayload, parseAppsPath, taskPagePath, type TaskOp } from "./bridge.js";

interface AppRecord { slug: string; name: string; description: string | null; icon: string | null; status: string; currentVersion: number | null; latestVersion: number }
interface AppVersion { version: number; manifest: Record<string, unknown>; source: string; notes: string | null; createdAt: string }

/** The refusal AppService gives a person outside every group an app is in; shown as a notice, not an error. */
const NO_ACCESS = "You don't have access to this app. Ask a company admin.";

/** Narrows an app-supplied tone to the host's toast tones, so an unknown string cannot reach the host. */
function toastTone(tone: string): PluginToastTone {
  return tone === "success" || tone === "warn" || tone === "error" ? tone : "info";
}

export function AppsPage({ context }: PluginPageProps) {
  const host = useHostContext();
  const companyId = context.companyId ?? host.companyId ?? "";
  const location = useHostLocation();
  const { slug } = parseAppsPath(location.pathname);
  if (!companyId) return <div className="p-4 text-sm">Select a company.</div>;
  return slug ? <Runner key={slug} companyId={companyId} userId={host.userId} slug={slug} /> : <Gallery companyId={companyId} userId={host.userId} />;
}

function Gallery(props: { companyId: string; userId: string | null }) {
  const navigation = useHostNavigation();
  const listApps = usePluginAction("apps.list");
  // Ruling P2-R26: memoise the params object on its scalar inputs.
  const accessParams = useMemo(() => ({ companyId: props.companyId, userId: props.userId }), [props.companyId, props.userId]);
  const access = usePluginData<{ level: string }>("data.access", accessParams);
  const usesAction = usePluginAction("apps.uses");
  const usesRef = useRef(usesAction);
  usesRef.current = usesAction;
  const [uses, setUses] = useState<Record<string, Array<{ name: string; access: string }>>>({});
  const [apps, setApps] = useState<AppRecord[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Ruling P1-R15: action functions from usePluginAction are not guaranteed
  // referentially stable, so the load effect reads this ref instead of
  // depending on `listApps` (which would re-run it on every render).
  const listRef = useRef(listApps);
  listRef.current = listApps;

  useEffect(() => {
    let cancelled = false;
    listRef.current({})
      .then((result) => { if (!cancelled) setApps(result as AppRecord[]); })
      .catch((err: unknown) => { if (!cancelled) setError(errorText(err)); });
    return () => { cancelled = true; };
  }, [props.companyId]);

  // The "Uses" line is a convenience: a failure leaves it out and the gallery still loads.
  useEffect(() => {
    let cancelled = false;
    Promise.resolve(usesRef.current({})).then((result) => { if (!cancelled && result && typeof result === "object") setUses(result as typeof uses); }).catch(() => {});
    return () => { cancelled = true; };
  }, [props.companyId]);

  const canWrite = access.data?.level === "write" || access.data?.level === "schema";
  return (
    <div className="flex flex-col gap-3 p-4" data-kyoube-page="apps">
      <div className="flex items-center gap-2"><h1 className="text-base font-semibold">Apps</h1><span className="text-xs text-foreground/60">{canWrite ? "Ask an agent to build an app, or create one from the Data page's tables." : "Published apps for this company."}</span></div>
      {error && <div className="text-sm text-red-600">{error}</div>}
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {(apps ?? []).map((app) => (
          <a key={app.slug} {...navigation.linkProps(appsPagePath(app.slug))} className="rounded border p-3 hover:bg-accent/40">
            <div className="text-lg">{app.icon ?? "◫"} <strong>{app.name}</strong></div>
            {/* An unpublished draft is only visible to (and only openable by) an editor, so only an editor is told one exists. */}
            <div className="text-xs text-foreground/60">{app.status}{app.currentVersion ? ` · v${app.currentVersion}` : ""}{canWrite && app.latestVersion > (app.currentVersion ?? 0) ? ` · draft v${app.latestVersion}` : ""}</div>
            {uses[app.slug]?.length ? <div className="text-xs text-foreground/60" data-kyoube-uses="">Uses: {uses[app.slug]!.map((entry) => `${entry.name} (${entry.access})`).join(", ")}</div> : null}
            {app.description && <p className="mt-1 text-sm">{app.description}</p>}
          </a>
        ))}
        {apps && apps.length === 0 && <div className="text-sm text-foreground/60">No apps yet.</div>}
      </div>
    </div>
  );
}

function Runner(props: { companyId: string; userId: string | null; slug: string }) {
  ensurePhoneStyles();
  const navigation = useHostNavigation();
  const toast = usePluginToast();
  const runtime = usePluginAction("apps.runtime");
  const data = usePluginAction("apps.data");
  const decide = usePluginAction("apps.decide");
  const outcome = usePluginAction("apps.decision_outcome");
  const connection = usePluginAction("apps.connection_call");
  const taskStart = usePluginAction("apps.task_start");
  const taskGet = usePluginAction("apps.task_get");
  const taskList = usePluginAction("apps.task_list");
  const taskCancel = usePluginAction("apps.task_cancel");
  const [state, setState] = useState<{ context: unknown; source: string } | null>(null);
  const [error, setError] = useState<{ code: string; message: string } | null>(null);
  const [showSource, setShowSource] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  // Ruling P1-R15: both actions are read through refs so neither `load` nor
  // the effect below has to depend on an unstable function identity.
  const actionsRef = useRef({ runtime, data, decide, outcome, connection, taskStart, taskGet, taskList, taskCancel });
  actionsRef.current = { runtime, data, decide, outcome, connection, taskStart, taskGet, taskList, taskCancel };

  const load = useCallback(() => {
    setError(null);
    return actionsRef.current.runtime({ slug: props.slug })
      .then((result) => { setState(result as { context: unknown; source: string }); })
      // The rejection is the host's plain `{ code, message }` object, whose
      // `code` is a transport code — so the "not published yet" case below is
      // recognised from the worker's code inside the message (P3-R17).
      .catch((err: unknown) => { setError(appErrorPayload(err)); });
  }, [props.slug]);
  useEffect(() => { void load(); }, [load]);

  const reload = () => { setState(null); void load(); };

  // App tasks: the bridge has already validated `params` and built it from the checked keys only;
  // the slug is the page's own, never the frame's.
  const onTask = (op: TaskOp, params: Record<string, unknown>): Promise<unknown> => {
    const actions = actionsRef.current;
    const action = op === "start" ? actions.taskStart : op === "get" ? actions.taskGet : op === "list" ? actions.taskList : actions.taskCancel;
    return action({ ...params, slug: props.slug });
  };
  // `open` reads the task through the same gate as `get` (so another app's or company's id is
  // `not_found`) and goes only to a host path; the url is the worker's, but it steers the top window.
  const onTaskOpen = async (id: string): Promise<void> => {
    const task = await actionsRef.current.taskGet({ slug: props.slug, id }) as { url?: unknown } | null;
    const path = taskPagePath(task?.url);
    if (!path) throw new Error("invalid: this task has no page to open");
    navigation.navigate(path);
  };

  return (
    <div className="flex h-full flex-col gap-2 p-4" data-kyoube-page="apps" data-kyoube-runner="">
      <div className="flex items-center gap-2 text-sm" data-kyoube-runner-bar="">
        <a {...navigation.linkProps(appsPagePath())} className="underline" aria-label="Back to Apps">←<span className="kyoube-wide-only"> Apps</span></a>
        <strong>{appNameOf(state?.context, props.slug)}</strong>
        <span className="flex-1" />
        <button type="button" className={`${button} kyoube-wide-only`} onClick={() => setShowSource((value) => !value)}>{showSource ? "Hide source" : "Source & versions"}</button>
        <button type="button" className={`${button} kyoube-wide-only`} onClick={reload}>Reload</button>
        <button type="button" className={`${button} kyoube-phone-only`} aria-label="More" aria-expanded={menuOpen} onClick={() => setMenuOpen((value) => !value)}>⋯</button>
      </div>
      {menuOpen && (
        <div className="kyoube-phone-menu kyoube-phone-only">
          <button type="button" className={button} onClick={() => { setMenuOpen(false); setShowSource((value) => !value); }}>{showSource ? "Hide source" : "Source & versions"}</button>
          <button type="button" className={button} onClick={() => { setMenuOpen(false); reload(); }}>Reload</button>
        </div>
      )}
      {error && (error.code === "forbidden" && error.message.includes(NO_ACCESS)
        ? <div role="alert" className="rounded border p-3 text-sm">{NO_ACCESS}</div>
        : <div className="text-sm text-red-600">{error.code === "not_found" ? "This app is not published yet." : error.message}</div>)}
      {showSource && <SourcePanel companyId={props.companyId} userId={props.userId} slug={props.slug} onChanged={reload} />}
      {state && (
        <AppRunner
          source={state.source}
          context={state.context}
          onData={(method, params) => actionsRef.current.data({ slug: props.slug, method, params })}
          onToast={(title, tone) => { toast({ title, tone: toastTone(tone) }); }}
          onOpenApp={(slug) => navigation.navigate(appsPagePath(slug))}
          onDecide={(set, input) => actionsRef.current.decide({ slug: props.slug, set, input })}
          onConnection={(name, request) => actionsRef.current.connection({ slug: props.slug, name, request })}
          onDecisionOutcome={(decisionId, question, value) => actionsRef.current.outcome({ slug: props.slug, decisionId, question, value })}
          onTask={onTask}
          onTaskOpen={onTaskOpen}
        />
      )}
    </div>
  );
}

function SourcePanel(props: { companyId: string; userId: string | null; slug: string; onChanged: () => void }) {
  const toast = usePluginToast();
  const getApp = usePluginAction("apps.get");
  const update = usePluginAction("apps.update");
  const publish = usePluginAction("apps.publish");
  const rollback = usePluginAction("apps.rollback");
  const preview = usePluginAction("apps.publish_preview");
  const [pending, setPending] = useState<{ mode: "publish" | "rollback"; preview: PublishPreviewData } | null>(null);
  // A preview being fetched or a dialog open: Publish and Roll back wait, so a second click can never
  // swap the dialog's version from under a confirmation.
  const [previewing, setPreviewing] = useState(false);
  // Ruling P2-R26: memoise the params object on its scalar inputs.
  const accessParams = useMemo(() => ({ companyId: props.companyId, userId: props.userId }), [props.companyId, props.userId]);
  const access = usePluginData<{ level: string }>("data.access", accessParams);
  const [app, setApp] = useState<AppRecord | null>(null);
  const [version, setVersion] = useState<AppVersion | null>(null);
  const [manifest, setManifest] = useState("");
  const [source, setSource] = useState("");
  const [notes, setNotes] = useState("");
  const [error, setError] = useState<string | null>(null);
  // Ruling P1-R15 again: `getApp` (a host-bridge function, not guaranteed
  // stable) may not be a dependency of `reload`, or the effect below would
  // re-run on every render; it is read through a ref kept current instead.
  const getRef = useRef(getApp);
  getRef.current = getApp;

  const reload = useCallback(() => getRef.current({ slug: props.slug, version: "latest" }).then((result) => {
    const payload = result as { app: AppRecord; version: AppVersion | null };
    setError(null);
    setApp(payload.app);
    setVersion(payload.version);
    setManifest(JSON.stringify(payload.version?.manifest ?? {}, null, 2));
    setSource(payload.version?.source ?? "");
  }).catch((err: unknown) => { setError(errorText(err)); }), [props.slug]);
  useEffect(() => { void reload(); }, [reload]);

  const act = (promise: Promise<unknown>, title: string) => promise
    .then(() => { toast({ title, tone: "success" }); props.onChanged(); return reload(); })
    .catch((err: unknown) => { toast({ title: errorText(err), tone: "error" }); });
  // Spec §5: anything with decision sets goes through the disclosure dialog; an app without sets
  // publishes in one click, as before.
  // Either way the request names the version the preview resolved, never "latest".
  const start = (mode: "publish" | "rollback", version: number | "latest") => {
    if (previewing || pending) return;
    setPreviewing(true);
    preview({ slug: props.slug, version }).then((result) => {
      const data = result as PublishPreviewData;
      if (data.sets.length === 0 && connectionsOf(data).length === 0) {
        const params = { slug: props.slug, version: data.version };
        return act(mode === "publish" ? publish(params) : rollback(params), mode === "publish" ? `Published v${data.version}` : "Rolled back");
      }
      setPending({ mode, preview: data });
    }).catch((err: unknown) => { toast({ title: errorText(err), tone: "error" }); })
      .finally(() => setPreviewing(false));
  };
  // Mirrors AppService's own gates (update needs write, publish/rollback need
  // schema); the worker enforces them regardless, this only stops the panel
  // offering a button the caller cannot use.
  const canWrite = access.data?.level === "write" || access.data?.level === "schema";
  const canSchema = access.data?.level === "schema";
  if (error) return <div className="rounded border p-3 text-sm text-red-600">Could not load the source for {props.slug}: {error}</div>;
  if (!app) return null;
  return (
    <div className="flex flex-col gap-2 rounded border p-3 text-sm">
      <div className="flex flex-wrap items-center gap-2">
        <span>{app.name} — published v{app.currentVersion ?? "—"}, latest v{app.latestVersion}</span>
        <span className="flex-1" />
        {canWrite && <input className={input} placeholder="version notes" value={notes} onChange={(event) => setNotes(event.target.value)} />}
        {canWrite && <button type="button" className={button} onClick={() => { try { void act(update({ slug: props.slug, manifest: JSON.parse(manifest), source, notes }), "Draft saved"); } catch (err) { toast({ title: `Manifest JSON: ${errorText(err)}`, tone: "error" }); } }}>Save draft</button>}
        {canSchema && <button type="button" className={button} disabled={previewing || pending !== null} onClick={() => start("publish", "latest")}>Publish latest</button>}
        {canSchema && app.currentVersion !== null && app.currentVersion > 1 && <button type="button" className={button} disabled={previewing || pending !== null} onClick={() => start("rollback", (app.currentVersion ?? 1) - 1)}>Roll back one version</button>}
      </div>
      {pending && (
        <PublishDialog key={`${pending.mode}:${pending.preview.version}`} slug={props.slug} appName={app.name} mode={pending.mode} preview={pending.preview}
          onCancel={() => setPending(null)} onDone={() => { setPending(null); props.onChanged(); void reload(); }} />
      )}
      <label className="flex flex-col gap-1">Manifest<textarea className={`${input} font-mono`} readOnly={!canWrite} rows={6} value={manifest} onChange={(event) => setManifest(event.target.value)} /></label>
      <label className="flex flex-col gap-1">Source (v{version?.version ?? "?"})<textarea className={`${input} font-mono`} readOnly={!canWrite} rows={16} value={source} onChange={(event) => setSource(event.target.value)} /></label>
    </div>
  );
}
