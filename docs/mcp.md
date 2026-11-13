# Assistant connections (MCP)

An assistant connection lets an AI assistant you already use (Claude, Claude Code, Codex, OpenCode,
or any MCP client that signs in with OAuth) work with your KyoubeAI company from outside the app. It
can read and update tasks, agents, projects and skills, and work with your data tables, apps and
project files. It
always acts as you, with your own access, never as a KyoubeAI agent.

The server is the core's own MCP endpoint, served by KyoubeAI at `/mcp/kyoubeai`. KyoubeAI adds its
table, app and file tools to it, renames every tool `kyoubeai_*`, and gives each one a title. The connection
is off until an instance admin turns it on.

## Two layers of permission

Every call passes two checks, and either can refuse it.

1. **What the connection may do.** When you approve a connection you pick one company and decide
   whether it may write. Each tool is in one of three tiers: **read**, **write** or **configure**.
   A read-only connection can call read tools only. A connection with write access can also call
   write and configure tools. A person with a read-only role in the company (the core's viewer) is
   refused every write, whatever the connection allows.
2. **What you may do in KyoubeAI.** The call then runs as you. For tables and apps, your Kyoube data
   level decides (`none < read < write < schema`, from your company role, adjusted by your groups), and
   so do the app checks you meet on the Apps page. A connection can never do more than you can do
   in the app.

So a connection with configure access, held by a member whose data level is `write`, can insert rows
but cannot drop a table. The refusal comes back to the assistant as a message, for example
`forbidden: … requires schema access (you have write)`.

## Turning it on

1. Sign in as an instance admin and open **Settings → Experimental**. Turn on **Assistant connections
   (MCP)**. It takes effect at once; turning it off blocks every assistant call, and saved connections
   are kept.
2. Give the instance an `https://` address in `KYOUBE_PUBLIC_URL`. Assistants sign in with OAuth, and
   the sign-in only works over `https://`, or on `localhost` for a client on the same machine (Claude
   Code, Codex, OpenCode). Claude on the web, Desktop and mobile always needs public HTTPS.
3. Behind a reverse proxy or tunnel, set `TRUST_PROXY` too
   ([operations.md](operations.md#reaching-kyoubeai-from-other-machines)), so the sign-in pages are
   built with the address people use.
4. If a firewall or WAF sits in front of the instance, let Anthropic's range `160.79.104.0/21` reach
   it. Claude on the web, Desktop and mobile calls your instance from there. Claude Code, Codex and
   OpenCode call it from the machine they run on.

`kyoube doctor` reports the state on its `assistant connections` line:

```
ok   assistant connections off — Settings → Experimental → Assistant connections (MCP) to turn on (docs/mcp.md)
ok   assistant connections on at https://kyoube.example.com/mcp/kyoubeai, 37 KyoubeAI tools — Add to Claude: https://claude.ai/customize/connectors?modal=add-custom-connector&connectorName=KyoubeAI&connectorUrl=https%3A%2F%2Fkyoube.example.com%2Fmcp%2Fkyoubeai
ok   assistant connections on at http://localhost:3100/mcp/kyoubeai, 37 KyoubeAI tools — Claude Code: claude mcp add --transport http kyoubeai http://localhost:3100/mcp/kyoubeai
FAIL assistant connections on, but KYOUBE_PUBLIC_URL is not https:// — assistants cannot sign in (docs/mcp.md)
FAIL assistant connections on, but the table and app tools are unavailable — see Settings → Plugins → kyoube.apps → Logs
WARN assistant connections on at http://localhost:3100/mcp/kyoubeai, 29 KyoubeAI tools; files tools missing (kyoube.files not answering) — Claude Code: claude mcp add …
```

On a `localhost` address the line gives the Claude Code command instead of the **Add to Claude**
link, since Claude on the web cannot reach `localhost`. The failure means the `kyoube.apps` plugin is
not answering, and the warning that `kyoube.files` is not (the count then leaves out the 8 file tools).
The core's own tools still work. On an instance with no company yet, the line ends
`— no company yet` instead of the link.

## Connecting an assistant

The server address is `<KYOUBE_PUBLIC_URL>/mcp/kyoubeai`. The setup page gives the exact steps for
each assistant with your address filled in. Open it from **Connectors → Assistant Connection (MCP)**
(**Set up manually**), or at `<KYOUBE_PUBLIC_URL>/mcp/setup`. The same page offers an invitation you
can paste into an assistant so that it sets itself up.

Whichever assistant you use, the sign-in ends on KyoubeAI's consent page. It names the assistant and
its callback address. Pick the company (**Organization**), leave **Write all of your KyoubeAI data**
ticked if it may make changes, and choose **Connect organization**. That one box grants both write and
configure access, when the assistant asked for them. Untick it for a read-only connection. A
connection is bound to the company you pick; to work with a second company, connect again under
another server name.

### Claude (web, Desktop, mobile)

Open the **Add to Claude** link from the setup page or `kyoube doctor`:

```
https://claude.ai/customize/connectors?modal=add-custom-connector&connectorName=KyoubeAI&connectorUrl=<your server address, URL-encoded>
```

It opens Claude's custom connector form with KyoubeAI filled in. Choose **Connect**, then approve the
connection in KyoubeAI. In a conversation, turn the KyoubeAI connector on from the tools menu. On
Claude's Team and Enterprise plans only an Owner adds custom connectors for the organisation. The
instance must be reachable over public HTTPS.

### Claude Code

```bash
claude mcp add --transport http kyoubeai 'https://kyoube.example.com/mcp/kyoubeai'
```

Then run `/mcp` in Claude Code, select `kyoubeai` and choose **Authenticate**. Claude Code opens the
consent page in your browser and takes the answer on a local callback, so it also works against an
instance at `http://localhost:3100`. Until you sign in, `claude mcp list` shows the server as
"Needs authentication".

### Codex

```bash
codex mcp add kyoubeai --url 'https://kyoube.example.com/mcp/kyoubeai'
codex mcp login kyoubeai --scopes paperclip:read,paperclip:write,paperclip:configure,offline_access
```

### OpenCode

For OpenCode 1.x, merge this into `opencode.json`:

```json
{
  "mcp": {
    "kyoubeai": {
      "type": "remote",
      "url": "https://kyoube.example.com/mcp/kyoubeai",
      "enabled": true,
      "oauth": { "scope": "paperclip:read paperclip:write paperclip:configure offline_access" }
    }
  }
}
```

Then run `opencode mcp auth kyoubeai` from the same directory.

### Other clients

Add a remote HTTP MCP server at the server address and choose OAuth sign-in. The server supports
dynamic client registration, client ID metadata documents, PKCE (S256) and the device grant. The scope
names are `paperclip:read`, `paperclip:write` and `paperclip:configure` (kept from the core, since
connections store them; people only see them as plain labels), plus `offline_access`.

After connecting, ask the assistant to call `kyoubeai_connection`. It shows who you are connected as,
the company and the access the connection has.

## The tools

The core's own tools cover work: `kyoubeai_connection`, tasks (`kyoubeai_search_tasks`,
`kyoubeai_create_task`, `kyoubeai_update_task` and the rest), comments, documents, deliverables,
approvals, agents, projects and skills. Ask the assistant for its tool list to see them all. The core's
two generic tools, `search_api` and `call_api`, are removed: they reached every operation through one
tool, which hides what a call does.

KyoubeAI adds 37 tools for data tables, apps, app tasks and project files, all run as you. The table
and app tools are the operations agents use; the app task tools run the checks of an app's task
button, and the file tools the operations of the Files tab:

| Tier | Tools |
|---|---|
| read | `kyoubeai_data_list_tables`, `kyoubeai_data_describe_table`, `kyoubeai_data_list_review`, `kyoubeai_data_get`, `kyoubeai_data_query`, `kyoubeai_data_count`, `kyoubeai_data_sql_select`, `kyoubeai_data_my_access`, `kyoubeai_apps_list`, `kyoubeai_apps_get`, `kyoubeai_apps_task_list`, `kyoubeai_apps_task_get`, `kyoubeai_files_folders`, `kyoubeai_files_list`, `kyoubeai_files_read` |
| write | `kyoubeai_data_insert`, `kyoubeai_data_update`\*, `kyoubeai_data_delete`\*, `kyoubeai_apps_create`, `kyoubeai_apps_update`, `kyoubeai_apps_task_start`, `kyoubeai_apps_task_cancel`\*, `kyoubeai_files_write`\*, `kyoubeai_files_edit`\*, `kyoubeai_files_create_folder`, `kyoubeai_files_move`, `kyoubeai_files_delete`\* |
| configure | `kyoubeai_data_create_table`, `kyoubeai_data_add_field`, `kyoubeai_data_update_field`, `kyoubeai_data_remove_field`\*, `kyoubeai_data_drop_table`\*, `kyoubeai_data_rename_table`, `kyoubeai_data_create_index`, `kyoubeai_apps_publish`, `kyoubeai_apps_rollback`, `kyoubeai_apps_archive`\* |

\* Marked destructive, so assistants that ask before a destructive call will ask.

Every tool has a title ("Query rows", "Publish app") and tells the assistant whether it only reads.
Some rules apply to every call:

- **`requestId`.** Each write and configure call carries a new UUID. If the same `requestId` comes
  again with the same arguments, the stored result is returned and nothing runs twice; with different
  arguments it is refused. Assistants handle this themselves.
- **The company comes from the connection.** No argument can name another company.
- **The guardrail does not apply.** The company's guardrail on risky agent actions
  ([decisions.md](decisions.md#the-guardrail)) checks agents only, and a call over a connection counts
  as you.
- **Refusals carry their reason.** A Kyoube refusal comes back as `outcome: "rejected"` with its code
  and message, such as `forbidden` with the level you lack, or `invalid` with the field at fault. A
  server error on a write or configure call comes back as `outcome: unknown`, which tells the assistant
  to check before acting again; on a read it comes back as the core's generic "rejected the operation
  (HTTP 500)" message. The error itself stays in the server log.
- **Long results are cut** at 20,000 characters, with the same note agents get: narrow the query or
  use `limit` and `offset`.

Typed decisions and outside connections are not on the connection yet.

### Project files

The `kyoubeai_files_*` tools work in a project's folder, the same one agents work in and the Files tab
shows ([README](../README.md#files)). Start with `kyoubeai_files_folders` to get the project's folder
ids; `folderId` is only needed when a project has more than one. Paths are relative to the folder, and
a path that leaves it is refused as invalid. No server path is shown.

- **Listing.** `kyoubeai_files_list` shows size and last-modified time, one level by default and up to
  three with `depth`. A long listing comes in pages of at most 500 entries, fewer when names are long:
  a page that is not the last says `cut` and gives a `nextOffset` to send back as `offset` for the
  next one.
- **Reading.** `kyoubeai_files_read` returns a text file in pages of up to 2000 lines (`offset` and
  `limit`) with the total line count. A page too long for one answer is shortened to whole lines, and
  its note gives the `offset` to continue from. A file that is not text, or is larger than the
  editable size setting, comes back as a link to open in KyoubeAI instead of its content.
- **Writing.** `kyoubeai_files_write` creates or replaces a file. `createOnly` refuses when the file
  exists. `kyoubeai_files_edit` replaces a passage and needs it to match exactly once, unless
  `replaceAll` is set, so the assistant reads the file first.
- **Not overwriting someone's change.** Listings and reads give each file's `modifiedAt`. Send it back
  as `expectedModifiedAt` on a write or edit and the call is refused if the file was changed, moved or
  deleted since.
- **Moving and deleting.** `kyoubeai_files_create_folder` needs the parent to exist. `kyoubeai_files_move`
  overwrites nothing. `kyoubeai_files_delete` removes a folder and its contents only with `recursive`,
  and cannot be undone.

The Files settings still apply: your company role decides whether you can browse and whether you can
change files, and need-to-know visibility on the project decides whether you see it at all. The
assistant gets the same refusals you would in the app.

### App tasks

The `kyoubeai_apps_task_*` tools start and follow the tasks an app's templates define
([app-tasks.md](app-tasks.md)). `kyoubeai_apps_get` shows an app's templates under `tasks` in its
manifest, and `kyoubeai_apps_task_start` starts one with the row and the inputs the template declares;
every declared input is required. The call runs the same checks as the app's button, in the same order
(access to the app, the row, your data level, the inputs, the agent, the assignment rule, the limits),
and a refusal comes back with its reason. `kyoubeai_apps_task_list` and `kyoubeai_apps_task_get` show
the tasks an app started with their status and reply, and `kyoubeai_apps_task_cancel` cancels one; a
run the agent has already begun may finish its current step.

### Publishing an app that changes what it sends

On the Apps page, publishing or rolling back a version that adds or changes decision sets, connections
or task templates needs a person to confirm what changed, and an agent can never do it. Over an
assistant connection the call counts as you, so it is allowed. The assistant must send
`decisionsConfirmed`, `connectionsConfirmed` or `tasksConfirmed`, and the tool tells it to show you
what changed and get your agreement first.

The trade-off: the assistant writes that call, and the only check left is the one your assistant
shows you before it runs a tool. Read that prompt before you approve a `kyoubeai_apps_publish` or
`kyoubeai_apps_rollback`. If you want the Apps page's own review, publish those versions there.

## Managing connections

`/assistant-connections` lists every connection you have approved: the assistant, the company and its
access ("Read and edit work", "Configure agents, projects, skills, tables and apps"). **Revoke
connection** stops its future calls at once. Work it already started, such as a task assigned to an
agent, carries on. The same list is under **Your connected assistants** on the setup page in
Connectors.

Each write or configure call is recorded in the company's activity log as `mcp.tool_called`, with the
tool name. Changes to tables also go to `kyoube_meta.audit`, as they do from the Data page.

## Limits

- **The instance must be reachable by the assistant.** Claude on the web, Desktop and mobile reaches
  your instance from Anthropic's servers, so a private instance (on a LAN or behind a VPN) cannot be
  connected there. Claude Enterprise's MCP tunnels are the exception. Claude Code, Codex and OpenCode
  run on your machine and reach whatever it can.
- **Claude's connector directory.** KyoubeAI is not listed there yet. Add it as a custom connector.
- **`/mcp/paperclip` is gone.** Connections made before 1.17 used that address and must be made
  again ([upgrading.md](upgrading.md#moving-to-117)).

## Troubleshooting

| What you see | Why, and what to do |
|---|---|
| "KyoubeAI's table, app and file tools are unavailable right now. Try again in a minute." | The plugin behind the tool did not answer: `kyoube.apps` for a table or app tool, `kyoube.files` for a file tool. KyoubeAI does not keep a failed answer, so the next call asks again. Check `kyoube doctor` and the plugin's logs. |
| The assistant lists the `kyoubeai_*` work tools but no `kyoubeai_data_*` or `kyoubeai_apps_*` | The same: the plugin was unavailable when the tools were listed. List the tools again. |
| The assistant lists the other tools but no `kyoubeai_files_*` | The `kyoube.files` plugin did not answer. Check `kyoube doctor` and its logs. |
| "paperclip:write permission is required" | The connection was approved without **Write all of your KyoubeAI data**. Connect again with it ticked. |
| `forbidden: … requires schema access` | Your own data level is too low. Ask an admin to raise it, or a group to grant it. |
| The assistant cannot sign in | Check that `KYOUBE_PUBLIC_URL` is `https://` (or `localhost`), that `kyoube doctor` says `on at …`, and, behind a proxy, `TRUST_PROXY`. |
