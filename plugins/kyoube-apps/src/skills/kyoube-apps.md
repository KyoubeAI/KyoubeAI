---
name: kyoube-apps
description: Build, update, and publish KyoubeAI apps — single-file HTML applications that run inside the KyoubeAI UI and use the company's Kyoube Data tables through window.kyoube — through the Kyoube REST API (or the kyoube.apps tools when your harness lists them). Use when a task asks for a CRM, tracker, dashboard, form, or any internal tool over company data.
---

# Kyoube Apps

An app is **one HTML document** (inline CSS and JavaScript, no external URLs — an injected
Content-Security-Policy blocks all network access and remote scripts, though `data:`/`blob:` images
and `data:` fonts still work since they never leave the document) plus a **manifest** that declares
which Data tables it uses. Users open apps at `/<company>/app-artifact/<slug>`. Apps run in a sandboxed
iframe with an opaque origin (no cookies, no storage, no host DOM); the only way to reach data is `window.kyoube`.

Never build an app any other way. A server on its own port, a file in the workspace, or a page hosted
elsewhere is not a Kyoube app: nobody can open it from the Apps page and it has no access to the data.

## How to call the API

Same credentials and base URL as the `kyoube-data` skill: `$PAPERCLIP_API_URL/api/plugins/kyoube.apps/api`,
`Authorization: Bearer $PAPERCLIP_API_KEY`, and the company as `?companyId=$PAPERCLIP_COMPANY_ID` on `GET`
or `"companyId"` in every `POST` body.

| Operation | Method and path | POST body fields (besides `companyId`) |
|---|---|---|
| List apps | `GET /apps` | — |
| Read an app | `GET /apps/{slug}?version=latest` (or `current`, or a number) | — |
| Create (draft v1) | `POST /apps` | `manifest`, `source`, `notes?` |
| Update (new draft) | `POST /apps/{slug}` | `manifest`, `source`, `notes?` |
| Publish | `POST /apps/{slug}/publish` | `version?` (default: latest draft); a version that adds or changes decision sets, adds or widens a connection, or adds or changes a task template, needs a person to publish it |
| Roll back | `POST /apps/{slug}/rollback` | `version` |
| Archive | `POST /apps/{slug}/archive` | — |

Put the HTML in the JSON as a string — write it to a file and let a tool encode it, for example
`jq -n --arg c "$PAPERCLIP_COMPANY_ID" --rawfile s app.html --argjson m "$(cat manifest.json)" '{companyId:$c, manifest:$m, source:$s}'`
piped to `curl -fsS -H "$A" -H 'Content-Type: application/json' -X POST "$K/apps" -d @-`.

If your harness lists tools named `kyoube.apps:apps_*` (`apps_create`, `apps_update`, `apps_publish`,
`apps_rollback`, …), they are these same operations; use whichever you have.

## Typed decisions in an app

An app can ask the company's typed-decision model closed questions about one of its rows, or about a
form the person is filling in. Declare each set of questions in the manifest under `"decisions"`:
the table (one the manifest declares), the fields the set may send, and the questions (the same
`choice` / `score` / `check` shapes as the kyoube-decisions skill). At most 10 sets.

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

```js
const ctx = await kyoube.ready();
if (ctx.decisions.available) {                       // false when the company has not switched apps on
  const r = await kyoube.decide("triage", { rowId: ticket.id });            // or { values: { subject, body } }
  if (r.answers.queue.status === "review") showReviewLane(ticket, r);        // never act on review alone
  else await kyoube.data.update("tickets", { ids: [ticket.id] }, { queue: r.answers.queue.value });
}
// In the review lane, once the person picks a value:
await kyoube.decideOutcome(r.decisionId, "queue", chosenQueue);
```

Rules:

- The app never sends text of its own: the host builds the question's state from the set's fields.
  `values` may only name the set's fields, and each must fit its field kind.
- Every choice gets an `unsure` option, and an `unsure` answer is always `review`. Build a review lane
  that shows the suggestion to the person and calls `kyoube.decideOutcome` with what they chose.
- Compute dates, totals, counts and comparisons in code; ask the model only the judgment.
- A set that decides anything about a person's employment, credit, housing, health, education or
  legal status must be `"advisory": true`: every answer is then `review`.
- A version that adds or changes decision sets needs a person to publish it. Save the draft with
  `apps_update` and ask the person who started the task to publish it from the Apps page, where they
  see what the sets send. You can still publish versions whose sets did not change.
