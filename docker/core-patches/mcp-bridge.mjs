/**
 * The bridge between the core's MCP server and KyoubeAI's table and app tools.
 *
 * The core serves MCP at /mcp and runs "capabilities" for its own tools. The
 * KyoubeAI tools (kyoubeai_data_*, kyoubeai_apps_*) live in the kyoube.apps
 * plugin, which answers its catalogue at GET /plugins/kyoube.apps/api/mcp/tools
 * and runs a tool at POST /plugins/kyoube.apps/api/mcp/call. Standing core
 * patches (patches.mjs) make the patched app.js, capabilities.js and
 * routes/public-mcp.js import this file: app.js hands over the core's internal
 * dispatch once (registerDispatch), the tool listing calls listTools and
 * titleFor, and the executor calls findTool for a name that is not a core tool.
 * The image ships this file as /opt/kyoube/core-patches/mcp-bridge.mjs.
 *
 * It imports nothing: the dispatch, zod and the core's CapabilityError are
 * handed in, so the tests run it with fakes. Only names starting kyoubeai_data_
 * or kyoubeai_apps_ are Kyoube's to answer or refuse; any other name is the
 * core's.
 */

export const KYOUBE_MCP_PATH = "/mcp/kyoubeai";
/** The generic API tools this connector replaces. */
export const REMOVED_TOOLS = ["kyoubeai_search_api", "kyoubeai_call_api"];
export const UNAVAILABLE = "KyoubeAI's table and app tools are unavailable right now. Try again in a minute.";

const CACHE_MS = 60_000;
const PLUGIN_API = "/plugins/kyoube.apps/api/mcp";
const PREFIXES = ["kyoubeai_data_", "kyoubeai_apps_"];

let dispatch = null;
let clock = () => Date.now();
/** company id -> { at, tools }; tools is null when the fetch failed. */
let cache = new Map();

const isKyoubeName = (name) => PREFIXES.some((prefix) => name.startsWith(prefix));

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

/** The company's catalogue entries, or null when unavailable. Cached, failures too. */
async function catalogue(principal) {
  const companyId = principal.grant.companyId;
  const hit = cache.get(companyId);
  if (hit && clock() - hit.at <= CACHE_MS) return hit.tools;
  let tools = null;
  if (dispatch) {
    try {
      const body = await dispatch(principal, "GET", `${PLUGIN_API}/tools?companyId=${encodeURIComponent(companyId)}`);
      if (Array.isArray(body?.tools)) tools = body.tools;
      else throw new Error("no tools in the response");
    } catch (error) {
      console.warn("[kyoube] MCP tool catalogue unavailable:", error instanceof Error ? error.message : error);
    }
  } else {
    console.warn("[kyoube] MCP bridge has no dispatch registered");
  }
  cache.set(companyId, { at: clock(), tools });
  return tools;
}

export async function listTools(principal) {
  const tools = await catalogue(principal);
  if (!tools) return [];
  return tools.map(({ name, title, description, inputSchema, annotations }) => ({ name, title, description, inputSchema, annotations }));
}

export async function findTool(principal, name, { z, CapabilityError }) {
  if (!isKyoubeName(name)) return undefined;
  const tools = await catalogue(principal);
  if (!tools) throw new CapabilityError(UNAVAILABLE);
  const entry = tools.find((tool) => tool.name === name);
  if (!entry) return undefined;
  const writes = entry.tier === "write" || entry.tier === "configure";
  return {
    name,
    description: entry.description,
    write: entry.tier === "write",
    configure: entry.tier === "configure",
    destructive: entry.annotations?.destructiveHint === true,
    schema: writes ? z.object({ requestId: z.string().min(1).max(200) }).passthrough() : z.object({}).passthrough(),
    async run(p, args, api) {
      const { companyId: _companyId, requestId: _requestId, ...rest } = args ?? {};
      return api(p, "POST", `${PLUGIN_API}/call`, { companyId: p.grant.companyId, tool: name, arguments: rest });
    },
  };
}
