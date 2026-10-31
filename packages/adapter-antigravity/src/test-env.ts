import { execFile } from "node:child_process";
import { constants as fsConstants, promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { ADAPTER_TYPE, AGY_CLI, ANTIGRAVITY_MODELS, DEFAULT_MODEL, INSTALL_HINT, SIGN_IN_HINT } from "./constants.js";
import { detectModel } from "./models.js";
import { resolveAntigravityHome } from "./skills.js";
import type {
  AdapterEnvironmentCheck,
  AdapterEnvironmentTestContext,
  AdapterEnvironmentTestResult,
} from "./types.js";

function cfgString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

export function resolveAntigravityCommand(config: Record<string, unknown>): string {
  return cfgString(config.agyCommand) || cfgString(config.command) || AGY_CLI;
}

function buildSearchPath(config: Record<string, unknown>): string {
  const home = resolveAntigravityHome(config);
  const localBin = path.join(home, ".local", "bin");
  const userLocalBin = path.join(os.homedir(), ".local", "bin");
  const currentPath =
    process.env.PATH ??
    "/usr/local/bin:/opt/homebrew/bin:/usr/local/sbin:/usr/bin:/bin:/usr/sbin:/sbin";
  return [localBin, userLocalBin, currentPath].filter(Boolean).join(path.delimiter);
}

export async function findExecutable(
  command: string,
  searchPath: string,
  cwd = process.cwd(),
): Promise<string | null> {
  if (command.includes("/") || command.includes("\\")) {
    const abs = path.isAbsolute(command) ? command : path.resolve(cwd, command);
    try {
      await fs.access(abs, fsConstants.X_OK);
      return abs;
    } catch {
      return null;
    }
  }
  for (const dir of searchPath.split(path.delimiter).filter(Boolean)) {
    const candidate = path.join(dir, command);
    try {
      await fs.access(candidate, fsConstants.X_OK);
      return candidate;
    } catch {
      // try next
    }
  }
  return null;
}

async function checkCliVersion(
  binPath: string,
  env: NodeJS.ProcessEnv,
): Promise<string | null> {
  return new Promise((resolve) => {
    execFile(binPath, ["--version"], { env, timeout: 5_000 }, (err, stdout, stderr) => {
      if (err) {
        resolve(null);
        return;
      }
      const line = `${stdout ?? ""}\n${stderr ?? ""}`
        .split(/\r?\n/)
        .map((s) => s.trim())
        .find((s) => s.length > 0);
      resolve(line ?? null);
    });
  });
}

export async function testEnvironment(
  ctx: AdapterEnvironmentTestContext,
): Promise<AdapterEnvironmentTestResult> {
  const config = (ctx.config ?? {}) as Record<string, unknown>;
  const command = resolveAntigravityCommand(config);
  const searchPath = buildSearchPath(config);
  const checks: AdapterEnvironmentCheck[] = [];

  // 1. Working directory check
  const cwd = cfgString(config.cwd) || process.cwd();
  if (!path.isAbsolute(cwd)) {
    checks.push({
      code: "antigravity_cwd_invalid",
      level: "error",
      message: `Working directory must be an absolute path: "${cwd}"`,
    });
  } else {
    try {
      await fs.mkdir(cwd, { recursive: true });
      const stats = await fs.stat(cwd);
      if (stats.isDirectory()) {
        checks.push({
          code: "antigravity_cwd_valid",
          level: "info",
          message: `Working directory is ready: ${cwd}`,
        });
      } else {
        checks.push({
          code: "antigravity_cwd_invalid",
          level: "error",
          message: `Working directory is not a directory: "${cwd}"`,
        });
      }
    } catch (err) {
      checks.push({
        code: "antigravity_cwd_invalid",
        level: "error",
        message: `Cannot access working directory "${cwd}": ${err instanceof Error ? err.message : String(err)}`,
      });
    }
  }

  // 2. CLI binary check
  const resolvedBin = await findExecutable(command, searchPath, cwd);
  if (!resolvedBin) {
    checks.push({
      code: "antigravity_cli_missing",
      level: "error",
      message: `Antigravity CLI is not installed ("${command}" is not on PATH).`,
      detail: `Searched PATH: ${searchPath}`,
      hint: INSTALL_HINT,
    });
    return {
      adapterType: ADAPTER_TYPE,
      status: "fail",
      checks,
      testedAt: new Date().toISOString(),
    };
  }

  const version = await checkCliVersion(resolvedBin, { ...process.env, PATH: searchPath });
  if (!version) {
    checks.push({
      code: "antigravity_cli_broken",
      level: "error",
      message: `Antigravity CLI was found at ${resolvedBin}, but "${command} --version" failed.`,
      hint: "Verify that the agy binary matches the container CPU architecture and has execute permissions.",
    });
    return {
      adapterType: ADAPTER_TYPE,
      status: "fail",
      checks,
      testedAt: new Date().toISOString(),
    };
  }

  checks.push({
    code: "antigravity_cli_installed",
    level: "info",
    message: `Antigravity CLI ${version} (${resolvedBin})`,
  });

  // 3. Authentication check (OAuth token or API key)
  const envCfg =
    typeof config.env === "object" && config.env !== null && !Array.isArray(config.env)
      ? (config.env as Record<string, unknown>)
      : {};
  const hasApiKey =
    Boolean(cfgString(envCfg.GEMINI_API_KEY)) ||
    Boolean(cfgString(envCfg.GOOGLE_API_KEY)) ||
    Boolean(cfgString(process.env.GEMINI_API_KEY)) ||
    Boolean(cfgString(process.env.GOOGLE_API_KEY));

  const home = resolveAntigravityHome(config);
  const oauthCandidates = [
    path.join(home, ".gemini", "antigravity-cli", "antigravity-oauth-token"),
    path.join(os.homedir(), ".gemini", "antigravity-cli", "antigravity-oauth-token"),
  ];
  let foundOauthPath: string | null = null;
  for (const candidate of oauthCandidates) {
    try {
      const stat = await fs.stat(candidate);
      if (stat.isFile() && stat.size > 0) {
        foundOauthPath = candidate;
        break;
      }
    } catch {
      // continue
    }
  }

  if (foundOauthPath) {
    checks.push({
      code: "antigravity_auth_oauth",
      level: "info",
      message: `Antigravity OAuth token found (${foundOauthPath}).`,
    });
  } else if (hasApiKey) {
    checks.push({
      code: "antigravity_auth_api_key",
      level: "info",
      message: "Google / Gemini API key configured in environment.",
    });
  } else {
    checks.push({
      code: "antigravity_auth_missing",
      level: "warn",
      message: "Antigravity CLI is installed but not signed in.",
      hint: SIGN_IN_HINT,
    });
  }

  // 4. Model check
  const configuredModel = cfgString(config.model);
  const detected = await detectModel().catch(() => null);
  const effectiveModel = configuredModel || detected?.model || DEFAULT_MODEL;
  const knownModel = ANTIGRAVITY_MODELS.some((m) => m.id === effectiveModel);
  checks.push({
    code: knownModel ? "antigravity_model_valid" : "antigravity_model_custom",
    level: "info",
    message: configuredModel
      ? `Configured model: ${effectiveModel}`
      : detected?.model
        ? `Auto-detected model from settings.json: ${detected.model}`
        : `Using default model: ${DEFAULT_MODEL}`,
  });

  const hasErrors = checks.some((c) => c.level === "error");
  const hasWarnings = checks.some((c) => c.level === "warn");

  return {
    adapterType: ADAPTER_TYPE,
    status: hasErrors ? "fail" : hasWarnings ? "warn" : "pass",
    checks,
    testedAt: new Date().toISOString(),
  };
}
