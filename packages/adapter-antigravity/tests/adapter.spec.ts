import { chmod, mkdir, mkdtemp, readdir, readFile, readlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  ADAPTER_LABEL,
  ADAPTER_TYPE,
  ANTIGRAVITY_MODELS,
  buildPrompt,
  createServerAdapter,
  detectAntigravityAuthRequired,
  detectModel,
  execute,
  getConfigSchema,
  inferProviderFromModel,
  isAntigravitySessionUnrecoverableError,
  listSkills,
  parseAntigravityJsonl,
  parseModelsOutput,
  resolveModelId,
  sessionCodec,
  syncSkills,
  testEnvironment,
} from "../src/index.js";
import { createStdoutParser, parseStdoutLine } from "../src/ui-parser.js";

describe("createServerAdapter", () => {
  it("creates a valid ServerAdapterModule for antigravity_local", () => {
    const adapter = createServerAdapter();
    expect(adapter.type).toBe("antigravity_local");
    expect(adapter.label).toBe("Antigravity");
    expect(ADAPTER_TYPE).toBe("antigravity_local");
    expect(ADAPTER_LABEL).toBe("Antigravity");
    expect(adapter.models).toEqual(ANTIGRAVITY_MODELS);
    expect(adapter.supportsLocalAgentJwt).toBe(true);
    expect(adapter.supportsInstructionsBundle).toBe(true);
    expect(adapter.instructionsPathKey).toBe("instructionsFilePath");
    expect(adapter.getRuntimeCommandSpec?.({})).toEqual({
      command: "agy",
      detectCommand: "agy",
      installCommand: null,
    });
  });

  it("serializes and deserializes session parameters via sessionCodec", () => {
    const raw = { sessionId: "9ef5543e-46fa-49b0-b4da-a23d2d29116c", cwd: "/workspace" };
    const deserialized = sessionCodec.deserialize(raw);
    expect(deserialized).toEqual({
      sessionId: "9ef5543e-46fa-49b0-b4da-a23d2d29116c",
      conversationId: "9ef5543e-46fa-49b0-b4da-a23d2d29116c",
      cwd: "/workspace",
    });
    expect(sessionCodec.serialize(deserialized)).toEqual(deserialized);
    expect(sessionCodec.getDisplayId?.(deserialized)).toBe("9ef5543e-46fa-49");
    expect(sessionCodec.deserialize(null)).toBeNull();
    expect(sessionCodec.deserialize({})).toBeNull();
  });

  it("exposes declarative config schema fields", () => {
    const schema = getConfigSchema();
    expect(schema.fields.map((f) => f.key)).toEqual([
      "effort",
      "dangerouslySkipPermissions",
      "disableSlashCommands",
      "mode",
      "persistSession",
      "timeoutSec",
      "graceSec",
    ]);
  });
});

