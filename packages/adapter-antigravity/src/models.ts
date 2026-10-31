import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { AGY_CLI, ANTIGRAVITY_MODELS, DEFAULT_MODEL } from "./constants.js";
import type { AdapterModel } from "./types.js";

/**
 * Infer the underlying model provider family from a model ID or label.
 */
export function inferProviderFromModel(model: string): string {
  const lower = model.trim().toLowerCase();
  if (lower.startsWith("claude")) return "anthropic";
  if (lower.startsWith("gpt") || lower.startsWith("o1") || lower.startsWith("o3")) return "openai";
  return "google";
}

/**
 * Resolve either a model ID (`gemini-4-argon-high`) or display label
 * (`Gemini 4 Argon (High)`) to a canonical Antigravity model ID.
 */
export function resolveModelId(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) return DEFAULT_MODEL;
  const byId = ANTIGRAVITY_MODELS.find(
    (entry) => entry.id.toLowerCase() === trimmed.toLowerCase(),
  );
  if (byId) return byId.id;
  const byLabel = ANTIGRAVITY_MODELS.find(
    (entry) => entry.label.toLowerCase() === trimmed.toLowerCase(),
  );
  if (byLabel) return byLabel.id;
  return trimmed;
}

/**
 * Parse the output of `agy models`. agy 1.4 prints one `<id>\t<label>` line per model; a table
 * padded with spaces under a "Model ID" header is accepted too:
 *   gemini-4-argon-high\tGemini 4 Argon (High)
 */
export function parseModelsOutput(stdout: string): AdapterModel[] {
  const parsed: AdapterModel[] = [];
  const seen = new Set<string>();
  for (const rawLine of stdout.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("Available models") || line.startsWith("Fetching available models") || line.startsWith("Model ID") || /^-{3,}$/.test(line)) {
      continue;
    }
    const match = line.match(/^([a-z0-9][a-z0-9._-]*)(?:\t|\s{2,})\s*(.+)$/i);
    if (!match) continue;
    const id = match[1]?.trim() ?? "";
    const label = match[2]?.trim() ?? id;
    if (!id || seen.has(id)) continue;
    seen.add(id);
    parsed.push({ id, label });
  }
  return parsed;
}

function buildSearchEnv(): NodeJS.ProcessEnv {
  const home = process.env.PAPERCLIP_HOME?.trim() || os.homedir();
  const localBin = path.join(home, ".local", "bin");
  const userLocalBin = path.join(os.homedir(), ".local", "bin");
  const currentPath = process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin";
  return {
    ...process.env,
    PATH: `${localBin}:${userLocalBin}:${currentPath}`,
  };
}

let cachedDynamicModels: AdapterModel[] | null = null;

export async function listModels(
  ctx?: { config?: Record<string, unknown> },
): Promise<AdapterModel[]> {
  if (cachedDynamicModels && cachedDynamicModels.length > 0) {
    return cachedDynamicModels;
  }
  return refreshModels(ctx);
}

export async function refreshModels(
  ctx?: { config?: Record<string, unknown> },
): Promise<AdapterModel[]> {
  const config = ctx?.config ?? {};
  const cmd =
    (typeof config.agyCommand === "string" && config.agyCommand.trim()) ||
    (typeof config.command === "string" && config.command.trim()) ||
    AGY_CLI;

  const discovered = await new Promise<AdapterModel[]>((resolve) => {
    execFile(
      cmd,
      ["models"],
      { env: buildSearchEnv(), timeout: 5_000 },
      (err, stdout) => {
        if (err || typeof stdout !== "string") {
          resolve([]);
          return;
        }
        resolve(parseModelsOutput(stdout));
      },
    );
  });

  if (discovered.length > 0) {
    cachedDynamicModels = discovered;
    return discovered;
  }
  return ANTIGRAVITY_MODELS;
}

/**
 * Read `~/.gemini/antigravity-cli/settings.json` to detect the user's configured
 * default Antigravity model.
 */
export async function detectModel(
  settingsPathOverride?: string,
): Promise<{
  model: string;
  provider?: string;
  source: string;
  candidates?: string[];
} | null> {
  const candidates = settingsPathOverride
    ? [settingsPathOverride]
    : [
        ...(process.env.PAPERCLIP_HOME?.trim()
          ? [path.join(process.env.PAPERCLIP_HOME.trim(), ".gemini", "antigravity-cli", "settings.json")]
          : []),
        path.join(os.homedir(), ".gemini", "antigravity-cli", "settings.json"),
      ];

  for (const filePath of candidates) {
    try {
      const raw = await readFile(filePath, "utf8");
      const data = JSON.parse(raw) as Record<string, unknown>;
      if (typeof data.model === "string" && data.model.trim().length > 0) {
        const model = resolveModelId(data.model);
        return {
          model,
          provider: inferProviderFromModel(model),
          source: filePath,
        };
      }
    } catch {
      // Try next candidate
    }
  }
  return null;
}
