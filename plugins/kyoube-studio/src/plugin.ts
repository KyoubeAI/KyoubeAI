import { definePlugin, type PaperclipPlugin, type PluginContext } from "@paperclipai/plugin-sdk";
import { buildHome, summarizeTeam, type AgentLike, type ApprovalLike, type IssueLike } from "./model.js";
import { buildProfile, type CommentLike, type ProfileAgentLike } from "./profile.js";
import { ASK_LEVELS_STATE_KEY, isBuiltInAgent, levelOf, parseAskLevel, parseAskLevels, pruneAskLevels, withAskLevel, type AskLevels } from "./ask-levels.js";
import { rulesTokenMatches, RULES_TOKEN_PATH } from "./rules-token.js";

type Params = Record<string, unknown>;
type HostGrant = Parameters<PluginContext["authorization"]["grants"]["set"]>[0]["grants"][number];

export interface StudioPluginDeps {
  now?: () => number;
  /** How long one company's snapshot is reused, so a roster that polls and a Home that polls share one read. */
  snapshotMs?: number;
  /** Where the kyoube CLI's rules token lives; tests point it at a temporary file. */
  rulesTokenPath?: string;
}

interface Snapshot {
  agents: AgentLike[];
  issues: IssueLike[];
  approvals: ApprovalLike[];
}

/** Tasks read per snapshot. The host lists newest activity first; older ones do not change what Studio shows. */
const ISSUE_WINDOW = 500;
/** Company roles that see the Terminal card on the Workspace page (the terminal plugin's default roles). */
const ADMIN_ROLES = new Set(["owner", "admin"]);
/**
 * The core permission an agent needs to change its own or another agent's
 * instructions, skills and settings. The core UI has no control for it (its
 * Access page needs an extension KyoubeAI does not ship), so the profile has one.
 */
const CHANGE_AGENTS = "agents:configure";

interface MemberLike { principalType: string; principalId: string; status: string; membershipRole: string | null }
type GrantLike = { permissionKey: string; scope?: Record<string, unknown> | null };

function isUnscoped(grant: GrantLike): boolean {
  return grant.scope == null || Object.keys(grant.scope).length === 0;
}

function isCompanyAdmin(members: MemberLike[], userId: string | null): boolean {
  const me = members.find((member) => member.principalType === "user" && member.principalId === userId && member.status === "active");
  return me ? ADMIN_ROLES.has(me.membershipRole ?? "") : false;
}

function companyOf(params: Params): string {
  // The host puts the caller's authorized company in `companyId` and refuses
  // a bridge call without one unless the caller is an instance admin.
  const companyId = params.companyId;
  if (typeof companyId !== "string" || companyId.length === 0) throw new Error("companyId is required");
  return companyId;
}

export const FORBIDDEN_MESSAGE = "forbidden: the kyoube CLI's rules token or a company owner or admin is required";

/** What the `ask-levels` route needs from the host; set up in `setup`, used by `onApiRequest`. */
interface AskLevelsRoute {
  isAdmin(companyId: string, userId: string): Promise<boolean>;
  list(companyId: string): Promise<AskLevels>;
}

