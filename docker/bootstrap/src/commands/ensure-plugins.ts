import { ensureAdapters, resolveAdapterRoot } from "../adapters.js";
import { readConfig, resolveConfigPath, type KyoubeConfig } from "../config.js";
import { resolveBoardApiKey, resolveBoardKeyPath } from "../key-store.js";
import {
  createCoreClient,
  type InstalledPlugin,
  type CoreClient,
  type CoreClientOptions,
} from "../core-api.js";
import { planPluginInstalls, scanPluginRoot, type LocalPluginBundle } from "../plugins.js";
import { ensureKyoubeSkills } from "../skills.js";

export interface EnsurePluginsDeps {
  client: CoreClient;
  scan: () => Promise<LocalPluginBundle[]>;
  log: (line: string) => void;
}

export interface EnsurePluginsResult {
  installed: string[];
  upgraded: string[];
  skipped: string[];
}

/**
 * Whether a failed upgrade was rejected because the new manifest declares
 * capabilities the installed one did not.
 *
 * Upstream's plugin loader throws
 * `Upgrade for "<uuid>" introduces new capabilities that require approval: <caps>. …`
 * (server/src/services/plugin-loader.ts) and the upgrade route turns any
 * lifecycle error into `400 { error: <message> }`, so this is a message match
 * rather than a status/code match. Matched loosely — both substrings, case
 * insensitive — so wording drift upstream does not silently turn a capability
 * escalation into a hard failure.
 */
function isCapabilityEscalation(error: unknown): boolean {
  const message = (error instanceof Error ? error.message : String(error)).toLowerCase();
  return message.includes("new capabilities") && message.includes("approval");
}

/**
 * Bring one already-installed bundled plugin up to the version on disk.
 *
 * The happy path is `POST /api/plugins/:id/upgrade`, which re-reads the stored
 * `packagePath`. Re-installing instead would be rejected: upstream's registry
 * throws `conflict("Plugin already installed: <key>")` (HTTP 400) for any
 * existing row whose status is not `uninstalled`.
 *
 * A capability escalation cannot be approved from here — approving is a board
 * action in the UI — so for Kyoube's own bundled plugins we soft-uninstall
 * (`DELETE`, no `purge`, so plugin-scoped data survives) and install the same
 * path again; upstream's registry reactivates the existing row with the new
 * manifest. Any other upgrade failure propagates.
 */
async function upgradeBundledPlugin(
  deps: EnsurePluginsDeps,
  key: string,
  pluginId: string,
  dir: string,
): Promise<InstalledPlugin> {
  const reinstall = async (why: string): Promise<InstalledPlugin> => {
    deps.log(
      `kyoube: ${key} upgrade needs board approval for new capabilities (${why}); ` +
        `re-installing from ${dir} via soft uninstall (plugin state is kept)`,
    );
    await deps.client.uninstallPlugin(pluginId);
    return deps.client.installLocalPlugin(dir);
  };

  let record: InstalledPlugin;
  try {
    record = await deps.client.upgradePlugin(pluginId);
  } catch (error) {
    if (!isCapabilityEscalation(error)) throw error;
    return reinstall(error instanceof Error ? error.message : String(error));
  }
  // Defensive: upstream's lifecycle manager has a second capability-escalation
  // branch that parks the plugin in `upgrade_pending` instead of throwing. The
  // loader currently throws first, so this is unreachable today — but if that
  // order ever changes, take the same fallback rather than failing the status
  // check below.
  if (record.status === "upgrade_pending") {
    return reinstall("upstream returned status upgrade_pending");
  }
  return record;
}

export async function ensurePlugins(deps: EnsurePluginsDeps): Promise<EnsurePluginsResult> {
  const local = await deps.scan();
  const installed = await deps.client.listPlugins();
  const result: EnsurePluginsResult = { installed: [], upgraded: [], skipped: [] };
  for (const plan of planPluginInstalls(local, installed)) {
    const key = plan.bundle.pluginKey;
    if (plan.action === "skip") {
      deps.log(`kyoube: ${key} skip (${plan.reason})`);
      result.skipped.push(key);
      continue;
    }
    deps.log(`kyoube: ${key} ${plan.action} from ${plan.bundle.dir} (${plan.reason})`);
    let record: InstalledPlugin;
    if (plan.action === "upgrade") {
      const pluginId = plan.installed?.id;
      if (!pluginId) throw new Error(`${key} planned for upgrade without an installed record id`);
      record = await upgradeBundledPlugin(deps, key, pluginId, plan.bundle.dir);
    } else {
      record = await deps.client.installLocalPlugin(plan.bundle.dir);
    }
    if (record.status !== "ready" && record.status !== "installed") {
      throw new Error(`${key} installed with status ${record.status}`);
    }
    deps.log(`kyoube: ${key} now ${record.status} at version ${record.version}`);
    (plan.action === "install" ? result.installed : result.upgraded).push(key);
  }
  return result;
}

