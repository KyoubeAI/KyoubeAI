import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  ADAPTER_TYPE,
  DEFAULT_GRACE_SEC,
  DEFAULT_MODEL,
  DEFAULT_TIMEOUT_SEC,
} from "./constants.js";
import { detectModel, inferProviderFromModel, resolveModelId } from "./models.js";
import {
  detectAntigravityAuthRequired,
  isAntigravitySessionUnrecoverableError,
  parseAntigravityJsonl,
} from "./parse.js";
import { reconcileAntigravitySkills, resolveAntigravityHome } from "./skills.js";
import { findExecutable, resolveAntigravityCommand } from "./test-env.js";
import type {
  AdapterExecutionContext,
  AdapterExecutionResult,
  AdapterRuntimeToolAccess,
  AdapterSpawnMeta,
} from "./types.js";

const MAX_CAPTURE_BYTES = 4 * 1024 * 1024;
const SENSITIVE_ENV_KEY = /(key|token|secret|password|passwd|authorization|cookie)/i;
const REDACTED_VALUE = "***REDACTED***";

function asObject(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return {};
  }
  return value as Record<string, unknown>;
}

function cfgString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function cfgNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function cfgBoolean(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

function cfgStringArray(value: unknown): string[] | undefined {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string" && item.length > 0)
    : undefined;
}

function appendWithCap(prev: string, chunk: string, cap = MAX_CAPTURE_BYTES): string {
  const combined = prev + chunk;
  return combined.length > cap ? combined.slice(combined.length - cap) : combined;
}

export function redactEnvForLogs(env: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    out[key] = SENSITIVE_ENV_KEY.test(key) ? REDACTED_VALUE : value;
  }
  return out;
}

export function buildPaperclipEnv(agent: { id: string; companyId: string }): Record<string, string> {
  const resolveHostForUrl = (rawHost: string): string => {
    const host = rawHost.trim();
    if (!host || host === "0.0.0.0" || host === "::") return "localhost";
    if (host.includes(":") && !host.startsWith("[") && !host.endsWith("]")) return `[${host}]`;
    return host;
  };
  const runtimeHost = resolveHostForUrl(
    process.env.PAPERCLIP_LISTEN_HOST ?? process.env.HOST ?? "localhost",
  );
  const runtimePort = process.env.PAPERCLIP_LISTEN_PORT ?? process.env.PORT ?? "3100";
  const apiUrl =
    process.env.PAPERCLIP_API_URL ??
    process.env.PAPERCLIP_RUNTIME_API_URL ??
    `http://${runtimeHost}:${runtimePort}`;
  return {
    PAPERCLIP_AGENT_ID: agent.id,
    PAPERCLIP_COMPANY_ID: agent.companyId,
    PAPERCLIP_API_URL: apiUrl,
  };
}

export function buildRuntimeToolsEnv(
  access: AdapterRuntimeToolAccess | null | undefined,
): Record<string, string> {
  if (!access) return {};
  return {
    PAPERCLIP_RUNTIME_TOOLS_MCP_URL: access.mcpEndpoint,
    PAPERCLIP_RUNTIME_TOOLS_TOKEN: access.bearerToken,
    PAPERCLIP_RUNTIME_TOOLS_EXPIRES_AT: access.expiresAt,
    PAPERCLIP_RUNTIME_TOOLS_CONNECTIONS_SEARCH_URL: access.rest.connectionsSearch,
    PAPERCLIP_RUNTIME_TOOLS_CONNECTION_REQUEST_URL: access.rest.connectionRequest,
    PAPERCLIP_RUNTIME_TOOLS_AVAILABLE: access.tools.join(","),
    PAPERCLIP_RUNTIME_TOOLS_GUIDANCE: access.guidance,
  };
}

