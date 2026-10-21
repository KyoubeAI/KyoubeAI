import pg from "pg";

/**
 * How often agents ask agents (docs/agent-rules.md, "Agent questions"), for
 * `kyoube doctor`: the core keeps every card in issue_thread_interactions, and
 * no API lists them across a company, so this reads the core database, as
 * licensing does (license/core-db.ts). Only `kyoube` uses this, never a plugin.
 * Refused questions are never stored and so never counted.
 */

/**
 * One task and one asking agent that asked in the last 7 days. `taskTotal` is
 * every question between agents on that task, from any agent and of any age,
 * because that is what the task's limit counts (core-patches/ask-level.mjs).
 */
export interface QuestionRow {
  companyId: string;
  companyName: string;
  issueId: string;
  agentId: string;
  agentName: string | null;
  recent: number;
  taskTotal: number;
}

export interface QuestionSummary {
  company: string;
  asked: number;
  askers: number;
  top: { name: string; asked: number } | null;
  tasksAtLimit: number;
}

/** The recency filter comes last, so a task's total still counts older questions and other agents' questions. */
export const QUESTION_ROWS_SQL = `WITH per AS (
  SELECT i.company_id, i.issue_id, i.created_by_agent_id AS agent_id,
    count(*) FILTER (WHERE i.created_at > now() - interval '7 days')::int AS recent,
    count(*)::int AS total
  FROM issue_thread_interactions i
  WHERE i.kind = 'ask_user_questions' AND i.created_by_agent_id IS NOT NULL AND i.addressee_agent_id IS NOT NULL
  GROUP BY i.company_id, i.issue_id, i.created_by_agent_id
), tasks AS (
  SELECT per.*, (sum(per.total) OVER (PARTITION BY per.issue_id))::int AS task_total FROM per
)
SELECT t.company_id, c.name AS company_name, t.issue_id, t.agent_id, a.name AS agent_name, t.recent, t.task_total
FROM tasks t
JOIN companies c ON c.id = t.company_id
LEFT JOIN agents a ON a.id = t.agent_id
WHERE t.recent > 0`;

/** Per company (by id; sorted by name, then id): questions this week, distinct askers, the top asker, and tasks that reached `limit` in all. */
export function summarizeQuestions(rows: QuestionRow[], limit = 3): QuestionSummary[] {
  const companies = new Map<string, QuestionRow[]>();
  for (const row of rows) {
    if (!companies.has(row.companyId)) companies.set(row.companyId, []);
    companies.get(row.companyId)!.push(row);
  }
  return [...companies.entries()]
    .map(([id, list]) => ({ id, name: list[0]!.companyName, list }))
    .sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id))
    .map(({ name, list }) => {
      const byAgent = new Map<string, { name: string; asked: number }>();
      const taskTotals = new Map<string, number>();
      for (const row of list) {
        const agent = byAgent.get(row.agentId) ?? { name: row.agentName ?? row.agentId, asked: 0 };
        agent.asked += row.recent;
        byAgent.set(row.agentId, agent);
        taskTotals.set(row.issueId, Math.max(taskTotals.get(row.issueId) ?? 0, row.taskTotal));
      }
      const top = [...byAgent.values()].sort((a, b) => b.asked - a.asked || a.name.localeCompare(b.name))[0] ?? null;
      return {
        company: name,
        asked: list.reduce((sum, row) => sum + row.recent, 0),
        askers: byAgent.size,
        top,
        tasksAtLimit: [...taskTotals.values()].filter((total) => total >= limit).length,
      };
    });
}

export async function readQuestionSummaries(url: string): Promise<QuestionSummary[]> {
  const pool = new pg.Pool({ connectionString: url, max: 1 });
  pool.on("error", () => {});
  try {
    const { rows } = await pool.query<{ company_id: string; company_name: string; issue_id: string; agent_id: string; agent_name: string | null; recent: number; task_total: number }>(QUESTION_ROWS_SQL);
    return summarizeQuestions(rows.map((row) => ({ companyId: row.company_id, companyName: row.company_name, issueId: row.issue_id, agentId: row.agent_id, agentName: row.agent_name, recent: row.recent, taskTotal: row.task_total })));
  } finally {
    await pool.end();
  }
}