- Ship a small fixture table with the app (a few rows covering each answer and `review`) so its
  branches can be checked without a browser, and say in the version notes how to use it.
- Errors arrive as `kyoube.Error` with `code` `disabled`, `budget_exceeded`, `too_large`,
  `provider_rejected`, `provider_unavailable`, `timeout`, `limit` (more than 10 decisions in 10
  seconds), `forbidden` (the viewer cannot read the set's table, or the running version does not
  declare the set) or `not_found` (the row is gone). Show a short message and let the person carry
  on by hand.

## Connections: calling outside services

An app has no network, and must never hold a key. A **connection** is how it reaches a service the
company already uses (a payments API, a CRM, a weather feed): an admin sets it up once with the
company's key, and the host makes the call, so the key never reaches the browser or you.

### You cannot set one up: ask a person

You cannot create secrets or connections. When the task needs a service that is not listed, stop and
ask the user for exactly this:

1. A company admin stores the API key under **Company, then Secrets**.
2. An instance admin adds the connection under **Settings, then Plugins, then Kyoube Data & Apps**
   (pick the company), in the "connections" list, with: a `name` (lower-case letters, digits, `-` and
   `_`, starting with a letter), the base URL (`https://` only, such as `https://api.example.com/v1/`),
   the auth style (`bearer`, `header` with its header name such as `X-API-Key`, or `basic` where the
   secret is `user:password`), the secret, and the methods: `read` (GET only) or `read-write`.
3. Only if you yourself must call it (not just the app): an owner or admin gives you a grant under
   **Company Settings, then Data access, then Connections**: `read` or `read-write`.

### Find what exists

`GET /connections?companyId=$PAPERCLIP_COMPANY_ID` (tool `connections_list`) returns each connection's
`name`, `baseUrl`, `auth`, `methods`, `available` and your own `access` (`none`, `read` or
`read-write`). Never write a manifest for a connection you have not seen listed. `available: false`
means the connection's secret does not resolve; ask a person to fix it. The secret is never shown.

### Explore with a direct call (when you have a grant)

`POST /connections/{name}/call`, for example:

```sh
curl -fsS -H "$A" -H 'Content-Type: application/json' -X POST "$K/connections/crm/call" \
  -d "{\"companyId\":\"$PAPERCLIP_COMPANY_ID\",\"method\":\"GET\",\"path\":\"contacts\",\"query\":{\"limit\":\"5\"}}"
```

(`$K` and `$A` as in the kyoube-data skill.) The tool is `connections_call`, with `name` where the URL
has `{name}`. Body fields: `method` (default GET), `path`, `query` (an object of strings), `headers`,
`body`, plus `issueId` and `confirmationId` for the guardrail. The answer is `{ status, headers, body }`;
`body` is text, so parse JSON yourself. Look at a real response before you write code that depends on
its shape.

- `path` is relative to the base URL: write `contacts` or `images:annotate`, not `/contacts` and not a
  full URL. A leading `/` or `\`, `//`, `..` in any form, non-ASCII characters (percent-encode them), a
  stray `%` and control characters are refused with `invalid`. Put query values in `query`, not in the path.
- You may set only these headers: `accept`, `content-type`, `if-match`, `if-none-match`,
  `idempotency-key`, `x-request-id`. The credential is added for you.
- `body` is at most 1 MiB; an object or array is sent as JSON. A GET has no body.
- Every status comes back as it is, including 4xx, 5xx and 3xx (redirects are not followed). A 429
  arrives with its `retry-after` header. A 204 has an empty `body`.
- Responses are text only and at most 2 MiB; a larger one fails with `too_large`, and binary content
  comes back garbled. A whole call may take 25 seconds, then it fails with `timeout`.
- A `read` grant allows GET only. A call you are not granted fails with `forbidden`.
- When the company's guardrail is on, your non-GET calls need `issueId` set to `$PAPERCLIP_TASK_ID` and
  may come back `held`. Handle it as in the kyoube-decisions skill: wait for the person, then send the
  same call again with `confirmationId`. Reads are never held.
- Calls are audited (connection, method, path, status, size; never bodies or query values), and your
  calls also appear in the activity log. Send a person's private data only when the task requires it.

### Use it from an app

Declare each connection in the manifest with the least access the app needs. `read` is the default;
use `read-write` only for an app that must change something at the other end.

