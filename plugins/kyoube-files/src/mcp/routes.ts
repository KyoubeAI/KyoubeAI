import type { PluginApiRouteDeclaration } from "@paperclipai/plugin-sdk";

/**
 * The route declarations alone, for the manifest: no zod and no catalogue,
 * so importing them never drags the tools into a bundle that only needs the
 * manifest.
 */
function route(routeKey: string, method: "GET" | "POST", path: string): PluginApiRouteDeclaration {
  return {
    routeKey,
    method,
    path,
    auth: "board",
    capability: "api.routes.register",
    companyResolution: method === "GET" ? { from: "query", key: "companyId" } : { from: "body", key: "companyId" },
  };
}

/** Board-only: an assistant connection always acts as the signed-in person. */
export const FILES_MCP_ROUTES: PluginApiRouteDeclaration[] = [
  route("mcp.tools", "GET", "/mcp/tools"),
  route("mcp.call", "POST", "/mcp/call"),
];