describe("models & detectModel", () => {
  it("parses agy models tabular output", () => {
    const sample = [
      "Available models:",
      "",
      "  Model ID                      Display Name",
      "  ------------------------------------------------------------",
      "  gemini-4-argon-high           Gemini 4 Argon (High)",
      "  claude-sonnet-5-5-high        Claude Sonnet 5.5 (High)",
      "  gpt-oss-120b-medium           GPT-OSS 120B (Medium)",
    ].join("\n");
    expect(parseModelsOutput(sample)).toEqual([
      { id: "gemini-4-argon-high", label: "Gemini 4 Argon (High)" },
      { id: "claude-sonnet-5-5-high", label: "Claude Sonnet 5.5 (High)" },
      { id: "gpt-oss-120b-medium", label: "GPT-OSS 120B (Medium)" },
    ]);
  });

  it("parses the tab-separated lines agy 1.4 prints", () => {
    const sample = [
      "Fetching available models...",
      "gemini-4-argon-medium\tGemini 4 Argon (Medium)",
      "claude-opus-5-5-low\tClaude Opus 5.5 (Low)",
    ].join("\n");
    expect(parseModelsOutput(sample)).toEqual([
      { id: "gemini-4-argon-medium", label: "Gemini 4 Argon (Medium)" },
      { id: "claude-opus-5-5-low", label: "Claude Opus 5.5 (Low)" },
    ]);
  });

  it("resolves model IDs from either ID or human display label", () => {
    expect(resolveModelId("Gemini 4 Argon (High)")).toBe("gemini-4-argon-high");
    expect(resolveModelId("claude-opus-5-5-medium")).toBe("claude-opus-5-5-medium");
    expect(resolveModelId("")).toBe("gemini-4-argon-high");
    expect(inferProviderFromModel("gemini-4-argon-high")).toBe("google");
    expect(inferProviderFromModel("claude-sonnet-5-5-high")).toBe("anthropic");
    expect(inferProviderFromModel("gpt-oss-120b-medium")).toBe("openai");
  });

  it("detects model from settings.json", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "agy-settings-"));
    const settingsPath = path.join(dir, "settings.json");
    await writeFile(settingsPath, JSON.stringify({ model: "Claude Opus 5.5 (High)" }));
    const detected = await detectModel(settingsPath);
    expect(detected).toEqual({
      model: "claude-opus-5-5-high",
      provider: "anthropic",
      source: settingsPath,
    });
  });
});