```json
"connections": [ { "name": "weather", "access": "read" }, { "name": "crm", "access": "read-write" } ]
```

At most 10 per app. Declaring `read-write` on a connection that only allows `read` fails at publish.

```js
const ctx = await kyoube.ready();
const weather = ctx.connections.find((c) => c.name === "weather");   // { name, access, available }
if (!weather || !weather.available) { showNote("Weather is not set up. Ask a company admin."); return; }
try {
  const res = await kyoube.connections.call("weather", { path: "forecast", query: { city: "Oslo" } });
  if (res.status !== 200) { showNote("The service answered " + res.status); return; }
  const forecast = JSON.parse(res.body);           // body is always a string
  render(forecast);
} catch (err) {
  showNote(err.message);                           // a kyoube.Error; see the codes below
}
```

- The call is `kyoube.connections.call(name, { method?, path?, query?, headers?, body? })` and returns
  `{ status, headers, body }`, with the same rules as above. A 4xx or 5xx `status` is a normal answer,
  not a thrown error: check it.
- Check `ctx.connections[].available` first and hide or explain the feature when it is false.
- Errors arrive as `kyoube.Error` with `code`: `forbidden` (the connection is not declared, or the
  declaration, the connection or the viewer's level does not allow the method), `invalid` (bad name,
  path, header or body), `disabled` (the connection is missing or its secret does not resolve; the host
  shows one toast per connection), `too_large` (response over 2 MiB), `timeout`, `provider_unavailable`
  (the service could not be reached) and `limit`. Handle every one with a short message; the rest of
  the app must keep working.
- Stay inside 30 connection calls per 10 seconds (they also count in the frame's 60); an app that keeps hitting a ceiling for three windows running is stopped. Fetch once and
  keep the result; never call inside a loop over rows.
- The viewer needs data level `read` for a GET and `write` for any other method, and the app never has
  more than its viewer.

### Publishing changes to connections

A version that adds a connection, or widens one from `read` to `read-write`, needs a person to publish
it (the publish dialog shows the host, auth style and methods, and the REST body carries
`connectionsConfirmed: true`). You cannot publish or roll back to such a version. Save the draft with
`apps_update` and ask the person who started the task to publish it from the Apps page. Removing or
narrowing connections needs no confirmation. Every connection a version declares must already exist in
the company's settings, or the publish fails naming the missing ones, so get the connection set up first.

## Tasks: handing work to an agent

A **task** lets an app ask one of the company's agents to do a piece of open-ended work (draft a reply
to a ticket, research a lead, summarise a contract) and show the result. The person using the app
presses a button; an agent does the work; the result comes back to the app.

Pick the right tool:

- **Task**: open-ended work an agent does over minutes, possibly writing rows.
- **A typed decision** (the "Typed decisions in an app" section): a closed question with a fixed answer
  (`approve` / `review` / `reject`), answered at once.
- **Connection** (the "Connections" section): fetching from or pushing to an outside service.

Only people start or cancel app tasks. An agent cannot start one, and an app cannot name an agent or
write instructions of its own: it picks a template a person confirmed at publish.

### Name the agent

A template names an agent by its name, exactly as the company shows it. Do not guess one. List the
company's agents:

```bash
curl -fsS -H "Authorization: Bearer $PAPERCLIP_API_KEY" "$PAPERCLIP_API_URL/api/companies/$PAPERCLIP_COMPANY_ID/agents"
```

Use the exact `name` of an agent whose `status` is not `terminated`. You may see only some of the
company's agents. If the call is refused, or the agent you need is not listed, then
ask the person which agent to name. The agent must exist and not be terminated or pending approval
at publish, or the publish fails with `invalid` naming it. A published version keeps the agent's id,
so renaming the agent later changes nothing.

### Declare templates in the manifest

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

- At most 10 templates per app. The key matches `^[a-z][a-z0-9_]{0,39}$`.
- `agent`: the agent's name, 1 to 120 characters. `title`: at most 200 characters after filling.
  `instructions`: 1 to 4,000 characters.
- `table` (optional) must be one the manifest declares in `tables`. `fields` lists 1 to 20 fields of
  it that exist at publish; only those fields' values are sent to the agent, for one row the viewer
  can read. Without `table` the template takes no row.
