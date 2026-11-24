/**
 * What the agent profile changes (on duty, a new task and its files) goes
 * through the core's documented board API (docs/api/agents.md,
 * docs/api/issues.md), called from the browser as the signed-in person: the
 * core then applies its own permission checks and side effects exactly as for
 * its own buttons (pausing cancels the agent's active run; assigning a task
 * wakes the agent). The plugin holds no write capability of its own.
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

/** The most files one message can carry (the core's attachmentIds limit). */
export const MAX_TASK_FILES = 20;

/**
 * Adds files to a new task the way the core's chat sends them: each is uploaded to the task
 * (POST /api/companies/{companyId}/issues/{issueId}/attachments), then all are posted as one message
 * bound to the uploads (POST /api/issues/{issueId}/comments with attachmentIds), one Markdown link per
 * file. The task page shows them as file chips in the conversation, and the assignee's wake carries
 * them. A file the core refuses, or every file when the message fails, is named in `failed`.
 */
export async function attachTaskFiles(companyId: string, issueId: string, files: readonly File[], fetchImpl: typeof fetch = fetch): Promise<{ failed: string[] }> {
  const failed: string[] = [];
  const uploaded: Array<{ name: string; id: string; contentPath: string }> = [];
  for (const file of files) {
    try {
      const form = new FormData();
      form.append("file", file);
      const response = await fetchImpl(`/api/companies/${encodeURIComponent(companyId)}/issues/${encodeURIComponent(issueId)}/attachments`, {
        method: "POST",
        credentials: "include",
        body: form,
      });
      const attachment = await readBoardResponse<{ id: string; contentPath: string }>(response);
      uploaded.push({ name: file.name, id: attachment.id, contentPath: attachment.contentPath });
    } catch {
      failed.push(file.name);
    }
  }
  if (uploaded.length === 0) return { failed };
  try {
    await boardPost(`/api/issues/${encodeURIComponent(issueId)}/comments`, {
      body: uploaded.map((file) => `[${file.name.replace(/[[\]]/g, "\\$&")}](${file.contentPath})`).join("\n"),
      attachmentIds: uploaded.map((file) => file.id),
    }, fetchImpl);
  } catch {
    failed.push(...uploaded.map((file) => file.name));
  }
  return { failed };
}

/** POST /api/companies/{companyId}/issues, assigned to the agent and ready to start. */
export function assignTask(companyId: string, agentId: string, title: string, description: string, fetchImpl?: typeof fetch) {
  const body: Record<string, unknown> = { title: title.trim(), status: "todo", assigneeAgentId: agentId };
  if (description.trim()) body.description = description.trim();
  return boardPost<{ id: string; identifier?: string | null }>(`/api/companies/${encodeURIComponent(companyId)}/issues`, body, fetchImpl);
}
