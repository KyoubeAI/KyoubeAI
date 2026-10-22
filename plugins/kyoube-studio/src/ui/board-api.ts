/**
 * The two things the agent profile changes go through the core's documented
 * board API (docs/api/agents.md, docs/api/issues.md), called from the browser
 * as the signed-in person: the core then applies its own permission checks
 * and side effects exactly as for its own buttons (pausing cancels the
 * agent's active run; assigning a task wakes the agent). The plugin holds no
 * write capability of its own.
 */
export class BoardApiError extends Error {
  constructor(message: string, readonly status: number) { super(message); }
}

export async function boardPost<T = unknown>(path: string, body: unknown = {}, fetchImpl: typeof fetch = fetch): Promise<T> {
  const response = await fetchImpl(path, {
    method: "POST",
    credentials: "include",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return readBoardResponse<T>(response);
}

/** A board API answer's JSON, or a `BoardApiError` with the core's own message for a non-2xx. */
export async function readBoardResponse<T>(response: Response): Promise<T> {
  const text = await response.text();
  let json: unknown = null;
  try { json = text ? JSON.parse(text) : null; } catch { json = null; }
  if (!response.ok) {
    const message = json && typeof json === "object" && typeof (json as { error?: unknown }).error === "string" ? (json as { error: string }).error
      : json && typeof json === "object" && typeof (json as { message?: unknown }).message === "string" ? (json as { message: string }).message
      : `The server answered ${response.status}`;
    throw new BoardApiError(message, response.status);
  }
  return json as T;
}

/** POST /api/agents/{agentId}/pause or /resume. */
export function setAgentOnDuty(agentId: string, onDuty: boolean, fetchImpl?: typeof fetch) {
  return boardPost(`/api/agents/${encodeURIComponent(agentId)}/${onDuty ? "resume" : "pause"}`, {}, fetchImpl);
}

/** POST /api/companies/{companyId}/issues, assigned to the agent and ready to start. */
export function assignTask(companyId: string, agentId: string, title: string, description: string, fetchImpl?: typeof fetch) {
  const body: Record<string, unknown> = { title: title.trim(), status: "todo", assigneeAgentId: agentId };
  if (description.trim()) body.description = description.trim();
  return boardPost<{ id: string; identifier?: string | null }>(`/api/companies/${encodeURIComponent(companyId)}/issues`, body, fetchImpl);
}
