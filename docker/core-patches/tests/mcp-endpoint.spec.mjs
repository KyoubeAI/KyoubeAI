// The `mcp-*` core patches: the core's public MCP endpoint served as /mcp/kyoubeai, with KyoubeAI
// tool names and setup copy (docs/superpowers/specs/2026-11-12-mcp-connector-design.md, "1. Core
// patches"). Every test runs against core 2026.1023.0's own files, copied verbatim into
// fixtures/mcp-2026.1023.0/ at their /app-relative paths. The two UI files there are excerpts of the
// real assets, saved under the real names so the patches' globs find them, and hold every match the
// real files have, so these counts and the image build's agree. server/dist/app.js is an excerpt
// too: its capabilities import and the block that builds the MCP dispatch (lines 811-829).
import { execFile } from "node:child_process";
import { cp, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { applyPatches } from "../lib.mjs";
import { MCP_PUBLIC_TOOL_NAMES, PATCHES } from "../patches.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE = path.join(HERE, "fixtures", "mcp-2026.1023.0");
const DOCKERFILE = path.join(HERE, "..", "..", "Dockerfile");
const BRIDGE = pathToFileURL(path.join(HERE, "..", "mcp-bridge.mjs")).href;
const MCP_PATCHES = () => PATCHES.filter((entry) => entry.id.startsWith("mcp-"));
const IDS = [
  "mcp-path-shared",
  "mcp-path-events",
  "mcp-tool-names",
  "mcp-setup-server-name",
  "mcp-setup-client-names",
  "mcp-setup-claude-web",
  "mcp-setup-after-approval",
  "mcp-setup-no-headless",
  "mcp-ui-configure-label",
  "mcp-server-info-name",
  "mcp-bridge-register",
  "mcp-bridge-import-capabilities",
  "mcp-bridge-executor-removed",
  "mcp-bridge-executor-find",
  "mcp-bridge-import-routes",
  "mcp-bridge-list",
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

// The patched tree lives under tests/ so the patched mcp-setup resolves its one package import
// (zod, through ./public-mcp) from docker/core-patches/node_modules.
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
    // Both copies of the shared constants: the server loads src/*.ts through tsx; dist is kept consistent.
    const files = await listFiles(root);
    for (const file of ["packages/shared/src/public-mcp.ts", "packages/shared/src/mcp-setup.ts"]) expect(files).toContain(file);
    for (const file of ["packages/shared/src/public-mcp.ts", "packages/shared/dist/public-mcp.js"]) {
      const shared = await readFile(path.join(root, file), "utf8");
      expect(shared, file).toContain('export const PUBLIC_MCP_PATH = "/mcp/kyoubeai";');
      expect(shared, file).toContain('export const DOT_RUNNER_MCP_PATH = "/mcp/runner";');
    }
    expect(await readFile(path.join(root, "server/dist/services/public-mcp/events.js"), "utf8")).toContain('cloudOrigin + "/mcp/kyoubeai"');
  });

  // The server's /mcp/setup page uses the TypeScript source, which it loads through tsx
  // (packages/shared exports "./*": "./src/*.ts"); the compiled dist copy is kept the same.
  it.each([
    ["the source the server loads", "packages/shared/src/mcp-setup.ts"],
    ["the compiled copy", "packages/shared/dist/mcp-setup.js"],
  ])("the patched setup page (%s) names the server kyoubeai, adds Claude web and drops Headless", async (_, entry) => {
    await applyPatches(root, MCP_PATCHES());
    // The fixture keeps the core's `//# sourceMappingURL=` lines but not the maps; drop them from
    // the copy that is imported, so the loader does not go looking.
    for (const file of ["packages/shared/dist/mcp-setup.js", "packages/shared/dist/public-mcp.js"]) {
      const full = path.join(root, file);
      await writeFile(full, (await readFile(full, "utf8")).replace(/\n\/\/# sourceMappingURL=\S+\s*$/, "\n"));
    }
    const setup = await import(pathToFileURL(path.join(root, entry)).href);
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
    // Headless is gone, so no step may send anyone to it.
    const other = setup.mcpSetupSteps(URL_, "other");
    expect(other[1].text).toContain("If it cannot receive a browser callback, use Claude Code, Codex or OpenCode instead.");
    expect(JSON.stringify(other)).not.toContain("Headless");
    expect(markdown).not.toContain("Headless");
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
    expect(KX(URL_, "other")[1].text).toContain("If it cannot receive a browser callback, use Claude Code, Codex or OpenCode instead.");
    expect(JSON.stringify(KX(URL_, "other"))).not.toContain("Headless");
    expect(Object.keys(JSON.parse(KX(URL_, "opencode")[0].code).mcp)).toEqual(["kyoubeai"]);
    const index = await readFile(path.join(root, "ui/dist/assets/index-YJY9oyby.js"), "utf8");
    expect(index.split("Configure agents, projects, skills, tables and apps")).toHaveLength(3);
    expect(index).not.toContain("Configure agents, projects and skills");
  });

  it("announces the server as kyoubeai on /mcp/kyoubeai, and leaves the Dot runner's name alone", async () => {
    const ROUTES = "server/dist/routes/public-mcp.js";
    const before = await readFile(path.join(root, ROUTES), "utf8");
    expect(before.split('name: "paperclip", version: "0.1.0" }')).toHaveLength(3);
    await applyPatches(root, MCP_PATCHES());
    const text = await readFile(path.join(root, ROUTES), "utf8");
    expect(text).not.toContain('name: "paperclip", version: "0.1.0" }');
    // The MCP SDK server's info on initialize, and the serverInfo _meta on the JSON-RPC answers.
    const announced = 'name: agentConnection ? "paperclip" : "kyoubeai", version: "0.1.0" }';
    expect(text.split(announced)).toHaveLength(3);
    expect(text).toContain(`new Server({ ${announced}, { capabilities: { tools: {} } });`);
    expect(text).toContain(`"io.modelcontextprotocol/serverInfo": { ${announced} }`);
    // Both sit in publicMcpIngressRoutes, after its agentConnection (true for the Dot runner's /mcp/runner).
    const fn = text.indexOf("export function publicMcpIngressRoutes(");
    const declared = text.indexOf("const agentConnection = endpoint === DOT_RUNNER_MCP_PATH;", fn);
    expect(fn).toBeGreaterThan(-1);
    expect(declared).toBeGreaterThan(fn);
    expect(text.indexOf(announced)).toBeGreaterThan(declared);
    expect(text.slice(fn + 1, text.lastIndexOf(announced)).includes("\nexport function ")).toBe(false);
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

// The bridge wiring: the patched core imports /opt/kyoube/core-patches/mcp-bridge.mjs to list and
// run KyoubeAI's table, app and file tools. The behaviour tests run the patched executor, tool listing and
// dispatch hand-over themselves, lifted out of the patched files into modules of their own (the
// files' other imports, such as express and the database, do not resolve here), with the bridge
// path pointed at the real mcp-bridge.mjs.
describe("the bridge wiring", () => {
  const CAPABILITIES = "server/dist/services/public-mcp/capabilities.js";
  const ROUTES = "server/dist/routes/public-mcp.js";
  const MISSING_BRIDGE = () => pathToFileURL(path.join(root, "no-such-bridge.mjs")).href;
  const read = (file) => readFile(path.join(root, file), "utf8");
  const nodeCheck = (file) => promisify(execFile)(process.execPath, ["--check", path.join(root, file)]);

  /** The patched file's kyoubeMcp loader line, pointed at `bridge`. */
  function loader(text, bridge) {
    const line = /^\/\* kyoube-mcp \(docs\/mcp\.md\) \*\/ const kyoubeMcp = \(\) => import\("\/opt\/kyoube\/core-patches\/mcp-bridge\.mjs"\);$/m.exec(text)?.[0];
    if (!line) throw new Error("no kyoubeMcp loader in the patched file");
    return line.replace("/opt/kyoube/core-patches/mcp-bridge.mjs", bridge);
  }

  /** Writes `source` as a module in the temp tree (under tests/, so zod resolves) and imports it. */
  async function load(name, source) {
    const file = path.join(root, `${name}-${Math.random().toString(36).slice(2)}.mjs`);
    await writeFile(file, source);
    return import(pathToFileURL(file).href);
  }

  /** The patched createPublicMcpExecutor, with the core's other module-scope names stood in for. */
  async function patchedExecutor() {
    const text = await read(CAPABILITIES);
    const fn = text.slice(text.indexOf("export function createPublicMcpExecutor")).replace(/^\/\/# sourceMappingURL=.*$/m, "").replace(/^export /, "");
    return load("executor-under-test", `import { z } from "zod";\n${loader(text, BRIDGE)}\nexport { kyoubeMcp };\n` +
      "export default ({ publicMcpCapabilities, McpCapabilityError, McpApiError }) => {\n" +
      '  const fail = () => { throw new Error("a read must not reach the database"); };\n' +
      "  const [hashMcpSecret, stable, logActivity, and, eq, mcpMutationReceipts] = [fail, fail, fail, fail, fail, {}];\n" +
      `${fn}\n  return createPublicMcpExecutor;\n};\n`);
  }

  /** The route's patched listTools arrow, with its closure handed in. */
  async function patchedListTools(bridge = BRIDGE) {
    const text = await read(ROUTES);
    const start = text.indexOf("const listTools = async () => {");
    const end = text.indexOf("const callTool = async");
    if (start < 0 || end < start) throw new Error("no patched listTools in the route");
    return load("list-under-test", `import { z } from "zod";\n${loader(text, bridge)}\nexport { kyoubeMcp };\n` +
      `export default ({ agentConnection, publicMcpCapabilities, extension, principal }) => {\n${text.slice(start, end)}\n  return listTools;\n};\n`);
  }

  class McpCapabilityError extends Error {}
  class McpApiError extends Error {}
  const principal = { grant: { id: "g1", companyId: "c1", userId: "u1", scopes: ["paperclip:read"] }, actor: {} };
  const READ = { name: "kyoubeai_connection", description: "Who", schema: z.object({}).strict(), run: async () => ({ core: true }) };
  const WRITE = { name: "kyoubeai_create_task", description: "Create", write: true, schema: z.object({}).strict(), run: async () => ({}) };
  const SEARCH = { name: "kyoubeai_search_api", description: "Search", schema: z.object({}).passthrough(), run: async () => ({}) };
  const CALL = { name: "kyoubeai_call_api", description: "Call", write: true, destructive: true, schema: z.object({}).passthrough(), run: async () => ({}) };
  const TITLED = { name: "kyoubeai_list_agents", title: "Agents in this company", description: "Agents", schema: z.object({}).strict(), run: async () => ({}) };
  const CORE = [READ, WRITE, SEARCH, CALL, TITLED];
  const TABLES = { name: "kyoubeai_data_list_tables", title: "Data list tables", description: "List tables", inputSchema: { type: "object" }, tier: "read", annotations: { readOnlyHint: true } };
  const TABLES_LISTED = { name: TABLES.name, title: TABLES.title, description: TABLES.description, inputSchema: TABLES.inputSchema, annotations: TABLES.annotations };
  const catalogue = async (_p, method, url) => {
    if (method === "GET" && url.startsWith("/plugins/kyoube.apps/api/mcp/tools?")) return { tools: [TABLES] };
    throw new Error(`unexpected dispatch ${method} ${url}`);
  };

  /** Runs the patched executor for an OAuth resource, with the bridge's catalogue answered by `dispatch`. */
  async function execute(name, input, { resource = "https://k.example/mcp/kyoubeai", dispatch = catalogue, api = async () => ({ ran: true }) } = {}) {
    const mod = await patchedExecutor();
    const bridge = await mod.kyoubeMcp();
    bridge.resetForTests();
    bridge.registerDispatch(dispatch);
    const oauth = { authenticate: async () => principal, config: { resource, origin: "https://k.example" } };
    return mod.default({ publicMcpCapabilities: CORE, McpCapabilityError, McpApiError })({}, oauth, api)("token", name, input);
  }

  it("patches the executor, the tool listing and the app's dispatch, and the files still parse", async () => {
    await applyPatches(root, MCP_PATCHES());
    const capabilities = await read(CAPABILITIES);
    expect(capabilities).toContain("kyoubeMcp()).findTool(");
    expect(capabilities).toContain("Unknown KyoubeAI operation.");
    await nodeCheck(CAPABILITIES);
    const routes = await read(ROUTES);
    expect(routes).toContain("titleFor(");
    expect(routes).toContain("bridge.listTools(principal)");
    await nodeCheck(ROUTES);
    expect(await read("server/dist/app.js")).toContain("registerDispatch(dispatch)");
    await nodeCheck("server/dist/app.js");
    // The lines the Dockerfile's `grep -c 'kyoube-mcp'` checks count.
    const markers = async (file) => (await read(file)).split("\n").filter((line) => line.includes("kyoube-mcp")).length;
    expect(await markers(CAPABILITIES)).toBe(3);
    expect(await markers(ROUTES)).toBe(2);
    expect(await markers("server/dist/app.js")).toBe(1);
  });

  it("the executor refuses the generic API tools the bridge declares removed", async () => {
    await applyPatches(root, MCP_PATCHES());
    const { REMOVED_TOOLS } = await import(BRIDGE);
    expect(await read(CAPABILITIES)).toContain(`if (${JSON.stringify(REMOVED_TOOLS).replaceAll(",", ", ")}.includes(name)) throw new McpCapabilityError("Unknown KyoubeAI operation.");`);
    for (const name of REMOVED_TOOLS) {
      await expect(execute(name, { companyId: "c1", operationId: "kyoubeai_connection", arguments: {} })).rejects.toThrow("Unknown KyoubeAI operation.");
    }
  });

  it("the executor runs a core tool first and a KyoubeAI table tool through the bridge, on /mcp/kyoubeai only", async () => {
    await applyPatches(root, MCP_PATCHES());
    expect(await execute("kyoubeai_connection", {})).toEqual({ core: true });
    const calls = [];
    const api = async (...args) => { calls.push(args); return { tables: [] }; };
    expect(await execute("kyoubeai_data_list_tables", { companyId: "c1" }, { api })).toEqual({ tables: [] });
    expect(calls).toEqual([[principal, "POST", "/plugins/kyoube.apps/api/mcp/call", { companyId: "c1", tool: "kyoubeai_data_list_tables", arguments: {} }]]);
    // The Dot runner's executor runs the same code but has no KyoubeAI tools.
    await expect(execute("kyoubeai_data_list_tables", {}, { resource: "https://k.example/mcp/runner" })).rejects.toThrow("Unknown Paperclip operation.");
    await expect(execute("kyoubeai_nonsense", {})).rejects.toThrow("Unknown Paperclip operation.");
    // A catalogue that cannot be read says so.
    const { UNAVAILABLE } = await import(BRIDGE);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      await expect(execute("kyoubeai_data_list_tables", {}, { dispatch: async () => { throw new Error("down"); } })).rejects.toThrow(UNAVAILABLE);
    } finally {
      warn.mockRestore();
    }
  });

  it("the tool list drops the generic API tools, titles the core tools, adds KyoubeAI's, then the extension's", async () => {
    await applyPatches(root, MCP_PATCHES());
    const mod = await patchedListTools();
    const bridge = await mod.kyoubeMcp();
    bridge.resetForTests();
    bridge.registerDispatch(catalogue);
    const extension = { listTools: async () => [{ name: "ext_tool" }] };
    const { tools } = await mod.default({ agentConnection: false, publicMcpCapabilities: CORE, extension, principal })();
    expect(tools.map((tool) => tool.name)).toEqual(["kyoubeai_connection", "kyoubeai_create_task", "kyoubeai_list_agents", "kyoubeai_data_list_tables", "ext_tool"]);
    expect(tools[0]).toEqual({
      name: "kyoubeai_connection", title: "Connection", description: "Who", inputSchema: z.toJSONSchema(READ.schema),
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    });
    expect(tools[1].title).toBe("Create task");
    expect(tools[1].annotations).toEqual({ readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true });
    // A capability's own title wins over the bridge's.
    expect(tools[2].title).toBe("Agents in this company");
    expect(tools[3]).toEqual(TABLES_LISTED);
    // The Dot runner's connection lists only its own tools, as before.
    const agent = await mod.default({ agentConnection: true, publicMcpCapabilities: CORE, extension, principal })();
    expect(agent.tools.map((tool) => tool.name)).toEqual(["ext_tool"]);
  });

  it("a bridge that cannot be loaded leaves the core list, untitled, rather than failing tools/list", async () => {
    await applyPatches(root, MCP_PATCHES());
    const mod = await patchedListTools(MISSING_BRIDGE());
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const { tools } = await mod.default({ agentConnection: false, publicMcpCapabilities: CORE, extension: undefined, principal })();
      expect(tools.map((tool) => tool.name)).toEqual(["kyoubeai_connection", "kyoubeai_create_task", "kyoubeai_list_agents"]);
      // Only a capability's own title is left.
      expect(tools.filter((tool) => "title" in tool).map((tool) => tool.title)).toEqual(["Agents in this company"]);
      expect(error).toHaveBeenCalledWith("[kyoube] MCP bridge unavailable", expect.anything());
    } finally {
      error.mockRestore();
    }
  });

  it("the app hands the core's dispatch to the bridge, and carries on when the bridge cannot be loaded", async () => {
    await applyPatches(root, MCP_PATCHES());
    const line = (await read("server/dist/app.js")).split("\n").find((text) => text.includes("kyoube-mcp"));
    const handOver = async (bridge) => (await load("app-under-test", `export default (dispatch) => {\n${line.replace("/opt/kyoube/core-patches/mcp-bridge.mjs", bridge)}\n};\n`)).default;
    const { resetForTests, listTools } = await import(BRIDGE);
    resetForTests();
    // The core does not wait for the import; give it a moment.
    (await handOver(BRIDGE))(catalogue);
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(await listTools(principal)).toEqual([TABLES_LISTED]);
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      (await handOver(MISSING_BRIDGE()))(catalogue);
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(error).toHaveBeenCalledWith("[kyoube] MCP bridge unavailable", expect.anything());
    } finally {
      error.mockRestore();
    }
  });

  it("is shipped and checked by the Dockerfile", async () => {
    const dockerfile = await readFile(DOCKERFILE, "utf8");
    const copy = dockerfile.split("\n").find((line) => line.startsWith("COPY docker/core-patches/apply.mjs "));
    expect(copy).toContain(" docker/core-patches/mcp-bridge.mjs ");
    expect(copy).toMatch(/ \/opt\/kyoube\/core-patches\/$/);
    expect(dockerfile).toContain("test \"$(grep -c 'kyoube-mcp' /app/server/dist/services/public-mcp/capabilities.js)\" -eq 3");
    expect(dockerfile).toContain("test \"$(grep -c 'kyoube-mcp' /app/server/dist/routes/public-mcp.js)\" -eq 2");
    expect(dockerfile).toContain("test \"$(grep -c 'kyoube-mcp' /app/server/dist/app.js)\" -eq 1");
    expect(dockerfile).toContain("node --check dist/services/public-mcp/capabilities.js");
    expect(dockerfile).toContain("node --check dist/routes/public-mcp.js");
    expect(dockerfile).toContain('import("/opt/kyoube/core-patches/mcp-bridge.mjs")');
    expect(dockerfile).toContain("mcp-bridge ok");
  });
});
