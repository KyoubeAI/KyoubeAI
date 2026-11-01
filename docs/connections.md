# Connections

A connection lets a Kyoube App or an agent call an outside service (a payments API, a CRM, a weather
feed) with a key the company stores once. The key stays on the server: the app runs in a sandbox with
no network, and the host makes the call for it. This page covers how an admin sets a connection up,
who may use it, the rules for a request, the limits, and what is logged. The code is in
`plugins/kyoube-apps/src/connections/`. Connections are free; no licence is needed.

## What a connection is

A connection is a named base URL plus the credential for it. Each one has:

| Field | What it is |
|---|---|
| `name` | Lower-case letters, digits, `-` and `_`, starting with a letter, 1 to 40 characters, unique in the company. Apps and agents refer to it by name. |
| `baseUrl` | An absolute `https://` URL. It is saved ending in `/`; any query or fragment is dropped, and credentials in the URL are refused. |
| `auth` | `bearer` sends `Authorization: Bearer <secret>`. `header` sends the secret in a header you name (for example `X-API-Key`). `basic` treats the secret as `user:password` and sends it base64-encoded. `authorization` sends `Authorization: <secret>`, the bare key, for APIs such as Postiz that take it without `Bearer`. |
| `headerName` | The header for `header` auth. `authorization`, `cookie`, `host`, `content-length`, `content-type`, the hop-by-hop headers (`connection`, `keep-alive`, `te`, `trailer`, `transfer-encoding`, `upgrade`) and `expect`, `proxy-*` and prototype-style names are refused. |
| `secret` | A company secret, picked with the core's secret picker. |
| `methods` | `read` allows GET only. `read-write` allows GET, POST, PUT, PATCH and DELETE. |

A company can have at most 20 connections. OAuth and per-person credentials are not supported; the
credential is one stored key.

## Setting one up

Two people may be involved, because KyoubeAI cannot create secrets.

1. A company admin stores the API key under Company, then Secrets.
2. An instance admin opens Settings, then Plugins, then Kyoube Data & Apps and picks the company.
   In the "connections" list, add the connection: name, base URL, auth style (and header name), the
   secret, and the methods.

Saving the settings applies at once. A rotated secret takes effect within 60 seconds, or immediately
when the plugin settings are saved. The core allows a company 30 secret lookups a minute and counts
failed ones, so after a secret fails to resolve, calls on that connection answer `disabled` for 15
seconds without asking again (the status checks wait a minute). Saving the settings clears that wait.
Company Settings, then Data access, then Connections shows each connection's host, auth style and
methods, its status ("ready", "secret doesn't resolve", "the secret contains a line break or other
control character" (often a newline pasted with a bearer or header key; save the secret again
without it), "too many secret lookups just now" or "missing", the last for a connection some app
declares that is not configured), and which published apps use it.

Give a connection the narrowest methods that do the job. A `read` connection cannot be written to
whatever an app or agent asks for.

## Who may call