- `inputs` (optional): at most 5 inputs, names `^[a-z][a-z0-9_]{0,39}$`. Types: `choice` (1 to 20 options of
  at most 100 characters), `number` (`min?`, `max?`), `text` (`maxLength` 1 to 200, default 200).
  Every input is required when the task starts.
- `writes` (optional): the fields the agent is expected to write, a subset of `fields`. Needs `table`.
  The named agent needs Data write access for these, and so does the viewer. An admin gives the agent
  write access under Company Settings, then Data access. The publish dialog warns when it is missing,
  and tasks are refused until it is fixed.

**Keep instructions fixed and put the variable part in inputs and the row.** Write the instructions
once, as a person would brief a colleague. Anything that changes between tasks goes in a typed input
or in the row. Never build instructions from user text.

**Placeholders.** Only `{{row.<field>}}` (a field in `fields`) and `{{input.<name>}}` (a declared
input) are allowed in `title` and `instructions`; any other `{{...}}` fails validation. A filled value
is flattened to one line, has `{{` and `}}` removed and is cut to 200 characters. A title that
fills to nothing becomes the template key. Put row placeholders in the middle of a sentence, not at
the start of a line, and use them for readable titles. The agent also receives the full values (each
cut to 2,000 characters, the whole block at most 16,000, with `"_cut": true` when anything was cut)
in a fenced data block that it is told to read as data, not as instructions. Say in the instructions
what to do with the fields, not what the values say.

### Use it from the app

```js
const ctx = await kyoube.ready();      // ctx.tasks: { available, templates: [{ key, table, inputs, writes }] }
if (!ctx.tasks.available) { hideButton(); return; }

async function draftReply(rowId, tone) {
  try {
    const task = await kyoube.tasks.start("draft_reply", { rowId, inputs: { tone } });   // → the full task
    showStatus(task);
    const stop = kyoube.tasks.watch(task.id, (t) => {
      showStatus(t);
      if (t.status === "done") {
        resultEl.textContent = t.result ?? "";     // text only, never innerHTML
        reloadRow(rowId);                          // the agent may have written the row
      }
    });
    // call stop() when the person leaves the view
  } catch (err) {
    showNote(MESSAGES[err.code] || err.message);
  }
}
```

`kyoube.tasks.start(template, { rowId?, inputs? })` starts a task and returns it in full.
`kyoube.tasks.get(id)` reads one task, and `kyoube.tasks.list({ template?, rowId? })` returns this
app's tasks, newest first, at most 50. `kyoube.tasks.cancel(id)` cancels one. `kyoube.tasks.open(id)`
takes the person to the task page, at most once per 10 seconds. `kyoube.tasks.watch(id, onChange)`
follows a task and returns `stop()`.

- A task has `status` (`waiting`, `working`, `needs_review`, `blocked`, `done`, `cancelled`),
  `waitingReason`, `result` (the agent's latest reply for `done` and `needs_review`, otherwise
  `null`), `url`, `startedAt` and `updatedAt`.
- `watch` checks every 5 seconds, stops at `done` or `cancelled`, after 30 minutes, when the app
  closes, or when the task can no longer be read; passing failures are waited out. At most 10 watches
  at once. Stop a watch you no longer need.
- **Render `result` as text only** (`textContent`, never `innerHTML`): it is whatever the agent wrote.
  It is plain text, cut to 20,000 characters.
- **Re-read the data on `done`.** The agent writes rows with its own access, so call
  `kyoube.data.get` or `query` again; the app's copy is out of date.
- Show `waiting` with `waitingReason` (the core put the wake-up off; it starts the task later). A
  paused agent is refused at `start`, and a task whose wake-up the core refuses (over budget, say) is
  cancelled and `start` fails; both answer `disabled` with the reason, so ask the person to try
  later. Show `blocked` and `needs_review` as "the agent needs a person" and offer `open(id)`. A
  watch can stop without a word (after 30 minutes, or when the task can no longer be read), so keep
  the last status you saw on screen.
- **`cancel` cannot stop a run already in progress.** When the answer has `runMayContinue: true`,
  tell the person the agent's writes may still land. If recording the cancel fails the app gets an
  error although the task may already be cancelled: re-read it with `get`.
