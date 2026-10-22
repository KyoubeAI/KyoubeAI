/**
 * Tasks, pending approvals and task comments, read in the browser through the
 * core's board API as the signed-in person (docs/api/issues.md,
 * docs/api/approvals.md). The core answers only what that person may see, so
 * the roster, Home and the profiles show a person whose visibility is
 * restricted only their share. The worker serves agents and access only.
 */
import { useEffect, useReducer, useState } from "react";
import { useHostContext } from "@paperclipai/plugin-sdk/ui";
import type { ApprovalLike, IssueLike } from "../model.js";
import type { CommentLike, ProfileAgentLike } from "../profile.js";
import { BoardApiError, readBoardResponse } from "./board-api.js";
import { useCompanyParams, usePoll, usePolledData } from "./shared.js";

/** How long one company's snapshot is reused, so the roster and Home, which both poll, share one read. */
export const SNAPSHOT_MS = 8_000;
/** Tasks read per snapshot. The core lists the latest activity first and caps a page at 1000; older tasks do not change what Studio shows. */
const ISSUE_LIMIT = 500;

export interface BoardSnapshot {
  issues: IssueLike[];
  approvals: ApprovalLike[];
  /** The core refused the approvals: a person whose visibility is restricted sees none. */
  approvalsHidden: boolean;
}

/** GET a board API path with the session; a non-2xx throws `BoardApiError` with the core's message. */
export async function boardGet<T>(path: string, fetchImpl: typeof fetch = fetch): Promise<T> {
  return readBoardResponse<T>(await fetchImpl(path, { credentials: "include", headers: { Accept: "application/json" } }));
}

/** A board API list. Anything else (say, a proxy's error page) is a failed read, not an empty list. */
async function boardList<T>(path: string, fetchImpl: typeof fetch): Promise<T[]> {
  const rows = await boardGet<unknown>(path, fetchImpl);
  if (!Array.isArray(rows)) throw new Error(`${path} did not answer a list`);
  return rows as T[];
}

async function readSnapshot(companyId: string, fetchImpl: typeof fetch): Promise<BoardSnapshot> {
  const company = encodeURIComponent(companyId);
  const [issues, approvals] = await Promise.all([
    boardList<IssueLike>(`/api/companies/${company}/issues?limit=${ISSUE_LIMIT}`, fetchImpl),
    boardList<ApprovalLike>(`/api/companies/${company}/approvals?status=pending`, fetchImpl).catch((error: unknown) => {
      if (error instanceof BoardApiError && error.status === 403) return null;
      throw error;
    }),
  ]);
  return { issues, approvals: approvals ?? [], approvalsHidden: approvals === null };
}

/**
 * Everything below is kept per person and company (or per person and task):
 * what the core answers depends on who asks, and its sign-out does not reload
 * the page, so the next person to sign in on the tab meets this memory.
 */
const keyOf = (userId: string | null, id: string) => `${userId ?? ""}:${id}`;
/** Each person's latest read of a company, reused for SNAPSHOT_MS. */
const snapshots = new Map<string, { at: number; value: Promise<BoardSnapshot> }>();
/** Each person's last snapshot of a company that loaded, which the views show while the next read is in flight. */
const latest = new Map<string, { at: number; data: BoardSnapshot }>();
/** Each person's last comments on a task that loaded. */
const comments = new Map<string, CommentLike[]>();
const NO_COMMENTS: CommentLike[] = [];
/** Whose reads the memory holds (undefined: no one's yet). */
let holder: string | null | undefined;

/** Before a read for `userId`: if the memory holds another person's reads, drop every one of them. */
function holdFor(userId: string | null): void {
  if (holder === userId) return;
  snapshots.clear();
  latest.clear();
  comments.clear();
  holder = userId;
}

/** Whose view of which company a snapshot is. */
export interface BoardKey { userId: string | null; companyId: string }

