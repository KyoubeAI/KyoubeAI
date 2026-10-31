import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

export const DEFAULT_ADAPTER_ROOT = "/opt/kyoube/adapters";

export interface DiscoveredAdapter {
  dir: string;
  name: string;
  packageName: string;
  type: string;
  version: string;
}

/** One record in the core's adapter-plugins.json. Fields this module does not set are kept as they are. */
export interface AdapterPluginStoreRecord {
  packageName: string;
  localPath?: string;
  version?: string;
  type: string;
  installedAt: string;
  [key: string]: unknown;
}

/** One row of `GET /api/adapters`. `version` is read from the package on disk; the path itself is not returned. */
export interface InstalledAdapterInfo {
  type: string;
  packageName?: string;
  version?: string;
  isLocalPath?: boolean;
  source?: string;
  disabled?: boolean;
}

export interface AdapterApiClient {
  listAdapters(): Promise<InstalledAdapterInfo[]>;
  installLocalAdapter(localPath: string): Promise<InstalledAdapterInfo>;
}

export interface EnsureAdaptersResult {
  installed: string[];
  skipped: string[];
}

export function resolveAdapterRoot(env: NodeJS.ProcessEnv = process.env): string {
  return env.KYOUBE_ADAPTER_ROOT?.trim() || DEFAULT_ADAPTER_ROOT;
}

/** Where the core keeps its external adapter records: `adapter-plugins.json` in PAPERCLIP_HOME, not per instance. */
export function resolveAdapterPluginStorePath(home: string): string {
  return path.join(home, "adapter-plugins.json");
}

/**
 * Scan `/opt/kyoube/adapters` for bundled external adapter packages.
 * Returns `[]` when `adapterRoot` does not exist.
 */
export async function discoverBundledAdapters(
  adapterRoot: string = DEFAULT_ADAPTER_ROOT,
): Promise<DiscoveredAdapter[]> {
  let entries;
  try {
    entries = await readdir(adapterRoot, { withFileTypes: true });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw err;
  }

  const dirs = entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();

  const discovered: DiscoveredAdapter[] = [];
  for (const name of dirs) {
    const dir = path.join(adapterRoot, name);
    const pkgPath = path.join(dir, "package.json");
    let raw: string;
    try {
      raw = await readFile(pkgPath, "utf8");
    } catch {
      continue;
    }
    const pkg = JSON.parse(raw) as {
      name?: unknown;
      version?: unknown;
      paperclip?: { adapterType?: unknown };
      kyoube?: { adapterType?: unknown };
    };
    const packageName = typeof pkg.name === "string" ? pkg.name.trim() : "";
    const version = typeof pkg.version === "string" ? pkg.version.trim() : "";
    const adapterType =
      (typeof pkg.paperclip?.adapterType === "string" && pkg.paperclip.adapterType.trim()) ||
      (typeof pkg.kyoube?.adapterType === "string" && pkg.kyoube.adapterType.trim()) ||
      "";
    if (!packageName || !version || !adapterType) {
      throw new Error(
        `Adapter bundle in ${dir} is missing name, version, or paperclip.adapterType in package.json`,
      );
    }
    discovered.push({
      dir,
      name,
      packageName,
      type: adapterType,
      version,
    });
  }

  return discovered;
}

/**
 * Write the bundled adapters into the core's adapter-plugins.json before the core starts, so it loads
 * them at boot. The bundle replaces any record of the same type or package; every other record is kept.
 * Only a missing file counts as empty: an unreadable or malformed one throws rather than being overwritten.
 */
export async function seedAdapterPluginsStore(options: {
  home: string;
  adapterRoot?: string;
  now?: Date;
}): Promise<DiscoveredAdapter[]> {
  const bundles = await discoverBundledAdapters(options.adapterRoot ?? DEFAULT_ADAPTER_ROOT);
  if (bundles.length === 0) return [];

  const storePath = resolveAdapterPluginStorePath(options.home);
  let records: AdapterPluginStoreRecord[] = [];
  let raw: string | null = null;
  try {
    raw = await readFile(storePath, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
  }
  if (raw !== null) {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) throw new Error(`${storePath} does not hold a JSON array; left as it is`);
    records = parsed as AdapterPluginStoreRecord[];
  }

  const nowIso = (options.now ?? new Date()).toISOString();
  for (const bundle of bundles) {
    const existingIdx = records.findIndex(
      (r) => r?.type === bundle.type || r?.packageName === bundle.packageName,
    );
    const prev = existingIdx >= 0 ? records[existingIdx] : undefined;
    const nextRecord: AdapterPluginStoreRecord = {
      ...prev,
      packageName: bundle.packageName,
      localPath: bundle.dir,
      version: bundle.version,
      type: bundle.type,
      installedAt: prev?.installedAt ?? nowIso,
    };
    if (existingIdx >= 0) {
      records[existingIdx] = nextRecord;
    } else {
      records.push(nextRecord);
    }
  }

  await mkdir(path.dirname(storePath), { recursive: true });
  await writeFile(storePath, `${JSON.stringify(records, null, 2)}\n`, "utf8");
  return bundles;
}

/**
 * Make sure a running core has each bundled adapter registered from its bundle. The startup seed
 * normally covers this; this pass catches a core that started before the seed or whose record points
 * elsewhere (an npm install of the same type, or an older version). Installing a local path replaces
 * the registration and the record, so there is no separate reload.
 */
export async function ensureAdapters(options: {
  client: AdapterApiClient;
  adapterRoot?: string;
  log?: (line: string) => void;
  scan?: () => Promise<DiscoveredAdapter[]>;
}): Promise<EnsureAdaptersResult> {
  const log = options.log ?? ((line: string) => console.log(line));
  const scan =
    options.scan ?? (() => discoverBundledAdapters(options.adapterRoot ?? DEFAULT_ADAPTER_ROOT));
  const bundles = await scan();
  if (bundles.length === 0) {
    return { installed: [], skipped: [] };
  }

  const existing = await options.client.listAdapters();
  const byType = new Map(existing.map((a) => [a.type, a]));

  const installed: string[] = [];
  const skipped: string[] = [];

  for (const bundle of bundles) {
    const current = byType.get(bundle.type);
    if (current?.isLocalPath === true && current.version === bundle.version) {
      skipped.push(bundle.type);
      continue;
    }
    await options.client.installLocalAdapter(bundle.dir);
    installed.push(bundle.type);
    log(
      current
        ? `kyoube: re-registered adapter ${bundle.type} from ${bundle.dir} (was ${current.version ?? "unknown"}${current.isLocalPath ? "" : " from npm"}, now ${bundle.version})`
        : `kyoube: installed adapter ${bundle.type}@${bundle.version} from ${bundle.dir}`,
    );
  }

  return { installed, skipped };
}