const ANTIGRAVITY_DEFAULT_PROMPT_TEMPLATE = [
  "You are agent {{agent.id}} ({{agent.name}}).",
  "",
  "KyoubeAI runtime identity:",
  "- Agent ID: {{agent.id}}",
  "- Company ID: {{agent.companyId}}",
  "- Run ID: {{run.id}}",
  "- API base: {{paperclipApiUrl}}",
  "",
  "KyoubeAI API guidance:",
  "- Use `run_command` with `curl` for KyoubeAI API calls; rely on `$PAPERCLIP_API_URL`, `$PAPERCLIP_API_KEY`, and `$PAPERCLIP_RUN_ID` in the shell environment.",
  "- Include `-H \"Authorization: Bearer $PAPERCLIP_API_KEY\"` on API requests.",
  "- Include `-H \"X-Paperclip-Run-Id: $PAPERCLIP_RUN_ID\"` on mutating issue requests.",
].join("\n");

function resolvePathValue(obj: Record<string, unknown>, dottedPath: string): string {
  const parts = dottedPath.split(".");
  let cursor: unknown = obj;
  for (const part of parts) {
    if (typeof cursor !== "object" || cursor === null || Array.isArray(cursor)) {
      return "";
    }
    cursor = (cursor as Record<string, unknown>)[part];
  }
  if (cursor === null || cursor === undefined) return "";
  if (typeof cursor === "string") return cursor;
  if (typeof cursor === "number" || typeof cursor === "boolean") return String(cursor);
  try {
    return JSON.stringify(cursor);
  } catch {
    return "";
  }
}

export function renderTemplate(template: string, data: Record<string, unknown>): string {
  return template.replace(/\{\{\s*([a-zA-Z0-9_.-]+)\s*\}\}/g, (_m, p: string) =>
    resolvePathValue(data, p),
  );
}

