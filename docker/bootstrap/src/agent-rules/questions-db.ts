import pg from "pg";

/**
 * How often agents ask agents (docs/agent-rules.md, "Agent questions"), for
 * `kyoube doctor`: the core keeps every card in issue_thread_interactions, and
 * no API lists them across a company, so this reads the core database, as
 * licensing does (license/core-db.ts). Only `kyoube` uses this, never a plugin.
 * Refused questions are never stored and so never counted.
 */

/** One task and one asking agent: questions in the last 7 days, and all-time questions on that task by that agent. */
export interface QuestionRow {
  companyName: string;
  issueId: string;
  agentId: string;
  agentName: string | null;
  recent: number;
  total: number;
}

export interface QuestionSummary {
  company: string;
  asked: number;
  askers: number;
  top: { name: string; asked: number } | null;
  tasksAtLimit: number;
}

export const QUESTION_ROWS_SQL = `SELECT c.name AS company_name, i.issue_id, i.created_by_agent_id AS agent_id, a.name AS agent_name,
  count(*) FILTER (WHERE i.created_at > now() - interval '7 days')::int AS recent,
  count(*)::int AS total
FROM issue_thread_interactions i
JOIN companies c ON c.id = i.company_id
LEFT JOIN agents a ON a.id = i.created_by_agent_id
WHERE i.kind = 'ask_user_questions' AND i.created_by_agent_id IS NOT NULL AND i.addressee_agent_id IS NOT NULL
GROUP BY c.name, i.issue_id, i.created_by_agent_id, a.name
HAVING count(*) FILTER (WHERE i.created_at > now() - interval '7 days') > 0`;

/** Per company, sorted by name: questions this week, distinct askers, the top asker, and tasks that reached `limit`. */
export function summarizeQuestions(rows: QuestionRow[], limit = 3): QuestionSummary[] {
  const companies = new Map<string, QuestionRow[]>();
  for (const row of rows) {
    if (!companies.has(row.companyName)) companies.set(row.companyName, []);
    companies.get(row.companyName)!.push(row);
  }
  return [...companies.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([company, list]) => {
      const byAgent = new Map<string, { name: string; asked: number }>();
      const byTask = new Map<string, number>();
      for (const row of list) {
        const agent = byAgent.get(row.agentId) ?? { name: row.agentName ?? row.agentId, asked: 0 };
        agent.asked += row.recent;
        byAgent.set(row.agentId, agent);
        byTask.set(row.issueId, (byTask.get(row.issueId) ?? 0) + row.total);
      }
      const top = [...byAgent.values()].sort((a, b) => b.asked - a.asked || a.name.localeCompare(b.name))[0] ?? null;
      return {
        company,
        asked: list.reduce((sum, row) => sum + row.recent, 0),
        askers: byAgent.size,
        top,
        tasksAtLimit: [...byTask.values()].filter((count) => count >= limit).length,
      };
    });
}

export async function readQuestionSummaries(url: string): Promise<QuestionSummary[]> {
  const pool = new pg.Pool({ connectionString: url, max: 1 });
  pool.on("error", () => {});
  try {
    const { rows } = await pool.query<{ company_name: string; issue_id: string; agent_id: string; agent_name: string | null; recent: number; total: number }>(QUESTION_ROWS_SQL);
    return summarizeQuestions(rows.map((row) => ({ companyName: row.company_name, issueId: row.issue_id, agentId: row.agent_id, agentName: row.agent_name, recent: row.recent, total: row.total })));
  } finally {
    await pool.end();
  }
}
