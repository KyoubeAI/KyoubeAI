export interface AdapterAgent {
  id: string;
  companyId: string;
  name: string;
  adapterType: string | null;
  adapterConfig: unknown;
}

export interface AdapterRuntime {
  sessionId: string | null;
  sessionParams: Record<string, unknown> | null;
  sessionDisplayId: string | null;
  taskKey: string | null;
}

export interface UsageSummary {
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens?: number;
}

export type AdapterBillingType = "api" | "subscription" | "unknown";

export interface AdapterExecutionResult {
  exitCode: number | null;
  signal: string | null;
  timedOut: boolean;
  errorMessage?: string | null;
  errorCode?: string | null;
  errorMeta?: Record<string, unknown>;
  usage?: UsageSummary;
  sessionId?: string | null;
  sessionParams?: Record<string, unknown> | null;
  sessionDisplayId?: string | null;
  provider?: string | null;
  biller?: string | null;
  model?: string | null;
  billingType?: AdapterBillingType;
  costUsd?: number | null;
  resultJson?: Record<string, unknown> | null;
  summary?: string | null;
  question?: {
    prompt: string;
    choices: Array<{
      key: string;
      label: string;
      description?: string;
    }>;
  } | null;
  clearSession?: boolean;
}

export interface AdapterInvocationMeta {
  adapterType: string;
  command: string;
  cwd?: string;
  args?: string[];
  env?: Record<string, string>;
  prompt?: string;
  context?: Record<string, unknown>;
}

export interface AdapterSpawnMeta {
  pid: number;
  processGroupId?: number | null;
  startedAt: string;
}

export interface AdapterRuntimeToolAccess {
  mcpEndpoint: string;
  bearerToken: string;
  expiresAt: string;
  rest: {
    connectionsSearch: string;
    connectionRequest: string;
  };
  tools: string[];
  guidance: string;
}

export interface AdapterExecutionContext {
  runId: string;
  agent: AdapterAgent;
  runtime: AdapterRuntime;
  config: Record<string, unknown>;
  context: Record<string, unknown>;
  getFreshSessionHandoff?: () => Promise<string | null>;
  runtimeTools?: AdapterRuntimeToolAccess | null;
  onLog: (stream: "stdout" | "stderr", chunk: string) => Promise<void>;
  onMeta?: (meta: AdapterInvocationMeta) => Promise<void>;
  onSpawn?: (meta: AdapterSpawnMeta) => Promise<void>;
  onCancelRequested?: (fn: () => Promise<void>) => void;
  signal?: AbortSignal;
  authToken?: string;
}

export interface AdapterEnvironmentCheck {
  code: string;
  level: "info" | "warn" | "error";
  message: string;
  detail?: string | null;
  hint?: string | null;
}

export interface AdapterEnvironmentTestResult {
  adapterType: string;
  status: "pass" | "warn" | "fail";
  checks: AdapterEnvironmentCheck[];
  testedAt: string;
}

export interface AdapterEnvironmentTestContext {
  companyId: string;
  adapterType: string;
  config: Record<string, unknown>;
}

export type AdapterSkillState =
  | "available"
  | "configured"
  | "installed"
  | "missing"
  | "stale"
  | "external";

export type AdapterSkillOrigin =
  | "paperclip_required"
  | "company_managed"
  | "user_installed"
  | "external_unknown";

export interface AdapterSkillEntry {
  key: string;
  runtimeName: string | null;
  versionId?: string | null;
  currentVersionId?: string | null;
  desired: boolean;
  managed: boolean;
  state: AdapterSkillState;
  origin?: AdapterSkillOrigin;
  originLabel?: string | null;
  locationLabel?: string | null;
  readOnly?: boolean;
  sourcePath?: string | null;
  targetPath?: string | null;
  detail?: string | null;
}