function renderConditionalSections(template: string, vars: Record<string, unknown>): string {
  const isTruthy = (key: string) => {
    if (key === "noTask") return !vars.taskId;
    const value = vars[key];
    if (Array.isArray(value)) return value.length > 0;
    return Boolean(value);
  };
  return template.replace(
    /\{\{#([a-zA-Z0-9_.-]+)\}\}([\s\S]*?)\{\{\/\1\}\}/g,
    (_match, key: string, body: string) => (isTruthy(key) ? body : ""),
  );
}

function joinPromptSections(sections: Array<string | null | undefined>): string {
  return sections
    .map((v) => (typeof v === "string" ? v.trim() : ""))
    .filter(Boolean)
    .join("\n\n");
}

function renderWakePayloadSection(
  rawWake: unknown,
  options: { suppressIssueDescription?: boolean } = {},
): string {
  const wake = asObject(rawWake);
  if (Object.keys(wake).length === 0) return "";
  const lines: string[] = ["## KyoubeAI Wake Context"];

  const reason = cfgString(wake.reason);
  if (reason) lines.push(`- Wake reason: ${reason}`);

  const issue = asObject(wake.issue);
  const issueId = cfgString(issue.id);
  const identifier = cfgString(issue.identifier);
  const title = cfgString(issue.title);
  const status = cfgString(issue.status);
  const priority = cfgString(issue.priority);
  if (issueId || identifier || title) {
    lines.push(
      `- Issue: ${[identifier, title].filter(Boolean).join(" — ") || issueId}${issueId ? ` (id: ${issueId})` : ""}`,
    );
  }
  if (status) lines.push(`- Status: ${status}`);
  if (priority) lines.push(`- Priority: ${priority}`);

  if (!options.suppressIssueDescription) {
    const description = cfgString(issue.description);
    if (description) {
      lines.push("", "### Issue Description", description);
    }
  }

  const executionStage = asObject(wake.executionStage);
  const wakeRole = cfgString(executionStage.wakeRole);
  if (wakeRole) {
    lines.push(`- Execution stage role: ${wakeRole}`);
    const reviewReq = asObject(executionStage.reviewRequest);
    const reviewInstructions = cfgString(reviewReq.instructions);
    if (reviewInstructions) {
      lines.push(`- Review instructions: ${reviewInstructions}`);
    }
  }

  const questionResponse = asObject(wake.questionResponse);
  const questionSummary = cfgString(questionResponse.summaryMarkdown);
  if (questionSummary) {
    lines.push("", "### Answered Question Response", questionSummary);
  }

  const comments = Array.isArray(wake.comments) ? wake.comments : [];
  if (comments.length > 0) {
    lines.push("", "### Recent Comments");
    comments.forEach((rawComment, idx) => {
      const c = asObject(rawComment);
      const author = [cfgString(c.authorType), cfgString(c.authorId)].filter(Boolean).join(" ") || "unknown";
      const createdAt = cfgString(c.createdAt) || "unknown";
      const body = cfgString(c.body) || "";
      lines.push(`${idx + 1}. comment ${cfgString(c.id) ?? "unknown"} at ${createdAt} by ${author}:`, body, "");
    });
  }

  const connectorSkills = cfgString(wake.connectorSkillInstructions);
  if (connectorSkills) {
    lines.push("", "## Assigned connector skills", connectorSkills);
  }

  const connInstructions = cfgString(asObject(wake.connectionInstructions).text);
  if (connInstructions) {
    lines.push("", connInstructions);
  }

  return lines.join("\n").trim();
}

export function buildPrompt(
  ctx: AdapterExecutionContext,
  config: Record<string, unknown>,
  env: Record<string, string>,
  options: { resumedSession?: boolean } = {},
): string {
  const context = asObject(ctx.context);
  const template = cfgString(config.promptTemplate) || ANTIGRAVITY_DEFAULT_PROMPT_TEMPLATE;
  const taskId =
    cfgString(context.taskId) ||
    cfgString(context.issueId) ||
    cfgString(asObject(context.paperclipWake).issue && asObject(asObject(context.paperclipWake).issue).id) ||
    cfgString(config.taskId) ||
    "";
  const taskTitle = cfgString(context.taskTitle) || cfgString(config.taskTitle) || "";
  const taskBody = cfgString(context.taskBody) || cfgString(config.taskBody) || "";
  const commentId =
    cfgString(context.commentId) ||
    cfgString(context.wakeCommentId) ||
    cfgString(config.commentId) ||
    "";
  const wakeReason = cfgString(context.wakeReason) || cfgString(config.wakeReason) || "";
  const agentName = ctx.agent?.name || "Antigravity Agent";
  const companyName = cfgString(context.companyName) || cfgString(config.companyName) || "";
  const projectName = cfgString(context.projectName) || cfgString(config.projectName) || "";

  let paperclipApiUrl =
    cfgString(config.paperclipApiUrl) ||
    env.PAPERCLIP_API_URL ||
    process.env.PAPERCLIP_API_URL ||
    "http://127.0.0.1:3100/api";
  if (!paperclipApiUrl.endsWith("/api")) {
    paperclipApiUrl = paperclipApiUrl.replace(/\/+$/, "") + "/api";
  }

  const fullTaskMarkdown =
    cfgString(context.paperclipTaskMarkdownAssignment) ||
    cfgString(context.paperclipTaskMarkdown) ||
    "";
  const compactTaskMarkdown =
    cfgString(context.paperclipTaskMarkdownAssignmentCompact) ||
    cfgString(context.paperclipTaskMarkdownCompact) ||
    fullTaskMarkdown;
  const communicationGuidance =
    options.resumedSession === true
      ? ""
      : joinPromptSections([
          cfgString(context.paperclipTaskCommunicationGuidance),
          cfgString(context.paperclipFreshSessionHandoffMarkdown),
        ]);
  const taskContextMarkdown =
    options.resumedSession === true
      ? compactTaskMarkdown
      : joinPromptSections([communicationGuidance, fullTaskMarkdown]);
  const sessionHandoffMarkdown = cfgString(context.paperclipSessionHandoffMarkdown) || "";
  const wakePrompt = renderWakePayloadSection(context.paperclipWake, {
    suppressIssueDescription: taskContextMarkdown.length > 0,
  });

  const vars: Record<string, unknown> = {
    agentId: ctx.agent?.id || "",
    agentName,
    companyId: ctx.agent?.companyId || "",
    companyName,
    runId: ctx.runId || "",
    agent: ctx.agent || {},
    company: { id: ctx.agent?.companyId || "", name: companyName },
    run: { id: ctx.runId || "", source: "on_demand" },
    context,
    taskId,
    taskTitle,
    taskBody,
    commentId,
    wakeReason,
    projectName,
    paperclipApiUrl,
    paperclipWakePrompt: wakePrompt,
    paperclipTaskMarkdown: fullTaskMarkdown,
    taskContext: fullTaskMarkdown,
    taskContextMarkdown,
    paperclipApiKeyEnv: "PAPERCLIP_API_KEY",
    paperclipRunIdEnv: "PAPERCLIP_RUN_ID",
  };

  const renderedTemplate = renderTemplate(renderConditionalSections(template, vars), vars);
  const paperclipKeys = Object.keys(env)
    .filter((k) => k.startsWith("PAPERCLIP_"))
    .sort();
  const envNote =
    paperclipKeys.length > 0
      ? `KyoubeAI runtime note: The following PAPERCLIP_* environment variables are set in your shell environment: ${paperclipKeys.join(", ")}.`
      : "";

  return joinPromptSections([
    wakePrompt,
    sessionHandoffMarkdown,
    taskContextMarkdown,
    renderedTemplate,
    envNote,
  ]);
}

export interface RunProcessResult {
  exitCode: number | null;
  signal: string | null;
  timedOut: boolean;
  stdout: string;
  stderr: string;
  pid: number | null;
  startedAt: string | null;
}

function signalProcessGroup(child: ChildProcess, processGroupId: number | null, sig: NodeJS.Signals) {
  if (process.platform !== "win32" && processGroupId && processGroupId > 0) {
    try {
      process.kill(-processGroupId, sig);
      return;
    } catch {
      // fall through
    }
  }
  if (!child.killed) {
    try {
      child.kill(sig);
    } catch {
      // ignore
    }
  }
}

export async function runChildProcess(
  command: string,
  args: string[],
  opts: {
    cwd: string;
    env: Record<string, string>;
    /** Written to the child's stdin, which is then closed; without it stdin is ignored. */
    stdin?: string;
    timeoutSec: number;
    graceSec: number;
    signal?: AbortSignal;
    onLog: (stream: "stdout" | "stderr", chunk: string) => Promise<void>;
    onSpawn?: (meta: AdapterSpawnMeta) => Promise<void>;
  },
): Promise<RunProcessResult> {
  return new Promise<RunProcessResult>((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: opts.cwd,
      env: opts.env,
      detached: process.platform !== "win32",
      stdio: [opts.stdin === undefined ? "ignore" : "pipe", "pipe", "pipe"],
    });
    if (opts.stdin !== undefined && child.stdin) {
      // A child that exits without reading stdin closes the pipe; its exit code tells the story.
      child.stdin.on("error", () => {});
      child.stdin.end(opts.stdin);
    }

    const startedAt = new Date().toISOString();
    const processGroupId =
      process.platform !== "win32" && typeof child.pid === "number" && child.pid > 0
        ? child.pid
        : null;

    if (typeof child.pid === "number" && child.pid > 0 && opts.onSpawn) {
      void Promise.resolve(
        opts.onSpawn({
          pid: child.pid,
          processGroupId,
          startedAt,
        }),
      ).catch(() => {});
    }

    let timedOut = false;
    let stdout = "";
    let stderr = "";
    let logChain = Promise.resolve();
    let killTimer: ReturnType<typeof setTimeout> | null = null;

    const terminate = () => {
      signalProcessGroup(child, processGroupId, "SIGTERM");
      killTimer = setTimeout(
        () => {
          signalProcessGroup(child, processGroupId, "SIGKILL");
        },
        Math.max(1, opts.graceSec) * 1000,
      );
    };

    const timeoutTimer =
      opts.timeoutSec > 0
        ? setTimeout(() => {
            timedOut = true;
            terminate();
          }, opts.timeoutSec * 1000)
        : null;

    const onAbort = () => {
      terminate();
    };
    if (opts.signal) {
      if (opts.signal.aborted) {
        terminate();
      } else {
        opts.signal.addEventListener("abort", onAbort, { once: true });
      }
    }

    child.stdout?.on("data", (chunk: unknown) => {
      const text = String(chunk);
      stdout = appendWithCap(stdout, text);
      logChain = logChain.then(() => opts.onLog("stdout", text)).catch(() => {});
    });

    child.stderr?.on("data", (chunk: unknown) => {
      const text = String(chunk);
      stderr = appendWithCap(stderr, text);
      logChain = logChain.then(() => opts.onLog("stderr", text)).catch(() => {});
    });

    child.on("error", (err: Error) => {
      if (timeoutTimer) clearTimeout(timeoutTimer);
      if (killTimer) clearTimeout(killTimer);
      opts.signal?.removeEventListener("abort", onAbort);
      const errno = (err as NodeJS.ErrnoException).code;
      const msg =
        errno === "ENOENT"
          ? `Failed to start Antigravity CLI command "${command}" in "${opts.cwd}". Verify that "agy" is installed and on PATH (${opts.env.PATH ?? ""}).`
          : `Failed to start command "${command}" in "${opts.cwd}": ${err.message}`;
      reject(new Error(msg));
    });

    child.on("close", (code: number | null, sig: NodeJS.Signals | null) => {
      if (timeoutTimer) clearTimeout(timeoutTimer);
      if (killTimer) clearTimeout(killTimer);
      opts.signal?.removeEventListener("abort", onAbort);
      void logChain.finally(() => {
        resolve({
          exitCode: code,
          signal: sig,
          timedOut,
          stdout,
          stderr,
          pid: child.pid ?? null,
          startedAt,
        });
      });
    });
  });
}

