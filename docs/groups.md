# User groups

Groups decide which people may use which agents and apps, and at what data level. They are a
licensed feature (see [Licence](#licence)). Owners and admins manage them under
**Company Settings → Groups**.

## What groups do

A group has four things:

- **People:** company members.
- **Agents:** people outside the group cannot give these agents work or chat with them.
- **Apps:** people outside the group cannot see or open these apps.
- **A data level (optional):** `read`, `write` or `schema`. It sets what the group's members may do
  on the Data page and in apps.

A person can be in several groups. They get everything any of their groups gives them.

A suspended or pending member keeps their groups, so a lowered data level still applies when they
are active again. Someone removed from the company (archived) loses their group memberships within
about a minute.

## Open by default

An agent or app that is in no group is open to everyone, as it was before groups. Upgrading changes
nothing until someone creates a group.

This works in both directions. Deleting a group, or taking an agent or app out of its last group,
makes it open to everyone. The Groups page warns you first, naming what becomes open: "This makes
Support Bot, Refunds usable by everyone. Continue?"

A group with agents but no members leaves those agents to owners and admins only.

## Owners and admins

Owners and admins are never restricted by a group. They see every app, may give work to every agent,
and always have the `schema` data level. A group cannot lock out the people who manage groups.

They also keep data-access administration by role: agent data grants, company data settings and
typed-decision settings. A group's `schema` level lets its members change tables and publish apps. It
never lets them decide who else gets access.

## Data levels

- A person's level is the highest level among their groups that set one. If none of their groups
  sets a level, their company role decides (owner and admin: `schema`, operator: `write`, viewer:
  `read`), as before.
- A group can lower an operator (an operator in a `read` group gets `read`) or raise one to
  `schema`. It never raises a viewer: the core refuses every change a viewer sends ("Viewer access is
  read-only"), so a viewer stays at `read` whatever their groups say, and the Data access page shows
  "role: viewer (groups cannot raise a viewer)".
- A group level is never below `read`. There is no `none`: every company member can read, and the
  Data page's reads rely on that (see `SECURITY.md`).
- The **Data access** page shows each person's level and where it comes from ("role: operator" or
  "group: Sales").

Level changes take effect on the person's next action.

## People are shown by id and role

The Groups page and the Data access people table list members by id and role. The core's plugin API
gives KyoubeAI no display names (the same gap as `viewer.name` in [apps.md](apps.md)).

## Apps

An app in a group is listed and opened only by members of one of its groups. Everyone else does not
see it in the gallery. Following a direct link shows "You don't have access to this app. Ask a company
admin." This applies to opening, running, saving data from and deciding in the app.

Apps that hand work to an agent ([app-tasks.md](app-tasks.md)) follow the same assignment rules as the
rest of KyoubeAI. When a person presses the button, the task is created as them, after the core's own
check of whether they may assign that agent. In a group that cannot assign a protected agent, the
person can open the app but the button is refused with the core's reason, and no task is created.

Restricting an app hides and refuses the app only. Its tables stay reachable on the Data page and
through any other app that declares them, at the person's own data level.

Apps take effect on the next request. An archived app keeps its groups, so restoring it restores its
restrictions.

## Agents

Someone outside the agent's groups cannot assign it a task or chat with it. The Groups page is where
an agent's restrictions are seen: each group lists its agents, and an agent in no group is open to
everyone. Only owners and admins see that page; anyone else who tries to assign or chat with a
restricted agent gets the core's own refusal. (Core 2026.1005.0 shows plugin tabs only on issues,
projects and workspaces, so there is no tab on the agent page.)

- **Takes effect within about a minute.** The agent rules loop (`kyoube agent-rules --watch`) applies
  group changes once a minute. Apps and data levels change at once.
- **Seeing is not restricted.** The core has no per-agent visibility, so people outside a group can
  still see its agents, their tasks and their runs.
- **Chat follows assignment.** Opening a chat with a protected agent, and sending a message in one,
  needs the right to assign that agent. Someone who loses the right can no longer reopen their old
  chat panel. The conversation stays readable as an issue.
- **Viewers.** On this core a viewer cannot assign work to or chat with any agent, in a group or
  not: the core refuses every change a viewer sends. Putting a viewer in a group gives them no agent.
  Owners, admins and operators keep chat with managers.
- Other actions in an already-open chat, such as answering an interaction card or uploading an
  attachment, are only checked against the chat's owner by the core.

## Licence

Creating and changing groups needs any valid licence (see [licensing.md](licensing.md)). Without
one, the Groups page shows your groups read-only with a pointer to the licence page
(**Settings → Plugins → KyoubeAI Licence**).

Enforcement never depends on the licence. Existing groups keep restricting apps, agents and data
levels when the licence is free, expired or removed, and you can still delete them. Switching
enforcement off at expiry would silently open every restricted app and agent to everyone.

## What KyoubeAI changes in the core

Agent restrictions use the core's own mechanism, written by the agent rules loop
([agent-rules.md](agent-rules.md)). Each pass, per company:

- **Protected agents.** Every agent in a group is marked protected, so only someone holding a
  matching `tasks:assign` grant can assign it. KyoubeAI removes the mark again only from agents it
  protected for groups that no longer list them, and never from a manager agent the manager rule
  protects.
- **Operators.** An operator's unscoped `tasks:assign` grant is replaced by one scoped to every live
  agent except the restricted agents they are not allowed. Unrestricted agents and managers stay
  assignable.
- **Viewers** are never given an assignment grant: the core refuses their every change anyway.
- **Owners and admins** are not touched.
- **Grants set by hand.** A grant someone scoped by hand is left alone and reported. A grant
  someone changes after KyoubeAI wrote it is left as they set it. The exception is a row equal to the
  person's original role-default grant, or to what KyoubeAI last wrote: KyoubeAI treats that as its
  own and re-scopes it while restricted agents exist.
- **Undo.** When the last restricted agent goes, or a person becomes an owner or admin, the original
  grants are put back.
- **Suspended members** are left untouched until they are active again.
- **Agents KyoubeAI cannot protect.** If an agent's authorization policy has keys KyoubeAI does not
  change, KyoubeAI leaves it alone and reports it as skipped. The core already refuses everyone
  assignment to an agent with such a policy, so its groups change nothing there. The chat check
  covers protected agents only and does not cover such an agent.

Chat needs one standing core patch, `groups-chat-open-assign-check` and
`groups-chat-message-assign-check` in `docker/core-patches/patches.mjs`. It adds the core's own
assignment check to the chat routes, for protected agents only. The build fails if a core release
moves the code it anchors on.

Groups do not depend on the agent working rules. With `KYOUBE_AGENT_RULES=off` the loop keeps
running and syncs only user groups each minute, so adding or deleting a group still takes effect.
`kyoube agent-rules off` does not remove group enforcement. Delete the groups to lift it.

## Troubleshooting

- The Groups page shows **Agent rules last synced N min ago**, with the error if the last pass
  failed. If it says the rules have not synced, or the time is old, check that the loop is running.
- If the agent-access list cannot be read, or is malformed, KyoubeAI skips the group step for that
  company and reports it. It never applies an unreadable list as "no groups", which would lift every
  restriction. The current restrictions stay as they were.
- `docker compose exec app kyoube doctor` shows group failures and skipped agents with the agent
  rules lines, and warns when the last pass is more than 5 minutes old. With `KYOUBE_AGENT_RULES=off`
  they appear on their own `user groups` and `user groups skipped` lines.
- `docker compose exec app kyoube agent-rules --once` runs a pass now and prints every message.
- The group routes answer only the agent rules loop, which proves itself with the rules token
  (`/kyoubeai/kyoube/rules-token`, see [agent-rules.md](agent-rules.md)), or a company owner or admin.
  The board key's user must be a member of each company, in any role: the core refuses the key in a
  company it does not belong to, before any plugin runs. The rules token only lets that member pass the
  owner-or-admin check without being an owner or admin. If `kyoube doctor` says the board key's user
  does not have access to a company, add that user to it as a member. If it says a plugin refused the
  kyoube CLI, check that the token file exists and that the `node` user can read it.
- A restricted person who can still assign an agent: wait a minute, then check the pass report for
  "has a custom assignment grant" or a skipped agent.
