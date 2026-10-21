import { access, readFile } from "node:fs/promises";
import net from "node:net";
import path from "node:path";
import { readConfig, resolveConfigPath, type KyoubeConfig } from "../config.js";
import { readBoardKey, resolveBoardApiKey, resolveBoardKeyPath } from "../key-store.js";
import { createCoreClient, type CompanySkill, type CompanySummary } from "../core-api.js";
import { describeHarness, harnessesForAdapterTypes, missingHarnesses, probeHarnesses, systemProbe, type HarnessSpec, type HarnessStatus } from "../harnesses.js";
import { describeMissing, KYOUBE_SKILLS, missingKyoubeSkills } from "../skills.js";
import { readState, resolveStatePath, type AgentRulesState } from "../agent-rules/state.js";
import { failureLines } from "../agent-rules/report.js";
import { readQuestionSummaries, type QuestionSummary } from "../agent-rules/questions-db.js";
import { agentRulesEnabled } from "./agent-rules.js";
import { AUTH_MODULE_PATH, ENFORCE_MODULE_PATH, HOOK_MARKER, licensePaths, licenseStatus, readTrimmed, readUserSnapshot, TRUSTED_KEYS, type LicenseStatus } from "@kyoube/license";
import { pathToFileURL } from "node:url";
import { coreDatabaseUrl, openCoreUsersDb } from "../license/core-db.js";

export interface Check { name: string; ok: boolean; detail: string; /** Printed as WARN; doesn't fail doctor. */ warn?: boolean }

/**
 * Whether every company's skill library holds both Kyoube skills. A company
 * with none is not an error state for the instance — the worker installs them
 * when the company is created — but a company that is missing one after that
 * is, because its agents cannot be given the skill.
 */
export function skillsCheck(companies: CompanySummary[], skillsByCompany: Map<string, CompanySkill[]>): Check {
  if (companies.length === 0) return { name: "skills", ok: true, detail: "no company yet — installed automatically when one is created" };
  const missing = companies
    .map((company) => ({ company, slugs: missingKyoubeSkills(skillsByCompany.get(company.id) ?? []) }))
    .filter(({ slugs }) => slugs.length > 0);
  const names = KYOUBE_SKILLS.map((skill) => skill.slug).join(" + ");
  if (missing.length === 0) return { name: "skills", ok: true, detail: `${names} present in ${companies.length}/${companies.length} companies` };
  return { name: "skills", ok: false, detail: `missing in ${describeMissing(missing)} — open Company Settings → Data access there and click "Install the Kyoube Data skill"` };
}

function tcpReachable(url: string): Promise<{ ok: boolean; detail: string }> {
  return new Promise((resolve) => {
    let host = "";
    let port = 5432;
    try {
      const parsed = new URL(url);
      host = parsed.hostname;
      port = Number(parsed.port || 5432);
    } catch {
      resolve({ ok: false, detail: "invalid URL" });
      return;
    }
    const socket = net.connect({ host, port, timeout: 5000 });
    socket.once("connect", () => { socket.destroy(); resolve({ ok: true, detail: `${host}:${port} reachable` }); });
    socket.once("timeout", () => { socket.destroy(); resolve({ ok: false, detail: `${host}:${port} timed out` }); });
    socket.once("error", (error) => { resolve({ ok: false, detail: `${host}:${port} ${error.message}` }); });
  });
}