describe("parseAntigravityJsonl & ui-parser", () => {
  const sampleStream = [
    "[antigravity] Starting Antigravity CLI (model=gemini-4-argon-high, timeout=900s)",
    JSON.stringify({
      event: "init",
      conversation_id: "9ef5543e-46fa-49b0-b4da-a23d2d29116c",
      init: {
        cwd: "/workspace",
        tools: ["run_command", "read_file"],
        permission_mode: "always-proceed",
      },
    }),
    JSON.stringify({
      event: "step_update",
      step_update: {
        conversation_id: "9ef5543e-46fa-49b0-b4da-a23d2d29116c",
        step_index: 0,
        state: "DONE",
        step_type: "user_input",
      },
    }),
    JSON.stringify({
      event: "step_update",
      step_update: {
        conversation_id: "9ef5543e-46fa-49b0-b4da-a23d2d29116c",
        step_index: 1,
        state: "ACTIVE",
        step_type: "agent_response",
        thinking_delta: "Checking workspace...",
      },
    }),
    JSON.stringify({
      event: "step_update",
      step_update: {
        conversation_id: "9ef5543e-46fa-49b0-b4da-a23d2d29116c",
        step_index: 2,
        state: "ACTIVE",
        step_type: "tool",
        tool_name: "run_command",
        tool_info: {
          name: "run_command",
          parameters: { CommandLine: "echo hi" },
        },
      },
    }),
    JSON.stringify({
      event: "step_update",
      step_update: {
        conversation_id: "9ef5543e-46fa-49b0-b4da-a23d2d29116c",
        step_index: 2,
        state: "DONE",
        step_type: "tool",
        tool_name: "run_command",
        tool_info: {
          name: "run_command",
          parameters: { CommandLine: "echo hi" },
          output: "hi\n",
        },
      },
    }),
    JSON.stringify({
      event: "step_update",
      step_update: {
        conversation_id: "9ef5543e-46fa-49b0-b4da-a23d2d29116c",
        step_index: 3,
        state: "DONE",
        step_type: "agent_response",
        text_delta: "AGY_STREAM_OK",
        usage: {
          input_tokens: 5120,
          output_tokens: 4,
          thinking_tokens: 43,
          cache_read_tokens: 100,
          total_tokens: 5267,
        },
      },
    }),
    JSON.stringify({
      event: "result",
      result: {
        conversation_id: "9ef5543e-46fa-49b0-b4da-a23d2d29116c",
        status: "SUCCESS",
        response: "AGY_STREAM_OK",
        duration_seconds: 2.33,
        num_turns: 1,
        usage: {
          input_tokens: 5120,
          output_tokens: 4,
          thinking_tokens: 43,
          cache_read_tokens: 100,
          total_tokens: 5267,
        },
      },
    }),
  ].join("\n");

  it("extracts sessionId, summary, and usage from stream-json output", () => {
    const parsed = parseAntigravityJsonl(sampleStream);
    expect(parsed.sessionId).toBe("9ef5543e-46fa-49b0-b4da-a23d2d29116c");
    expect(parsed.summary).toBe("AGY_STREAM_OK");
    expect(parsed.status).toBe("SUCCESS");
    expect(parsed.usage).toEqual({
      inputTokens: 5120,
      outputTokens: 47,
      cachedInputTokens: 100,
    });
  });

  it("parses stream-json lines into UI TranscriptEntry items", () => {
    const parser = createStdoutParser();
    const entries = sampleStream
      .split("\n")
      .flatMap((line) => parser.parseLine(line, "2026-10-31T00:00:00Z"));
    expect(entries.map((e) => e.kind)).toEqual([
      "system",
      "init",
      "thinking",
      "tool_call",
      "tool_result",
      "assistant",
      "result",
    ]);
    expect(entries[1]).toEqual({
      kind: "init",
      ts: "2026-10-31T00:00:00Z",
      model: "antigravity",
      sessionId: "9ef5543e-46fa-49b0-b4da-a23d2d29116c",
    });
    expect(entries[3]).toEqual({
      kind: "tool_call",
      ts: "2026-10-31T00:00:00Z",
      name: "run_command",
      toolUseId: "agy-tool-9ef5543e-46fa-49b0-b4da-a23d2d29116c-2",
      input: { CommandLine: "echo hi" },
    });
    expect(entries[4]).toEqual({
      kind: "tool_result",
      ts: "2026-10-31T00:00:00Z",
      toolUseId: "agy-tool-9ef5543e-46fa-49b0-b4da-a23d2d29116c-2",
      content: "hi\n",
      isError: false,
    });
    const retry = parser.parseLine(
      JSON.stringify({
        event: "step_update",
        step_update: { conversation_id: "fresh-conv", step_index: 2, state: "ACTIVE", step_type: "tool", tool_info: { name: "view_file", parameters: {} } },
      }),
      "2026-10-31T00:00:01Z",
    );
    expect(retry).toEqual([
      { kind: "tool_call", ts: "2026-10-31T00:00:01Z", name: "view_file", toolUseId: "agy-tool-fresh-conv-2", input: {} },
    ]);
    expect(parseStdoutLine("plain text line", "2026-10-31T00:00:00Z")).toEqual([
      { kind: "stdout", ts: "2026-10-31T00:00:00Z", text: "plain text line" },
    ]);
  });

  it("identifies unrecoverable session and auth errors", () => {
    expect(isAntigravitySessionUnrecoverableError("", "Error: conversation 123 not found")).toBe(true);
    expect(isAntigravitySessionUnrecoverableError("all good", "")).toBe(false);
    expect(detectAntigravityAuthRequired("", "Not logged in. Please run `agy login`")).toBe(true);
  });
});

describe("skills reconciliation", () => {
  it("links desired KyoubeAI skills into ~/.gemini/config/skills and lists them", async () => {
    const tmp = await mkdtemp(path.join(os.tmpdir(), "agy-skills-"));
    const skillSource = path.join(tmp, "source-skills", "kyoube-data");
    await mkdir(skillSource, { recursive: true });
    await writeFile(path.join(skillSource, "SKILL.md"), "---\nname: kyoube-data\n---\n");

    const config = {
      env: { HOME: tmp },
      paperclipRuntimeSkills: [
        {
          key: "plugin/kyoube-apps/kyoube-data",
          runtimeName: "kyoube-data",
          source: skillSource,
        },
      ],
      paperclipSkillSync: {
        desiredSkills: ["plugin/kyoube-apps/kyoube-data"],
      },
    };

    const before = await listSkills({ adapterType: "antigravity_local", config });
    expect(before.entries[0]?.state).toBe("configured");

    const after = await syncSkills(
      { adapterType: "antigravity_local", config },
      ["plugin/kyoube-apps/kyoube-data"],
    );
    expect(after.entries[0]?.state).toBe("installed");
    const targetLink = path.join(tmp, ".gemini", "config", "skills", "kyoube-data");
    expect(await readlink(targetLink)).toBe(skillSource);
  });
});

