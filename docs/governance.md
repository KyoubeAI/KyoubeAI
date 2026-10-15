# Access governance for agents

This page is about what an agent's tools may touch. How agents hand work to each other, and who
approves what, is set by the agent working rules: [`agent-rules.md`](agent-rules.md).

Two independent gates decide whether an agent's call to a Kyoube tool actually does anything. Get
both right before you hand an agent broad tool access:

1. **Kyoube's own grant levels** (`none < read < write < schema`) decide whether the *plugin worker*
   accepts the call at all, for that company. This is enforced inside `kyoube.apps` on every request —
   there is no way around it from inside a tool call, and it is the same check whether the caller is a
   person on the Data page or an agent using `kyoube.apps:data_*`/`kyoube.apps:apps_*`.
2. **The core's (Paperclip's) tool profiles and policies** decide whether the agent's *tool call* is even allowed to
   reach the plugin, and whether it needs a human's sign-off first. This is the core's own MCP Access
   Governance layer — full reference in upstream's
   [`doc/MCP-ACCESS-GOVERNANCE.md`](https://github.com/paperclipai/paperclip/blob/main/doc/MCP-ACCESS-GOVERNANCE.md).
   As that document puts it: **a profile decides *can this agent see the tool*; a policy decides *is
   this exact call allowed right now***.

**Which gate applies depends on how the agent reaches Kyoube.** The core's profiles and policies govern
tool calls that pass through its MCP gateway, and the core (2026.831.1 through 2026.1012.0) only gives a run that gateway
when the agent already has an installed MCP connection (see `architecture.md`, "Agent run → Kyoube").
The managed skills therefore lead with Kyoube's REST routes, which every run can call with its own
`PAPERCLIP_API_KEY` — and a REST call is checked by gate 1 only. If you want gate 2 as well (an
approval on `data_drop_table`, say), connect an MCP server to the company so that its agents receive
the gateway, and the `kyoube.apps:*` tools with it; until then, the agent's Kyoube grant level is the
whole story, so grant `schema` only to the agent you would let drop a table.

The two are complementary, not redundant. Kyoube's grant level is the guarantee that holds even if a
profile is misconfigured — an agent at `none` cannot write a row no matter what the core lets it call.
The core's profiles and policies are the guardrail you can tighten *without touching the plugin*: they
run before the call ever reaches `kyoube.apps`, they can force human approval for a specific dangerous
tool regardless of the agent's own data-access grant, and they are what gives you a per-tool audit trail
of every attempted call, allowed or not (`GET /api/tool-gateway/audit`).

The recipe below builds a company profile that only exposes Kyoube's read tools by default, a policy
that forces human approval for the three most consequential write calls, and a rate limit on bulk
inserts. All three examples use the tool names exactly as the host namespaces them:
`kyoube.apps:data_*` and `kyoube.apps:apps_*` (the core's plugin tools are namespaced
`<pluginId>:<toolName>`).

Every command needs `$KYOUBE_URL` (the core's base URL), `$BOARD_API_KEY` (an instance-admin key —
see [`docs/operations.md`](operations.md#rotating-the-board-api-key)), and `$COMPANY_ID`.

### A third gate: the typed-decisions guardrail

Both gates above decide whether a call is *allowed*. A company that has typed decisions set up
([`decisions.md`](decisions.md)) can add a third that decides whether an allowed call is *wanted*:
**Guardrail on risky agent actions**, under Company Settings → Data access. It runs inside
`kyoube.apps`, so it covers the REST path as well as tools, for `data_drop_table`,
`data_rename_table`, `data_remove_field`, bulk `data_update`/`data_delete`, and `apps_publish`,
`apps_rollback`, `apps_archive`, and an agent's write requests (anything but GET) to
connected external services ([`connections.md`](connections.md); the operation is `connection_write`,
and GET calls are never held). It can only hold a call, never allow one the grant level refuses.
A held call waits on a people-only confirmation card on the agent's task. It is not a security
boundary: the grant level is. Grant `schema` as narrowly as before, and use the guardrail to catch
the allowed call that does not fit the task.

## 1. A read-only default profile

Create a profile that includes only Kyoube's read-level tools — `data_list_tables`,
`data_describe_table`, `data_query`, `data_get`, `data_count`, and `data_sql_select` — matched by
`selectorType: "tool_name"`, one exact name per entry (kept explicit rather than a single wildcard
pattern, so the profile does exactly what it says regardless of how a given core version matches a
glob):

```sh
curl -fsS -X POST -H "Authorization: Bearer $BOARD_API_KEY" -H "Content-Type: application/json" \
  "$KYOUBE_URL/api/companies/$COMPANY_ID/tools/profiles" \
  -d '{
    "profileKey": "kyoube.safe-default",
    "name": "Kyoube safe default (read-only)",
    "defaultAction": "deny",
    "entries": [
      { "selectorType": "tool_name", "toolName": "kyoube.apps:data_list_tables", "effect": "include" },
      { "selectorType": "tool_name", "toolName": "kyoube.apps:data_describe_table", "effect": "include" },
      { "selectorType": "tool_name", "toolName": "kyoube.apps:data_query", "effect": "include" },
      { "selectorType": "tool_name", "toolName": "kyoube.apps:data_get", "effect": "include" },
      { "selectorType": "tool_name", "toolName": "kyoube.apps:data_count", "effect": "include" },
      { "selectorType": "tool_name", "toolName": "kyoube.apps:data_sql_select", "effect": "include" }
    ]
  }' | jq '{id, name, defaultAction}'
```

(Upstream's own `doc/MCP-ACCESS-GOVERNANCE.md` example uses `selectorValue` for a profile entry — that
field doesn't exist on `createToolProfileEntrySchema`; the field a `tool_name` entry actually takes is
`toolName`, as above, and a `risk_level` entry takes `riskLevel`.)

Bind it as the company's default so every agent that has no narrower binding gets it:

```sh
curl -fsS -X POST -H "Authorization: Bearer $BOARD_API_KEY" -H "Content-Type: application/json" \
  "$KYOUBE_URL/api/companies/$COMPANY_ID/tools/profiles/$PROFILE_ID/bind" \
  -d '{ "targetType": "company", "targetId": "'"$COMPANY_ID"'", "priority": 100 }' | jq .
```

The two connection tools, `kyoube.apps:connections_list` and `kyoube.apps:connections_call`, are
deliberately not in this profile. An agent can call a connection (`connections_call`, or the REST
route) only with a grant from an owner or admin under Company Settings, then Data access, then
Connections, and that grant is separate from its data level; leave `connections_call` out of any
profile for an agent that should not reach outside services, and include it (with a grant) for one
that should. `connections_list` only lists names, hosts and the agent's own access, so it can join the
read-only profile if you want agents to see what exists. To make every call to a service wait for a
person regardless of the guardrail, add `kyoube.apps:connections_call` to a `require_approval`
policy as in step 2.

An agent that genuinely needs to write rows or change schema needs its **own** profile bound at
`targetType: "agent"` (narrower scopes win) that also includes the write/schema tools it needs — this
default only covers the common case of an agent that should merely read and report.

## 2. Require human approval for the dangerous calls

`data_drop_table` and `data_remove_field` destroy data (recoverable for 30 days, but still); `apps_publish`
is the one gate between a prompt-injected agent and a running app that other people will open. Force
approval on all three regardless of which profile let the call through:

```sh
curl -fsS -X POST -H "Authorization: Bearer $BOARD_API_KEY" -H "Content-Type: application/json" \
  "$KYOUBE_URL/api/companies/$COMPANY_ID/tools/policies" \
  -d '{
    "name": "Kyoube: approve destructive schema changes and publishes",
    "policyType": "require_approval",
    "priority": 10,
    "selectors": {
      "toolNames": ["kyoube.apps:data_drop_table", "kyoube.apps:data_remove_field", "kyoube.apps:apps_publish"]
    }
  }' | jq '{id, name, policyType, priority}'
```

A matching call now comes back `409` with `reasonCode: "approval_required"` and an `actionRequestId`;
the agent's run pauses on that call until a human approves or rejects it in the UI (or via
`POST /api/tool-gateway/action-requests/:id/approve`). See upstream's
[Approval flow and trust rules](https://github.com/paperclipai/paperclip/blob/main/doc/MCP-ACCESS-GOVERNANCE.md#approval-flow-and-trust-rules)
for promoting a repeated, reviewed approval into a standing trust rule.

## 3. Rate-limit bulk writes

`data_insert` takes up to 500 rows per call already, but nothing stops an agent from calling it in a
loop. A `rate_limit` policy adds a ceiling on top of Kyoube's own per-call cap, keyed per agent so one
runaway agent doesn't exhaust the whole company's budget:

```sh
curl -fsS -X POST -H "Authorization: Bearer $BOARD_API_KEY" -H "Content-Type: application/json" \
  "$KYOUBE_URL/api/companies/$COMPANY_ID/tools/policies" \
  -d '{
    "name": "Kyoube: rate-limit bulk inserts",
    "policyType": "rate_limit",
    "priority": 20,
    "selectors": { "toolNames": ["kyoube.apps:data_insert"] },
    "config": { "rateLimit": { "limit": 100, "windowSeconds": 3600, "keyBy": ["agent"] } }
  }' | jq '{id, name, policyType, config}'
```

That allows 100 `data_insert` calls per agent per rolling hour (up to 500 rows each); a call past the
limit comes back as `rate_limited` rather than reaching the plugin. Adjust `limit`/`windowSeconds` to
the company's real bulk-load needs.

## Check what actually applies

Dry-run any of the above against a real tool call before trusting it, and check what an agent's
effective profile resolves to:

```sh
curl -fsS -H "Authorization: Bearer $BOARD_API_KEY" \
  "$KYOUBE_URL/api/companies/$COMPANY_ID/tools/profiles/effective/agents/$AGENT_ID" \
  | jq '{profileIds, allowedToolNames}'

curl -fsS -X POST -H "Authorization: Bearer $BOARD_API_KEY" -H "Content-Type: application/json" \
  "$KYOUBE_URL/api/companies/$COMPANY_ID/tools/policy/test" \
  -d '{
    "companyId": "'"$COMPANY_ID"'",
    "actor": { "actorType": "agent", "actorId": "'"$AGENT_ID"'", "agentId": "'"$AGENT_ID"'" },
    "request": { "toolName": "kyoube.apps:data_drop_table", "arguments": { "table": "contacts" } }
  }' | jq '{decision: .decision.decision, matchedPolicyIds: .decision.matchedPolicyIds, reasonCode: .decision.reasonCode}'
```

Every attempted call — allowed, denied, rate-limited, or sent to approval — lands in the audit log:
`GET /api/tool-gateway/audit?companyId=$COMPANY_ID&limit=100`.

## Recommended defaults

| Who | Kyoube data-access grant | Where |
|---|---|---|
| Agents, by default | `none` | Company default under **Company Settings → Data access**; grant explicitly per agent from there. |
| A "builder" agent that designs schema and ships apps | `schema` | In a dedicated project, not the company's main one, and only for the duration of the build — drop it back down (or to `write`) once the app is published and stable. |
| A "reviewer" or reporting agent | `read` | Enough to query and describe tables, never to change them. |
| An agent that calls an outside service | a `read` connection grant | Company Settings → Data access → Connections; `read-write` only when it must change something there. The default is `none`. |

Layer the core's profiles and policies on top of whatever grant you choose — a `schema`-level agent
gated behind `require_approval` on its destructive calls is safer than either control alone, and both
recommendations above hold regardless of company size: the two builder/reviewer roles are exactly the
two agent shapes covered by [step 1](#1-a-read-only-default-profile) (reviewer) and a narrower,
per-agent profile that adds the write/schema tools (builder).
