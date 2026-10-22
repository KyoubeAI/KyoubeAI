import pg from "pg";
import { parseMode, type VisibilityMode } from "@kyoube/visibility";

/**
 * Every company's visibility mode as the Groups page stores it (docs/groups.md), for
 * `kyoube doctor` to hold against the index the core reads. The modes live in the kyoube
 * database, not the core's; a company without a settings row is open. Only `kyoube` uses this.
 */
export const VISIBILITY_MODES_SQL =
  "SELECT c.company_id, coalesce(s.visibility_mode, 'open') AS mode FROM kyoube_meta.companies c LEFT JOIN kyoube_meta.company_settings s USING (company_id)";

interface ModeRow {
  company_id: string;
  mode: string;
}

/** The two pool calls this needs; a test passes a fake. */
export interface ModesPool {
  query(sql: string): Promise<{ rows: ModeRow[] }>;
  end(): Promise<void>;
}

function openPool(url: string): ModesPool {
  const pool = new pg.Pool({ connectionString: url, max: 1 });
  pool.on("error", () => {});
  return { query: (sql) => pool.query<ModeRow>(sql), end: () => pool.end() };
}

/** Throws when the database cannot be read or holds a mode KyoubeAI does not know. */
export async function readVisibilityModes(url: string, open: (url: string) => ModesPool = openPool): Promise<Map<string, VisibilityMode>> {
  const pool = open(url);
  try {
    const { rows } = await pool.query(VISIBILITY_MODES_SQL);
    const modes = new Map<string, VisibilityMode>();
    for (const row of rows) {
      const mode = parseMode(row.mode);
      if (mode === null) throw new Error(`kyoube_meta.company_settings holds an unknown visibility mode for ${row.company_id}`);
      modes.set(row.company_id, mode);
    }
    return modes;
  } finally {
    await pool.end();
  }
}
