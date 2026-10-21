import { readConfig, resolveConfigPath, type KyoubeConfig } from "../config.js";
import { createCoreClient, type CoreClientOptions } from "../core-api.js";
import { ensureRulesToken, resolveBoardApiKey, resolveBoardKeyPath, resolveRulesTokenPath } from "../key-store.js";
import { createRulesApi, type RulesApi } from "../agent-rules/api.js";
import { createBoardKeyApi, renewBoardKeyIfDue, RENEWAL_CHECK_MS, revokeReplacedKey, type BoardKeyApi, type BoardKeyRenewal } from "../board-key-renewal.js";
import { applyPass, groupsPass, revertPass } from "../agent-rules/pass.js";
import { failureLines, summarize } from "../agent-rules/report.js";
import { assertStateWritable, mergeGovernancePrevious, readState, resolveStatePath, writeState } from "../agent-rules/state.js";
import { NO_KEY_EXIT_CODE } from "./ensure-plugins.js";

export const PASS_INTERVAL_MS = 60_000;
/**
 * How often, and for how long, a pass waits for the plugin worker before it
 * runs anyway and records what it meets. A worker starts within seconds; a
 * disabled or broken plugin answers 503 too, and must not hold a pass for long.
 */
export const PLUGIN_POLL_MS = 2_000;
export const PLUGIN_WAIT_MS = 30_000;

/** `KYOUBE_AGENT_RULES=off` turns the loop off; anything else, unset included, leaves it on. */
export function agentRulesEnabled(env: NodeJS.ProcessEnv): boolean {
  return (env.KYOUBE_AGENT_RULES ?? "on").trim().toLowerCase() !== "off";
}

export interface RunAgentRulesDeps {
  readConfig: (filePath: string) => Promise<KyoubeConfig>;
  /** `rulesToken` goes in the body of every plugin route call (ruling R18). */
  createApi: (opts: CoreClientOptions, rulesToken: string) => RulesApi;
  /** Renews the stored board key before the core lets it expire (board-key-renewal.ts). */
  createKeyApi: (opts: Pick<CoreClientOptions, "apiBase">) => BoardKeyApi;
  waitForHealth: (apiBase: string) => Promise<void>;
  sleep: (ms: number) => Promise<void>;
  log: (line: string) => void;
  now: () => Date;
  /** Ends `--watch` after this many passes; tests only. */
  maxPasses?: number;
}

const defaultDeps: RunAgentRulesDeps = {
  readConfig,
  createApi: createRulesApi,
  createKeyApi: createBoardKeyApi,
  waitForHealth: async (apiBase) => {
    await createCoreClient({ apiBase }).waitForHealth({ timeoutMs: 15 * 60_000, intervalMs: 2000 });
  },
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  log: (line) => console.log(line),
  now: () => new Date(),
};

const USAGE = "usage: kyoube agent-rules --once | --watch | off";

/** What the loop logs about a renewal; nothing when the key was not due. */
export function renewalLine(renewal: BoardKeyRenewal | null): string {
  if (renewal?.status === "renewed") {
    const expires = renewal.expiresAt ? `expires ${renewal.expiresAt.slice(0, 10)}` : "never expires";
    return `kyoube: board key renewed; the new one ${expires}, and the old one is revoked within the hour`;
  }
  if (renewal?.status === "failed") {
    return (
      `kyoube: could not renew the board key: ${renewal.reason}. It is tried again in an hour; if the key expires, ` +
      "plugin updates and the agent rules stop until kyoube setup issues a new one (docs/operations.md)"
    );
  }
  return "";
}

/**
 * The core reports healthy before its plugin loader has started the workers,
 * and the entrypoint starts this loop at the same moment, so a first pass can
 * meet a 503 that a few seconds would have cleared. That pass would then be
 * what `kyoube doctor` shows until the next one, a minute later.
 */
async function waitForPlugin(api: RulesApi, sleep: (ms: number) => Promise<void>): Promise<void> {
  for (let waited = 0; waited < PLUGIN_WAIT_MS; waited += PLUGIN_POLL_MS) {
    if (await api.pluginReady()) return;
    await sleep(PLUGIN_POLL_MS);
  }
}

/**
 * Keeps the agent working rules (docs/agent-rules.md) in force: `--once` runs
 * one pass, `--watch` one pass a minute for the life of the container (the
 * entrypoint starts it), and `off` takes everything back out. In `--watch` an
 * unchanged summary or failure is logged once, not every minute. With
 * KYOUBE_AGENT_RULES=off, `--once` and `--watch` run only the user-groups step
 * (docs/groups.md). `--watch` also renews the board key `kyoube setup` stored,
 * once it has less than a week left (board-key-renewal.ts): it checks at the
 * first pass and then hourly, whatever KYOUBE_AGENT_RULES is set to.
 */
