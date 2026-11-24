import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import { applyToText } from "../lib.mjs";
import { PATCHES } from "../patches.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));

// The New task dialog's create mutation in core 2026.1023.0's main bundle (index-YJY9oyby.js), verbatim.
const DIALOG_2026_1023_0 = await readFile(path.join(HERE, "fixtures", "new-task-dialog-2026.1023.0.js"), "utf8");

const filesPatch = PATCHES.find((entry) => entry.id === "new-task-files-message");

/** The mutation as the dialog runs it, with the bundle's helpers stubbed and the issues API given. */
function mutationFrom(code, issuesApi) {
  const body = code.trim().replace(/,$/, "");
  return new Function("Ct", `const r=(f)=>f,je=(o)=>o;let Gt;${body}});return Gt.mutationFn;`)(issuesApi);
}

function fakeIssuesApi({ failUpload = [], failComment = false } = {}) {
  let next = 0;
  return {
    create: vi.fn(async () => ({ id: "issue-1", identifier: "ATT-1" })),
    upsertDocument: vi.fn(async () => ({})),
    uploadAttachment: vi.fn(async (_companyId, _issueId, file) => {
      if (failUpload.includes(file.name)) throw new Error("upload failed");
      next += 1;
      return { id: `att-${next}`, contentPath: `/api/attachments/att-${next}/content`, originalFilename: file.name };
    }),
    addComment: vi.fn(async () => {
      if (failComment) throw new Error("comment failed");
      return { id: "comment-1" };
    }),
  };
}

const file = (name, text = "x") => ({ name, text: async () => text });
const staged = [
  { kind: "document", documentKey: "notes", title: "Notes", file: file("notes.md", "# Notes") },
  { kind: "attachment", file: file("brief.pdf") },
  { kind: "attachment", file: file("a[1].png") },
];

describe("new-task-files-message", () => {
  it("is declared with the safety fields every patch needs", () => {
    expect(filesPatch).toBeDefined();
    expect(filesPatch.upstream).toContain("github.com/paperclipai/paperclip");
    expect(filesPatch.expect).toBe(1);
    expect(filesPatch.files).toEqual(["ui/dist/assets/*.js"]);
    expect(filesPatch.pattern.flags).toContain("g");
  });

  it("matches the 2026.1023.0 dialog exactly once, whatever the minifier called the identifiers, and not again once applied", () => {
    const once = applyToText(DIALOG_2026_1023_0, filesPatch);
    expect(once.count).toBe(1);
    expect(applyToText(once.text, filesPatch).count).toBe(0);
    const renamed = DIALOG_2026_1023_0.replaceAll("Dn", "$w").replaceAll("Ct.", "Q1.").replaceAll("ys", "Yb").replaceAll("ct", "k$");
    expect(applyToText(renamed, filesPatch).count).toBe(1);
  });

  it("without the patch, the uploaded files are bound to nothing (the bug)", async () => {
    const api = fakeIssuesApi();
    const result = await mutationFrom(DIALOG_2026_1023_0, api)({ companyId: "co-1", stagedFiles: staged, title: "T" });
    expect(api.uploadAttachment).toHaveBeenCalledTimes(2);
    expect(api.addComment).not.toHaveBeenCalled();
    expect(result.failures).toEqual([]);
  });

  it("posts the uploaded files as the task's first message, bound to them, as the chat composer sends files", async () => {
    const api = fakeIssuesApi();
    const run = mutationFrom(applyToText(DIALOG_2026_1023_0, filesPatch).text, api);
    const result = await run({ companyId: "co-1", stagedFiles: staged, title: "T", navigateOnCreate: true });
    expect(api.create).toHaveBeenCalledWith("co-1", { title: "T" });
    expect(api.upsertDocument).toHaveBeenCalledTimes(1);
    expect(api.addComment).toHaveBeenCalledTimes(1);
    expect(api.addComment).toHaveBeenCalledWith(
      "issue-1",
      "[brief.pdf](/api/attachments/att-1/content)\n[a\\[1\\].png](/api/attachments/att-2/content)",
      undefined,
      undefined,
      ["att-1", "att-2"],
    );
    // The message is sent after every upload.
    expect(api.addComment.mock.invocationCallOrder[0]).toBeGreaterThan(Math.max(...api.uploadAttachment.mock.invocationCallOrder));
    expect(result).toEqual({ issue: { id: "issue-1", identifier: "ATT-1" }, companyId: "co-1", failures: [], navigateOnCreate: true });
  });

  it("sends no message when only documents were staged", async () => {
    const api = fakeIssuesApi();
    await mutationFrom(applyToText(DIALOG_2026_1023_0, filesPatch).text, api)({ companyId: "co-1", stagedFiles: staged.slice(0, 1) });
    expect(api.addComment).not.toHaveBeenCalled();
  });

  it("leaves a failed upload out of the message and still reports it", async () => {
    const api = fakeIssuesApi({ failUpload: ["brief.pdf"] });
    const result = await mutationFrom(applyToText(DIALOG_2026_1023_0, filesPatch).text, api)({ companyId: "co-1", stagedFiles: staged });
    expect(api.addComment).toHaveBeenCalledWith("issue-1", "[a\\[1\\].png](/api/attachments/att-1/content)", undefined, undefined, ["att-1"]);
    expect(result.failures).toEqual(["brief.pdf"]);
  });

  it("reports the files as warnings when the message cannot be sent, and still returns the task", async () => {
    const api = fakeIssuesApi({ failComment: true });
    const result = await mutationFrom(applyToText(DIALOG_2026_1023_0, filesPatch).text, api)({ companyId: "co-1", stagedFiles: staged });
    expect(result.issue.id).toBe("issue-1");
    expect(result.failures).toEqual(["brief.pdf", "a[1].png"]);
  });
});
