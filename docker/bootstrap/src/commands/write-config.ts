import { mkdir } from "node:fs/promises";
import path from "node:path";
import { ensureInstanceId, licensePaths } from "@kyoube/license";
import { resolveAdapterRoot, seedAdapterPluginsStore } from "../adapters.js";
import { renderConfigFromEnv, resolveConfigPath, writeConfig } from "../config.js";

/** Renders /kyoubeai/kyoube/config.json from the container environment. Runs as the `node` user from the entrypoint. */
export async function runWriteConfig(env: NodeJS.ProcessEnv): Promise<number> {
  const config = renderConfigFromEnv(env);
  const filePath = resolveConfigPath(env);
  await mkdir(config.hermesHome, { recursive: true });
  await writeConfig(filePath, config);
  try {
    const instanceId = await ensureInstanceId(licensePaths(path.posix.join(config.home, "kyoube")).instanceId);
    console.log(`kyoube: instance ID ${instanceId}`);
  } catch (error) {
    console.log(`kyoube: could not create the instance ID (${error instanceof Error ? error.message : String(error)}); instance-bound licence keys won't apply until it exists`);
  }
  try {
    const seeded = await seedAdapterPluginsStore({
      home: config.home,
      adapterRoot: resolveAdapterRoot(env),
    });
    if (seeded.length > 0) {
      console.log(`kyoube: registered ${seeded.length} bundled adapter(s): ${seeded.map((a) => a.type).join(", ")}`);
    }
  } catch (error) {
    console.log(`kyoube: could not seed adapter-plugins.json (${error instanceof Error ? error.message : String(error)})`);
  }
  console.log(`kyoube: wrote ${filePath} (plugins at ${config.pluginRoot}, api ${config.paperclipApiUrl})`);
  return 0;
}
