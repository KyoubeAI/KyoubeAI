/**
 * The bridge between the core's MCP server and KyoubeAI's table, app and file tools.
 *
 * The core serves MCP at /mcp and runs "capabilities" for its own tools. The
 * KyoubeAI tools live in two plugins, each answering its catalogue at
 * GET /plugins/<id>/api/mcp/tools and running a tool at
 * POST /plugins/<id>/api/mcp/call: kyoube.apps (kyoubeai_data_*, kyoubeai_apps_*)
 * and kyoube.files (kyoubeai_files_*), see MCP_PLUGINS. Standing core
 * patches (patches.mjs) make the patched app.js, capabilities.js and
 * routes/public-mcp.js import this file: app.js hands over the core's internal
 * dispatch once (registerDispatch), the tool listing calls listTools and
 * titleFor, and the executor calls findTool for a name that is not a core tool.
 * The image ships this file as /opt/kyoube/core-patches/mcp-bridge.mjs.
 *
 * It imports nothing: the dispatch, zod and the core's CapabilityError are
 * handed in, so the tests run it with fakes. A name's prefix picks the plugin
 * that owns it; a name with no owning prefix is the core's. A plugin that
 * answers with a name outside its own prefixes has that entry dropped.
 */

export const KYOUBE_MCP_PATH = "/mcp/kyoubeai";
/** The generic API tools this connector replaces. */
export const REMOVED_TOOLS = ["kyoubeai_search_api", "kyoubeai_call_api"];
export const UNAVAILABLE = "KyoubeAI's table, app and file tools are unavailable right now. Try again in a minute.";

/** The plugins that serve MCP tools, in listing order, and the name prefixes each owns. */
export const MCP_PLUGINS = [
  { id: "kyoube.apps", prefixes: ["kyoubeai_data_", "kyoubeai_apps_"] },
  { id: "kyoube.files", prefixes: ["kyoubeai_files_"] },
];

const CACHE_MS = 60_000;

let dispatch = null;
let clock = () => Date.now();
/** "<company id>|<plugin id>" -> { at, tools }; only successful answers are kept. */
let cache = new Map();

const ownerOf = (name) => MCP_PLUGINS.find((plugin) => plugin.prefixes.some((prefix) => name.startsWith(prefix)));

export function titleFor(name) {
  const words = name.replace(/^kyoubeai_/, "").replace(/_/g, " ");
  return words.charAt(0).toUpperCase() + words.slice(1);
}

export function registerDispatch(fn) {
  dispatch = fn;
}

export function resetForTests(now) {
  cache = new Map();
  dispatch = null;
  clock = now ?? (() => Date.now());
}

/** One plugin's catalogue entries for the company, or null when unavailable. A failure is not cached. */
async function catalogue(principal, plugin) {
  const companyId = principal.grant.companyId;
  const key = `${companyId}|${plugin.id}`;
  const hit = cache.get(key);
  if (hit && clock() - hit.at <= CACHE_MS) return hit.tools;
  if (!dispatch) {
    console.warn("[kyoube] MCP bridge has no dispatch registered");
    return null;
  }
  try {
    const body = await dispatch(principal, "GET", `/plugins/${plugin.id}/api/mcp/tools?companyId=${encodeURIComponent(companyId)}`);
    if (!Array.isArray(body?.tools)) throw new Error("no tools in the response");
    const tools = body.tools.filter((tool) => {
      const ok = typeof tool?.name === "string" && plugin.prefixes.some((prefix) => tool.name.startsWith(prefix));
      if (!ok) console.warn(`[kyoube] ${plugin.id} offered a tool outside its prefixes, dropped:`, tool?.name);
      return ok;
    });
    cache.set(key, { at: clock(), tools });
    return tools;
  } catch (error) {
    console.warn(`[kyoube] MCP tool catalogue of ${plugin.id} unavailable:`, error instanceof Error ? error.message : error);
    return null;
  }
}

export async function listTools(principal) {
  const lists = await Promise.all(MCP_PLUGINS.map((plugin) => catalogue(principal, plugin)));
  return lists.flatMap((tools) => tools ?? []).map(({ name, title, description, inputSchema, annotations }) => ({ name, title, description, inputSchema, annotations }));
}

export async function findTool(principal, name, { z, CapabilityError }) {
  const owner = ownerOf(name);
  if (!owner) return undefined;
  const tools = await catalogue(principal, owner);
  if (!tools) throw new CapabilityError(UNAVAILABLE);
  const entry = tools.find((tool) => tool.name === name);
  if (!entry) return undefined;
  // A tier this bridge does not know fails closed: the strictest scope and a receipt.
  const tier = entry.tier === "read" || entry.tier === "write" ? entry.tier : "configure";
  const writes = tier !== "read";
  return {
    name,
    description: entry.description,
    write: tier === "write",
    configure: tier === "configure",
    destructive: entry.annotations?.destructiveHint === true,
    schema: writes ? z.object({ requestId: z.uuid() }).passthrough() : z.object({}).passthrough(),
    async run(p, args, api) {
      const { companyId: _companyId, requestId: _requestId, ...rest } = args ?? {};
      return api(p, "POST", `/plugins/${owner.id}/api/mcp/call`, { companyId: p.grant.companyId, tool: name, arguments: rest });
    },
  };
}
