import { describe, expect, it } from "vitest";
import { buildFilesCatalogue } from "../src/mcp/catalogue.js";

const EXPECTED: [string, string, "read" | "write", boolean][] = [
  ["kyoubeai_files_folders", "Project folders", "read", false],
  ["kyoubeai_files_list", "List files", "read", false],
  ["kyoubeai_files_read", "Read file", "read", false],
  ["kyoubeai_files_write", "Write file", "write", true],
  ["kyoubeai_files_edit", "Edit file", "write", true],
  ["kyoubeai_files_create_folder", "Create folder", "write", false],
  ["kyoubeai_files_move", "Move or rename", "write", false],
  ["kyoubeai_files_delete", "Delete file or folder", "write", true],
];

describe("kyoube.files MCP catalogue", () => {
  const tools = buildFilesCatalogue();

  it("has the tools in order, with their titles, tiers and hints", () => {
    expect(tools.map((tool) => tool.entry.name)).toEqual(EXPECTED.map(([name]) => name));
    for (const [name, title, tier, destructive] of EXPECTED) {
      const { entry } = tools.find((tool) => tool.entry.name === name)!;
      expect(entry.title).toBe(title);
      expect(entry.tier).toBe(tier);
      expect(entry.annotations).toEqual({ readOnlyHint: tier === "read", destructiveHint: destructive, idempotentHint: tier === "read", openWorldHint: false });
    }
  });

  it("is memoised", () => {
    expect(buildFilesCatalogue()).toBe(tools);
  });

  it("names every tool for MCP", () => {
    for (const { entry } of tools) {
      expect(entry.name).toMatch(/^kyoubeai_files_[a-z_]+$/);
      expect(entry.name.length).toBeLessThanOrEqual(64);
    }
  });

  it("asks for a requestId on write tools only, and a projectId on all", () => {
    for (const { entry } of tools) {
      const schema = entry.inputSchema as { required?: string[]; properties: Record<string, { format?: string }> };
      expect(schema.required).toContain("projectId");
      if (entry.tier === "write") {
        expect(schema.required).toContain("requestId");
        expect(schema.properties.requestId?.format).toBe("uuid");
      } else {
        expect(schema.properties.requestId).toBeUndefined();
      }
    }
  });

  it("scopes every tool but the folder list to a folder", () => {
    for (const tool of tools) {
      const folderScoped = tool.entry.name !== "kyoubeai_files_folders";
      expect(tool.folderScoped).toBe(folderScoped);
      expect("folderId" in (tool.entry.inputSchema.properties as object)).toBe(folderScoped);
    }
  });

  it("describes tools for a person's assistant, not for an agent", () => {
    for (const { entry } of tools) {
      expect(entry.description.length).toBeGreaterThan(0);
      expect(entry.description.toLowerCase()).not.toContain("agent");
    }
  });
});
