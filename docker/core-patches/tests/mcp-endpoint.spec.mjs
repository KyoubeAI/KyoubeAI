// The `mcp-*` core patches: the core's public MCP endpoint served as /mcp/kyoubeai, with KyoubeAI
// tool names and setup copy (docs/superpowers/specs/2026-11-12-mcp-connector-design.md, "1. Core
// patches"). Every test runs against core 2026.1023.0's own files, copied verbatim into
// fixtures/mcp-2026.1023.0/ at their /app-relative paths. The two UI files there are excerpts of the
// real assets, saved under the real names so the patches' globs find them, and hold every match the
// real files have, so these counts and the image build's agree.
import { execFile } from "node:child_process";
import { cp, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { applyPatches } from "../lib.mjs";
import { MCP_PUBLIC_TOOL_NAMES, PATCHES } from "../patches.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE = path.join(HERE, "fixtures", "mcp-2026.1023.0");
const MCP_PATCHES = () => PATCHES.filter((entry) => entry.id.startsWith("mcp-"));
const IDS = [
  "mcp-path-shared",
  "mcp-path-events",
  "mcp-tool-names",
  "mcp-setup-server-name",
  "mcp-setup-client-names",
  "mcp-setup-claude-web",
  "mcp-setup-after-approval",
  "mcp-ui-configure-label",
];
const URL_ = "https://k.example/mcp/kyoubeai";
const CLAUDE_WEB_STEPS = [
  {
    text: "Open this link to add KyoubeAI as a custom connector in Claude, then choose Connect and approve the connection in KyoubeAI. On Team and Enterprise plans an Owner adds custom connectors for the organization. The instance must be reachable over public HTTPS.",
    code: "https://claude.ai/customize/connectors?modal=add-custom-connector&connectorName=KyoubeAI&connectorUrl=https%3A%2F%2Fk.example%2Fmcp%2Fkyoubeai",
  },
  {
    text: "In a conversation, turn on the KyoubeAI connector from the tools menu. Verify the account and organization with kyoubeai_connection before doing work.",
  },
];

async function listFiles(dir) {
  const entries = await readdir(dir, { recursive: true, withFileTypes: true });
  return entries.filter((entry) => entry.isFile()).map((entry) => path.relative(dir, path.join(entry.parentPath, entry.name))).sort();
}

// The patched tree lives under tests/ so the patched mcp-setup.js resolves its one package import
// (zod, through ./public-mcp.js) from docker/core-patches/node_modules.
let root;
beforeEach(async () => {
  root = await mkdtemp(path.join(HERE, ".mcp-under-test-"));
  await cp(FIXTURE, root, { recursive: true });
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("the mcp-* entries", () => {
  it("are standing KyoubeAI patches, in order, built from the 37 public tool names", () => {
    expect(MCP_PATCHES().map((entry) => entry.id)).toEqual(IDS);
    for (const entry of MCP_PATCHES()) {
      expect(entry.standing, entry.id).toBe("KyoubeAI MCP connector");
      expect(entry.upstream, entry.id).toBeUndefined();
      expect(entry.upstreamFix, entry.id).toBeUndefined();
      expect(entry.title, entry.id).toMatch(/\S/);
      expect(entry.pattern.flags, entry.id).toContain("g");
    }
    expect(MCP_PUBLIC_TOOL_NAMES).toHaveLength(37);
    expect(new Set(MCP_PUBLIC_TOOL_NAMES).size).toBe(37);
    expect(MCP_PUBLIC_TOOL_NAMES.some((name) => name.startsWith("dot_"))).toBe(false);
  });

  it("the tool list is every non-Dot `name: \"paperclip_…\"` the core's capability files declare", async () => {
    const declared = new Set();
    for (const file of ["capabilities.js", "expanded-capabilities.js", "file-transfers.js"]) {
      const text = await readFile(path.join(FIXTURE, "server/dist/services/public-mcp", file), "utf8");
      for (const [, name] of text.matchAll(/name: "paperclip_([a-z_]+)"/g)) if (!name.startsWith("dot_")) declared.add(name);
    }
    expect([...declared].sort()).toEqual([...MCP_PUBLIC_TOOL_NAMES].sort());
  });

  it("each matches exactly its declared count on core 2026.1023.0", async () => {
    const report = await applyPatches(root, MCP_PATCHES());
    expect(report.map((entry) => entry.id)).toEqual(IDS);
    for (const entry of report) expect(entry.matched, entry.id).toBe(entry.expect);
  });

  it("a second run throws, so nothing is applied twice", async () => {
    await applyPatches(root, MCP_PATCHES());
    await expect(applyPatches(root, MCP_PATCHES())).rejects.toThrow(/standing KyoubeAI patch/);
    // Each entry on its own, too: none of them finds its anchor in its own output.
    for (const entry of MCP_PATCHES()) {
      await expect(applyPatches(root, [entry]), entry.id).rejects.toThrow(new RegExp(`"${entry.id}" matched 0 time`));
    }
  });

  it("leaves no public tool named paperclip_ and no /mcp/paperclip", async () => {
    await applyPatches(root, MCP_PATCHES());
    // oauth.js and agent-config.js (not in this fixture) only name paperclip_runner, which is no tool.
    const exempt = new Set(["server/dist/services/public-mcp/oauth.js", "server/dist/services/public-mcp/agent-config.js"]);
    for (const file of await listFiles(root)) {
      if (exempt.has(file)) continue;
      const text = await readFile(path.join(root, file), "utf8");
      expect(text.match(/\bpaperclip_(?!dot_)[a-z][a-z_]*/g), file).toBeNull();
      expect(text.includes("/mcp/paperclip"), file).toBe(false);
    }
    const shared = await readFile(path.join(root, "packages/shared/dist/public-mcp.js"), "utf8");
    expect(shared).toContain('export const PUBLIC_MCP_PATH = "/mcp/kyoubeai";');
    expect(shared).toContain('export const DOT_RUNNER_MCP_PATH = "/mcp/runner";');
    expect(await readFile(path.join(root, "server/dist/services/public-mcp/events.js"), "utf8")).toContain('cloudOrigin + "/mcp/kyoubeai"');
  });

  it("the patched setup page names the server kyoubeai, adds Claude web and drops Headless", async () => {
    await applyPatches(root, MCP_PATCHES());
    // The fixture keeps the core's `//# sourceMappingURL=` lines but not the maps; drop them from
    // the copy that is imported, so the loader does not go looking.
    for (const file of ["packages/shared/dist/mcp-setup.js", "packages/shared/dist/public-mcp.js"]) {
      const full = path.join(root, file);
      await writeFile(full, (await readFile(full, "utf8")).replace(/\n\/\/# sourceMappingURL=\S+\s*$/, "\n"));
    }
    const setup = await import(pathToFileURL(path.join(root, "packages/shared/dist/mcp-setup.js")).href);
    expect(Object.keys(setup.assistantClientNames).sort()).toEqual(["browser", "claude", "claude_web", "codex", "opencode", "other"]);
    expect(setup.assistantClientNames.claude_web).toBe("Claude (web, Desktop, mobile)");
    expect(setup.assistantClientNames.browser).toBe("ChatGPT");
    expect(setup.mcpSetupSteps(URL_, "claude_web")).toEqual(CLAUDE_WEB_STEPS);
    // The browser case still follows, unchanged apart from the client name.
    expect(setup.mcpSetupSteps(URL_, "browser")[0].code).toBe(URL_);

    const claude = setup.mcpSetupSteps(URL_, "claude");
    expect(claude[0].code).toContain("claude mcp add --transport http kyoubeai");
    expect(claude[1].text).toContain("select kyoubeai,");
    expect(claude[1].text).toContain("`claude mcp login kyoubeai`");
    expect(claude[1].text).toContain("`claude mcp login --help`");
    const codex = setup.mcpSetupSteps(URL_, "codex");
    expect(codex[0].code).toBe(`codex mcp add kyoubeai --url '${URL_}'`);
    // The scope identifiers stay as they are.
    expect(codex[1].code).toBe("codex mcp login kyoubeai --scopes paperclip:read,paperclip:write,paperclip:configure,offline_access");
    const opencode = setup.mcpSetupSteps(URL_, "opencode");
    expect(Object.keys(JSON.parse(opencode[0].code).mcp)).toEqual(["kyoubeai"]);
    expect(opencode[1].code).toBe("opencode mcp auth kyoubeai");

    const markdown = setup.mcpSetupMarkdown(URL_);
    expect(markdown).toContain("kyoubeai_connection");
    expect(markdown).not.toContain("paperclip_connection");
    expect(markdown).toContain("If the name kyoubeai already points elsewhere");
    expect(markdown).toContain("## Claude (web, Desktop, mobile)");
    expect(markdown).toContain("## ChatGPT\n");
    expect(markdown).not.toContain("## Headless");
    expect(markdown).toContain("then summarize agents, open tasks and data tables.");
    expect(markdown).not.toMatch(/\b(add|login|auth|select|name) paperclip\b/);
  });

  it("the minified UI copy of the setup steps gets the same changes", async () => {
    await applyPatches(root, MCP_PATCHES());
    const chunk = await readFile(path.join(root, "ui/dist/assets/agent-avatar-url-DQnt6boq.js"), "utf8");
    // The excerpt's only free names: GG (the scopes list) and n (the bundle's keepNames helper).
    const { VX, KX } = new Function("GG", "n", `let VX; ${chunk} return { VX, KX };`)(["paperclip:read"], () => {});
    expect(Object.keys(VX).sort()).toEqual(["browser", "claude", "claude_web", "codex", "opencode", "other"]);
    expect(VX.browser).toBe("ChatGPT");
    expect(KX(URL_, "claude_web")).toEqual(CLAUDE_WEB_STEPS);
    expect(KX(URL_, "claude")[0].code).toContain("claude mcp add --transport http kyoubeai");
    expect(KX(URL_, "opencode")[1].code).toBe("opencode mcp auth kyoubeai");
    expect(Object.keys(JSON.parse(KX(URL_, "opencode")[0].code).mcp)).toEqual(["kyoubeai"]);
    const index = await readFile(path.join(root, "ui/dist/assets/index-YJY9oyby.js"), "utf8");
    expect(index.split("Configure agents, projects, skills, tables and apps")).toHaveLength(3);
    expect(index).not.toContain("Configure agents, projects and skills");
  });

  it("every patched .js file still parses", async () => {
    await applyPatches(root, MCP_PATCHES());
    const files = (await listFiles(root)).filter((file) => file.endsWith(".js"));
    expect(files.length).toBeGreaterThan(0);
    for (const file of files) await promisify(execFile)(process.execPath, ["--check", path.join(root, file)]);
  });

  it("a core that moved an anchor fails the build with the entry's id", async () => {
    const events = path.join(root, "server/dist/services/public-mcp/events.js");
    await writeFile(events, (await readFile(events, "utf8")).replace('"/mcp/paperclip"', '"/mcp/x"'));
    await expect(applyPatches(root, MCP_PATCHES())).rejects.toThrow(/mcp-path-events[\s\S]*standing KyoubeAI patch/);
  });
});