export async function runAgentRules(
  positionals: string[],
  flags: Record<string, string | true>,
  env: NodeJS.ProcessEnv,
  overrides: Partial<RunAgentRulesDeps> = {},
): Promise<number> {
  const deps = { ...defaultDeps, ...overrides };
  const mode = positionals[0] === "off" ? "off" : flags.once === true ? "once" : flags.watch === true ? "watch" : null;
  if (!mode) {
    deps.log(USAGE);
    return 1;
  }
  // With the rules off, `--once` and `--watch` still run the group step, and only that (ruling
  // R15): groups are their own feature. `off` reverts the rules and never touches groups.
  const groupsOnly = mode !== "off" && !agentRulesEnabled(env);

  const config = await deps.readConfig(resolveConfigPath(env));
  const statePath = resolveStatePath(config.home);
  const keyPath = resolveBoardKeyPath(config);
  const rulesTokenPath = resolveRulesTokenPath(config);
  const explicitKey = typeof flags["api-key"] === "string" ? flags["api-key"] : undefined;
  let lastSummary = "";
  let lastFailures = "";
  let lastKeyLine = "";
  let lastKeyCheck = Number.NEGATIVE_INFINITY;
  let replacedKeyId: string | null = null;
  let passes = 0;

  while (true) {
    try {
      await deps.waitForHealth(config.paperclipApiUrl);
      let apiKey = await resolveBoardApiKey(env, keyPath, explicitKey);
      if (!apiKey) {
        if (mode !== "watch") {
          deps.log("kyoube: no board API key yet — run kyoube setup");
          return NO_KEY_EXIT_CODE;
        }
        if (lastSummary !== "no-key") deps.log("kyoube: agent rules wait for a board API key (kyoube setup)");
        lastSummary = "no-key";
      } else {
        // Only the key kyoube setup stored is renewed; one from the environment or --api-key is the operator's.
        const keyIsStored = !explicitKey && !env.KYOUBE_BOARD_API_KEY?.trim();
        if (mode === "watch" && keyIsStored && deps.now().getTime() - lastKeyCheck >= RENEWAL_CHECK_MS) {
          lastKeyCheck = deps.now().getTime();
          const keyApi = deps.createKeyApi({ apiBase: config.paperclipApiUrl });
          if (replacedKeyId) {
            if (!(await revokeReplacedKey({ api: keyApi, keyPath, keyId: replacedKeyId }).catch(() => false))) {
              deps.log(`kyoube: could not revoke the replaced board key ${replacedKeyId}; it expires on its own within a week`);
            }
            replacedKeyId = null;
          }
          const renewal = await renewBoardKeyIfDue({ api: keyApi, keyPath, now: deps.now() }).catch(
            (error: unknown): BoardKeyRenewal => ({ status: "failed", reason: error instanceof Error ? error.message : String(error) }),
          );
          const keyLine = renewalLine(renewal);
          if (keyLine && keyLine !== lastKeyLine) deps.log(keyLine);
          lastKeyLine = keyLine;
          if (renewal?.status === "renewed") {
            replacedKeyId = renewal.oldKeyId;
            apiKey = (await resolveBoardApiKey(env, keyPath)) ?? apiKey;
          }
        }
        // Created on the first run (mode 600, as node), then reused; the plugins read the same file.
        const rulesToken = await ensureRulesToken(rulesTokenPath);
        const api = deps.createApi({ apiBase: config.paperclipApiUrl, apiKey }, rulesToken);
        const passDeps = { api, now: deps.now };
        const state = await readState(statePath, deps.log);
        // Pre-flight: unwritable state aborts the pass before any remote write happens. A probe
        // rather than a rewrite of the file, which could undo a save another pass made since the read.
        await assertStateWritable(statePath);
        await waitForPlugin(api, deps.sleep);
        const result = mode === "off" ? await revertPass(passDeps, state) : groupsOnly ? await groupsPass(passDeps, state) : await applyPass(passDeps, state);
        let writeErrorLine = "";
        const couldNotSave = (error: unknown) => {
          writeErrorLine = `kyoube: agent rules: could not save ${statePath}: ${error instanceof Error ? error.message : String(error)}`;
        };
        let next = result.state;
        if (mode !== "off") {
          // After a restart the loop's first pass and install.sh/update.sh's --once overlap: keep the
          // governance values the other one saved meanwhile. `off` saves its record as it is, so its
          // deletions stick. A malformed file was already reported by the read above.
          try {
            const fresh = await readState(statePath, () => {});
            // A group-only pass changed nothing else, so it keeps the file as it now is and adds its report.
            next = groupsOnly
              ? { ...fresh, lastGroupsPass: result.state.lastGroupsPass ?? null }
              : { ...result.state, governancePrevious: mergeGovernancePrevious(fresh.governancePrevious, result.state.governancePrevious) };
          } catch (readError) {
            couldNotSave(readError);
          }
        }
        try {
          await writeState(statePath, next);
        } catch (writeError) {
          couldNotSave(writeError);
        }
        const summary = summarize(result.report);
        const failures = failureLines(result.report).join("\n");
        const allFailures = failures + (writeErrorLine ? (failures ? "\n" : "") + writeErrorLine : "");
        if (mode !== "watch" || summary !== lastSummary) deps.log(summary);
        if (allFailures && (mode !== "watch" || allFailures !== lastFailures)) deps.log(allFailures);
        lastSummary = summary;
        lastFailures = allFailures;
        if (mode !== "watch") return allFailures ? 1 : 0;
      }
    } catch (error) {
      const line = `kyoube: agent rules pass failed: ${error instanceof Error ? error.message : String(error)}`;
      if (mode !== "watch") {
        deps.log(line);
        return 1;
      }
      if (line !== lastFailures) deps.log(line);
      lastFailures = line;
    }
    passes += 1;
    if (deps.maxPasses !== undefined && passes >= deps.maxPasses) return 0;
    await deps.sleep(PASS_INTERVAL_MS);
  }
}
