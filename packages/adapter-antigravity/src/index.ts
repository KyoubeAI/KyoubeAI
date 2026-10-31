import { getConfigSchema } from "./config-schema.js";
import { ADAPTER_LABEL, ADAPTER_TYPE, ANTIGRAVITY_MODELS } from "./constants.js";
import { execute } from "./execute.js";
import { detectModel, listModels, refreshModels } from "./models.js";
import { listAntigravitySkills, syncAntigravitySkills } from "./skills.js";
import { resolveAntigravityCommand, testEnvironment } from "./test-env.js";
import type {
  AdapterRuntimeCommandSpec,
  AdapterSessionCodec,
  AdapterSessionManagement,
  ServerAdapterModule,
} from "./types.js";

export const type = ADAPTER_TYPE;
export const label = ADAPTER_LABEL;
export const models = ANTIGRAVITY_MODELS;

export {
  ADAPTER_LABEL,
  ADAPTER_TYPE,
  ANTIGRAVITY_MODELS,
  DEFAULT_GRACE_SEC,
  DEFAULT_MODEL,
  DEFAULT_TIMEOUT_SEC,
  VALID_EFFORTS,
  VALID_MODES,
} from "./constants.js";
export { getConfigSchema } from "./config-schema.js";
export { buildPrompt, execute, runChildProcess } from "./execute.js";
export { detectModel, inferProviderFromModel, listModels, parseModelsOutput, refreshModels, resolveModelId } from "./models.js";
export {
  detectAntigravityAuthRequired,
  isAntigravitySessionUnrecoverableError,
  parseAntigravityJsonl,
} from "./parse.js";
export {
  listAntigravitySkills as listSkills,
  reconcileAntigravitySkills,
  resolveAntigravityHome,
  resolveAntigravitySkillsHome,
  syncAntigravitySkills as syncSkills,
} from "./skills.js";
export { resolveAntigravityCommand, testEnvironment } from "./test-env.js";

function readNonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

export const sessionCodec: AdapterSessionCodec = {
  deserialize(raw: unknown) {
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return null;
    const record = raw as Record<string, unknown>;
    const sessionId =
      readNonEmptyString(record.sessionId) ??
      readNonEmptyString(record.conversationId) ??
      readNonEmptyString(record.conversation_id) ??
      readNonEmptyString(record.session_id);
    if (!sessionId) return null;
    const cwd = readNonEmptyString(record.cwd);
    return {
      sessionId,
      conversationId: sessionId,
      ...(cwd ? { cwd } : {}),
    };
  },
  serialize(params: Record<string, unknown> | null) {
    if (!params) return null;
    const sessionId =
      readNonEmptyString(params.sessionId) ??
      readNonEmptyString(params.conversationId) ??
      readNonEmptyString(params.conversation_id) ??
      readNonEmptyString(params.session_id);
    if (!sessionId) return null;
    const cwd = readNonEmptyString(params.cwd);
    return {
      sessionId,
      conversationId: sessionId,
      ...(cwd ? { cwd } : {}),
    };
  },
  getDisplayId(params: Record<string, unknown> | null) {
    if (!params) return null;
    const id =
      readNonEmptyString(params.sessionId) ??
      readNonEmptyString(params.conversationId) ??
      readNonEmptyString(params.conversation_id) ??
      readNonEmptyString(params.session_id);
    return id ? id.slice(0, 16) : null;
  },
};

export const sessionManagement: AdapterSessionManagement = {
  supportsSessionResume: true,
  nativeContextManagement: "confirmed",
  defaultSessionCompaction: {
    enabled: true,
    maxSessionRuns: 0,
    maxRawInputTokens: 0,
    maxSessionAgeHours: 0,
  },
};

function getRuntimeCommandSpec(config: Record<string, unknown>): AdapterRuntimeCommandSpec {
  const command = resolveAntigravityCommand(config);
  return {
    command,
    detectCommand: command,
    installCommand: null,
  };
}

export const agentConfigurationDoc = `# Antigravity CLI Configuration

Runs Google Antigravity CLI (\`agy\`) in headless \`stream-json\` mode as a managed agent in KyoubeAI.

## Prerequisites

- Installed: the Antigravity CLI is not part of the KyoubeAI image. Run \`kyoube harness install agy\` in the Terminal (Workspace, then Terminal); it lands in \`/kyoubeai/.local/bin/agy\`. The model list falls back to a built-in one until \`agy\` is installed.
- Signed in: run \`agy\` in the Terminal, choose Google OAuth, open the printed link and paste the code back (the token is kept in \`~/.gemini/antigravity-cli/\`). Or use a Gemini API key: \`"modelProvider": "gemini"\` in \`~/.gemini/antigravity-cli/settings.json\` plus \`GEMINI_API_KEY\`

## Core Configuration

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| model | string | gemini-4-argon-high | Antigravity model ID (see \`agy models\`) |
| effort | string | (default) | Reasoning effort override: low, medium, high, xhigh, max |
| mode | string | auto | Permission mode: auto, accept-edits, plan |
| dangerouslySkipPermissions | boolean | true | Pass \`--dangerously-skip-permissions\` for unattended runs |
| persistSession | boolean | true | Resume conversations across heartbeats via \`--conversation\` |
| timeoutSec | number | 900 | Execution timeout in seconds; 0 for none |
| graceSec | number | 15 | Grace period after SIGTERM before SIGKILL |
| command | string | agy | Path or binary name for Antigravity CLI |
| extraArgs | string[] | [] | Additional CLI arguments |
`;

/**
 * Factory function invoked by KyoubeAI's external adapter loader (`plugin-loader.ts`).
 */
export function createServerAdapter(): ServerAdapterModule {
  return {
    type,
    label,
    execute,
    testEnvironment,
    sessionCodec,
    sessionManagement,
    listSkills: listAntigravitySkills,
    syncSkills: syncAntigravitySkills,
    models,
    listModels,
    refreshModels,
    supportsLocalAgentJwt: true,
    supportsInstructionsBundle: true,
    instructionsPathKey: "instructionsFilePath",
    requiresMaterializedRuntimeSkills: false,
    getRuntimeCommandSpec,
    agentConfigurationDoc,
    detectModel,
    getConfigSchema,
  };
}
