import { z } from "zod";
export const DOT_RUNNER_MCP_PATH = "/mcp/runner";
export const DOT_RUNNER_MCP_SCOPES = ["paperclip:agent", "offline_access"];
export const PUBLIC_MCP_PATH = "/mcp/paperclip";
export const PUBLIC_MCP_SCOPES = ["paperclip:read", "paperclip:write", "paperclip:configure", "offline_access"];
export const mcpConsentSchema = z.object({
    decision: z.enum(["approve", "deny"]),
    companyId: z.string().uuid().optional(),
    allowWrites: z.boolean().default(false),
    allowConfiguration: z.boolean().default(false),
}).strict();
//# sourceMappingURL=public-mcp.js.map