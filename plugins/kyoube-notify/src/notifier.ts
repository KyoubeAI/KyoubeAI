import type { PluginEvent } from "@paperclipai/plugin-sdk";
import { approvalMessage, askMessage, commentMessage, failureMessage, statusMessage, type ApprovalLike } from "./messages.js";
import {
  activeMembers, approvalRecipients, askRecipients, failureRecipients, isOpenAgentQuestion, statusTransition, taskOwners,
  type ActiveMember, type InteractionLike, type IssueLike, type MemberRow,
} from "./routing.js";
import type { DeviceRecord, NotifyStore, Prefs } from "./store.js";
import type { VisibilityGate } from "./visibility.js";
import type { PushTarget } from "./webpush/endpoints.js";
import type { PushMessage, SendOutcome } from "./webpush/send.js";

export const FAILURE_WINDOW_MS = 30 * 60_000;
const RECENT_EVENTS = 1000;

export interface Notice {
  userIds: string[];
  message: PushMessage;
}

/** The slices of the plugin context the notifier reads; each is a documented SDK client method. */
export interface NotifierDeps {
  issues: {
    get(issueId: string, companyId: string): Promise<IssueLike | null>;
    listInteractions(issueId: string, companyId: string): Promise<InteractionLike[]>;
  };
  approvals: { get(approvalId: string, companyId: string): Promise<(ApprovalLike & { status: string; requestedByAgentId?: string | null }) | null> };
  agents: { get(agentId: string, companyId: string): Promise<{ name: string } | null> };
  companies: { get(companyId: string): Promise<{ issuePrefix: string } | null> };
  members: { list(input: { companyId: string }): Promise<MemberRow[]> };
  /** Which of the company's people the need-to-know policy lets be told about a task or an approval. */
  visibility: VisibilityGate;
  store: NotifyStore;
  send: (target: PushTarget, message: PushMessage) => Promise<SendOutcome>;
  logger: { warn(message: string): void };
  concurrency?: number;
}

/** Runs `fn` over `items`, at most `limit` at a time, keeping the results in order. */
async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const index = next;
      next += 1;
      out[index] = await fn(items[index]!);
    }
  });
  await Promise.all(workers);
  return out;
}

const userActor = (event: PluginEvent) => (event.actorType === "user" && event.actorId ? event.actorId : null);
const str = (value: unknown) => (typeof value === "string" && value.length > 0 ? value : null);

/**
 * Turns core events into notifications. Every event is a trigger only: the
 * task, approval or question is re-read through the SDK clients, which are
 * the documented contract (event payloads are looser). A failure is logged
 * once with the event id and never thrown back to the host.
 */
export class Notifier {
  private readonly recent: string[] = [];
  private readonly recentSet = new Set<string>();
  private readonly concurrency: number;

  constructor(private readonly deps: NotifierDeps) {
    this.concurrency = deps.concurrency ?? 10;
  }