export function createStudioPlugin(deps: StudioPluginDeps = {}): PaperclipPlugin {
  const now = deps.now ?? (() => Date.now());
  const snapshotMs = deps.snapshotMs ?? 8_000;
  const snapshots = new Map<string, { at: number; value: Promise<Snapshot> }>();
  const tokenPath = deps.rulesTokenPath ?? RULES_TOKEN_PATH;
  // `onApiRequest` runs outside `setup`, so its host adapter lives in this instance's closure.
  let askLevelsRoute: AskLevelsRoute | null = null;

  return definePlugin({
    async setup(ctx: PluginContext) {
      /** One company's agents, tasks and pending approvals; `fresh` skips (and replaces) the short-lived cache. */
      const load = (companyId: string, { fresh = false }: { fresh?: boolean } = {}): Promise<Snapshot> => {
        const cached = snapshots.get(companyId);
        if (!fresh && cached && now() - cached.at < snapshotMs) return cached.value;
        const value = (async () => {
          const [agents, issues, approvals] = await Promise.all([
            ctx.agents.list({ companyId }),
            ctx.issues.list({ companyId, limit: ISSUE_WINDOW }),
            ctx.approvals.list({ companyId, status: "pending" }),
          ]);
          return { agents, issues, approvals } as unknown as Snapshot;
        })();
        snapshots.set(companyId, { at: now(), value });
        // A failed read must not be served from the cache for the next 8 s.
        value.catch(() => { if (snapshots.get(companyId)?.value === value) snapshots.delete(companyId); });
        return value;
      };

      const levelsScope = (companyId: string) => ({ scopeKind: "company" as const, scopeId: companyId, stateKey: ASK_LEVELS_STATE_KEY });
      const readLevels = async (companyId: string): Promise<AskLevels> => parseAskLevels(await ctx.state.get(levelsScope(companyId)));
      const writeLevels = (companyId: string, levels: AskLevels) => ctx.state.set(levelsScope(companyId), levels);
      askLevelsRoute = {
        async isAdmin(companyId, userId) {
          return isCompanyAdmin((await ctx.access.members.list({ companyId })) as MemberLike[], userId);
        },
        async list(companyId) {
          const [levels, agents] = await Promise.all([readLevels(companyId), ctx.agents.list({ companyId })]);
          const live = new Set(agents.filter((row) => row.status !== "terminated").map((row) => row.id));
          const kept = pruneAskLevels(levels, live);
          if (Object.keys(kept).length !== Object.keys(levels).length) await writeLevels(companyId, kept);
          return kept;
        },
      };

      ctx.data.register("team", async (params) => {
        const { agents, issues } = await load(companyOf(params));
        return summarizeTeam(agents, issues);
      });

      ctx.data.register("home", async (params) => {
        const { agents, issues, approvals } = await load(companyOf(params));
        return buildHome(agents, issues, approvals, now());
      });

      const readProfile = async (params: Params) => {
        const companyId = companyOf(params);
        const ref = typeof params.agentRef === "string" ? params.agentRef : "";
        if (!ref) throw new Error("agentRef is required");
        // Always a fresh read: the profile is where people pause an agent or
        // assign it a task, and must show the result on its next refresh.
        const { agents, issues } = await load(companyId, { fresh: true });
        const first = buildProfile(ref, agents as ProfileAgentLike[], issues, [], now());
        if (!first.found || !first.current) return first;
        // The agent's own latest notes on the task it is working on. Read per
        // request (one task, one call) rather than cached with the snapshot.
        const comments = await ctx.issues.listComments(first.current.task.id, companyId).catch(() => []);
        return buildProfile(ref, agents as ProfileAgentLike[], issues, comments as unknown as CommentLike[], now());
      };

      ctx.data.register("agent", async (params) => {
        const profile = await readProfile(params);
        if (!profile.found) return profile;
        const companyId = companyOf(params);
        const userId = typeof params.userId === "string" ? params.userId : null;
        // Without it the profile still shows; only the permission panel is left out.
        const access = await Promise.all([
          ctx.authorization.grants.list({ companyId, principalType: "agent", principalId: profile.agent.id }),
          ctx.access.members.list({ companyId }),
          readLevels(companyId),
          ctx.agents.get(profile.agent.id, companyId),
        ]).then(([grants, members, levels, row]) => ({
          canChangeAgents: (grants as GrantLike[]).some((grant) => grant.permissionKey === CHANGE_AGENTS && isUnscoped(grant)),
          // Cosmetic only: the action checks the signed-in person itself.
          canManage: isCompanyAdmin(members as MemberLike[], userId),
          askLevel: isBuiltInAgent(row?.metadata) ? null : levelOf(levels, profile.agent.id),
        }), () => null);
        return { ...profile, access };
      });

      ctx.actions.register("agent.change-access", async (params, context) => {
        // The company and the person come from the host, never from params.
        const companyId = context.companyId;
        if (!companyId) throw new Error("This needs a company");
        const userId = context.actor.type === "user" ? context.actor.userId : null;
        const members = userId ? await ctx.access.members.list({ companyId }) : [];
        if (!isCompanyAdmin(members as MemberLike[], userId)) throw new Error("Only company owners and admins can change what an agent may do");
        const agentId = typeof params.agentId === "string" ? params.agentId : "";
        const agent = agentId ? await ctx.agents.get(agentId, companyId) : null;
        if (!agent || agent.status === "terminated") throw new Error("Agent not found");
        if (agent.status === "pending_approval") throw new Error("Available once the agent is approved");
        const on = params.on === true;
        const grants = await ctx.authorization.grants.list({ companyId, principalType: "agent", principalId: agentId });
        const holds = (grants as GrantLike[]).some((grant) => grant.permissionKey === CHANGE_AGENTS && isUnscoped(grant));
        const others = (grants as GrantLike[]).filter((grant) => grant.permissionKey !== CHANGE_AGENTS);
        let next: GrantLike[] | null = null;
        if (on && !holds) next = [...grants as GrantLike[], { permissionKey: CHANGE_AGENTS, scope: null }];
        if (!on && others.length < grants.length) next = others;
        if (next) {
          await ctx.authorization.grants.set({
            companyId,
            principalType: "agent",
            principalId: agentId,
            grants: next.map((grant) => ({ permissionKey: grant.permissionKey as HostGrant["permissionKey"], scope: grant.scope ?? null })),
            grantedByUserId: userId,
          });
        }
        return { canChangeAgents: on };
      });

      ctx.actions.register("agent.change-ask-level", async (params, context) => {
        // The company and the person come from the host, never from params.
        const companyId = context.companyId;
        if (!companyId) throw new Error("This needs a company");
        const userId = context.actor.type === "user" ? context.actor.userId : null;
        const members = userId ? await ctx.access.members.list({ companyId }) : [];
        if (!isCompanyAdmin(members as MemberLike[], userId)) throw new Error("Only company owners and admins can change what an agent may do");
        const level = parseAskLevel(params.level);
        if (!level) throw new Error("level must be none, line or any");
        const agentId = typeof params.agentId === "string" ? params.agentId : "";
        const agent = agentId ? await ctx.agents.get(agentId, companyId) : null;
        if (!agent || agent.status === "terminated") throw new Error("Agent not found");
        if (agent.status === "pending_approval") throw new Error("Available once the agent is approved");
        if (isBuiltInAgent(agent.metadata)) throw new Error("Built-in agents keep the default");
        await writeLevels(companyId, withAskLevel(await readLevels(companyId), agentId, level));
        return { askLevel: level };
      });

      ctx.data.register("workspace", async (params) => {
        const companyId = companyOf(params);
        const [{ agents, issues }, projects, members] = await Promise.all([
          load(companyId),
          ctx.projects.list({ companyId }),
          ctx.access.members.list({ companyId }).catch(() => []),
        ]);
        const userId = typeof params.userId === "string" ? params.userId : null;
        const open = issues.filter((issue) => issue.hiddenAt == null && !["done", "cancelled"].includes(issue.status)).length;
        const people = (members as Array<{ principalType: string; status: string }>).filter((member) => member.principalType === "user" && member.status === "active").length;
        return {
          agents: agents.filter((agent) => agent.status !== "terminated").length,
          people,
          projects: projects.filter((project) => (project as { archivedAt?: unknown }).archivedAt == null).length,
          openTasks: open,
          // Cosmetic only: the Terminal page enforces its own access.
          isAdmin: isCompanyAdmin(members as MemberLike[], userId),
        };
      });
    },

    async onApiRequest(input) {
      const route = askLevelsRoute;
      if (!route) return { status: 503, body: { error: "plugin not ready" } };
      // Declared `auth: "board"`, which the host enforces before the request reaches this worker;
      // checked again so a mis-declared route could never hand an agent the levels.
      if (input.actor.actorType === "agent") return { status: 403, body: { error: "forbidden: board access required", code: "forbidden" } };
      if (input.routeKey !== "ask-levels.list") return { status: 404, body: { error: `unknown route ${input.routeKey}` } };
      try {
        // "board" admits every signed-in person: the caller must be the kyoube CLI, proven by the
        // rules token in the body, or a company owner or admin, read fresh from the core.
        if (!(await rulesTokenMatches(tokenPath, (input.body as { rulesToken?: unknown } | undefined)?.rulesToken))) {
          const userId = input.actor.userId ?? input.actor.actorId;
          if (input.actor.actorType !== "user" || !userId || !(await route.isAdmin(input.companyId, userId))) {
            return { status: 403, body: { error: FORBIDDEN_MESSAGE, code: "forbidden" } };
          }
        }
        return { status: 200, body: { levels: await route.list(input.companyId) } };
      } catch (error) {
        const text = error instanceof Error ? error.message : String(error);
        return { status: 500, body: { error: `${input.routeKey} failed: ${text}`, code: "error" } };
      }
    },

    async onHealth() {
      return { status: "ok", message: "Kyoube Studio is ready" };
    },
  });
}