export async function execute(ctx: AdapterExecutionContext): Promise<AdapterExecutionResult> {
  const config = asObject(ctx.config ?? ctx.agent?.adapterConfig);
  const context = asObject(ctx.context);

  const commandName = resolveAntigravityCommand(config);
  const configuredModel = cfgString(config.model);
  const detected = !configuredModel ? await detectModel().catch(() => null) : null;
  const model = resolveModelId(configuredModel || detected?.model || DEFAULT_MODEL);
  const effort =
    cfgString(config.effort) ||
    cfgString(config.thinkingEffort) ||
    cfgString(config.reasoningEffort);
  const mode = cfgString(config.mode);
  const dangerouslySkipPermissions =
    cfgBoolean(config.dangerouslySkipPermissions) ?? cfgBoolean(config.yolo) ?? true;
  const disableSlashCommands = cfgBoolean(config.disableSlashCommands) === true;
  const persistSession = cfgBoolean(config.persistSession) !== false;
  // 0 is a real setting (no timeout), so only a missing value falls back to the default.
  const timeoutSec = cfgNumber(config.timeoutSec) ?? DEFAULT_TIMEOUT_SEC;
  const graceSec = cfgNumber(config.graceSec) ?? DEFAULT_GRACE_SEC;
  const extraArgs = cfgStringArray(config.extraArgs);
  const addDirs = cfgStringArray(config.addDirs);

  const sessionParams = asObject(ctx.runtime?.sessionParams);
  const savedSessionId = persistSession
    ? cfgString(sessionParams.sessionId) ||
      cfgString(sessionParams.conversationId) ||
      cfgString(ctx.runtime?.sessionId) ||
      null
    : null;

  // 1. Reconcile KyoubeAI runtime skills into ~/.gemini/config/skills
  if (Object.prototype.hasOwnProperty.call(config, "paperclipRuntimeSkills")) {
    try {
      const synced = await reconcileAntigravitySkills(config);
      if (synced.length > 0) {
        await ctx.onLog(
          "stdout",
          `[antigravity] Reconciled ${synced.length} KyoubeAI-managed skill(s) into ~/.gemini/config/skills.\n`,
        );
      }
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      await ctx.onLog(
        "stdout",
        `[antigravity] Warning: could not reconcile KyoubeAI runtime skills: ${reason}\n`,
      );
    }
  }

  // 2. Load managed instructions file if provided
  const instructionsFilePath = cfgString(config.instructionsFilePath);
  let agentInstructions = "";
  if (instructionsFilePath) {
    try {
      agentInstructions = await fs.readFile(instructionsFilePath, "utf8");
      const instructionsDir = path.dirname(instructionsFilePath);
      agentInstructions += `\nThe above agent instructions were loaded from ${instructionsFilePath}. Resolve any relative file references from ${instructionsDir}/.`;
      await ctx.onLog(
        "stdout",
        `[antigravity] Loaded agent instructions from ${instructionsFilePath} (${agentInstructions.length} chars)\n`,
      );
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      await ctx.onLog(
        "stdout",
        `[antigravity] Warning: could not read agent instructions file "${instructionsFilePath}": ${reason}\n`,
      );
    }
  }

  // 3. Build environment
  const home = resolveAntigravityHome(config);
  const localBin = path.join(home, ".local", "bin");
  const userLocalBin = path.join(os.homedir(), ".local", "bin");
  const basePath =
    process.env.PATH ??
    "/usr/local/bin:/opt/homebrew/bin:/usr/local/sbin:/usr/bin:/bin:/usr/sbin:/sbin";
  const mergedPath = [localBin, userLocalBin, basePath].filter(Boolean).join(path.delimiter);

  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (typeof v !== "string") continue;
    if (
      k.startsWith("PAPERCLIP_") &&
      k !== "PAPERCLIP_RUNTIME_API_URL" &&
      k !== "PAPERCLIP_LISTEN_HOST" &&
      k !== "PAPERCLIP_LISTEN_PORT"
    ) {
      continue;
    }
    env[k] = v;
  }

  Object.assign(env, buildPaperclipEnv(ctx.agent));
  Object.assign(env, buildRuntimeToolsEnv(ctx.runtimeTools));

  const workspaceObj = asObject(context.paperclipWorkspace);
  const workspaceCwd =
    cfgString(config.cwd) ||
    cfgString(workspaceObj.cwd) ||
    cfgString(context.workspaceCwd) ||
    cfgString(config.workspaceDir) ||
    process.cwd();

  const workspaceMappings: Array<[string, string | undefined]> = [
    ["PAPERCLIP_WORKSPACE_CWD", workspaceCwd],
    ["PAPERCLIP_WORKSPACE_SOURCE", cfgString(workspaceObj.source) ?? cfgString(context.workspaceSource)],
    ["PAPERCLIP_WORKSPACE_STRATEGY", cfgString(workspaceObj.strategy) ?? cfgString(context.workspaceStrategy)],
    ["PAPERCLIP_WORKSPACE_ID", cfgString(workspaceObj.id) ?? cfgString(context.workspaceId)],
    ["PAPERCLIP_WORKSPACE_REPO_URL", cfgString(workspaceObj.repoUrl) ?? cfgString(context.workspaceRepoUrl)],
    ["PAPERCLIP_WORKSPACE_REPO_REF", cfgString(workspaceObj.repoRef) ?? cfgString(context.workspaceRepoRef)],
    ["PAPERCLIP_WORKSPACE_BRANCH", cfgString(workspaceObj.branchName) ?? cfgString(context.workspaceBranch)],
    ["PAPERCLIP_WORKSPACE_WORKTREE_PATH", cfgString(workspaceObj.worktreePath) ?? cfgString(context.workspaceWorktreePath)],
    ["AGENT_HOME", cfgString(context.agentHome)],
  ];
  for (const [key, val] of workspaceMappings) {
    if (val) env[key] = val;
  }

  // A conversation's files and paths belong to the directory it started in; resume it only there.
  const savedCwd = cfgString(sessionParams.cwd);
  const prevSessionId =
    savedSessionId && savedCwd && path.resolve(savedCwd) !== path.resolve(workspaceCwd)
      ? null
      : savedSessionId;
  if (savedSessionId && !prevSessionId) {
    await ctx.onLog(
      "stdout",
      `[antigravity] Conversation "${savedSessionId}" started in ${savedCwd}, not ${workspaceCwd}; starting a fresh one.\n`,
    );
  }
  if (Array.isArray(context.paperclipWorkspaces) && context.paperclipWorkspaces.length > 0) {
    env.PAPERCLIP_WORKSPACES_JSON = JSON.stringify(context.paperclipWorkspaces);
  }

  const userEnv = asObject(config.env);
  for (const [k, v] of Object.entries(userEnv)) {
    if (typeof v !== "string") continue;
    if (k === "PAPERCLIP_API_KEY" || k === "PAPERCLIP_WAKE_PAYLOAD_JSON") continue;
    if (k.startsWith("PAPERCLIP_") && k in env) continue;
    env[k] = v;
  }

  if (ctx.runId) env.PAPERCLIP_RUN_ID = ctx.runId;
  delete env.PAPERCLIP_API_KEY;
  delete env.PAPERCLIP_WAKE_PAYLOAD_JSON;
  if (ctx.authToken) env.PAPERCLIP_API_KEY = ctx.authToken;

  const envTaskId =
    cfgString(context.taskId) || cfgString(context.issueId) || cfgString(config.taskId);
  if (envTaskId) env.PAPERCLIP_TASK_ID = envTaskId;
  const envWakeReason = cfgString(context.wakeReason) || cfgString(config.wakeReason);
  if (envWakeReason) env.PAPERCLIP_WAKE_REASON = envWakeReason;
  const envCommentId =
    cfgString(context.commentId) ||
    cfgString(context.wakeCommentId) ||
    cfgString(config.commentId);
  if (envCommentId) env.PAPERCLIP_WAKE_COMMENT_ID = envCommentId;

  env.PATH = mergedPath;
  env.TERM = "xterm-256color";
  env.NO_BROWSER = "1";

  try {
    if (path.isAbsolute(workspaceCwd)) {
      await fs.mkdir(workspaceCwd, { recursive: true });
    }
  } catch {
    // Non-fatal
  }

  const executable =
    (await findExecutable(commandName, mergedPath, workspaceCwd)) ?? commandName;

  const wrappedOnLog = async (stream: "stdout" | "stderr", chunk: string) => {
    if (stream === "stderr") {
      const trimmed = chunk.trimEnd();
      const isBenign =
        /^\[?\d{4}[-/]\d{2}[-/]\d{2}T/.test(trimmed) ||
        /^[IWE]\d{4}\s/.test(trimmed) ||
        /\b(INFO|DEBUG|WARN|WARNING)\b/.test(trimmed) ||
        /MCP [Ss]erver/.test(trimmed);
      if (isBenign) {
        return ctx.onLog("stdout", chunk);
      }
    }
    return ctx.onLog(stream, chunk);
  };

  const runAttempt = async (sessionToResume: string | null) => {
    if (!sessionToResume && ctx.getFreshSessionHandoff) {
      const handoff = await ctx.getFreshSessionHandoff().catch(() => null);
      if (handoff) {
        ctx.context.paperclipFreshSessionHandoffMarkdown = handoff;
      } else {
        delete ctx.context.paperclipFreshSessionHandoffMarkdown;
      }
    }

    let prompt = buildPrompt(ctx, config, env, {
      resumedSession: Boolean(sessionToResume),
    });
    if (agentInstructions) {
      prompt = `${agentInstructions}\n\n---\n\n${prompt}`;
    }

    // The prompt goes to stdin as one stream-json user message: as an argument it is capped at
    // 128 KiB (E2BIG) and visible in `ps`. `--print=` stays last so it never takes a flag as its value.
    const args: string[] = ["--input-format", "stream-json", "--output-format", "stream-json"];
    if (dangerouslySkipPermissions) {
      args.push("--dangerously-skip-permissions");
    }
    if (model) {
      args.push("--model", model);
    }
    if (effort) {
      args.push("--effort", effort);
    }
    if (mode) {
      args.push("--mode", mode);
    }
    if (disableSlashCommands) {
      args.push("--disable-slash-commands");
    }
    if (addDirs?.length) {
      for (const dir of addDirs) {
        args.push("--add-dir", dir);
      }
    }
    if (sessionToResume) {
      args.push("--conversation", sessionToResume);
    }
    if (extraArgs?.length) {
      args.push(...extraArgs);
    }
    args.push("--print=");
    const stdin = `${JSON.stringify({ event: "user", message: { role: "user", content: prompt } })}\n`;

    await ctx.onMeta?.({
      adapterType: ADAPTER_TYPE,
      command: executable,
      cwd: workspaceCwd,
      args,
      env: redactEnvForLogs(env),
      prompt,
      context: ctx.context,
    });

    await ctx.onLog(
      "stdout",
      `[antigravity] Starting Antigravity CLI (model=${model}${effort ? `, effort=${effort}` : ""}, timeout=${timeoutSec}s)\n`,
    );
    if (sessionToResume) {
      await ctx.onLog(
        "stdout",
        `[antigravity] Resuming conversation: ${sessionToResume}\n`,
      );
    }

    const proc = await runChildProcess(executable, args, {
      cwd: workspaceCwd,
      env,
      stdin,
      timeoutSec,
      graceSec,
      signal: ctx.signal,
      onLog: wrappedOnLog,
      onSpawn: ctx.onSpawn,
    });

    const parsed = parseAntigravityJsonl(proc.stdout, proc.stderr);
    return { proc, parsed };
  };

  let attempt = await runAttempt(prevSessionId);
  let clearedStaleSession = false;

  if (
    prevSessionId &&
    !attempt.proc.timedOut &&
    (attempt.proc.exitCode ?? 0) !== 0 &&
    isAntigravitySessionUnrecoverableError(attempt.proc.stdout, attempt.proc.stderr)
  ) {
    await ctx.onLog(
      "stdout",
      `[antigravity] Resume conversation "${prevSessionId}" is unavailable; retrying with a fresh session.\n`,
    );
    clearedStaleSession = true;
    attempt = await runAttempt(null);
  }

  const { proc, parsed } = attempt;
  await ctx.onLog(
    "stdout",
    `[antigravity] Exit code: ${proc.exitCode ?? "null"}, timed out: ${proc.timedOut}\n`,
  );
  if (parsed.sessionId) {
    await ctx.onLog("stdout", `[antigravity] Conversation: ${parsed.sessionId}\n`);
  }

  const resolvedSessionId =
    parsed.sessionId ?? (!clearedStaleSession ? prevSessionId : null);
  const hasApiKey = Boolean(env.GEMINI_API_KEY || env.GOOGLE_API_KEY);
  const authRequired = detectAntigravityAuthRequired(proc.stdout, proc.stderr);

  if (proc.timedOut) {
    return {
      exitCode: proc.exitCode,
      signal: proc.signal,
      timedOut: true,
      errorMessage: `Timed out after ${timeoutSec}s`,
      errorCode: authRequired ? "antigravity_auth_required" : null,
      provider: inferProviderFromModel(model),
      biller: "google",
      model,
      billingType: hasApiKey ? "api" : "subscription",
      clearSession: clearedStaleSession && !resolvedSessionId,
    };
  }

  const failed =
    (proc.exitCode ?? 0) !== 0 ||
    Boolean(parsed.status && parsed.status !== "SUCCESS" && parsed.status !== "DONE");
  const errorMessage = failed
    ? parsed.errorMessage || `Antigravity CLI exited with code ${proc.exitCode ?? -1}`
    : null;

  return {
    exitCode: proc.exitCode,
    signal: proc.signal,
    timedOut: false,
    errorMessage,
    errorCode: failed && authRequired ? "antigravity_auth_required" : null,
    usage: parsed.usage,
    sessionId: resolvedSessionId,
    sessionParams:
      persistSession && resolvedSessionId
        ? {
            sessionId: resolvedSessionId,
            conversationId: resolvedSessionId,
            cwd: workspaceCwd,
          }
        : null,
    sessionDisplayId: resolvedSessionId ? resolvedSessionId.slice(0, 16) : null,
    provider: inferProviderFromModel(model),
    biller: "google",
    model,
    billingType: hasApiKey ? "api" : "subscription",
    costUsd: parsed.costUsd,
    resultJson: parsed.resultEvent ?? {
      result: parsed.summary ?? "",
      session_id: resolvedSessionId,
      usage: parsed.usage ?? null,
    },
    summary: parsed.summary,
    clearSession: Boolean(clearedStaleSession && !resolvedSessionId),
  };
}