export const NO_KEY_EXIT_CODE = 2;

/**
 * Runtime dependencies for {@link runEnsurePlugins}, injectable so tests can drive the
 * health-wait / retry loop without touching disk or the network. Each field defaults to
 * the real implementation; callers (`cli.ts`, `setup.ts`) keep using the two-argument form.
 */
export interface RunEnsurePluginsDeps {
  readConfig: (filePath: string) => Promise<KyoubeConfig>;
  createClient: (opts: CoreClientOptions) => CoreClient;
  sleep: (ms: number) => Promise<void>;
  log: (line: string) => void;
}

const defaultRunEnsurePluginsDeps: RunEnsurePluginsDeps = {
  readConfig,
  createClient: createCoreClient,
  sleep: (ms: number) => new Promise((resolve) => setTimeout(resolve, ms)),
  log: (line: string) => console.log(line),
};

export async function runEnsurePlugins(
  flags: Record<string, string | true>,
  env: NodeJS.ProcessEnv,
  deps: Partial<RunEnsurePluginsDeps> = {},
): Promise<number> {
  const { readConfig: loadConfig, createClient, sleep, log } = { ...defaultRunEnsurePluginsDeps, ...deps };
  const config = await loadConfig(resolveConfigPath(env));
  const apiBase = typeof flags["api-base"] === "string" ? flags["api-base"] : config.paperclipApiUrl;
  const watch = flags.watch === true;
  const explicitKey = typeof flags["api-key"] === "string" ? flags["api-key"] : undefined;
  const keyPath = resolveBoardKeyPath(config);

  while (true) {
    try {
      const probe = createClient({ apiBase });
      await probe.waitForHealth({ timeoutMs: 15 * 60_000, intervalMs: 2000 });
      const apiKey = await resolveBoardApiKey(env, keyPath, explicitKey);
      if (!apiKey) {
        log(
          "kyoube: no board API key yet. Sign up as the first admin in the browser, then run:\n" +
            "  docker compose exec app kyoube setup\n" +
            "(or set KYOUBE_BOARD_API_KEY in .env). Kyoube plugins are not installed until then.",
        );
        if (!watch) return NO_KEY_EXIT_CODE;
        await sleep(60_000);
        continue;
      }
      const client = createClient({ apiBase, apiKey });
      const result = await ensurePlugins({
        client,
        scan: () => scanPluginRoot(config.pluginRoot),
        log,
      });
      log(
        `kyoube: plugins ok (installed ${result.installed.length}, upgraded ${result.upgraded.length}, skipped ${result.skipped.length})`,
      );
      // Best effort: the startup seed already registers the bundled adapters, and a refused install
      // (adapter management hidden or cloud-managed) must not hold up the skills below.
      if (client.listAdapters && client.installLocalAdapter) {
        try {
          await ensureAdapters({
            client: {
              listAdapters: () => client.listAdapters!(),
              installLocalAdapter: (p) => client.installLocalAdapter!(p),
            },
            adapterRoot: resolveAdapterRoot(env),
            log,
          });
        } catch (error) {
          log(`kyoube: could not register the bundled adapters (${error instanceof Error ? error.message : String(error)})`);
        }
      }
      // Every pass, not only after an install: the worker cannot reach a
      // company's skill library from its own start-up code, so this is how a
      // company that already existed gets the Kyoube skills after an upgrade.
      await ensureKyoubeSkills(client, { sleep, log });
      return 0;
    } catch (error) {
      log(`kyoube: ensure-plugins failed: ${error instanceof Error ? error.message : String(error)}`);
      if (!watch) return 1;
      await sleep(60_000);
    }
  }
}