export interface AdapterSkillSnapshot {
  adapterType: string;
  supported: boolean;
  mode: "ephemeral" | "persistent" | "unsupported";
  desiredSkills: string[];
  desiredSkillEntries?: Array<{ key: string; versionId: string | null }>;
  entries: AdapterSkillEntry[];
  warnings: string[];
}

export interface AdapterSkillContext {
  agentId?: string;
  companyId?: string;
  adapterType: string;
  config: Record<string, unknown>;
}

export interface AdapterSessionCodec {
  deserialize: (raw: unknown) => Record<string, unknown> | null;
  serialize: (params: Record<string, unknown> | null) => Record<string, unknown> | null;
  getDisplayId?: (params: Record<string, unknown> | null) => string | null;
}

export interface AdapterSessionManagement {
  supportsSessionResume: boolean;
  nativeContextManagement: "confirmed" | "estimated" | "unknown";
  defaultSessionCompaction: {
    enabled: boolean;
    maxSessionRuns: number;
    maxRawInputTokens: number;
    maxSessionAgeHours: number;
  };
}

export interface AdapterRuntimeCommandSpec {
  command: string;
  detectCommand: string;
  installCommand: string | null;
}

export interface AdapterModel {
  id: string;
  label: string;
}

export interface ConfigSchemaOption {
  value: string;
  label: string;
}

export interface ConfigSchemaField {
  key: string;
  label: string;
  type: "text" | "number" | "toggle" | "select" | "textarea" | "tags";
  required?: boolean;
  default?: unknown;
  hint?: string;
  options?: ConfigSchemaOption[];
  showWhen?: { field: string; equals: unknown };
  group?: string;
}

export interface AdapterConfigSchema {
  fields: ConfigSchemaField[];
}

export interface ServerAdapterModule {
  type: string;
  label?: string;
  execute: (ctx: AdapterExecutionContext) => Promise<AdapterExecutionResult>;
  testEnvironment: (ctx: AdapterEnvironmentTestContext) => Promise<AdapterEnvironmentTestResult>;
  listSkills?: (ctx: AdapterSkillContext) => Promise<AdapterSkillSnapshot>;
  syncSkills?: (ctx: AdapterSkillContext, desiredSkills: string[]) => Promise<AdapterSkillSnapshot>;
  sessionCodec?: AdapterSessionCodec;
  sessionManagement?: AdapterSessionManagement;
  models?: AdapterModel[];
  listModels?: (ctx?: { config?: Record<string, unknown> }) => Promise<AdapterModel[]>;
  refreshModels?: (ctx?: { config?: Record<string, unknown> }) => Promise<AdapterModel[]>;
  supportsLocalAgentJwt?: boolean;
  supportsInstructionsBundle?: boolean;
  instructionsPathKey?: string;
  requiresMaterializedRuntimeSkills?: boolean;
  getRuntimeCommandSpec?: (config: Record<string, unknown>) => AdapterRuntimeCommandSpec | null;
  agentConfigurationDoc?: string;
  detectModel?: () => Promise<{
    model: string;
    provider?: string;
    source: string;
    candidates?: string[];
  } | null>;
  getConfigSchema?: () => Promise<AdapterConfigSchema> | AdapterConfigSchema;
}

export type TranscriptEntry =
  | { kind: "assistant"; ts: string; text: string; delta?: boolean }
  | { kind: "thinking"; ts: string; text: string; delta?: boolean }
  | { kind: "user"; ts: string; text: string }
  | { kind: "tool_call"; ts: string; name: string; toolUseId: string; input: unknown }
  | { kind: "tool_result"; ts: string; toolUseId: string; content: string; isError: boolean }
  | { kind: "init"; ts: string; model: string; sessionId: string }
  | {
      kind: "result";
      ts: string;
      text: string;
      inputTokens: number;
      outputTokens: number;
      cachedTokens: number;
      costUsd: number;
      subtype: string;
      isError: boolean;
      errors: string[];
    }
  | { kind: "stderr"; ts: string; text: string }
  | { kind: "system"; ts: string; text: string }
  | { kind: "stdout"; ts: string; text: string };