describe("execute & testEnvironment", () => {
  it("spawns the configured agy binary, retries on stale conversation, and returns structured result", async () => {
    const tmp = await mkdtemp(path.join(os.tmpdir(), "agy-exec-"));
    const fakeBin = path.join(tmp, "fake-agy.sh");
    await writeFile(
      fakeBin,
      [
        "#!/usr/bin/env bash",
        "if [[ \"$*\" == *\"--version\"* ]]; then",
        "  echo '1.4.12'",
        "  exit 0",
        "fi",
        "printf '%s\\n' \"$@\" > \"$(dirname \"$0\")/args-$$.txt\"",
        "if [[ \"$*\" == *\"--conversation stale-id\"* ]]; then",
        "  echo 'Error: conversation stale-id not found' >&2",
        "  exit 1",
        "fi",
        "cat > \"$(dirname \"$0\")/stdin.txt\"",
        "echo '{\"event\":\"init\",\"conversation_id\":\"fresh-conv-123\",\"init\":{\"cwd\":\"'\"$PWD\"'\"}}'",
        "echo '{\"event\":\"result\",\"result\":{\"conversation_id\":\"fresh-conv-123\",\"status\":\"SUCCESS\",\"response\":\"Done task '\"$PAPERCLIP_TASK_ID\"'\",\"usage\":{\"input_tokens\":120,\"output_tokens\":30,\"thinking_tokens\":10,\"cache_read_tokens\":5}}}'",
      ].join("\n"),
    );
    await chmod(fakeBin, 0o755);

    const oauthDir = path.join(tmp, ".gemini", "antigravity-cli");
    await mkdir(oauthDir, { recursive: true });
    await writeFile(path.join(oauthDir, "antigravity-oauth-token"), "token-data");

    const envTest = await testEnvironment({
      companyId: "c1",
      adapterType: "antigravity_local",
      config: { command: fakeBin, cwd: tmp, env: { HOME: tmp } },
    });
    expect(envTest.status).toBe("pass");
    expect(envTest.checks.some((c) => c.code === "antigravity_cli_installed")).toBe(true);
    expect(envTest.checks.some((c) => c.code === "antigravity_auth_oauth")).toBe(true);

    const logs: string[] = [];
    let spawnedPid = 0;
    const res = await execute({
      runId: "run-99",
      agent: {
        id: "agent-1",
        companyId: "comp-1",
        name: "Builder",
        adapterType: "antigravity_local",
        adapterConfig: {},
      },
      runtime: {
        sessionId: "stale-id",
        sessionParams: { sessionId: "stale-id" },
        sessionDisplayId: "stale-id",
        taskKey: null,
      },
      config: {
        command: fakeBin,
        cwd: tmp,
        model: "gemini-4-argon-high",
        effort: "high",
        env: { HOME: tmp },
      },
      context: {
        taskId: "ISS-42",
        paperclipWake: {
          reason: "issue_assigned",
          issue: { id: "ISS-42", identifier: "BAP-42", title: "Ship Antigravity adapter" },
        },
      },
      authToken: "secret-run-jwt",
      onLog: async (_stream, chunk) => {
        logs.push(chunk);
      },
      onSpawn: async (meta) => {
        spawnedPid = meta.pid;
      },
    });

    expect(spawnedPid).toBeGreaterThan(0);
    expect(res.exitCode).toBe(0);
    expect(res.sessionId).toBe("fresh-conv-123");
    expect(res.summary).toBe("Done task ISS-42");
    expect(res.usage).toEqual({
      inputTokens: 120,
      outputTokens: 40,
      cachedInputTokens: 5,
    });
    expect(logs.join("")).toContain("retrying with a fresh session");

    const argFiles = (await readdir(tmp)).filter((f) => f.startsWith("args-"));
    const argLists = await Promise.all(argFiles.map(async (f) => (await readFile(path.join(tmp, f), "utf8")).trim().split("\n")));
    const fresh = argLists.find((list) => !list.includes("--conversation"));
    expect(fresh?.slice(0, 4)).toEqual(["--input-format", "stream-json", "--output-format", "stream-json"]);
    expect(fresh?.at(-1)).toBe("--print=");
    expect(argLists.flat().some((arg) => arg.includes("BAP-42"))).toBe(false);
    const message = JSON.parse(await readFile(path.join(tmp, "stdin.txt"), "utf8"));
    expect(message.event).toBe("user");
    expect(message.message.role).toBe("user");
    expect(message.message.content).toContain("BAP-42 — Ship Antigravity adapter");
  });

  it("starts a fresh conversation when the workspace moved, and honours timeoutSec 0", async () => {
    const tmp = await mkdtemp(path.join(os.tmpdir(), "agy-cwd-"));
    const fakeBin = path.join(tmp, "fake-agy.sh");
    await writeFile(
      fakeBin,
      [
        "#!/usr/bin/env bash",
        "printf '%s\\n' \"$@\" > \"$(dirname \"$0\")/args.txt\"",
        "cat > /dev/null",
        "echo '{\"event\":\"result\",\"result\":{\"conversation_id\":\"new-conv\",\"status\":\"SUCCESS\",\"response\":\"ok\"}}'",
      ].join("\n"),
    );
    await chmod(fakeBin, 0o755);
    const workspace = path.join(tmp, "new-workspace");
    const logs: string[] = [];
    const res = await execute({
      runId: "run-100",
      agent: { id: "agent-1", companyId: "comp-1", name: "Builder", adapterType: "antigravity_local", adapterConfig: {} },
      runtime: {
        sessionId: "old-conv",
        sessionParams: { sessionId: "old-conv", cwd: path.join(tmp, "old-workspace") },
        sessionDisplayId: "old-conv",
        taskKey: null,
      },
      config: { command: fakeBin, cwd: workspace, timeoutSec: 0, env: { HOME: tmp } },
      context: {},
      onLog: async (_stream, chunk) => {
        logs.push(chunk);
      },
    });

    expect(res.exitCode).toBe(0);
    expect(res.sessionId).toBe("new-conv");
    expect(res.sessionParams).toMatchObject({ sessionId: "new-conv", cwd: workspace });
    expect(await readFile(path.join(tmp, "args.txt"), "utf8")).not.toContain("--conversation");
    expect(logs.join("")).toContain('Conversation "old-conv" started in');
    expect(logs.join("")).toContain("timeout=0s");
  });

  it("builds wake prompt with issue details and runtime env notes", () => {
    const prompt = buildPrompt(
      {
        runId: "r1",
        agent: { id: "a1", companyId: "c1", name: "Coder", adapterType: "antigravity_local", adapterConfig: {} },
        runtime: { sessionId: null, sessionParams: null, sessionDisplayId: null, taskKey: null },
        config: {},
        context: {
          paperclipWake: {
            reason: "issue_commented",
            issue: { id: "i1", identifier: "BAP-1", title: "Fix bug", description: "Details here" },
          },
        },
        onLog: async () => {},
      },
      {},
      { PAPERCLIP_API_URL: "http://127.0.0.1:3100", PAPERCLIP_RUN_ID: "r1" },
    );
    expect(prompt).toContain("BAP-1 — Fix bug");
    expect(prompt).toContain("Details here");
    expect(prompt).toContain("PAPERCLIP_API_URL, PAPERCLIP_RUN_ID");
  });
});