**Apps.** The viewer must be able to open the app, and the app's published manifest must declare the
connection (see [apps.md](apps.md#connections)). A GET needs the viewer's data level `read`. Any other
method needs `write`, the declaration `read-write`, and the connection's methods `read-write`. A
declaration can narrow what the connection allows and never widens it. Owners and admins follow the
same rules inside an app. On core 2026.1012.0 a member with the core `viewer` role cannot run apps
at all (the core refuses their every action with "Viewer access is read-only"), so in practice these
rules apply to members above viewer, at the data level their groups or role give them.

**Agents.** An agent needs a grant per connection, set by an owner or admin under Company Settings,
then Data access, then Connections: `none` (the default), `read` or `read-write`. A grant never
widens the connection, so `read-write` on a `read` connection still allows reads only. A grant names
the connection, so renaming a connection ends its effect; the page lists such orphaned grants so an
admin can remove them or grant again.

**People calling the REST route** (for example testing from a terminal with a board key) need data
level `read` for GET and `write` for other methods. Owners and admins may use any method the
connection allows.

## Calling

### From an app

```js
const ctx = await kyoube.ready();                       // ctx.connections: [{ name, access, available }]
const res = await kyoube.connections.call("weather", { path: "forecast", query: { city: "Oslo" } });
const data = JSON.parse(res.body);                      // body is always a string
```

`available` is false when the connection is missing or its secret does not resolve. When a call comes
back `disabled`, the host shows one toast per connection per mount. The full contract, a complete
example and the error codes are in [apps.md](apps.md#connections).

### From an agent

`GET /connections?companyId=…` (tool `connections_list`) returns every connection's `name`,
`baseUrl`, `auth`, `methods`, whether it is `available`, and the caller's own access. It never returns
a secret. Listing needs data level `read`, for an agent as for a person; below it the answer is
`forbidden`.

`POST /connections/{name}/call` (tool `connections_call`) takes:

```json
{ "companyId": "…", "method": "GET", "path": "contacts", "query": { "limit": "5" },
  "headers": {}, "body": null, "issueId": "…", "confirmationId": "…" }
```

Only `companyId` is required. Both routes live under `$PAPERCLIP_API_URL/api/plugins/kyoube.apps/api`.

```sh
K="$PAPERCLIP_API_URL/api/plugins/kyoube.apps/api"
A="Authorization: Bearer $PAPERCLIP_API_KEY"
curl -fsS -H "$A" "$K/connections?companyId=$PAPERCLIP_COMPANY_ID"
curl -fsS -H "$A" -H 'Content-Type: application/json' -X POST "$K/connections/crm/call" \
  -d "{\"companyId\":\"$PAPERCLIP_COMPANY_ID\",\"path\":\"contacts\",\"query\":{\"limit\":\"5\"}}"
```

When the company's guardrail is on ([decisions.md](decisions.md#switching-uses-on)), an agent's
non-GET call waits for a person's confirmation card that names the connection, method and path, never
the body. The agent passes `issueId` (its task) and, after the person allows it, repeats the same call
with `confirmationId`. A confirmed call cannot be swapped for another: the confirmation covers the
connection, method, path, query and body. GET calls are never held.

## The request

- **Path.** It is relative to the base URL and joined to it as text, so `contacts` and Google-style
  `images:annotate` both work. Refused with `invalid`: an absolute URL, a leading `/` or `\`, `//`,
  dot segments in any form (plain, encoded, double-encoded, full-width, and the forms a server
  normalises such as `..;`), raw non-ASCII characters (percent-encode them), a `%` left over after
  decoding, and control characters. A request cannot leave the base URL's scheme, host, port or path.
- **Query.** An object of strings in `query`, encoded for you. Do not put a `?` in the path.
- **Headers.** The caller may set only `accept`, `content-type`, `if-match`, `if-none-match`,
  `idempotency-key` and `x-request-id`. The credential is added by the server, and the caller cannot
  set `authorization`, `cookie`, `host` or the connection's own header.
- **Body.** A string or a JSON value, at most 1 MiB. A JSON value is sent with
  `content-type: application/json`. A GET carries no body.
- **Response.** `{ status, headers, body }`. Every status comes back as it is, including 4xx, 5xx and
  3xx: redirects are not followed, so a credential cannot be bounced to another host. Only these
  response headers are returned: `content-type`, `content-length`, `etag`, `last-modified`,
  `location`, `retry-after`, `x-request-id` and `x-ratelimit-*`. A service's `set-cookie` or echoed
  auth headers never reach the caller. A 204, 205 or 304 returns an empty `body`.
- **Text only.** The body is read as text, at most 2 MiB; a longer one fails with `too_large`. Binary
  responses (images, PDFs, archives) are not supported and come back garbled.

## Limits

| Limit | Value |
|---|---|
| Connections per company | 20 |
| Connections declared by one app | 10 |
| Request body | 1 MiB |
| Response body | 2 MiB (text) |
| One call, start to finish | 25 seconds, then `timeout` |
| Calls from one running app | 30 per 10 seconds, inside the frame's 60 per 10 seconds |

The core refuses private and reserved addresses for every plugin request, so a service has to be
reachable at a public HTTPS address; an internal API on a private network cannot be a connection.

## Publishing an app that uses connections

A version that adds a connection or widens one from `read` to `read-write` has to be published by a
person. The publish dialog lists each declared connection with its host and base path, its auth
style, the connection's methods and the app's declared access, and marks only the connections the
version adds or widens. The person confirms that the app may call these services with the company's
credentials, and the REST body carries `connectionsConfirmed: true`. Without it, that publish fails
with `invalid`.

Agents cannot publish, or roll back to, a version that adds or widens a connection. They save the
draft and ask a person. Removing or narrowing connections needs no confirmation, and every connection
a version declares has to exist in the company's settings at publish time or the publish fails
naming the missing ones. If a connection's base URL later changes to another host, apps keep
working. The publish dialog shows the new host; a confirmation is asked only when the version adds
or widens a connection.

## What is logged

Every call writes one audit row: the connection, method, path **without** the query, status, duration,
response size, who called, and how (`app@<slug>@<version>` for an app, e.g. `app@dash@3`, and
`agent` or `person` for a direct call). Request and response bodies, query values, headers and the
secret are never recorded. Agent calls also add a line to the activity log; app calls do not,
because they are frequent. A completed write whose audit row cannot be saved still returns its
response (the failure is logged on the server). A GET whose audit row cannot be saved fails, so a
read is never unrecorded.

## Troubleshooting

| What you see | Likely cause |
|---|---|
| `disabled` | The connection is missing, renamed or removed, or its secret does not resolve or contains a line break. Check the Connections section under Data access, and the secret under Company, then Secrets. |
| `forbidden` | The app does not declare the connection, or the declaration, the connection or the person's level does not allow the method; for an agent, it has no grant or only a `read` one. |
| `invalid` | The path, query, header or body broke a rule above, or a publish lacks `connectionsConfirmed`. |
| `too_large` | The response is over 2 MiB. Ask the service for less (a filter, a page size). |
| `timeout` | The service took longer than 25 seconds. |
| `provider_unavailable` | The host could not be reached, or resolves to a private address. |
| `limit` | More than 30 calls in 10 seconds from one app (fetch once and keep the result), or the company used up the core's 30 secret lookups a minute (wait up to a minute). |
| status 401 or 403 in the response | The service rejected the key. The call itself worked; fix the secret or the service's permissions. |
| status 429 | The service is rate limiting. Read `retry-after`. |

## What connections do not do

A published app can send data its viewer can read to a service it declared, and a read-only
connection limits changes at the other end, not what a GET's query can carry. An agent with a grant
can do the same within its grant. That is why a person confirms what an app may call at publish, and
why agent grants are explicit. See [SECURITY.md](../SECURITY.md#connections).