/** One company's tasks and pending approvals as the person sees them; `fresh` skips (and replaces) the short-lived cache. */
export function loadBoardSnapshot({ userId, companyId }: BoardKey, opts: { fetchImpl?: typeof fetch; fresh?: boolean; now?: () => number } = {}): Promise<BoardSnapshot> {
  const now = opts.now ?? Date.now;
  holdFor(userId);
  const key = keyOf(userId, companyId);
  const cached = snapshots.get(key);
  if (!opts.fresh && cached && now() - cached.at < SNAPSHOT_MS) return cached.value;
  const at = now();
  const value = readSnapshot(companyId, opts.fetchImpl ?? fetch);
  snapshots.set(key, { at, value });
  value.then(
    (data) => {
      // Not kept once someone else's read has started (they signed in meanwhile),
      // and a slower, older read never replaces a newer answer.
      if (holder === userId && (latest.get(key)?.at ?? -Infinity) <= at) latest.set(key, { at, data });
    },
    // A failed read must not be served from the cache for the next 8 s.
    () => { if (snapshots.get(key)?.value === value) snapshots.delete(key); },
  );
  return value;
}

/** The comments on one task, in whatever order the core lists them (the profile sorts its notes itself). */
export async function loadIssueComments({ userId, issueId }: { userId: string | null; issueId: string }, fetchImpl: typeof fetch = fetch): Promise<CommentLike[]> {
  holdFor(userId);
  const rows = await boardList<CommentLike>(`/api/issues/${encodeURIComponent(issueId)}/comments`, fetchImpl);
  if (holder === userId) comments.set(keyOf(userId, issueId), rows);
  return rows;
}

/**
 * The company's snapshot as the signed-in person sees it, read on mount and
 * polled like `usePolledData`: skipped while the tab is hidden, and the last
 * good answer kept on screen through a failed read. `refresh` reads fresh,
 * for after a change.
 */
export function useBoardSnapshot(companyId: string, intervalMs: number): { data: BoardSnapshot | null; error: string | null; refresh: () => void } {
  const { userId } = useHostContext();
  const key = keyOf(userId, companyId);
  // Set after each read so the view draws what landed; the snapshot itself lives in `latest`.
  const [outcome, setOutcome] = useState<{ key: string; error: string | null }>({ key, error: null });
  const load = (fresh: boolean) => {
    if (!companyId) return;
    loadBoardSnapshot({ userId, companyId }, { fresh }).then(
      () => setOutcome({ key, error: null }),
      (error: unknown) => setOutcome({ key, error: error instanceof Error ? error.message : String(error) }),
    );
  };
  useEffect(() => load(false), [key]);
  usePoll(() => load(false), intervalMs);
  return {
    data: companyId ? latest.get(key)?.data ?? null : null,
    error: outcome.key === key ? outcome.error : null,
    refresh: () => load(true),
  };
}

/** The signed-in person's comments on one task (none for `null`), read when the task changes and on each poll; the last answer is kept. */
export function useIssueComments(issueId: string | null, intervalMs: number): CommentLike[] {
  const { userId } = useHostContext();
  const [, landed] = useReducer((count: number) => count + 1, 0);
  const load = () => {
    if (!issueId) return;
    // On a failure the last answer stays; the next poll tries again.
    loadIssueComments({ userId, issueId }).then(() => landed(), () => {});
  };
  useEffect(load, [userId, issueId]);
  usePoll(load, intervalMs);
  return (issueId && comments.get(keyOf(userId, issueId))) || NO_COMMENTS;
}

/** The company's agents (from the worker) and its snapshot (read here), polled together: what the roster, Home and the profiles draw. */
export function useTeamData(intervalMs: number) {
  const host = useHostContext();
  const agents = usePolledData<{ agents: ProfileAgentLike[] }>("agents", useCompanyParams(), intervalMs);
  const board = useBoardSnapshot(host.companyId ?? "", intervalMs);
  return {
    agents: agents.data?.agents ?? null,
    board: board.data,
    /** Why the last read failed; the views show it only while they have nothing to draw. */
    error: agents.error?.message ?? board.error,
    refresh: () => { agents.refresh(); board.refresh(); },
  };
}

/** Clears every cache, between tests. */
export function _resetBoardData(): void {
  snapshots.clear();
  latest.clear();
  comments.clear();
  holder = undefined;
}
