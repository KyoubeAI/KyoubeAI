import type { GroupsApplyReport, GuardReport } from "./api.js";

export interface Failure {
  step: "list" | "governance" | "guard" | "rules" | "groups" | "asklevels";
  agent?: string;
  error: string;
}

export interface CompanyReport {
  companyId: string;
  name: string;
  governance: "set" | "already" | "restored" | "failed";
  guard: GuardReport | null;
  /** Absent in reports saved before groups existed. */
  groups?: GroupsApplyReport | null;
  /** Agents whose AGENTS.md this pass wrote. */
  rulesUpdated: string[];
  /** Agents whose metadata this pass gave a new ask level. Absent in reports saved before agent questions. */
  askLevelsUpdated?: string[];
  skipped: Array<{ agent: string; reason: string }>;
  failures: Failure[];
  /** Writes this pass made to the core, for the summary and the smoke's idempotence check. */
  writes: number;
}

export interface PassReport {
  at: string;
  /** "groups": the group step alone, which is what a pass does while the rules are off (ruling R15). */
  mode: "apply" | "revert" | "groups";
  companies: CompanyReport[];
  /** Failures before any company was reached, such as listing the companies. */
  failures: Failure[];
}

const plural = (count: number, one: string, many: string) => `${count} ${count === 1 ? one : many}`;

export function failureLines(report: PassReport): string[] {
  const prefix = report.mode === "groups" ? "kyoube: user groups:" : "kyoube: agent rules:";
  const lines = report.failures.map((failure) => `${prefix} ${failure.step} failed: ${failure.error}`);
  for (const company of report.companies) {
    for (const failure of company.failures) {
      lines.push(`${prefix} ${company.name}${failure.agent ? ` / ${failure.agent}` : ""}: ${failure.step} failed: ${failure.error}`);
    }
  }
  return lines;
}

/** One line per pass; it carries no time, so an unchanged watch loop can log it once. */
export function summarize(report: PassReport): string {
  const companies = plural(report.companies.length, "company", "companies");
  const changes = plural(report.companies.reduce((sum, company) => sum + company.writes, 0), "change", "changes");
  const failures = plural(failureLines(report).length, "failure", "failures");
  if (report.mode === "revert") return `kyoube: agent rules removed: ${companies}, ${changes}, ${failures}`;
  const skipped = report.companies.reduce((sum, company) => sum + company.skipped.length, 0);
  if (report.mode === "groups") return `kyoube: agent rules are off (KYOUBE_AGENT_RULES=off); user groups only: ${companies}, ${changes}, ${skipped} skipped, ${failures}`;
  const tests = report.companies.map((company) => company.guard?.selfTest.status);
  const selfTest = tests.includes("fail") ? "fail" : tests.includes("pass") ? "pass" : "not applicable";
  return `kyoube: agent rules: ${companies}, ${changes}, ${skipped} skipped, ${failures}; self-test ${selfTest}`;
}