  async handle(event: PluginEvent): Promise<void> {
    if (this.seen(event.eventId)) return;
    try {
      switch (event.eventType) {
        case "approval.created": await this.onApproval(event); break;
        case "issue.updated": await this.onIssueUpdated(event); break;
        case "issue.comment.created": await this.onComment(event); break;
        case "agent.run.finished":
        case "agent.run.failed": await this.onRunEnded(event); break;
        default: break;
      }
    } catch (error) {
      this.deps.logger.warn(`kyoube.notify: ${event.eventType} ${event.eventId} not delivered: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /** Sends one notice to every device of every recipient, 10 at a time, then records the outcomes per person in one write each. */
  async deliver(notice: Notice): Promise<number> {
    const jobs: Array<{ userId: string; device: DeviceRecord }> = [];
    for (const userId of notice.userIds) for (const device of await this.deps.store.devices(userId)) jobs.push({ userId, device });
    const results = await mapLimit(jobs, this.concurrency, async (job) => ({ job, outcome: await this.safeSend(job.device, notice.message) }));
    const byUser = new Map<string, Map<string, SendOutcome>>();
    for (const { job, outcome } of results) {
      const outcomes = byUser.get(job.userId) ?? new Map<string, SendOutcome>();
      outcomes.set(job.device.id, outcome);
      byUser.set(job.userId, outcomes);
    }
    for (const [userId, outcomes] of byUser) {
      try {
        await this.deps.store.applyOutcomes(userId, outcomes);
      } catch (error) {
        this.deps.logger.warn(`kyoube.notify: could not record outcomes for ${userId}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    return results.filter((result) => result.outcome.result === "delivered").length;
  }

  async sendTo(userId: string, device: DeviceRecord, message: PushMessage): Promise<SendOutcome> {
    const outcome = await this.safeSend(device, message);
    await this.deps.store.applyOutcomes(userId, new Map([[device.id, outcome]]));
    return outcome;
  }

  private async safeSend(device: DeviceRecord, message: PushMessage): Promise<SendOutcome> {
    try {
      return await this.deps.send({ endpoint: device.endpoint, p256dh: device.p256dh, auth: device.auth }, message);
    } catch (error) {
      return { result: "failed", status: null, error: error instanceof Error ? error.message : String(error) };
    }
  }

  private seen(eventId: string | undefined): boolean {
    if (!eventId) return false;
    if (this.recentSet.has(eventId)) return true;
    this.recentSet.add(eventId);
    this.recent.push(eventId);
    if (this.recent.length > RECENT_EVENTS) this.recentSet.delete(this.recent.shift()!);
    return false;
  }

  private async members(companyId: string): Promise<ActiveMember[]> {
    return activeMembers(await this.deps.members.list({ companyId }));
  }

  /** The ids among `userIds` who may read the task: need-to-know hides it from a restricted person who is not involved in it. */
  private async readers(companyId: string, issueId: string, userIds: string[], members: ActiveMember[]): Promise<string[]> {
    const byId = new Map(members.map((member) => [member.userId, member]));
    const out: string[] = [];
    for (const userId of userIds) {
      const person = byId.get(userId);
      if (person && (await this.deps.visibility.canReadTask(companyId, person, issueId))) out.push(userId);
    }
    return out;
  }

  private async prefix(companyId: string): Promise<string | null> {
    return (await this.deps.companies.get(companyId))?.issuePrefix ?? null;
  }

  private async agentName(agentId: string, companyId: string): Promise<string> {
    return (await this.deps.agents.get(agentId, companyId))?.name ?? "An agent";
  }

  private async prefsFor(userIds: string[]): Promise<Map<string, Prefs>> {
    const out = new Map<string, Prefs>();
    for (const userId of userIds) out.set(userId, await this.deps.store.prefs(userId));
    return out;
  }

  private async onApproval(event: PluginEvent): Promise<void> {
    const approvalId = str(event.entityId);
    if (!approvalId) return;
    const approval = await this.deps.approvals.get(approvalId, event.companyId);
    if (!approval || approval.status !== "pending") return;
    const members = await this.members(event.companyId);
    const userIds = approvalRecipients(members, userActor(event), await this.deps.visibility.restricted(event.companyId, members));
    const prefix = await this.prefix(event.companyId);
    if (userIds.length === 0 || !prefix) return;
    const agentName = approval.requestedByAgentId ? await this.agentName(approval.requestedByAgentId, event.companyId) : null;
    await this.deliver({ userIds, message: approvalMessage({ prefix, approval, agentName }) });
  }

  private async onIssueUpdated(event: PluginEvent): Promise<void> {
    const issueId = str(event.entityId);
    if (!issueId) return;
    const issue = await this.deps.issues.get(issueId, event.companyId);
    if (!issue) return;
    const reported = str(((event.payload ?? {}) as { _previous?: { status?: unknown } })._previous?.status);
    const stored = await this.deps.store.swapStatus(issue.id, issue.status);
    // Trusting the stored status over `_previous` (when it equals the current one) can miss a transition
    // that happened while the plugin was down; accepted to avoid duplicate notices.
    // Already seen in this status (a second event for the same change): nothing new to say.
    const previous = stored === issue.status ? issue.status : (reported ?? stored);
    const kind = statusTransition(issue.status, previous);
    if (!kind) return;
    const members = await this.members(event.companyId);
    const userIds = await this.readers(event.companyId, issue.id, taskOwners(issue, members, userActor(event)), members);
    const prefix = await this.prefix(event.companyId);
    if (userIds.length === 0 || !prefix) return;
    await this.deliver({ userIds, message: statusMessage({ prefix, issue, kind }) });
  }

  private async onComment(event: PluginEvent): Promise<void> {
    const issueId = str(event.entityId);
    if (!issueId) return;
    await this.safeCheckQuestions(event.companyId, issueId);
    const issue = await this.deps.issues.get(issueId, event.companyId);
    if (!issue) return;
    const members = await this.members(event.companyId);
    const candidates = await this.readers(event.companyId, issue.id, taskOwners(issue, members, userActor(event)), members);
    const prefs = await this.prefsFor(candidates);
    const userIds = candidates.filter((userId) => prefs.get(userId)?.comments === true);
    const prefix = await this.prefix(event.companyId);
    if (userIds.length === 0 || !prefix) return;
    const authorName = event.actorType === "agent" && event.actorId ? await this.agentName(event.actorId, event.companyId) : "A teammate";
    await this.deliver({ userIds, message: commentMessage({ prefix, authorName, issue }) });
  }

  private async onRunEnded(event: PluginEvent): Promise<void> {
    const payload = (event.payload ?? {}) as { issueId?: unknown; agentId?: unknown; runId?: unknown };
    const issueId = str(payload.issueId);
    if (issueId) await this.safeCheckQuestions(event.companyId, issueId);
    const agentId = str(payload.agentId);
    const runId = str(payload.runId);
    if (event.eventType !== "agent.run.failed" || !agentId || !runId) return;
    const members = await this.members(event.companyId);
    const userIds = failureRecipients(members, await this.prefsFor(members.map((member) => member.userId)));
    const prefix = await this.prefix(event.companyId);
    if (userIds.length === 0 || !prefix) return;
    if (!(await this.deps.store.claimFailure(agentId, FAILURE_WINDOW_MS))) return;
    await this.deliver({ userIds, message: failureMessage({ prefix, agentName: await this.agentName(agentId, event.companyId), agentId, runId }) });
  }

  private async safeCheckQuestions(companyId: string, issueId: string): Promise<void> {
    try {
      await this.checkQuestions(companyId, issueId);
    } catch (error) {
      this.deps.logger.warn(`kyoube.notify: question check for issue ${issueId} failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /** Option A: the core sends no event for a new question, so a task's open questions are checked when its agent's run ends or a comment lands. */
  private async checkQuestions(companyId: string, issueId: string): Promise<void> {
    const issue = await this.deps.issues.get(issueId, companyId);
    if (!issue) return;
    const open = (await this.deps.issues.listInteractions(issue.id, companyId)).filter(isOpenAgentQuestion);
    if (open.length === 0) return;
    const members = await this.members(companyId);
    const prefix = await this.prefix(companyId);
    if (!prefix) return;
    for (const interaction of open) {
      if (!(await this.deps.store.claimInteraction(interaction.id))) continue;
      const userIds = await this.readers(companyId, issue.id, askRecipients(interaction, issue, members), members);
      if (userIds.length === 0) continue;
      const agentName = await this.agentName(interaction.createdByAgentId!, companyId);
      await this.deliver({ userIds, message: askMessage({ prefix, agentName, interaction, issue }) });
    }
  }
}