async function fileExists(filePath: string): Promise<boolean> {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

/**
 * A public deployment (`KYOUBE_DEPLOYMENT_EXPOSURE=public`) with a non-`https://` public URL
 * means the board key, session cookies, and every plugin API call travel in the clear to whoever
 * is on the path — put TLS in front (a reverse proxy or load balancer) and point
 * `KYOUBE_PUBLIC_URL` at the `https://` address before exposing the instance. A `private`
 * deployment (the default, e.g. behind a VPN/tailnet) is not warned about either way: the operator
 * has already decided who can reach it. The function still reads `env.PAPERCLIP_DEPLOYMENT_EXPOSURE`,
 * which is what compose sets inside the container.
 */
export function exposureWarning(env: NodeJS.ProcessEnv, publicUrl: string): string | null {
  if ((env.PAPERCLIP_DEPLOYMENT_EXPOSURE ?? "private") !== "public") return null;
  if (!publicUrl.startsWith("https://")) return `KYOUBE_DEPLOYMENT_EXPOSURE=public but KYOUBE_PUBLIC_URL is ${publicUrl}; put TLS in front and use an https URL`;
  return null;
}

/** Marker `scripts/migrate-from-0.1.sh` leaves in the home volume; while it exists the entrypoint keeps the legacy `/paperclip` path resolvable. */
export const MIGRATION_MARKER = ".migrated-from-paperclip-home";

/** The `.env` keys this release still accepts through compose fallbacks, and what replaces them. */
export const LEGACY_ENV_KEYS: Record<string, string> = {
  PAPERCLIP_PUBLIC_URL: "KYOUBE_PUBLIC_URL",
  PAPERCLIP_DEPLOYMENT_EXPOSURE: "KYOUBE_DEPLOYMENT_EXPOSURE",
  PAPERCLIP_VERSION: "KYOUBE_CORE_VERSION",
};

/**
 * Compose cannot tell the container which `.env` key supplied a value, so it
 * passes the names of the legacy keys that were set (`KYOUBE_LEGACY_ENV_KEYS`,
 * built with `${VAR:+VAR }` substitutions in docker-compose.yml). Informational:
 * the values still work this release.
 */
export function legacyEnvCheck(env: NodeJS.ProcessEnv): Check {
  const keys = (env.KYOUBE_LEGACY_ENV_KEYS ?? "").split(/\s+/).filter(Boolean);
  if (keys.length === 0) return { name: "legacy env", ok: true, detail: "none" };
  const renames = keys.map((key) => `${key} -> ${LEGACY_ENV_KEYS[key] ?? "?"}`).join(", ");
  return { name: "legacy env", ok: true, detail: `${renames} (still honoured; bash scripts/migrate-from-0.1.sh renames them in .env; the old names go away next release)` };
}

export async function legacyHomeLinkCheck(home: string, exists: (file: string) => Promise<boolean> = fileExists): Promise<Check> {
  const marker = path.posix.join(home, MIGRATION_MARKER);
  if (!(await exists(marker))) return { name: "legacy home link", ok: true, detail: "none" };
  return {
    name: "legacy home link",
    ok: true,
    detail: `/paperclip -> ${home} compatibility link active (${marker} exists); run 'bash scripts/migrate-from-0.1.sh --check' and delete the marker when it reports 0 legacy paths`,
  };
}

/**
 * scripts/smoke.sh writes this file so kyoube.notify will send to its local
 * receiver. Nothing else should: on a real instance it would let one URL
 * outside the push services receive notifications.
 */
export async function pushTestEndpointCheck(home: string, env: NodeJS.ProcessEnv, exists: (file: string) => Promise<boolean> = fileExists): Promise<Check | null> {
  const file = path.posix.join(home, "kyoube", "push-test-endpoint");
  if (!(await exists(file))) return null;
  if ((env.PAPERCLIP_DEPLOYMENT_EXPOSURE ?? "private") === "public") {
    return { name: "push test endpoint", ok: false, detail: `${file} exists on a public instance; delete it (only the smoke test writes it)` };
  }
  return { name: "push test endpoint", ok: true, warn: true, detail: `${file} exists, so notifications may also go to a test receiver; delete it unless this is the smoke test` };
}

async function readOptional(filePath: string): Promise<string | null> {
  try {
    return await readFile(filePath, "utf8");
  } catch {
    return null;
  }
}

/** One informational line per harness CLI on PATH; the image ships none of its own. */
export function harnessChecks(statuses: HarnessStatus[]): Check[] {
  const installed = statuses.filter((status) => status.path);
  if (installed.length === 0) return [{ name: "harnesses", ok: true, detail: "none installed — see README → Harnesses (kyoube harness install <name>)" }];
  return installed.map((status) => ({ name: `${status.spec.name} cli`, ok: true, detail: describeHarness(status) }));
}

/** Fails when an agent's harness is not installed or does not run: that agent's runs would fail. */
export function harnessesInUseCheck(statuses: HarnessStatus[], inUse: Map<string, number>): Check {
  if (inUse.size === 0) return { name: "harnesses in use", ok: true, detail: "no agents yet" };
  const used = [...inUse.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([type, count]) => `${type} (${count})`).join(", ");
  const missing = missingHarnesses(statuses, inUse.keys());
  const needed = new Set(harnessesForAdapterTypes(inUse.keys()).map((spec) => spec.name));
  const broken = statuses.filter((status) => needed.has(status.spec.name) && status.path && status.version === null).map((status) => status.spec);
  if (missing.length === 0 && broken.length === 0) return { name: "harnesses in use", ok: true, detail: used };
  const fix = (spec: HarnessSpec) => (spec.install ? `kyoube harness install ${spec.name}` : `install ${spec.label}`);
  const problems: string[] = [];
  if (missing.length > 0) problems.push(`not installed: ${missing.map((spec) => spec.name).join(", ")} (${missing.map(fix).join("; ")})`);
  if (broken.length > 0) problems.push(`does not run: ${broken.map((spec) => spec.name).join(", ")} (${broken.map(fix).join("; ")})`);
  return { name: "harnesses in use", ok: false, detail: `${used} — ${problems.join(" — ")}` };
}

/** The packages `sudo apt install` kept (docker/system/apt-record) and whether the last start put them back. */
export function systemPackagesCheck(list: string | null, status: string | null, logPath: string): Check {
  const packages = (list ?? "").split("\n").map((line) => line.trim()).filter((line) => line.length > 0 && !line.startsWith("#"));
  if (/^failed\b/.test(status?.trim() ?? "")) {
    return { name: "system packages", ok: false, detail: `reinstalling the kept packages failed at the last start — see ${logPath} (${packages.join(", ")})` };
  }
  if (packages.length === 0) return { name: "system packages", ok: true, detail: "none kept (sudo apt install <package> keeps one across restarts and updates)" };
  const shown = packages.slice(0, 8).join(", ") + (packages.length > 8 ? `, … (${packages.length - 8} more)` : "");
  return { name: "system packages", ok: true, detail: `${packages.length} kept: ${shown}` };
}

export const AGENT_RULES_STALE_MS = 5 * 60_000;

/**
 * The agent working rules (docs/agent-rules.md), from the last pass the
 * background loop recorded. Skipped agents get their own line, which is always
 * ok: they are left alone on purpose, but someone should know.
 */
export function agentRulesChecks(env: NodeJS.ProcessEnv, state: AgentRulesState, now: number): Check[] {
  if (!agentRulesEnabled(env)) {
    // Switched off without `kyoube agent-rules off`: the last pass's changes are all still in place.
    if (state.lastPass?.mode === "apply") {
      return [{ name: "agent rules", ok: false, detail: "off (KYOUBE_AGENT_RULES=off), but the rules are still applied: run kyoube agent-rules off" }, ...groupSyncChecks(state, now)];
    }
    return [{ name: "agent rules", ok: true, detail: "off (KYOUBE_AGENT_RULES=off); the loop still syncs user groups" }, ...groupSyncChecks(state, now)];
  }
  const pass = state.lastPass;
  if (!pass) {
    return [{ name: "agent rules", ok: false, detail: "no pass yet — the container starts kyoube agent-rules --watch; run kyoube agent-rules --once to see what stops it" }];
  }
  const skippedAgents = pass.companies.flatMap((company) => company.skipped.map((item) => `${company.name} / ${item.agent}: ${item.reason}`));
  const skipped: Check = { name: "agent rules skipped", ok: true, detail: skippedAgents.length > 0 ? skippedAgents.join("; ") : "none" };
  if (pass.mode === "revert") {
    return [{ name: "agent rules", ok: false, detail: `removed at ${pass.at} by kyoube agent-rules off; the running loop puts them back within a minute unless KYOUBE_AGENT_RULES=off` }, skipped];
  }
  if (!(now - Date.parse(pass.at) <= AGENT_RULES_STALE_MS)) {
    return [{ name: "agent rules", ok: false, detail: `last pass at ${pass.at}, more than 5 minutes ago — is kyoube agent-rules --watch running?` }, skipped];
  }
  const failures = failureLines(pass).map((line) => line.replace(/^kyoube: agent rules: /, ""));
  if (failures.length > 0) {
    return [{ name: "agent rules", ok: false, detail: `${failures[0]}${failures.length > 1 ? ` (and ${failures.length - 1} more)` : ""}` }, skipped];
  }
  const companies = pass.companies.length;
  const passed = pass.companies.filter((company) => company.guard?.selfTest.status === "pass").length;
  return [{ name: "agent rules", ok: true, detail: `in force in ${companies} ${companies === 1 ? "company" : "companies"} (self-test passed in ${passed}) as of ${pass.at}` }, skipped];
}

/**
 * With the rules off, the loop runs only the user-groups step (ruling R15), recorded as
 * `lastGroupsPass`. With the rules on, group failures are part of the `agent rules` line instead.
 */
function groupSyncChecks(state: AgentRulesState, now: number): Check[] {
  const pass = state.lastGroupsPass;
  if (!pass || !Array.isArray(pass.companies)) {
    return [{ name: "user groups", ok: false, detail: "no group sync yet — kyoube agent-rules --watch syncs user groups even with the rules off; run kyoube agent-rules --once to see what stops it" }];
  }
  const checks: Check[] = [];
  const failures = failureLines(pass).map((line) => line.replace(/^kyoube: user groups: /, ""));
  if (!(now - Date.parse(pass.at) <= AGENT_RULES_STALE_MS)) {
    checks.push({ name: "user groups", ok: false, detail: `last group sync at ${pass.at}, more than 5 minutes ago — is kyoube agent-rules --watch running?` });
  } else if (failures.length > 0) {
    checks.push({ name: "user groups", ok: false, detail: `${failures[0]}${failures.length > 1 ? ` (and ${failures.length - 1} more)` : ""}` });
  } else {
    const companies = pass.companies.length;
    checks.push({ name: "user groups", ok: true, detail: `synced in ${companies} ${companies === 1 ? "company" : "companies"} as of ${pass.at}` });
  }
  const skipped = pass.companies.flatMap((company) => company.skipped.map((item) => `${company.name} / ${item.agent}: ${item.reason}`));
  if (skipped.length > 0) checks.push({ name: "user groups skipped", ok: true, detail: skipped.join("; ") });
  return checks;
}

export async function agentRulesDoctorChecks(
  env: NodeJS.ProcessEnv,
  statePath: string,
  now: number,
  read: (file: string) => Promise<AgentRulesState> = (file) => readState(file, () => {}),
): Promise<Check[]> {
  // Off, an unreadable file still gives the plain "off" line; the group sync it would record is
  // reported as unreadable rather than missing.
  if (!agentRulesEnabled(env)) {
    try {
      return agentRulesChecks(env, await read(statePath), now);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return [
        { name: "agent rules", ok: true, detail: "off (KYOUBE_AGENT_RULES=off); the loop still syncs user groups" },
        { name: "user groups", ok: false, detail: `cannot read ${statePath}: ${message}` },
      ];
    }
  }
  try {
    return agentRulesChecks(env, await read(statePath), now);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return [{ name: "agent rules", ok: false, detail: `cannot read ${statePath}: ${message}` }];
  }
}

export function claudeCredentialDetail(raw: string | null, filePath: string): string {
  if (raw === null) return `not found (${filePath}) — only agents without an AI connection use it`;
  try {
    const expiresAt = (JSON.parse(raw) as { claudeAiOauth?: { expiresAt?: unknown } }).claudeAiOauth?.expiresAt;
    if (typeof expiresAt === "number") return `present (${filePath}); access token until ${new Date(expiresAt).toISOString()}, which Claude refreshes itself`;
    return `present (${filePath})`;
  } catch {
    return `present but unreadable (${filePath})`;
  }
}

/**
 * Whether the user limit is enforced: the seat check loads, and the served
 * auth module carries the core patch's hook. Either missing means sign-ups are
 * refused with LICENSE_CHECK_FAILED, or the limit isn't enforced at all.
 */
export async function licenceEnforcementCheck(opts: {
  modulePath: string;
  authModulePath: string;
  importModule?: (file: string) => Promise<unknown>;
  readText?: (file: string) => Promise<string | null>;
}): Promise<Check> {
  const name = "licence enforcement";
  const importModule = opts.importModule ?? ((file: string) => import(pathToFileURL(file).href));
  const readText = opts.readText ?? readOptional;
  try {
    const module = (await importModule(opts.modulePath)) as { checkSeat?: unknown };
    if (typeof module.checkSeat !== "function") return { name, ok: false, detail: `${opts.modulePath} has no checkSeat; rebuild the image` };
  } catch (error) {
    return { name, ok: false, detail: `${opts.modulePath} does not load (${error instanceof Error ? error.message : String(error)}): every sign-up is refused until the image is fixed` };
  }
  const authText = await readText(opts.authModulePath);
  if (!authText?.includes(HOOK_MARKER)) {
    return { name, ok: false, detail: `${opts.authModulePath} has no licensing hook: the core patch did not apply, so the user limit is not enforced` };
  }
  if (authText.split("databaseHooks").length - 1 > 1) {
    return { name, ok: false, detail: `${opts.authModulePath} has more than one databaseHooks block: a core change may override the licensing hook` };
  }
  return { name, ok: true, detail: `active (the sign-up hook calls ${opts.modulePath})` };
}

/** The licence status as one doctor line; WARN whenever the status needs someone's attention. */
export function licenceCheck(status: LicenseStatus, snapshotAt: string | null): Check {
  const notes: string[] = [];
  if (status.problem) notes.push(status.problem);
  if (status.expiringSoon && status.daysLeft !== null) notes.push(`expires in ${status.daysLeft} ${status.daysLeft === 1 ? "day" : "days"}`);
  if (status.overLimit) notes.push("over the user limit: no new user can be added");
  else if (status.atLimit) notes.push("at the user limit: the next sign-up is refused");
  const detail = `${status.summary}${notes.length > 0 ? ` — ${notes.join("; ")}` : ""}${snapshotAt ? ` (count from the user snapshot of ${snapshotAt})` : ""}`;
  return status.needsAttention ? { name: "licence", ok: true, warn: true, detail } : { name: "licence", ok: true, detail };
}

async function licenceDoctorChecks(env: NodeJS.ProcessEnv, home: string): Promise<Check[]> {
  const enforcement = await licenceEnforcementCheck({ modulePath: ENFORCE_MODULE_PATH, authModulePath: AUTH_MODULE_PATH });
  const paths = licensePaths(path.posix.join(home, "kyoube"));
  let count: number | null = null;
  let snapshotAt: string | null = null;
  try {
    const db = openCoreUsersDb(coreDatabaseUrl(env));
    try {
      count = (await db.listUsers()).length;
    } finally {
      await db.close();
    }
  } catch {
    const snapshot = await readUserSnapshot(paths.users);
    if (snapshot) {
      count = snapshot.users.length;
      snapshotAt = snapshot.at;
    }
  }
  if (count === null) return [enforcement, { name: "licence", ok: false, detail: "cannot count the users: the core database and the user snapshot are both unavailable" }];
  const status = licenseStatus({ key: await readTrimmed(paths.key), instanceId: await readTrimmed(paths.instanceId), userCount: count, now: new Date(), trustedKeys: TRUSTED_KEYS });
  return [enforcement, licenceCheck(status, snapshotAt)];
}

/** Where the image ships the agent-questions module and the core file the standing patch changes (docker/Dockerfile). */
export const ASK_LEVEL_MODULE_PATH = "/opt/kyoube/core-patches/ask-level.mjs";
export const ASK_LEVEL_PATCHED_PATH = "/app/server/dist/services/issue-thread-interactions.js";
export const ASK_LEVEL_MARKER = "kyoube-ask-level";

const plural = (count: number, one: string, many: string) => `${count} ${count === 1 ? one : many}`;

export function questionCountsText(summaries: QuestionSummary[] | null): string {
  if (summaries === null) return "counts unavailable (the core database cannot be read)";
  if (summaries.length === 0) return "no questions between agents in the last 7 days";
  return `last 7 days: ${summaries.map((summary) => {
    const most = summary.top ? ` (most: ${summary.top.name}, ${summary.top.asked})` : "";
    const atLimit = summary.tasksAtLimit > 0 ? `, ${plural(summary.tasksAtLimit, "task", "tasks")} at the limit` : "";
    return `${summary.company} ${plural(summary.asked, "question", "questions")} by ${plural(summary.askers, "agent", "agents")}${most}${atLimit}`;
  }).join("; ")}`;
}

/**
 * Whether agent questions are checked (docs/agent-rules.md): the module loads,
 * and the served interactions service carries the patch's marker. Either
 * missing means questions to agents are refused (module) or stay people-only
 * (patch). With the rules on and both present, it adds how often agents asked.
 */
export async function agentQuestionsCheck(opts: {
  env: NodeJS.ProcessEnv;
  summaries: QuestionSummary[] | null;
  modulePath?: string;
  patchedPath?: string;
  importModule?: (file: string) => Promise<unknown>;
  readText?: (file: string) => Promise<string | null>;
}): Promise<Check> {
  const name = "agent questions";
  if (!agentRulesEnabled(opts.env)) return { name, ok: true, detail: "off (KYOUBE_AGENT_RULES=off): agents' questions follow the core's own rules" };
  const modulePath = opts.modulePath ?? ASK_LEVEL_MODULE_PATH;
  const patchedPath = opts.patchedPath ?? ASK_LEVEL_PATCHED_PATH;
  const importModule = opts.importModule ?? ((file: string) => import(pathToFileURL(file).href));
  const readText = opts.readText ?? readOptional;
  try {
    const module = (await importModule(modulePath)) as { applyAskLevel?: unknown };
    if (typeof module.applyAskLevel !== "function") return { name, ok: false, detail: `${modulePath} has no applyAskLevel; rebuild the image` };
  } catch (error) {
    return { name, ok: false, detail: `${modulePath} does not load (${error instanceof Error ? error.message : String(error)}): every question from an agent to an agent is refused until the image is fixed` };
  }
  if (!(await readText(patchedPath))?.includes(ASK_LEVEL_MARKER)) {
    return { name, ok: false, detail: `${patchedPath} has no ask-level check: the core patch did not apply, so agents' questions to agents stay people-only` };
  }
  return { name, ok: true, detail: `active; ${questionCountsText(opts.summaries)}` };
}

/** The doctor line, with the counts read from the core database; unreadable counts never fail it. */
export async function agentQuestionsDoctorCheck(
  env: NodeJS.ProcessEnv,
  deps: {
    read?: (url: string) => Promise<QuestionSummary[]>;
    importModule?: (file: string) => Promise<unknown>;
    readText?: (file: string) => Promise<string | null>;
  } = {},
): Promise<Check> {
  const read = deps.read ?? readQuestionSummaries;
  let summaries: QuestionSummary[] | null = null;
  if (agentRulesEnabled(env)) {
    try {
      summaries = await read(coreDatabaseUrl(env));
    } catch {
      summaries = null;
    }
  }
  return agentQuestionsCheck({ env, summaries, importModule: deps.importModule, readText: deps.readText });
}

export function formatCheck(check: Check): string {
  return `${check.ok ? (check.warn ? "WARN" : "ok  ") : "FAIL"} ${check.name.padEnd(20)} ${check.detail}`;
}

export async function runDoctor(env: NodeJS.ProcessEnv): Promise<number> {
  const checks: Check[] = [];
  const configPath = resolveConfigPath(env);
  let config: KyoubeConfig;
  try {
    config = await readConfig(configPath);
    checks.push({ name: "config", ok: true, detail: configPath });
  } catch (error) {
    checks.push({ name: "config", ok: false, detail: error instanceof Error ? error.message : String(error) });
    return report(checks);
  }

  const warning = exposureWarning(env, config.publicUrl);
  checks.push({ name: "exposure", ok: warning === null, detail: warning ?? "private or https" });
  checks.push(legacyEnvCheck(env));

  const client = createCoreClient({ apiBase: config.paperclipApiUrl });
  try {
    const health = await client.getHealth();
    // `/api/health` redacts `version` for an anonymous caller on an
    // `authenticated` instance (which is what this probe is) but always
    // reports `commit`, so lead with the commit and only add `version` when
    // the full payload came back.
    const parts = [
      `commit ${health.commit ? health.commit.slice(0, 7) : "?"}`,
      `mode ${health.deploymentMode ?? "?"}`,
      `bootstrap ${health.bootstrapStatus ?? "?"}`,
    ];
    if (health.version) parts.unshift(`version ${health.version}`);
    checks.push({ name: "core", ok: health.status === "ok", detail: parts.join(" ") });
  } catch (error) {
    checks.push({ name: "core", ok: false, detail: error instanceof Error ? error.message : String(error) });
  }

  const db = await tcpReachable(config.dataDatabaseUrl);
  checks.push({ name: "kyoube database", ok: db.ok, detail: db.detail });

  const keyPath = resolveBoardKeyPath(config);
  const apiKey = await resolveBoardApiKey(env, keyPath);
  const storedKey = await readBoardKey(keyPath);
  const keyFromEnv = Boolean(env.KYOUBE_BOARD_API_KEY?.trim());
  checks.push({
    name: "board key",
    ok: Boolean(apiKey),
    detail: !apiKey
      ? "missing — run kyoube setup"
      : keyFromEnv
        ? "from environment"
        : `stored (user ${storedKey?.userId ?? "?"})`,
  });

  let inUse: Map<string, number> | null = null;
  if (apiKey) {
    try {
      const authed = createCoreClient({ apiBase: config.paperclipApiUrl, apiKey });
      const plugins = await authed.listPlugins();
      const ours = plugins.filter((plugin) => plugin.pluginKey.startsWith("kyoube."));
      const bad = ours.filter((plugin) => plugin.status !== "ready");
      checks.push({ name: "plugins", ok: ours.length > 0 && bad.length === 0, detail: ours.map((plugin) => `${plugin.pluginKey}@${plugin.version}=${plugin.status}`).join(", ") || "none installed" });
    } catch (error) {
      checks.push({ name: "plugins", ok: false, detail: error instanceof Error ? error.message : String(error) });
    }
    try {
      const authed = createCoreClient({ apiBase: config.paperclipApiUrl, apiKey });
      const companies = await authed.listCompanies();
      const skillsByCompany = new Map<string, CompanySkill[]>();
      for (const company of companies) skillsByCompany.set(company.id, await authed.listCompanySkills(company.id));
      checks.push(skillsCheck(companies, skillsByCompany));
    } catch (error) {
      checks.push({ name: "skills", ok: false, detail: error instanceof Error ? error.message : String(error) });
    }
    try {
      const authed = createCoreClient({ apiBase: config.paperclipApiUrl, apiKey });
      const counts = new Map<string, number>();
      for (const company of await authed.listCompanies()) {
        for (const agent of await authed.listAgents(company.id)) {
          if (agent.status === "terminated" || !agent.adapterType) continue;
          counts.set(agent.adapterType, (counts.get(agent.adapterType) ?? 0) + 1);
        }
      }
      inUse = counts;
    } catch (error) {
      checks.push({ name: "harnesses in use", ok: false, detail: error instanceof Error ? error.message : String(error) });
    }
  }

  const harnessEnv = { ...env, HOME: config.home, HERMES_HOME: config.hermesHome };
  const statuses = await probeHarnesses(config.home, systemProbe(harnessEnv));
  checks.push(...harnessChecks(statuses));
  if (inUse) checks.push(harnessesInUseCheck(statuses, inUse));

  const stateDir = path.posix.join(config.home, ".kyoube");
  checks.push(systemPackagesCheck(
    await readOptional(path.posix.join(stateDir, "apt-packages.txt")),
    await readOptional(path.posix.join(stateDir, "apt-restore.status")),
    path.posix.join(stateDir, "apt-restore.log"),
  ));
  checks.push(...await agentRulesDoctorChecks(env, resolveStatePath(config.home), Date.now()));
  checks.push(await agentQuestionsDoctorCheck(env));
  checks.push(...await licenceDoctorChecks(env, config.home));

  const claudeFile = path.posix.join(config.home, ".claude", ".credentials.json");
  checks.push({ name: "claude credentials", ok: true, detail: claudeCredentialDetail(await readOptional(claudeFile), claudeFile) });
  for (const [name, filePath] of [
    ["pi config dir", path.posix.join(config.home, ".pi")],
    ["hermes config", path.posix.join(config.hermesHome, "config.yaml")],
  ] as const) {
    const present = await fileExists(filePath);
    checks.push({ name, ok: true, detail: present ? `present (${filePath})` : `not found (${filePath}) — set up from the Terminal once the harness is installed` });
  }
  checks.push(await legacyHomeLinkCheck(config.home));
  const pushTest = await pushTestEndpointCheck(config.home, env);
  if (pushTest) checks.push(pushTest);

  return report(checks);
}

function report(checks: Check[]): number {
  for (const check of checks) console.log(formatCheck(check));
  return checks.every((check) => check.ok) ? 0 : 1;
}
