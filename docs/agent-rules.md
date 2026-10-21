# Agent working rules

KyoubeAI keeps agents working the way a small team expects:

1. **An agent finishes its own task.** It does the work end to end and does not pass it, or parts
   of it, to another agent, or ask another agent to review or approve it. The exceptions: the person
   who started the task asks for that, or the agent's own **Handoffs** section names that agent.
2. **Approvals go to the person who started the task.** An agent asks that person, never another
   agent.
3. **A stuck agent may ask one agent a question, as a last resort.** It sends a question card
   addressed to that agent, which can answer in its own words, keeps the task and ends its run. Its
   **ask level** decides which agents it may ask (see [Agent questions](#agent-questions)). One open
   question per task, three in all.
4. **Work moves up to a manager agent only with that person's decision.** An agent that cannot do a
   task hands it back to the person with a decision card: `"Escalate to <manager>"` or `"Keep it with
   <agent>"`.
5. **An agent with reports may orchestrate.** It does small tasks itself and splits big ones across
   its own team only.
6. **No extra tasks.** An agent does not create review, QA, follow-up or "let X know" tasks unless
   rule 1 or rule 5 allows it.
7. **An agent that is asked answers in the card,** in the run that woke it. It does not check out,
   take, reassign, split or work on the asker's task, and does not pass the question on.

The core (Paperclip) teaches the opposite by default: its bundled skill tells agents never to ask a
human what an agent could do, and its default instructions say "ask QA, ask your boss". These rules
override that without changing any core file.

## How it works

| Part | What it does | Enforced by |
|---|---|---|
| Rules block | A marked block at the top of every agent's `AGENTS.md` with the seven rules above, and a line that says which agents that agent may ask, plus a `## Handoffs` section. The core puts `AGENTS.md` into the agent's system prompt. | The instructions themselves |
| People-only cards | The company setting that caps confirmation, question, checkbox, verdict and suggested-task cards at `human_only`. No agent can answer one, not even the one that asked, except a question to another agent that the asker's ask level allows (see [Agent questions](#agent-questions)). | The core |
| Protected managers | Every agent with a direct report is protected: another agent can assign it work only with a grant. Each manager holds one grant, for itself and everyone below it. The core's default "assign to anyone" grant is taken from every agent. | The core |
| Escalation | A decision card only a person can decide; on "Escalate" the core moves the task to the manager. | The core |
| Agent questions | A standing core patch checks every question card an agent addresses to another agent against the asker's ask level and the per-task limits. A question it lets through can be answered by that agent; anything else stays people-only. | The core (patch) |
| Top agent may change agents | The one agent that reports to nobody gets `agents:configure` and `skills:create`, so it can change its own and other agents' instructions, skills and settings. Core 2026.1012.0 gives both to every new standard agent itself, with twelve more grants (tools, inbox, audit, task assignment and checkouts); before that it gave them only to a top agent whose role is `ceo`, and KyoubeAI hires the first agent as `general`, so this rule covers agents hired on an earlier core. Given once: switch it off on the agent's profile (**Can change agents**) and it stays off. Nobody gets it while more than one agent reports to nobody; switch it on per agent instead. | The core |

`kyoube agent-rules --watch` starts with the container. It runs as `node`, makes one pass a minute,
and writes only what differs:
- It writes the rules blocks and the company setting itself, through the core's REST API with the
  board key.
- It asks the `kyoube.agent-rules` plugin to set the managers' protection and grants. The core lets
  only a plugin set an agent's scoped grant.
- It copies each agent's ask level from Studio into the agent's metadata, where the patch reads it.
- It records each pass in `/kyoubeai/.kyoube/agent-rules.json`, which `kyoube doctor` reads.

The plugin routes the loop calls (`/reconcile`, `/revert`, Studio's `/ask-levels`, and the group
routes below) refuse anyone but the loop itself or a company owner or admin, because every signed-in
person passes the core's own "board" check. The loop proves itself with the **rules token**: a random secret in
`/kyoubeai/kyoube/rules-token` (mode 600), which `kyoube agent-rules` creates on its first run and
sends in the body of each call. Only the container's own processes can read the file, so a request carrying it came from the
loop. The board key's user must still be a member (any role) of each company, or the core refuses
the call before the plugin sees it; the token lets that member pass the plugin's owner-or-admin
check without being an owner or admin. Code running inside the container can read
the token, as it can the board key. To rotate it, delete the file; the next pass creates a new one.

## Group restrictions

When a company has user groups (`docs/groups.md`), the same loop also applies which people may give
work to which agents. After the guard step, each pass:

- reads the list of restricted agents from `kyoube.apps` (`POST /groups/agent-access`) and posts it
  to `kyoube.agent-rules` (`POST /groups/apply`), then reports the result back (`POST
  /groups/sync-report`) for the Groups page;
- protects every listed agent, and scopes operators' `tasks:assign` grants (viewers get none). A
  grant someone scoped by hand is left alone and reported; everything is put back when the last
  restricted agent goes.

If the list cannot be read, the group step is skipped for that company and reported. It is never
applied as "no groups". An agent whose authorization policy has keys KyoubeAI does not change cannot
be protected; it shows under `agent rules skipped`. The core already refuses everyone assignment to
an agent with such a policy, but the chat check (protected agents only) does not cover it. A low-trust
agent's policy (the core's `trustPreset`, `trustBoundary` and `reviewPreset`) is not one of these:
core 2026.1012.0 evaluates those keys together with assignment policy, so such an agent is protected
like any other.

`kyoube agent-rules off` does not remove group enforcement: delete the groups for that. The group
step runs even with `KYOUBE_AGENT_RULES=off` (see [Turn it off](#turn-it-off)).

**Chat.** A standing core patch makes opening a chat with a protected agent, and sending a message
in one, require the right to assign it. This applies to the managers above too. Viewers cannot assign
or chat with any agent on this core in any case: it refuses every change a viewer sends. Owners,
admins and operators keep chat with managers.

## Standing handoffs

To let an agent hand a kind of work to another agent without being asked each time, write it in that
agent's `## Handoffs` section, on its Instructions tab:

    ## Handoffs

    QA Agent tests every code change before it is marked done.

KyoubeAI never edits that section. Everything between `<!-- kyoube:working-rules v2 … -->` and
`<!-- /kyoube:working-rules -->` is replaced on the next pass, so put your own instructions outside it.

A handoff up to a manager always goes through the person, even when a Handoffs line names the
manager: the manager is protected.

## Agent questions

An agent that is stuck on one missing answer may ask another agent instead of stopping for a person.
It sends an `ask_user_questions` card addressed to that agent (`addresseeAgentId`), keeps the task
assigned to itself, sets it to `in_review` and ends its run. The core then wakes the agent it asked.
Only that agent or a person can answer, and the answer wakes the asker. The task never changes hands.

**Ask levels.** Set on the agent's profile (Team → the agent → Permissions → **Can ask other
agents**), by company owners and admins:

| Level | Who it may ask |
|---|---|
| No agents | Nobody. It finishes the task or hands it back to the person (rule 4). |
| Its line (default) | Every manager above it up to the top agent, and every agent below it. Terminated agents never count. |
| Any agent | Any agent in the company. |

A change takes effect within a minute: Studio keeps the level, and the loop copies it into the
agent's metadata, where the core patch reads it.

**Limits.** One open question to an agent per task, and three in all. Answered, expired and
cancelled questions count too. A question the agent then asks its person replaces its open question
to an agent, as the core does with any newer question.

**Refusals.** The core refuses a question the level or the limits do not allow, with a message that
says what to do instead:

| Code | When |
|---|---|
| `kyoube_ask_level_none` | The asker's level is No agents. |
| `kyoube_ask_outside_line` | The agent asked is outside the asker's line. The message lists who it may ask, or says there is nobody. |
| `kyoube_ask_open_question` | The task already has an open question to an agent. |
| `kyoube_ask_limit` | The task has used its three questions to agents. |
| `kyoube_ask_check_failed` | The check itself failed. The question is refused (fail closed). |

Questions to a person, questions with no addressee, and every other card kind stay people-only, as
before.

## What the rules cannot stop

- A manager can still assign work to an agent with no reports in another team.
- Agents can still create board approvals (`request_board_approval`). They go to every board member,
  because the core's approvals have no addressee. The rules limit them to spending and hiring.
- A CEO-role agent may change another agent's permissions, which can give back the broad assign
  grant. That change lasts only until the next pass, at most a minute, and the task's history shows
  it.
- An agent with `agents:configure` (core 2026.1012.0 gives it to every new agent) can change its own
  `reportsTo`, which changes what "its line" covers. The loop only reads `reportsTo`, so the change
  stays until someone changes it back, and the task's history shows it. The same agent can edit an
  ask level in an agent's metadata; the loop puts the level back within a minute.
- KyoubeAI owns two settings and puts them back on the next pass if someone changes them in the UI:
  an agent's "can assign tasks" permission, and the resolver policy of the five card kinds. To change
  either for good, turn the rules off.

## Check it

    docker compose exec app kyoube doctor

- `agent rules` is ok when the last pass was under 5 minutes ago, recorded no failure, and the
  self-test did not fail. The self-test asks the core's own assignment check whether a report can
  assign to its manager (it must not) and whether the manager can assign to the report (it must).
- `agent questions` is ok when the core patch is in place and its module loads. It also shows how
  many questions agents asked agents in the last 7 days, per company, who asked most, and how many
  tasks reached the limit.
- `agent rules skipped` lists agents left alone on purpose:
  - one whose instructions are not a core-managed bundle
  - one still on the legacy prompt template
  - an `AGENTS.md` whose markers were damaged by hand
  - a manager whose authorization policy KyoubeAI does not change
  - an agent waiting for approval
  - an agent a group restricts whose authorization policy KyoubeAI does not change (the core already
    refuses everyone assignment to it; the chat check does not cover it)
  - a person whose assignment grant someone scoped by hand
  - an instructions bundle with no `AGENTS.md`

Run a pass by hand and see every message with `docker compose exec app kyoube agent-rules --once`.

Right after a container start, `agent rules` can show `no pass yet`, or a last pass more than
5 minutes old, until the loop's first pass. That pass comes within about a minute, because the loop
waits up to 30 s for the plugin worker. `./install.sh` and `./update.sh` run a pass themselves just
before their own `kyoube doctor`, so they normally never show this.

## Turn it off

1. Set `KYOUBE_AGENT_RULES=off` in `.env` and `docker compose up -d`. With `KYOUBE_AGENT_RULES=off`,
   the core patch stops checking at once. Agents' questions follow the core's own rules once step 2
   has put the company setting back.
2. `docker compose exec app kyoube agent-rules off`. This:
   - removes the blocks
   - puts the company setting back as it was
   - lifts the protection and grants KyoubeAI set, the top agent's `agents:configure` and
     `skills:create` included (only the ones it added)
   - gives the default grant back to the agents it was taken from
   - removes the ask level it copied into each agent's metadata (the levels people set stay in
     Studio)

It leaves the Handoffs sections, and does not put back the two "ask QA / ask your boss" sentences it
removed from the core's default text.

User groups are not part of the rules. With `KYOUBE_AGENT_RULES=off` the loop keeps running, but each
pass only syncs user groups: no company setting, no manager protection, no rules blocks. Its summary
starts `agent rules are off (KYOUBE_AGENT_RULES=off); user groups only`, and `kyoube doctor` shows
`agent rules` as off plus a `user groups` line for the last sync. `kyoube agent-rules off` never
touches group restrictions; delete the groups to lift them ([groups.md](groups.md)).

## After a core update

Apart from the standing core patches (the chat check and the agent-questions check), nothing here
patches the core, so a core update cannot quietly undo it. Everything else lives in the database, and
the loop re-applies it every minute. A core that changes one of the calls this relies on shows up
twice:
- as a failed `agent rules` section in the smoke test, which CI runs against the pinned core and
  weekly against the core's next beta
- as a failed `agent rules` line in `kyoube doctor` on a running instance, naming the call the core
  no longer accepts

The calls this relies on:
- the company's `interactionResolverGovernance`
- an agent's authorization policy and grants, through the plugin SDK
- the instructions bundle routes
- decisions with an `assign_issue` effect
- the plugin routes answering 503 while the plugin worker starts, which the loop waits on
  before each pass
- the core's card creation code, which the agent-questions patch anchors on (the build fails if it
  moves)