- Errors arrive as `kyoube.Error` with `code`:
  - `forbidden`: the viewer cannot open the app, can only read Data while the template writes, the
    agent has no write access ("Ask an admin to give <agent> write access to Data."), the assignment
    rules forbid the person from giving that agent work (the message is the core's reason), or only
    the starter or an admin may cancel. Show the message.
  - `invalid`: no row, a row for a template without a table, or an input that is missing or does not
    fit its type. Fix the call.
  - `not_found`: the template, row or task does not exist (or belongs to another app). Refresh.
  - `disabled`: the agent no longer exists or is terminated (tell the person to ask for the app to be
    republished), the agent is paused, or the core refused to wake it and the task was cancelled (ask
    them to try later). The message says which.
  - `limit`: 10 starts per minute per person per app, 25 open tasks per app, or 5 `tasks.start`
    per 10 seconds. Ask them to wait.
  - `conflict`: `cancel` on a task that is already done or cancelled. Re-read it with `get`.
  Handle every one with a short message; the rest of the app must keep working.
- Assignment follows the core's own rule: a protected agent needs a `tasks:assign` grant, even for an
  owner or admin (their role grants normally cover it). A viewer cannot run apps at all.

### Publishing templates

A version that adds a template, or changes any part of one (agent, title, instructions, table,
fields, inputs, writes), needs a person to publish it. The publish dialog shows each added or changed
template in full and the REST body carries `tasksConfirmed: true`; without it the publish fails with
`invalid`. The same holds for a version whose template text is unchanged but that would send the
work to a different agent than the published version does (a rollback to a version published for
another agent, for example). You cannot publish, or roll back to, such a version: for an agent it
fails with `forbidden`. Save the draft with `apps_update` or `POST /apps/{slug}` and ask the person
who started the task to publish it from the Apps page. Removing a template needs no confirmation.

## Workflow

1. Design or reuse tables with the `kyoube-data` skill (list tables, create tables).
2. Create the app with a manifest and the full source. This makes **draft version 1**.
3. Test in the browser? You cannot — ask the user to open the app; or reason carefully and keep the UI simple.
4. Publish (needs `schema` access; if you only have `write` access, ask an admin to publish from the app page).
5. Iterate with update (new draft version) → publish. Roll back restores an earlier version.

## Manifest

```json
{ "name": "Sales CRM", "slug": "sales-crm", "icon": "📇", "description": "Contacts and deals",
  "tables": [ { "name": "contacts", "access": "readwrite" }, { "name": "deals", "access": "readwrite" } ] }
```
`access` is `read` (default) or `readwrite`. A call on an undeclared table is rejected. The viewer's own
level still applies: a `viewer` can never write, whatever the app declares.

The gallery shows the **published** version's `name`, `icon` and `description`, so renaming an app in a
draft changes nothing anyone sees until you publish it — say so rather than telling the user the rename
has happened.

## window.kyoube (injected before your code runs)

```ts
await kyoube.ready()                       // → { companyId, viewer: { id, name, level }, app: { slug, name, version }, tables, decisions, connections: [{ name, access, available }], tasks: { available, templates } }
kyoube.data.query(table, { where?, orderBy?, limit?, offset?, fields? })   // → { rows, limit, offset }
kyoube.data.get(table, id)                 // → row | null
kyoube.data.count(table, where?)           // → { count }
kyoube.data.describe(table)                // → { fields: [{ name, kind, required, options }] }
kyoube.data.insert(table, rows)            // → created rows (validated by field kind)
kyoube.data.update(table, { ids } | { where }, patch)   // → { affected, rows }
kyoube.data.delete(table, { ids } | { where })          // → { affected }
kyoube.ui.toast(title, "info" | "success" | "warn" | "error")
kyoube.ui.openApp(slug)
kyoube.ui.download(filename, data)         // saves a file on the viewer's computer (see Saving files)
kyoube.connections.call(name, { method?, path?, query?, headers?, body? })   // → { status, headers, body }
kyoube.tasks.start(template, { rowId?, inputs? })   // → task; also get, list, cancel, open, watch (see Tasks)
```
`where` grammar: `{ field, op, value }` with `eq neq gt gte lt lte in contains starts_with is_null is_not_null`,
combined with `{ and: [...] }`, `{ or: [...] }`, `{ not: {...} }`. Errors are thrown as `kyoube.Error` with
`code` (`forbidden`, `invalid`, `not_found`, `conflict`, `limit`). Every row has `id`, `created_at`, `updated_at`.
`viewer.name` is always `""` in v1 (the host gives the worker ids, not display names) — use `viewer.id`,
or nothing; branch on `viewer.level` (`read`, `write`, `schema`) to hide controls the viewer cannot use.

## Saving files

To let the person export something (a sheet, a report, a CSV), build the file's bytes in the app and
call `kyoube.ui.download(filename, data)` from the click handler of the button they press:

```js
exportButton.addEventListener("click", async () => {
  try { await kyoube.ui.download("balloons.csv", toCsv(rows)); }
  catch (err) { if (err.code !== "declined") kyoube.ui.toast(err.message, "error"); }
});
```

- `data` is a string (saved as UTF-8), a `Blob`, an `ArrayBuffer` or a typed array. Build xlsx, docx
  or zip bytes yourself in the app's own script; nothing can be loaded from a CDN.
- Allowed types: csv, tsv, txt, json, md, xlsx, docx, pptx, pdf, png, jpg/jpeg, zip. At most
  25 MB. The host cleans the name and sets the type from the extension; anything else is refused with
  `invalid` (`too_large` over the size).
- Make the call straight from the click. If the file takes more than a few seconds to build, the
  person sees a Save/Dismiss bar instead; if they dismiss it, the call rejects with `declined`:
  don't retry it, they said no.
- At most 3 downloads per 10 seconds, counted inside the 60 requests (`limit` over that).
- Don't build `<a download>` links or `blob:` URLs yourself: they skip the host's checks, may not work
  in every browser, and the person gets no Save bar when it's needed.

## Rules for the source

- Start with `<!doctype html>`; put CSS in `<style>` and JS in `<script>` — no `src=`, `href=` to the network, no `fetch`.
- No `eval` and no `new Function`: the policy carries no `'unsafe-eval'`, so both throw.
- Use `kyoube.ready()` before the first data call; render loading and error states; keep lists paged (`limit` ≤ 200).
- Use semantic HTML and plain CSS; it must be readable on a 1024px-wide panel, on a 375px-wide phone, and in dark mode (`prefers-color-scheme`). On a phone: forms wrap (`flex-wrap: wrap`), wide tables scroll inside their own box (`overflow-x: auto`) or become one card per row, and every button and input is at least 44px tall.
- **Never navigate the frame.** Assigning `location`, linking to another document, or submitting a form
  stops the app: a second page load is treated as the app navigating away, the `window.kyoube` bridge
  dies, and the frame is replaced with a notice. Use `kyoube.ui.openApp(slug)` to open another app, keep
  links in-page (`href="#…"`), and `preventDefault()` on every form submit.
- **Stay inside the call budget:** 60 requests per rolling 10 seconds per app frame, of which at
  most 5 may be toasts. Every call counts, including ones the host rejects. Over the ceiling a call
  throws `kyoube.Error` with `code: "limit"`; an over-quota toast is dropped; three limited windows
  in a row stop the app. Batch — one `query` with a `limit` beats sixty `get`s, and `insert` takes an
  array — and never poll on a timer faster than a few seconds.
- No `<link rel="dns-prefetch">` and no `<link rel="preconnect">`: they are the one network-shaped
  thing the policy does not govern, so they are forbidden by rule rather than by the browser. They
  fetch nothing for you regardless.
- Never store secrets or tokens in the app; never assume other companies' data exists.
- Keep the whole file under 2 MiB (usually well under 100 KB).
- `window.kyoube` is the only way to reach the host, and it is the only thing that can: the runner
  hands the SDK a per-mount handshake nonce before your code is parsed and refuses messages without
  it, so hand-rolled `postMessage` calls do nothing and three of them stop the app. The SDK deletes
  the global and removes the script that carried it as it installs, and it binds `window.parent`
  before your code is parsed — so the nonce is reachable through neither `window`, the DOM, nor the
  SDK's own outgoing messages. Everything you are meant to have, you get from `kyoube.ready()`,
  which is also how you wait for the context.

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

## Reporting back

Tell the user the app's slug and link (`/<company>/app-artifact/<slug>`), which version is published and
which is the latest draft, and which tables it uses, and which connections it declares.

To classify, score or check rows with the company's typed-decision model, see the kyoube-decisions
skill (`POST /decisions/decide` with `rows`).

If the company's guardrail is on, `apps_publish`, `apps_rollback` and `apps_archive` (and their REST
routes) need `issueId` set to your task's id, `$PAPERCLIP_TASK_ID`. A `held` answer means stop and
wait for the person; see the kyoube-decisions skill.
